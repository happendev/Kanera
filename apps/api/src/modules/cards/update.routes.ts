import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { assertWorkspaceFeature } from "../../lib/workspace-features.js";
import type { FastifyInstance } from "fastify";
import { assertBoardAccess, assertWorkspaceAccess } from "../../lib/access.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { emitToBoard } from "../../realtime/emit.js";
import { toWireCard } from "../../lib/wire-card.js";
import { assertCardActive, assertIntegrationEmbeddedMediaStoredLocally } from "../../lib/card-guards.js";
import { emitCardActivityFeedItem, loadEditableCard, emitCardLabels, emitCardAssignees, emitCardCompletion } from "./route-support.js";
import { emitUpdatedCard, updateCard } from "./update-card.js";
import { setCardCompletion, setListCardsCompletion } from "./card-completion.js";
import { setCardInProgressTime } from "./card-in-progress-time.js";
import { archiveCard, emitArchivedCard } from "./archive-card.js";
import { setCardLabels } from "./card-labels.js";
import { setCardAssignees } from "./card-assignees.js";

/**
 * Single-card field writes: title/description/dates, completion, in-progress time, archive, labels
 * and assignees. Called from `cardRoutes` rather than registered on its own, so these routes share
 * its `app.authenticate` preHandler.
 */
export function cardUpdateRoutes(app: FastifyInstance) {
  app.post("/boards/:boardId/lists/:id/cards/completion", async (req) => {
    const { boardId, id: listId } = req.params as { boardId: string; id: string };
    const body = dto.setCardCompletionBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const updates = await setListCardsCompletion({ auth: req.auth, ctx, boardId, listId, completed: body.completed });
    if (updates.length === 0) return { updated: 0 };
    await emitCardCompletion(updates, { clientId: req.auth.cid, completed: body.completed, mailer: app.mailer, log: req.log });
    return { updated: updates.length };
  });

  // Workspace admins correct a card's tracked time in progress (a card that sat in an In progress
  // list over a holiday, or work done before the list was flagged). The value is the total as of
  // now. Reductions below the alert restart the running stint and rearm its notification and
  // automations. Other corrections keep the start when they cover the running time; a total
  // below what the running stint already tracked restarts it instead. Only the clock columns are written, so the card trigger does not
  // fire. The audit entry is feed-only: a correction is not news for assignees or watchers.
  app.put("/cards/:id/in-progress-time", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setInProgressTimeBody.parse(req.body);
    const { card: current, ctx } = await loadEditableCard(req.auth, id);
    await assertWorkspaceAccess(req.auth, ctx.workspaceId, "admin");
    assertCardActive(current);
    const { card, activity } = await setCardInProgressTime({ auth: req.auth, card: current, ctx, seconds: body.seconds });
    const wireCard = toWireCard(card, req.auth.cid);
    await emitToBoard(current.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: current.boardId, card: wireCard });
    await emitCardActivityFeedItem(current.boardId, id, activity, { notify: false });
    return wireCard;
  });

  app.patch("/cards/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateCardBody.parse(req.body);
    const { card: loaded, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(loaded);
    // Setting a start needs the timeline; clearing one is always allowed (a due date moved before a
    // hidden start still drags it along, so the stored range stays valid for re-enabling).
    if (body.startDateLocalDate) await assertWorkspaceFeature(ctx.workspaceId, "timeline");
    assertIntegrationEmbeddedMediaStoredLocally(body.description, req.auth.cid, req.auth.authKind);
    const result = await updateCard({ auth: req.auth, card: loaded, ctx, body });
    return emitUpdatedCard(result, { auth: req.auth, mailer: app.mailer });
  });

  app.patch("/cards/:id/completion", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setCardCompletionBody.parse(req.body);
    const { card: current, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(current);
    if (body.completed === Boolean(current.completedAt)) {
      return toWireCard(current, req.auth.cid);
    }
    const { write, card } = await setCardCompletion({ auth: req.auth, card: current, ctx, completed: body.completed });
    if (!write) return toWireCard(card, req.auth.cid);
    await emitCardCompletion([write], { clientId: req.auth.cid, completed: body.completed, mailer: app.mailer, log: req.log });
    if (body.completed) await evaluateWorkspaceAnalyticsMilestones({
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      supportSession: req.auth.authKind === "support" || req.auth.authKind === "apiKey",
    });
    return toWireCard(card, req.auth.cid);
  });

  app.patch("/cards/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setCardArchivedBody.parse(req.body);
    const { card, ctx } = await loadEditableCard(req.auth, id);
    if (body.archived === Boolean(card.archivedAt)) {
      return toWireCard(card, req.auth.cid);
    }
    const result = await archiveCard({ auth: req.auth, card, ctx, archived: body.archived });
    return emitArchivedCard(result, { card, auth: req.auth, mailer: app.mailer, log: req.log });
  });

  app.put("/cards/:id/labels", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setCardLabelsBody.parse(req.body);
    const { card, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(card);
    const { update, finalLabelIds } = await setCardLabels({ auth: req.auth, card, ctx, labelIds: body.labelIds });
    await emitCardLabels([update]);
    return { labelIds: finalLabelIds };
  });

  app.put("/cards/:id/assignees", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.setCardAssigneesBody.parse(req.body);
    const nextUserIds = Array.from(new Set(body.userIds));
    const { card, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(card);
    const update = await setCardAssignees({ auth: req.auth, card, ctx, nextUserIds });
    await emitCardAssignees([update], app.mailer, req.auth.sub);
    return { assigneeIds: update.assigneeIds };
  });
}
