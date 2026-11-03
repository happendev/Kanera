import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { cards } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertCardAccess } from "../../lib/access.js";
import { loadChecklistsForCard } from "../../lib/checklist-rows.js";
import { notFound } from "../../lib/errors.js";
import { emitToBoard } from "../../realtime/emit.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { emitCoalescedCardActivityFeedItem, loadEditableCard, loadChecklistForCard } from "./route-support.js";
import {
  applyChecklistTemplatesToCard,
  createChecklist,
  deleteChecklist,
  emitAppliedChecklistTemplates,
  emitChecklistMove,
  emitCreatedChecklist,
  emitDeletedChecklist,
  loadEditableChecklist,
  moveChecklist,
  renameChecklist,
} from "./card-checklists.js";

/**
 * Card checklists: listing, create, template apply, rename, delete and reorder. Called from
 * `cardRoutes` rather than registered on its own, so these routes share its `app.authenticate`
 * preHandler.
 */
export function cardChecklistRoutes(app: FastifyInstance) {
  // Read-only checklist view for agents and integrations: the card's checklists without the rest of
  // card detail. With checklistId it returns that checklist plus, for a top-level checklist, the
  // sub-checklists owned by its items, so one call yields everything needed to edit that tree.
  app.get("/cards/:id/checklists", async (req) => {
    const { id } = req.params as { id: string };
    const query = dto.listCardChecklistsQuery.parse(req.query);
    const [card] = await db.select({ id: cards.id, boardId: cards.boardId }).from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card);
    const checklists = await loadChecklistsForCard(id);
    if (!query.checklistId) return { checklists };
    const focused = checklists.find((checklist) => checklist.id === query.checklistId);
    if (!focused) throw notFound("checklist not found");
    const ownedItemIds = new Set(focused.items.map((item) => item.id));
    return {
      checklists: [focused, ...checklists.filter((checklist) => checklist.parentItemId !== null && ownedItemIds.has(checklist.parentItemId))],
    };
  });

  app.post("/cards/:id/checklists", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.createChecklistBody.parse(req.body);
    const { card, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(card);
    const result = await createChecklist({ actorId: req.auth.sub, card, ctx, body });
    await emitCreatedChecklist(result);
    return reply.status(201).send({ ...result.created, subChecklists: result.trees.flatMap((tree) => tree.subChecklists) });
  });

  app.post("/cards/:id/checklist-templates/apply", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.applyChecklistTemplatesBody.parse(req.body);
    const { card, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(card);
    const result = await applyChecklistTemplatesToCard({ actorId: req.auth.sub, card, ctx, templateIds: body.templateIds });
    await emitAppliedChecklistTemplates(result);
    return {
      checklists: result.applied.map((applied) => applied.checklist),
      skippedTemplateIds: result.skippedTemplateIds,
    };
  });

  app.patch("/cards/:id/checklists/:checklistId", async (req) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.updateChecklistBody.parse(req.body);
    const { card, ctx, checklist: current } = await loadEditableChecklist(req.auth, id, checklistId);
    const { checklist, activity } = await renameChecklist({ actorId: req.auth.sub, card, ctx, current, title: body.title });
    if (activity) {
      await emitCoalescedCardActivityFeedItem(card.boardId, id, activity);
      await emitToBoard(card.boardId, SERVER_EVENTS.CARD_CHECKLIST_UPDATED, { boardId: card.boardId, cardId: id, checklist });
    }
    return checklist;
  });

  app.delete("/cards/:id/checklists/:checklistId", async (req, reply) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const { card, ctx, checklist: current } = await loadEditableChecklist(req.auth, id, checklistId);
    const result = await deleteChecklist({ actorId: req.auth.sub, card, ctx, current });
    await emitDeletedChecklist(result);
    return reply.status(204).send();
  });

  app.post("/cards/:id/checklists/:checklistId/move", async (req) => {
    const { id, checklistId } = req.params as { id: string; checklistId: string };
    const body = dto.moveChecklistBody.parse(req.body);
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    const current = await loadChecklistForCard(id, checklistId);
    if (!current) throw notFound("checklist not found");
    const result = await moveChecklist({ card, current, body });
    await emitChecklistMove(result);
    return { id: checklistId, position: result.position };
  });
}
