import type { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cardAssignees, cardLabelAssignments, cardLabels, cards, users, type ActivityEvent } from "@kanera/shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import type { assertBoardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { enqueueDueDateChangedEmails } from "../../lib/assignee-email-notifications.js";
import { ensureBoardMembershipForUsers } from "../../lib/card-assignment.js";
import { lockWorkspaceRelations } from "../../lib/card-relations.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { clampStartToDue } from "../../lib/due-date.js";
import { badRequest } from "../../lib/errors.js";
import type { Mailer } from "../../lib/mailer.js";
import { requestScheduleRecheckForCards } from "../../lib/schedule-events.js";
import { toWireCard } from "../../lib/wire-card.js";
import { emitToBoard } from "../../realtime/emit.js";
import {
  activeBulkCards,
  applyCardAssignees,
  applyCardCompletion,
  applyCardLabels,
  emitCardActivityFeedItem,
  lockCompletionBatch,
  orderedUniqueIds,
  sortedIds,
  type CardAssigneesWrite,
  type CardCompletionWrite,
  type CardLabelsWrite,
} from "./route-support.js";

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;
type Card = typeof cards.$inferSelect;

/** Completes or reopens the given cards; any that stopped changing state before the lock are left out. */
export async function setBulkCardCompletion({
  auth,
  ctx,
  cards: changingCards,
  completed,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  cards: Card[];
  completed: boolean;
}): Promise<CardCompletionWrite[]> {
  const at = new Date();
  return db.transaction(async (tx) => {
    // Lock the batch and its dependents before the first per-card write (see lockCardsForWrite).
    await lockCompletionBatch(tx, ctx.workspaceId, changingCards.map((card) => card.id), completed);
    const rows: CardCompletionWrite[] = [];
    for (const current of changingCards) {
      const write = await applyCardCompletion(tx, {
        cardId: current.id,
        completed,
        at,
        workspaceId: ctx.workspaceId,
        clientId: ctx.clientId,
        actorId: auth.sub,
      });
      if (write) rows.push(write);
    }
    return rows;
  });
}

type BulkDueDateWrite = { previous: Card; card: Card; activity: ActivityEvent };

/**
 * Sets one due date across the given active cards. Cards archived between the load and the row
 * lock are appended to `skippedCardIds`.
 */
export async function setBulkCardDueDates({
  auth,
  ctx,
  boardId,
  cards: targetCards,
  skippedCardIds,
  body,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  cards: Card[];
  skippedCardIds: string[];
  body: dto.BulkSetCardDueDateBody;
}): Promise<BulkDueDateWrite[]> {
  const dueDateLocalDate = body.dueDateLocalDate;
  const dueDateSlot = dueDateLocalDate ? (body.dueDateSlot ?? "anyTime") : null;
  const dueDateTimezone = dueDateLocalDate
    ? ((await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, auth.sub)).limit(1))[0]?.timezone ?? "UTC")
    : null;
  if (targetCards.length === 0) return [];
  return db.transaction(async (tx) => {
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    const locked = await tx.select().from(cards)
      .where(and(eq(cards.boardId, boardId), inArray(cards.id, targetCards.map((card) => card.id))))
      .orderBy(cards.id).for("update");
    const active = activeBulkCards(locked);
    skippedCardIds.push(...active.skippedCardIds);
    const changingCards = active.cards.filter((card) => card.dueDateLocalDate !== dueDateLocalDate
      || card.dueDateSlot !== dueDateSlot || card.dueDateTimezone !== dueDateTimezone);
    const rows: BulkDueDateWrite[] = [];
    for (const current of changingCards) {
      // A start may never sit after the due date: a bulk due date set before a card's planned
      // start pulls that start along, and the history row records both so the card's bar on the
      // Timeline can be explained from its activity alone (see lib/due-date.ts).
      const startDateLocalDate = clampStartToDue(current.startDateLocalDate, dueDateLocalDate);
      const startClamped = startDateLocalDate !== current.startDateLocalDate;
      const [card] = await tx
        .update(cards)
        .set({ dueDateLocalDate, dueDateSlot, dueDateTimezone, ...(startClamped && { startDateLocalDate }), updatedAt: new Date() })
        .where(eq(cards.id, current.id))
        .returning();
      const activity = await recordActivity(tx, {
        boardId,
        workspaceId: ctx.workspaceId,
        actorId: auth.sub,
        entityType: "card",
        entityId: current.id,
        action: ACTIVITY_ACTION.UPDATED,
        payload: { dueDateLocalDate, dueDateSlot, dueDateTimezone, ...(startClamped && { startDateLocalDate }) },
      });
      rows.push({ previous: current, card: card!, activity });
    }
    await requestScheduleRecheckForCards(tx, rows.map(({ card }) => card.id));
    return rows;
  });
}

/** Post-commit fanout for `setBulkCardDueDates`: per card, due-date emails, then feed, then card. */
export async function emitBulkCardDueDates(
  updates: readonly BulkDueDateWrite[],
  opts: { boardId: string; auth: AuthClaims; mailer: Mailer },
): Promise<void> {
  const { boardId, auth } = opts;
  for (const { previous, card, activity } of updates) {
    await enqueueDueDateChangedEmails({
      tx: db,
      mailer: opts.mailer,
      webOrigin: env.WEB_ORIGIN,
      cardId: card.id,
      actorId: auth.sub,
      previousDue: {
        dueDateLocalDate: previous.dueDateLocalDate,
        dueDateSlot: previous.dueDateSlot,
        dueDateTimezone: previous.dueDateTimezone,
      },
      nextDue: {
        dueDateLocalDate: card.dueDateLocalDate,
        dueDateSlot: card.dueDateSlot,
        dueDateTimezone: card.dueDateTimezone,
      },
      previousStart: previous.startDateLocalDate,
      nextStart: card.startDateLocalDate,
    });
    await emitCardActivityFeedItem(boardId, card.id, activity);
    await emitToBoard(boardId, SERVER_EVENTS.CARD_UPDATED, { boardId, card: toWireCard(card, auth.cid) });
  }
}

/** Adds or removes workspace labels on the given active cards; unchanged cards are skipped. */
export async function patchBulkCardLabels({
  auth,
  ctx,
  boardId,
  cards: targetCards,
  body,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  cards: Card[];
  body: dto.BulkPatchCardLabelsBody;
}): Promise<CardLabelsWrite[]> {
  const validLabels = await db
    .select({ id: cardLabels.id, name: cardLabels.name })
    .from(cardLabels)
    .where(and(eq(cardLabels.workspaceId, ctx.workspaceId), inArray(cardLabels.id, body.labelIds), isNull(cardLabels.archivedAt)));
  if (validLabels.length !== orderedUniqueIds(body.labelIds).length) throw badRequest("one or more label ids are invalid");
  const labelNameById = new Map(validLabels.map((label) => [label.id, label.name]));
  const labelNamesById = Object.fromEntries(validLabels.map((label) => [label.id, label.name]));
  const labelNames = body.labelIds.map((id) => labelNameById.get(id)).filter((name): name is string => Boolean(name));

  return db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    await lockCardsForWrite(tx, targetCards.map((card) => card.id));
    const rows: CardLabelsWrite[] = [];
    for (const card of targetCards) {
      const previous = await tx
        .select({ labelId: cardLabelAssignments.labelId })
        .from(cardLabelAssignments)
        .where(eq(cardLabelAssignments.cardId, card.id));
      const previousIds = previous.map((row) => row.labelId);
      const nextIds = body.mode === "add"
        ? Array.from(new Set([...previousIds, ...body.labelIds]))
        : previousIds.filter((labelId) => !body.labelIds.includes(labelId));
      if (sortedIds(previousIds).join("\0") === sortedIds(nextIds).join("\0")) continue;
      rows.push(await applyCardLabels(tx, {
        cardId: card.id,
        boardId,
        workspaceId: ctx.workspaceId,
        clientId: ctx.clientId,
        actorId: auth.sub,
        previousIds,
        nextIds,
        labelNames,
        labelNamesById,
        bulk: true,
      }));
    }
    return rows;
  });
}

/** Adds or removes assignees on the given active cards; unchanged cards are skipped. */
export async function patchBulkCardAssignees({
  auth,
  ctx,
  boardId,
  cards: targetCards,
  body,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  cards: Card[];
  body: dto.BulkPatchCardAssigneesBody;
}): Promise<CardAssigneesWrite[]> {
  const userIds = orderedUniqueIds(body.userIds);
  const eligibleUserIds = await ensureBoardMembershipForUsers(boardId, userIds);
  if (eligibleUserIds.length !== userIds.length) throw badRequest("one or more user ids are not assignable members");
  const changedUsers = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, userIds));
  const assigneeNamesById = Object.fromEntries(changedUsers.map((user) => [user.id, user.displayName]));

  return db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    await lockCardsForWrite(tx, targetCards.map((card) => card.id));
    const rows: CardAssigneesWrite[] = [];
    for (const card of targetCards) {
      const previous = await tx
        .select({ userId: cardAssignees.userId })
        .from(cardAssignees)
        .where(eq(cardAssignees.cardId, card.id));
      const previousIds = previous.map((row) => row.userId);
      const nextUserIds = body.mode === "add"
        ? Array.from(new Set([...previousIds, ...userIds]))
        : previousIds.filter((userId) => !userIds.includes(userId));
      if (sortedIds(previousIds).join("\0") === sortedIds(nextUserIds).join("\0")) continue;
      rows.push(await applyCardAssignees(tx, {
        cardId: card.id,
        boardId,
        workspaceId: ctx.workspaceId,
        clientId: ctx.clientId,
        actorId: auth.sub,
        previousIds,
        nextIds: nextUserIds,
        assigneeNamesById,
        bulk: true,
      }));
    }
    return rows;
  });
}
