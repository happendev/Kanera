import { dto } from "@kanera/shared";
import { MAX_REMINDER_LEAD_DAYS, type CardFollowState, type WireCardReminderListItem } from "@kanera/shared/dto";
import { boardWatchers, cardReminders, cards, cardWatchers, lists } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertBoardAccess, assertCardAccess, assertWriteCapableCredential, assignedCardVisibility } from "../../lib/access.js";
import { assertAgentAccessAllowed } from "../../lib/mcp-policy.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { serializeCardReminder } from "../../lib/card-follow.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { absoluteCardUrl } from "../../lib/wire-card.js";
import { emitToUser } from "../../realtime/emit.js";

/**
 * Following (watching) and reminders: per-user subscription state on a card or board.
 *
 * Served by both the app API and the public API so the web client, MCP, CLI and SDK share one set of
 * handlers. None of these routes records an activity row: watching and reminding change nothing
 * about the card, and an activity row is board-visible history (and webhook payload). Other
 * sessions learn about the change through the user-scoped `watch:changed` / `cardReminder:*` events
 * instead; see their doc comment in @kanera/shared/events.
 */
export async function followRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  // This is a human's own subscription state, so a workspace-scoped key (which acts for the
  // workspace, merely borrowing its creator's user id) has no person to follow on behalf of.
  app.addHook("preHandler", async (req) => assertPersonalCredential(req.auth));

  app.get("/cards/:id/follow", async (req): Promise<CardFollowState> => {
    const { id } = req.params as { id: string };
    const card = await loadCard(id);
    await assertCardAccess(req.auth, card);
    return followState(req.auth.sub, id);
  });

  app.put("/cards/:id/watch", async (req): Promise<CardFollowState> => setCardWatch(req.auth, (req.params as { id: string }).id, true));
  app.delete("/cards/:id/watch", async (req): Promise<CardFollowState> => setCardWatch(req.auth, (req.params as { id: string }).id, false));

  app.put("/boards/:id/watch", async (req, reply) => {
    const { id } = req.params as { id: string };
    assertWriteCapableCredential(req.auth);
    const access = await assertBoardAccess(req.auth, id);
    await db.insert(boardWatchers).values({ boardId: id, userId: req.auth.sub }).onConflictDoNothing();
    emitToUser(req.auth.sub, "watch:changed", { kind: "board", id, boardId: id, workspaceId: access.workspaceId, watching: true });
    return reply.status(204).send();
  });

  app.delete("/boards/:id/watch", async (req, reply) => {
    const { id } = req.params as { id: string };
    assertWriteCapableCredential(req.auth);
    const access = await assertBoardAccess(req.auth, id);
    await db.delete(boardWatchers).where(and(eq(boardWatchers.boardId, id), eq(boardWatchers.userId, req.auth.sub)));
    emitToUser(req.auth.sub, "watch:changed", { kind: "board", id, boardId: id, workspaceId: access.workspaceId, watching: false });
    return reply.status(204).send();
  });

  app.put("/cards/:id/reminder", async (req): Promise<CardFollowState> => {
    const { id } = req.params as { id: string };
    const body = dto.setCardReminderBody.parse(req.body);
    assertWriteCapableCredential(req.auth);
    const card = await loadCard(id);
    // Observer access is enough: reminding yourself about a card you can read changes nothing on it.
    await assertCardAccess(req.auth, card);
    const remindAt = new Date(body.remindAt);
    const now = Date.now();
    if (remindAt.getTime() <= now) throw badRequest("remindAt must be in the future");
    if (remindAt.getTime() > now + MAX_REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000) {
      throw badRequest(`remindAt must be within ${MAX_REMINDER_LEAD_DAYS} days`);
    }
    // One reminder per user per card: setting a new time replaces the old one and re-arms it even
    // if it had already fired. It takes a fresh id because each scheduling is its own occurrence:
    // the reminder.due dedupe index and the push tag are keyed by id, so reusing it would swallow
    // the re-armed delivery as a duplicate of the one that already fired.
    const [row] = await db
      .insert(cardReminders)
      .values({ cardId: id, userId: req.auth.sub, remindAt })
      .onConflictDoUpdate({
        target: [cardReminders.cardId, cardReminders.userId],
        set: { id: sql`uuidv7()`, remindAt, firedAt: null, createdAt: new Date(), updatedAt: new Date() },
      })
      .returning();
    const reminder = serializeCardReminder(row!);
    emitToUser(req.auth.sub, "cardReminder:updated", { reminder });
    return { ...(await followState(req.auth.sub, id)), reminder };
  });

  app.delete("/cards/:id/reminder", async (req): Promise<CardFollowState> => {
    const { id } = req.params as { id: string };
    assertWriteCapableCredential(req.auth);
    const card = await loadCard(id);
    await assertCardAccess(req.auth, card);
    const [removed] = await db
      .delete(cardReminders)
      .where(and(eq(cardReminders.cardId, id), eq(cardReminders.userId, req.auth.sub)))
      .returning({ id: cardReminders.id });
    if (removed) emitToUser(req.auth.sub, "cardReminder:deleted", { cardId: id, reminderId: removed.id });
    return followState(req.auth.sub, id);
  });

  app.get("/reminders", async (req): Promise<WireCardReminderListItem[]> => {
    const query = dto.listCardRemindersQuery.parse(req.query ?? {});
    // Reminders outlive access changes (they are only dropped when they fire), so list just the ones
    // whose card this credential can still read, with the same assigned-items-only rule as cards.
    const accessible = await loadAccessibleBoards(req.auth);
    const openBoardIds = accessible.filter((board) => !board.assignedItemsOnly).map((board) => board.id);
    const restrictedBoardIds = accessible.filter((board) => board.assignedItemsOnly).map((board) => board.id);
    if (openBoardIds.length === 0 && restrictedBoardIds.length === 0) return [];
    const visible = or(
      ...(openBoardIds.length ? [inArray(cards.boardId, openBoardIds)] : []),
      ...(restrictedBoardIds.length ? [and(inArray(cards.boardId, restrictedBoardIds), assignedCardVisibility(req.auth.sub))] : []),
    );
    const rows = await db
      .select({ reminder: cardReminders, card: { id: cards.id, key: cards.key, organisationKey: cards.organisationKey, title: cards.title, boardId: cards.boardId }, workspaceId: lists.workspaceId })
      .from(cardReminders)
      .innerJoin(cards, eq(cards.id, cardReminders.cardId))
      .innerJoin(lists, eq(lists.id, cards.listId))
      .where(and(
        eq(cardReminders.userId, req.auth.sub),
        isNull(cards.archivedAt),
        visible,
        ...(query.status === "pending" ? [isNull(cardReminders.firedAt)] : []),
      ))
      .orderBy(asc(cardReminders.remindAt), asc(cardReminders.id))
      .limit(500);
    return rows.map(({ reminder, card, workspaceId }) => ({
      ...serializeCardReminder(reminder),
      card: {
        id: card.id,
        key: card.key,
        title: card.title,
        boardId: card.boardId,
        workspaceId,
        url: absoluteCardUrl(card.organisationKey, card.key),
      },
    }));
  });
}

function assertPersonalCredential(claims: AuthClaims): void {
  if (claims.authKind === "apiKey" && claims.apiKeyKind !== "personal") {
    throw forbidden("following and reminders need a personal API key or OAuth connection");
  }
  assertAgentAccessAllowed(claims);
}

async function loadCard(id: string) {
  const [card] = await db
    .select({ id: cards.id, boardId: cards.boardId, workspaceId: lists.workspaceId })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(eq(cards.id, id))
    .limit(1);
  if (!card) throw notFound("card not found");
  return card;
}

async function setCardWatch(auth: AuthClaims, cardId: string, watching: boolean): Promise<CardFollowState> {
  assertWriteCapableCredential(auth);
  const card = await loadCard(cardId);
  await assertCardAccess(auth, card);
  if (watching) {
    await db.insert(cardWatchers).values({ cardId, userId: auth.sub }).onConflictDoNothing();
  } else {
    await db.delete(cardWatchers).where(and(eq(cardWatchers.cardId, cardId), eq(cardWatchers.userId, auth.sub)));
  }
  emitToUser(auth.sub, "watch:changed", { kind: "card", id: cardId, boardId: card.boardId, workspaceId: card.workspaceId, watching });
  return followState(auth.sub, cardId);
}

async function followState(userId: string, cardId: string): Promise<CardFollowState> {
  const [[watch], [reminder]] = await Promise.all([
    db.select({ exists: sql<number>`1` }).from(cardWatchers)
      .where(and(eq(cardWatchers.cardId, cardId), eq(cardWatchers.userId, userId))).limit(1),
    db.select().from(cardReminders)
      .where(and(eq(cardReminders.cardId, cardId), eq(cardReminders.userId, userId))).limit(1),
  ]);
  return { cardId, watching: Boolean(watch), reminder: reminder ? serializeCardReminder(reminder) : null };
}
