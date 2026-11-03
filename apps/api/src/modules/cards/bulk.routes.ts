import { dto } from "@kanera/shared";
import { lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess } from "../../lib/access.js";
import { badRequest } from "../../lib/errors.js";
import { toWireCard } from "../../lib/wire-card.js";
import { emitBulkCardDueDates, patchBulkCardAssignees, patchBulkCardLabels, setBulkCardCompletion, setBulkCardDueDates } from "./bulk-card-attributes.js";
import { archiveBulkCards, emitBulkCardArchive } from "./bulk-card-archive.js";
import { emitBulkCardCustomField, loadBulkCustomField, setBulkCardCustomField } from "./bulk-card-custom-fields.js";
import { emitBulkCardMoves, moveBulkCards } from "./bulk-card-move.js";
import { loadBulkBoardCards, activeBulkCards, emitCardLabels, emitCardAssignees, emitCardCompletion } from "./route-support.js";

/**
 * Board-scoped bulk card writes. Called from `cardRoutes` rather than registered on its own, so
 * these routes share its `app.authenticate` preHandler.
 */
export function cardBulkRoutes(app: FastifyInstance) {
  app.patch("/boards/:boardId/cards/bulk/completion", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetCardCompletionBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const changingCards = targetCards.filter((card) => body.completed !== Boolean(card.completedAt));
    if (changingCards.length === 0) return { updated: 0, cards: [], skippedCardIds };

    const updates = await setBulkCardCompletion({ auth: req.auth, ctx, cards: changingCards, completed: body.completed });

    await emitCardCompletion(updates, { clientId: req.auth.cid, completed: body.completed, mailer: app.mailer, log: req.log });
    return { updated: updates.length, cards: updates.map(({ finalCard }) => toWireCard(finalCard, req.auth.cid)), skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/due-date", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetCardDueDateBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);

    // Appends cards archived since the load to `skippedCardIds`.
    const updates = await setBulkCardDueDates({ auth: req.auth, ctx, boardId, cards: targetCards, skippedCardIds, body });

    await emitBulkCardDueDates(updates, { boardId, auth: req.auth, mailer: app.mailer });
    return { updated: updates.length, cards: updates.map(({ card }) => toWireCard(card, req.auth.cid)), skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/labels", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkPatchCardLabelsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);

    const updates = await patchBulkCardLabels({ auth: req.auth, ctx, boardId, cards: targetCards, body });

    await emitCardLabels(updates);
    return { updated: updates.length, updatedCardIds: updates.map((update) => update.cardId), skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/assignees", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkPatchCardAssigneesBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);

    const updates = await patchBulkCardAssignees({ auth: req.auth, ctx, boardId, cards: targetCards, body });

    await emitCardAssignees(updates, app.mailer, req.auth.sub);
    return { updated: updates.length, updatedCardIds: updates.map((update) => update.cardId), skippedCardIds };
  });

  app.post("/boards/:boardId/cards/bulk/move", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkMoveCardsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    // Lists are workspace-scoped, so any list in this board's workspace is a valid target.
    const [targetList] = await db.select().from(lists).where(eq(lists.id, body.listId)).limit(1);
    if (!targetList || targetList.workspaceId !== ctx.workspaceId) throw badRequest("target list not in same workspace");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const movingCards = targetCards.filter((card) => card.listId !== body.listId);
    if (movingCards.length === 0) return { moved: 0, cards: [], skippedCardIds };

    const moves = await moveBulkCards({ auth: req.auth, ctx, boardId, cards: movingCards, listId: body.listId });

    await emitBulkCardMoves(moves, { boardId, listId: body.listId });
    return { moved: moves.length, cards: moves.map(({ finalCard }) => toWireCard(finalCard, req.auth.cid)), skippedCardIds };
  });

  app.patch("/boards/:boardId/cards/bulk/archive", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkArchiveCardsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const targetCards = loaded.filter((card) => !card.archivedAt);
    if (targetCards.length === 0) return { archived: 0, cards: [], skippedCardIds: [] };

    const result = await archiveBulkCards({ auth: req.auth, ctx, boardId, cards: targetCards });

    await emitBulkCardArchive(result, { boardId, auth: req.auth, mailer: app.mailer, log: req.log });
    return { archived: result.rows.length, cards: result.rows.map(({ card }) => toWireCard(card, req.auth.cid)), skippedCardIds: [] };
  });

  // Bulk-set one custom field across many cards. Mirrors the single-card PUT/DELETE path:
  // per changed card we upsert/delete the value, then emit card:customFieldValue:set|cleared
  // (one event per card, reconciled by BoardState) plus a coalesced bulk activity entry.
  app.patch("/boards/:boardId/cards/bulk/custom-fields", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetCardCustomFieldBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const field = await loadBulkCustomField(ctx, body);
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);

    const changes = await setBulkCardCustomField({ auth: req.auth, ctx, boardId, field, cards: targetCards, body });

    await emitBulkCardCustomField(changes, { boardId, field });
    return {
      values: changes.set.map((c) => c.value),
      clearedCardIds: changes.cleared.map((c) => c.cardId),
      skippedCardIds,
      updated: changes.set.length + changes.cleared.length,
    };
  });
}
