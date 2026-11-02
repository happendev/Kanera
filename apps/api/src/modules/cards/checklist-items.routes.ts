import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertBoardAccess } from "../../lib/access.js";
import { emitToBoard } from "../../realtime/emit.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { loadEditableCard, orderedUniqueIds, loadBulkBoardCards } from "./route-support.js";
import { loadEditableChecklist } from "./card-checklists.js";
import {
  createChecklistItems,
  deleteChecklistItem,
  emitChecklistItemMove,
  emitChecklistItemUpdate,
  emitCreatedChecklistItems,
  loadChecklistItemTarget,
  moveChecklistItem,
  updateChecklistItem,
  updateSelectedChecklistItems,
} from "./card-checklist-items.js";
import {
  bulkUpdateChecklistItems,
  createBulkChecklistItems,
  emitBulkChecklistItemUpdate,
  emitBulkCreatedChecklistItems,
  emitChecklistItemDescriptions,
  loadBulkChecklistItemTargets,
  loadChecklistItemDescriptionTargets,
  setChecklistItemDescriptions,
} from "./card-checklist-items-bulk.js";

type ItemParams = { id: string; checklistId?: string; itemId: string };

/**
 * Checklist items: create, update, delete and move, per item, per card and board-wide bulk. Called
 * from `cardRoutes` rather than registered on its own, so these routes share its `app.authenticate`
 * preHandler.
 */
export function cardChecklistItemRoutes(app: FastifyInstance) {
  app.patch("/boards/:boardId/checklist-items/bulk/descriptions", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkSetChecklistItemDescriptionsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const requestedCardIds = orderedUniqueIds(body.updates.map((update) => update.cardId));
    const selectedCards = await loadBulkBoardCards(boardId, requestedCardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    for (const card of selectedCards) assertCardActive(card);
    const currentByItemId = await loadChecklistItemDescriptionTargets(boardId, body.updates);
    const result = await setChecklistItemDescriptions({ actorId: req.auth.sub, boardId, workspaceId: ctx.workspaceId, updates: body.updates, currentByItemId });
    await emitChecklistItemDescriptions(result);
    return {
      updated: result.updates.length,
      items: result.updates.map((update) => ({ cardId: update.card.id, checklistId: update.checklist.id, item: update.item })),
      unchangedItemIds: result.unchangedItemIds,
    };
  });

  app.post("/boards/:boardId/checklist-items/bulk/create", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkCreateChecklistItemsBody.parse(req.body);
    const boardAccess = await assertBoardAccess(req.auth, boardId, "editor");
    const targets = await loadBulkChecklistItemTargets(req.auth, boardAccess, boardId, body.items);
    const result = await createBulkChecklistItems({ actorId: req.auth.sub, boardId, workspaceId: boardAccess.workspaceId, items: body.items, targets });
    await emitBulkCreatedChecklistItems(result);
    return reply.status(201).send({ created: result.items.length, items: result.items });
  });

  app.post("/cards/:id/checklists/:checklistId/items", async (req, reply) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const { afterItemId, beforeItemId, ...item } = dto.createChecklistItemBody.parse(req.body);
    const { card, ctx, checklist } = await loadEditableChecklist(req.auth, id, checklistId);
    const result = await createChecklistItems({
      actorId: req.auth.sub,
      card,
      ctx,
      checklist,
      items: [item],
      anchor: { afterItemId, beforeItemId },
      itemPath: () => [],
      created: "coalesced",
    });
    await emitCreatedChecklistItems(result);
    const [tree] = result.trees;
    return reply.status(201).send({ ...tree!.item, subChecklists: tree!.subChecklists });
  });

  app.post("/cards/:id/checklists/:checklistId/items/batch", async (req, reply) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.createChecklistItemsBody.parse(req.body);
    const { card, ctx, checklist } = await loadEditableChecklist(req.auth, id, checklistId);
    // A batch is an explicit plan edit, so each item gets an audit row (without watcher fanout), as
    // in the board-level bulk create.
    const result = await createChecklistItems({
      actorId: req.auth.sub,
      card,
      ctx,
      checklist,
      items: body.items,
      anchor: body,
      itemPath: (index) => ["items", index],
      created: "perItem",
    });
    await emitCreatedChecklistItems(result);
    return reply.status(201).send({ items: result.trees.map((tree) => ({ ...tree.item, subChecklists: tree.subChecklists })) });
  });

  app.patch("/cards/:id/checklists/:checklistId/items/bulk", async (req) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.bulkUpdateChecklistItemsBody.parse(req.body);
    const { card, ctx, checklist } = await loadEditableChecklist(req.auth, id, checklistId);
    const result = await bulkUpdateChecklistItems({ actorId: req.auth.sub, card, ctx, checklist, body });
    await emitBulkChecklistItemUpdate(result);
    return { items: result.items };
  });

  async function updateChecklistItemRoute(req: FastifyRequest) {
    const params = req.params as ItemParams;
    const body = dto.updateChecklistItemBody.parse(req.body);
    const target = await loadChecklistItemTarget(req.auth, params);
    const result = await updateChecklistItem({ actorId: req.auth.sub, target, body });
    await emitChecklistItemUpdate(result);
    return result.written.item;
  }

  app.patch("/cards/:id/checklists/:checklistId/items/:itemId", updateChecklistItemRoute);
  // Item-addressed alias: the server derives the containing checklist from the item, so callers
  // that hold only an item id (agents, integrations) do not need to look up its checklist first.
  app.patch("/cards/:id/checklist-items/:itemId", updateChecklistItemRoute);

  // Selected-item updates: different changes for chosen items on one card, applied atomically (see
  // `updateSelectedChecklistItems`).
  app.patch("/cards/:id/checklist-items", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateChecklistItemsBody.parse(req.body);
    const { card, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(card);
    const results = await updateSelectedChecklistItems({ actorId: req.auth.sub, card, ctx, updates: body.updates });
    for (const result of results) await emitChecklistItemUpdate(result);
    return { items: results.map((result) => result.written.item) };
  });

  async function deleteChecklistItemRoute(req: FastifyRequest, reply: FastifyReply) {
    const params = req.params as ItemParams;
    const target = await loadChecklistItemTarget(req.auth, params);
    await deleteChecklistItem({ target });
    const { card, checklist, current } = target;
    await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_DELETED, { boardId: card.boardId, cardId: card.id, checklistId: checklist.id, checklistParentItemId: checklist.parentItemId, itemId: current.id, completedAt: current.completedAt });
    return reply.status(204).send();
  }

  app.delete("/cards/:id/checklists/:checklistId/items/:itemId", deleteChecklistItemRoute);
  app.delete("/cards/:id/checklist-items/:itemId", deleteChecklistItemRoute);

  async function moveChecklistItemRoute(req: FastifyRequest) {
    const params = req.params as ItemParams;
    const body = dto.moveChecklistItemBody.parse(req.body);
    const target = await loadChecklistItemTarget(req.auth, params);
    const result = await moveChecklistItem({ target, body });
    await emitChecklistItemMove(result);
    return { id: result.itemId, checklistId: result.targetChecklistId, position: result.position };
  }

  app.post("/cards/:id/checklists/:checklistId/items/:itemId/move", moveChecklistItemRoute);
  app.post("/cards/:id/checklist-items/:itemId/move", moveChecklistItemRoute);
}
