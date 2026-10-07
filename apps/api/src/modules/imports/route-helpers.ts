import { users } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { userAcceptsEmail } from "../../lib/lifecycle-emails.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { ANALYTICS_EVENT_VERSION, productAnalytics } from "../../lib/product-analytics.js";
import { emitToBoard, emitToBoardAudience, emitToWorkspace } from "../../realtime/emit.js";
import type { TrelloImportResult } from "./importer.js";
import type { KaneraBoardImportResult } from "./kanera-importer.js";

type ImportResult = TrelloImportResult | KaneraBoardImportResult;

export async function emitImportResult(result: ImportResult, workspaceId: string, targetBoardId: string | null): Promise<void> {
  // Import replay publishes parents before dependent cards so durable webhook/outbox consumers can
  // rebuild a board without observing child rows before their workspace-scoped configuration.
  if (!targetBoardId) {
    await emitToBoardAudience(result.board.id, "board:created", { workspaceId, board: result.board }, { workspaceId });
  }
  for (const list of result.createdLists) await emitToWorkspace(workspaceId, "list:created", { workspaceId, list });
  for (const cardLabel of result.createdLabels) await emitToWorkspace(workspaceId, "cardLabel:created", { workspaceId, cardLabel });
  for (const customField of result.createdCustomFields) await emitToWorkspace(workspaceId, "customField:created", { workspaceId, customField });
  for (const card of result.events.cardsCreated) await emitToBoard(result.board.id, "card:created", { boardId: result.board.id, card });
  for (const { cardId, labelIds } of result.events.labelsSet) await emitToBoard(result.board.id, "card:labels:set", { boardId: result.board.id, cardId, labelIds });
  for (const { cardId, assigneeIds } of result.events.assigneesSet) await emitToBoard(result.board.id, "card:assignees:set", { boardId: result.board.id, cardId, assigneeIds });
  for (const value of result.events.customFieldValuesSet) await emitToBoard(result.board.id, "card:customFieldValue:set", { boardId: result.board.id, ...value });
  for (const { cardId, checklist } of result.events.checklistsCreated) await emitToBoard(result.board.id, "card:checklist:created", { boardId: result.board.id, cardId, checklist });
  const importedCardById = new Map(result.events.cardsCreated.map((card) => [card.id, card]));
  for (const { cardId, checklistId, checklistParentItemId, item } of result.events.checklistItemsCreated) await emitToBoard(result.board.id, "card:checklistItem:created", { boardId: result.board.id, cardId, cardTitle: importedCardById.get(cardId)?.title ?? "", listId: importedCardById.get(cardId)?.listId ?? "", checklistId, checklistParentItemId, item });
  for (const { cardId, comment } of result.events.commentsCreated) await emitToBoard(result.board.id, "comment:created", { boardId: result.board.id, cardId, comment });
  for (const { cardId, item } of result.events.commentsCreated) await emitToBoard(result.board.id, "card:feedItem:created", { boardId: result.board.id, cardId, item });
  for (const { cardId, item } of result.events.activityFeedItemsCreated) await emitToBoard(result.board.id, "card:feedItem:created", { boardId: result.board.id, cardId, item });
  for (const { cardId, attachment } of result.events.attachmentsCreated) await emitToBoard(result.board.id, "card:attachment:created", { boardId: result.board.id, cardId, attachment });
  const reactions = "reactionsAdded" in result.events ? result.events.reactionsAdded : [];
  for (const { cardId, commentId, type, user } of reactions) await emitToBoard(result.board.id, "comment:reaction:added", { boardId: result.board.id, cardId, commentId, type, user });
  for (const card of result.events.cardsUpdated) await emitToBoard(result.board.id, "card:updated", { boardId: result.board.id, card });
}

export async function finishImportAnalytics(req: FastifyRequest, workspaceId: string, category: "trello" | "kanera" | "csv"): Promise<void> {
  const supportSession = req.auth.authKind === "support";
  void productAnalytics.capture({
    event: "board_imported",
    distinctId: req.auth.sub,
    organizationId: req.auth.cid,
    supportSession,
    properties: {
      user_id: req.auth.sub,
      workspace_id: workspaceId,
      import_source_category: category,
      event_version: ANALYTICS_EVENT_VERSION,
    },
  });
  await evaluateWorkspaceAnalyticsMilestones({ workspaceId, actorId: req.auth.sub, supportSession });
}

/**
 * Migration support: confirms by email what transferred, so the importer can check it against the
 * source before retiring the old tool. Sent to the person who ran the import, never during a support
 * session (the customer did not start it). Best-effort: it runs inside the commit handler's try, and
 * a mail failure must not flip a completed import to failed.
 */
export async function sendImportCompletedEmail(req: FastifyRequest, result: ImportResult, source: "trello" | "kanera" | "csv"): Promise<void> {
  if (req.auth.authKind === "support") return;
  try {
    if (!await userAcceptsEmail(req.auth.sub)) return;
    const [user] = await db.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
    if (!user) return;
    const { summary } = result;
    await req.server.mailer.sendImportCompleted(user.email, {
      displayName: user.displayName,
      source,
      boardName: result.board.name,
      boardUrl: `${env.WEB_ORIGIN}/b/${result.board.id}`,
      // Lists are workspace-scoped, so an import may map onto lists that already existed.
      lists: summary.lists.created + summary.lists.reused,
      cards: summary.cards.created,
      checklistItems: summary.checklistItems,
      comments: summary.comments,
      attachmentsImported: summary.attachments.imported,
      attachmentsSkipped: summary.attachments.skipped,
      warningCount: summary.warnings.length,
    });
  } catch (err) {
    req.log.warn({ err }, "failed to queue import completed email");
  }
}
