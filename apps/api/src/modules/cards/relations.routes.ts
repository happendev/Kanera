import { dto } from "@kanera/shared";
import type { CardRelationsResponse, CardRelationSummary } from "@kanera/shared/dto";
import { ACTIVITY_ACTION, boards, cardRelations, cards, lists } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess, assertCardAccess, assignedCardVisibility } from "../../lib/access.js";
import { emitActivityFeedItem, recordActivity } from "../../lib/activity.js";
import { assertCardActive } from "../../lib/card-guards.js";
import {
  assertNoBlockingCycle,
  blockedByCounts,
  captureBlockedDependents,
  emitBlockedByCountChanged,
  loadCardRelations,
  lockWorkspaceRelations,
  relationCardAssignees,
  relationCardLabels,
  relationDirectionFor,
  storedRelation,
} from "../../lib/card-relations.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { emitInternalLinksChanged } from "../../lib/internal-links.js";
import { EMPTY_EFFECTS, emitAutomationEffects, runCardBlockedAutomations, runCardUnblockedAutomations } from "../../lib/automations.js";
import { notifyDependencyHandoffs, recordBlockersCleared, notifyDependencyAdded } from "../../lib/dependency-notifications.js";
import { env } from "../../env.js";
import type { CardRelationDirection } from "@kanera/shared/card-relations";

function oppositeDirection(direction: CardRelationDirection): CardRelationDirection {
  if (direction === "blocks") return "blocked_by";
  if (direction === "blocked_by") return "blocks";
  return "relates_to";
}

/**
 * Typed card relations. Called from `cardRoutes` rather than registered on its own so the public
 * API (`/api/v1`), which reuses the card routes, exposes the same handlers with the same audit and
 * realtime side effects.
 *
 * Access: changing a relation is an edit of the card in the path, so that card needs editor access.
 * For `blocks`, the card that ends up blocked also needs editor access, whichever side of the path
 * it is on: being blocked changes its state (Blocked chip, card_blocked automations, notifications
 * to its assignees), so read access to it is not enough. `relates_to` and the blocker side of a
 * relation only need the other card to be readable, since they say nothing new about it.
 */
export function cardRelationRoutes(app: FastifyInstance) {
  app.post("/cards/completion-warning", async (req): Promise<dto.CompletionWarningResponse> => {
    const body = dto.completionWarningBody.parse(req.body);
    let selected;
    if ("cardIds" in body) {
      selected = await db.select().from(cards).where(inArray(cards.id, body.cardIds));
      for (const card of selected) await assertCardAccess(req.auth, card, "editor");
    } else {
      const access = await assertBoardAccess(req.auth, body.boardId, "editor");
      selected = await db.select().from(cards).where(and(eq(cards.boardId, body.boardId), eq(cards.listId, body.listId),
        isNull(cards.archivedAt), access.assignedItemsOnly ? assignedCardVisibility(req.auth.sub) : undefined));
    }
    const counts = await blockedByCounts(db, selected.filter((card) => !card.completedAt && !card.archivedAt).map((card) => card.id));
    return { blockedCardCount: counts.size };
  });
  // Relations on their own, so an open card re-reads them on `card:links:changed` without a full
  // /detail fetch (which the realtime revision guard would discard).
  app.get("/cards/:id/relations", async (req): Promise<CardRelationsResponse> => {
    const { id } = req.params as { id: string };
    const [card] = await db.select({ id: cards.id, boardId: cards.boardId }).from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card);
    return loadCardRelations(req.auth, id);
  });

  app.post("/cards/:id/relations", async (req, reply): Promise<CardRelationSummary> => {
    const { id } = req.params as { id: string };
    const body = dto.addCardRelationBody.parse(req.body);
    if (body.targetCardId === id) throw badRequest("a card cannot be related to itself");

    const [pathCard] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!pathCard) throw notFound();
    const ctx = await assertCardAccess(req.auth, pathCard, "editor");

    // 404, not 403, for a target the caller cannot read, so ids cannot be probed for existence.
    const [otherCard] = await db.select().from(cards).where(eq(cards.id, body.targetCardId)).limit(1);
    if (!otherCard) throw notFound("card not found");
    try {
      await assertCardAccess(req.auth, otherCard);
    } catch {
      throw notFound("card not found");
    }
    // Lists and fields are workspace-scoped, and so is the dependency graph: a relation across
    // workspaces would leak between tenants' boards and could not be cycle-checked in one lock.
    if (otherCard.workspaceId !== pathCard.workspaceId) throw badRequest("cards must be in the same workspace to be related");

    const stored = storedRelation(id, otherCard.id, body.direction);
    if (stored.kind === "blocks" && stored.targetCardId === otherCard.id) await assertCardAccess(req.auth, otherCard, "editor");
    const result = await db.transaction(async (tx) => {
      await lockWorkspaceRelations(tx, pathCard.workspaceId);
      const [existing] = await tx.select().from(cardRelations).where(and(
        eq(cardRelations.sourceCardId, stored.sourceCardId),
        eq(cardRelations.targetCardId, stored.targetCardId),
        eq(cardRelations.kind, stored.kind),
      )).limit(1);
      // Idempotent, and checked before any lifecycle rule: agents retry, and "already blocked by X"
      // is the outcome they asked for even if that blocker has since been completed.
      if (existing) return { relation: existing, created: false as const, activities: null, card: pathCard, other: otherCard };
      // Lifecycle is validated on rows read under the graph lock: completing or archiving either
      // card takes this lock first, so what is checked here is what the relation is written against.
      const fresh = await tx.select().from(cards).where(inArray(cards.id, [pathCard.id, otherCard.id]));
      const card = fresh.find((row) => row.id === pathCard.id);
      const other = fresh.find((row) => row.id === otherCard.id);
      if (!card || !other) throw notFound("card not found");
      assertCardActive(card);
      assertCardActive(other);
      if (stored.kind === "blocks") {
        // A completed card holds nothing up, and "blocked by" something already done is only noise:
        // the dependent would never gain a Blocked chip or a handoff from it.
        const blocker = stored.sourceCardId === card.id ? card : other;
        if (blocker.completedAt) throw badRequest("a completed card cannot block another card");
        await assertNoBlockingCycle(tx, stored.sourceCardId, stored.targetCardId);
      }
      const readyBefore = stored.kind === "blocks" && !(await blockedByCounts(tx, [stored.targetCardId])).has(stored.targetCardId);
      const [relation] = await tx.insert(cardRelations).values({
        workspaceId: card.workspaceId,
        ...stored,
        createdById: req.auth.sub,
      }).returning();
      // Recorded on both cards, each from its own side, and naming the other card by key rather
      // than title: a card's feed is readable by people who may not be able to open the other card.
      const record = (subject: typeof card, otherCard: typeof card, direction: CardRelationDirection) => recordActivity(tx, {
        boardId: subject.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: subject.id,
        action: ACTIVITY_ACTION.RELATION_ADDED,
        payload: { relationId: relation!.id, direction, otherCardId: otherCard.id, otherCardKey: otherCard.key },
      });
      const activities = {
        path: await record(card, other, body.direction),
        other: await record(other, card, oppositeDirection(body.direction)),
      };
      const effects = readyBefore
        ? await runCardBlockedAutomations(tx, { cardIds: [stored.targetCardId], workspaceId: ctx.workspaceId, clientId: req.auth.cid, triggerActorId: req.auth.sub })
        : EMPTY_EFFECTS;
      // The card_blocked automations may have moved or completed either card; notifications and
      // the response describe the cards as committed, not as they were before the write.
      const after = effects.effects.length
        ? await tx.select().from(cards).where(inArray(cards.id, [card.id, other.id]))
        : fresh;
      return {
        relation: relation!, created: true as const, activities, effects,
        card: after.find((row) => row.id === card.id) ?? card,
        other: after.find((row) => row.id === other.id) ?? other,
      };
    });
    const { card, other } = result;

    if (result.created) {
      // Notifications are sent explicitly below, to card watchers under their own setting, rather
      // than through the generic watcher fanout.
      await emitActivityFeedItem(card.boardId, card.id, result.activities.path, { notify: false });
      await emitActivityFeedItem(other.boardId, other.id, result.activities.other, { notify: false });
      await emitInternalLinksChanged({ cardIds: [card.id, other.id], noteIds: [] });
      const pathIsBlocker = stored.sourceCardId === card.id;
      const blocked = pathIsBlocker ? other : card;
      // A completed dependent is not held up by anything (its Blocked chip stays hidden), so the
      // relation is recorded without telling anyone they are blocked; reopening it later does not
      // re-announce either, matching the automations, which only fire on a real boundary. The same
      // goes for a card a card_blocked automation completed or archived in this very write.
      if (stored.kind === "blocks") await emitBlockedByCountChanged([stored.targetCardId], req.auth.cid);
      if (stored.kind === "blocks" && !blocked.completedAt && !blocked.archivedAt) {
        // A failed notification must not turn a stored relation into an error response.
        await notifyDependencyAdded({
          actorId: req.auth.sub,
          mailer: app.mailer,
          webOrigin: env.WEB_ORIGIN,
          blocker: pathIsBlocker ? card : other,
          blocked,
          activities: pathIsBlocker
            ? { blocker: result.activities.path, blocked: result.activities.other }
            : { blocker: result.activities.other, blocked: result.activities.path },
        }).catch((err: unknown) => req.log.warn({ err, relationId: result.relation.id }, "failed to send dependency notifications"));
      }
      await emitAutomationEffects(result.effects);
    }

    reply.code(result.created ? 201 : 200);
    return {
      id: result.relation.id,
      direction: relationDirectionFor(id, result.relation),
      createdAt: result.relation.createdAt.toISOString(),
      card: await relationCard(other),
    };
  });

  app.delete("/cards/:id/relations/:relationId", async (req, reply) => {
    const { id, relationId } = req.params as { id: string; relationId: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);

    const removed = await db.transaction(async (tx) => {
      await lockWorkspaceRelations(tx, card.workspaceId);
      const [relation] = await tx.select().from(cardRelations).where(and(
        eq(cardRelations.id, relationId),
        // Either end may remove it: "blocked by X" is removable from the blocked card, which is
        // where people notice it is stale.
        or(eq(cardRelations.sourceCardId, id), eq(cardRelations.targetCardId, id)),
      )).limit(1);
      if (!relation) throw notFound("relation not found");
      const before = relation.kind === "blocks"
        ? (await captureBlockedDependents(tx, card.workspaceId, [relation.sourceCardId])).filter((row) => row.dependentId === relation.targetCardId)
        : [];
      await tx.delete(cardRelations).where(eq(cardRelations.id, relation.id));
      const otherCardId = relation.sourceCardId === id ? relation.targetCardId : relation.sourceCardId;
      const [other] = await tx.select().from(cards).where(eq(cards.id, otherCardId)).limit(1);
      const activity = await recordActivity(tx, {
        boardId: card.boardId,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        entityType: "card",
        entityId: card.id,
        action: ACTIVITY_ACTION.RELATION_REMOVED,
        payload: { relationId: relation.id, direction: relationDirectionFor(id, relation), otherCardId, otherCardKey: other?.key ?? null },
      });
      const otherActivity = other ? await recordActivity(tx, {
        boardId: other.boardId, workspaceId: other.workspaceId, actorId: req.auth.sub,
        entityType: "card", entityId: other.id, action: ACTIVITY_ACTION.RELATION_REMOVED,
        payload: { relationId: relation.id, direction: relationDirectionFor(other.id, relation), otherCardId: card.id, otherCardKey: card.key },
      }) : null;
      const handoffs = await recordBlockersCleared(tx, { before, actorId: req.auth.sub });
      const effects = await runCardUnblockedAutomations(tx, { handoffs, workspaceId: card.workspaceId, clientId: req.auth.cid, triggerActorId: req.auth.sub });
      return { relation, otherCardId, activity, other, otherActivity, handoffs, effects };
    });

    await emitActivityFeedItem(card.boardId, card.id, removed.activity, { notify: false });
    if (removed.other && removed.otherActivity) await emitActivityFeedItem(removed.other.boardId, removed.other.id, removed.otherActivity, { notify: false });
    await notifyDependencyHandoffs({ handoffs: removed.handoffs, mailer: app.mailer, webOrigin: env.WEB_ORIGIN })
      .catch((err: unknown) => req.log.warn({ err }, "failed to send blockers-cleared notifications"));
    await emitAutomationEffects(removed.effects);
    await emitInternalLinksChanged({ cardIds: [card.id, removed.otherCardId], noteIds: [] });
    if (removed.relation.kind === "blocks") await emitBlockedByCountChanged([removed.relation.targetCardId], req.auth.cid);
    return reply.code(204).send();
  });
}

async function relationCard(card: typeof cards.$inferSelect): Promise<CardRelationSummary["card"]> {
  const [[names], labelsByCard, assigneesByCard] = await Promise.all([
    db
      .select({ boardName: boards.name, listName: lists.name })
      .from(boards)
      .innerJoin(lists, eq(lists.id, card.listId))
      .where(eq(boards.id, card.boardId))
      .limit(1),
    relationCardLabels([card.id]),
    relationCardAssignees([card.id]),
  ]);
  return {
    id: card.id,
    organisationKey: card.organisationKey,
    key: card.key,
    title: card.title,
    boardId: card.boardId,
    boardName: names?.boardName ?? "",
    listName: names?.listName ?? "",
    completedAt: card.completedAt?.toISOString() ?? null,
    archivedAt: card.archivedAt?.toISOString() ?? null,
    labels: labelsByCard.get(card.id) ?? [],
    assignees: assigneesByCard.get(card.id) ?? [],
  };
}
