import { dto } from "@kanera/shared";
import type { BoardExportArchive } from "@kanera/shared/dto";
import { MAX_KANERA_BOARD_IMPORT_BYTES, MAX_TRELLO_IMPORT_BYTES } from "@kanera/shared/dto";
import { boards, kaneraBoardImports, trelloImports, workspaces } from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { getUploadEntitlements } from "../../lib/entitlements.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { ANALYTICS_EVENT_VERSION, productAnalytics } from "../../lib/product-analytics.js";
import { emitToBoard, emitToBoardAudience, emitToWorkspace } from "../../realtime/emit.js";
import { runTrelloImport } from "./importer.js";
import { runKaneraBoardImport } from "./kanera-importer.js";
import { parseKaneraBoardExport } from "./kanera-parser.js";
import { parseTrelloExport } from "./parser.js";
import type { NormalizedTrelloBoard } from "./types.js";

function jsonErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid JSON";
}

async function resolveImportTargetBoard(workspaceId: string): Promise<string | null> {
  const [workspace] = await db.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (workspace?.kind !== "board") return null;

  const rows = await db.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, workspaceId));
  // A standalone import appends into its one visible board. Checking the route-level invariant here
  // prevents a damaged hidden workspace from making an arbitrary board the import destination.
  if (rows.length !== 1) throw badRequest("standalone board configuration must contain exactly one board");
  return rows[0]!.id;
}

export async function importRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/imports/trello/auth-config", async () => ({
    enabled: !!env.TRELLO_API_KEY,
    ...(env.TRELLO_API_KEY ? { apiKey: env.TRELLO_API_KEY } : {}),
  }));

  app.get("/imports/:importId/status", async (req) => {
    const { importId } = req.params as { importId: string };
    const [row] = await db.select().from(trelloImports).where(eq(trelloImports.id, importId)).limit(1);
    if (!row) throw notFound("import not found");
    await assertWorkspaceAccess(req.auth, row.workspaceId, "admin");

    const progress = dto.importAttachmentProgress.safeParse(row.result);
    const result = dto.importResultSummary.safeParse(row.result);
    return {
      status: row.status,
      error: row.error,
      progress: progress.success ? progress.data : null,
      result: result.success ? result.data : null,
    };
  });

  app.post("/workspaces/:id/imports/trello/analyze", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await resolveImportTargetBoard(workspaceId);
    // Fastify rejects duplicate multipart parser registration across the app
    // encapsulation tree, so the import route raises only this file read's limit.
    const file = await req.file({ limits: { fileSize: MAX_TRELLO_IMPORT_BYTES, files: 1 } });
    if (!file) throw badRequest("upload a Trello JSON export");
    const buf = await file.toBuffer();
    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString("utf8"));
    } catch (error) {
      throw badRequest(`could not parse Trello JSON: ${jsonErrorMessage(error)}`);
    }
    const parsed = parseTrelloExport(raw);
    if (parsed.manifest.lists.length === 0) throw badRequest("Trello export did not contain any lists");

    const importId = crypto.randomUUID();
    const sourceFileKey = `imports/${importId}/source.json`;
    const storage = await getStorageForClient(req.auth.cid);
    await storage.put(sourceFileKey, buf, "application/json");

    await db.insert(trelloImports).values({
      id: importId,
      workspaceId,
      clientId: req.auth.cid,
      createdById: req.auth.sub,
      status: "ready",
      sourceFileKey,
      sourceFileName: file.filename,
      manifest: parsed.manifest,
      source: parsed.source,
    });

    return reply.status(201).send({ importId, manifest: parsed.manifest });
  });

  app.post("/workspaces/:id/imports/kanera-board/analyze", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await resolveImportTargetBoard(workspaceId);
    const file = await req.file({ limits: { fileSize: MAX_KANERA_BOARD_IMPORT_BYTES, files: 1 } });
    if (!file) throw badRequest("upload a Kanera board JSON export");
    const buf = await file.toBuffer();
    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString("utf8"));
    } catch (error) {
      throw badRequest(`could not parse Kanera JSON: ${jsonErrorMessage(error)}`);
    }
    const parsed = parseKaneraBoardExport(raw);
    if (parsed.manifest.lists.length === 0) throw badRequest("Kanera export did not contain any lists");

    const importId = crypto.randomUUID();
    const sourceFileKey = `imports/kanera-board/${importId}/source.json`;
    const storage = await getStorageForClient(req.auth.cid);
    await storage.put(sourceFileKey, buf, "application/json");

    await db.insert(kaneraBoardImports).values({
      id: importId,
      workspaceId,
      clientId: req.auth.cid,
      createdById: req.auth.sub,
      status: "ready",
      sourceFileKey,
      sourceFileName: file.filename,
      manifest: parsed.manifest,
      source: parsed.source,
    });

    return reply.status(201).send({ importId, manifest: parsed.manifest });
  });

  app.post("/imports/:importId/commit", async (req) => {
    const { importId } = req.params as { importId: string };
    const body = dto.commitImportBody.parse(req.body);
    const [current] = await db.select().from(trelloImports).where(eq(trelloImports.id, importId)).limit(1);
    if (!current) throw notFound("import not found");
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const targetBoardId = await resolveImportTargetBoard(current.workspaceId);

    const [row] = await db.update(trelloImports)
      .set({ status: "importing", mappings: body, error: null, updatedAt: new Date() })
      .where(and(eq(trelloImports.id, importId), inArray(trelloImports.status, ["ready", "failed"])))
      .returning();
    if (!row) throw conflict("import is not ready to commit");

    try {
      // Trello tokens are transient import credentials: accept them only on the commit request and
      // never persist them in the import mappings/source/result rows.
      const trelloToken = typeof req.headers["x-trello-token"] === "string" ? req.headers["x-trello-token"] : null;
      const storage = await getStorageForClient(req.auth.cid);
      const uploadEntitlements = await getUploadEntitlements(db, req.auth.cid);
      const result = await db.transaction((tx) =>
        runTrelloImport(tx, {
          source: row.source as NormalizedTrelloBoard,
          body,
          workspaceId: row.workspaceId,
          clientId: req.auth.cid,
          actorId: req.auth.sub,
          actorTimezone: "UTC",
          targetBoardId,
          storage,
          trelloApiKey: env.TRELLO_API_KEY ?? null,
          trelloToken,
          uploadEntitlements,
          onAttachmentProgress: async (progress) => {
            await db.update(trelloImports)
              .set({ result: progress, updatedAt: new Date() })
              .where(eq(trelloImports.id, importId));
          },
        })
      );
      await db.update(trelloImports)
        .set({ status: "completed", result: result.summary, mappings: body, error: null, updatedAt: new Date() })
        .where(eq(trelloImports.id, importId));

      // Import replay publishes parents before dependent cards so durable webhook/outbox
      // consumers can rebuild a board without seeing child rows before their workspace data.
      if (!targetBoardId) {
        await emitToBoardAudience(result.board.id, "board:created", { workspaceId: row.workspaceId, board: result.board }, { workspaceId: row.workspaceId });
      }
      for (const list of result.createdLists) await emitToWorkspace(row.workspaceId, "list:created", { workspaceId: row.workspaceId, list });
      for (const cardLabel of result.createdLabels) await emitToWorkspace(row.workspaceId, "cardLabel:created", { workspaceId: row.workspaceId, cardLabel });
      for (const customField of result.createdCustomFields) await emitToWorkspace(row.workspaceId, "customField:created", { workspaceId: row.workspaceId, customField });
      for (const card of result.events.cardsCreated) await emitToBoard(result.board.id, "card:created", { boardId: result.board.id, card });
      for (const { cardId, labelIds } of result.events.labelsSet) await emitToBoard(result.board.id, "card:labels:set", { boardId: result.board.id, cardId, labelIds });
      for (const { cardId, assigneeIds } of result.events.assigneesSet) await emitToBoard(result.board.id, "card:assignees:set", { boardId: result.board.id, cardId, assigneeIds });
      for (const value of result.events.customFieldValuesSet) await emitToBoard(result.board.id, "card:customFieldValue:set", { boardId: result.board.id, ...value });
      for (const { cardId, checklist } of result.events.checklistsCreated) await emitToBoard(result.board.id, "card:checklist:created", { boardId: result.board.id, cardId, checklist });
      // Checklist-item created events carry the parent card title + list so assignee-centric
      // consumers (assigned-work) can render a work item without a follow-up fetch.
      const importedCardById = new Map(result.events.cardsCreated.map((card) => [card.id, card]));
      for (const { cardId, checklistId, checklistParentItemId, item } of result.events.checklistItemsCreated) await emitToBoard(result.board.id, "card:checklistItem:created", { boardId: result.board.id, cardId, cardTitle: importedCardById.get(cardId)?.title ?? "", listId: importedCardById.get(cardId)?.listId ?? "", checklistId, checklistParentItemId, item });
      for (const { cardId, comment } of result.events.commentsCreated) await emitToBoard(result.board.id, "comment:created", { boardId: result.board.id, cardId, comment });
      for (const { cardId, item } of result.events.commentsCreated) await emitToBoard(result.board.id, "card:feedItem:created", { boardId: result.board.id, cardId, item });
      for (const { cardId, item } of result.events.activityFeedItemsCreated) await emitToBoard(result.board.id, "card:feedItem:created", { boardId: result.board.id, cardId, item });
      for (const { cardId, attachment } of result.events.attachmentsCreated) await emitToBoard(result.board.id, "card:attachment:created", { boardId: result.board.id, cardId, attachment });
      for (const card of result.events.cardsUpdated) await emitToBoard(result.board.id, "card:updated", { boardId: result.board.id, card });
      const supportSession = req.auth.authKind === "support";
      void productAnalytics.capture({
        event: "board_imported",
        distinctId: req.auth.sub,
        organizationId: req.auth.cid,
        supportSession,
        properties: {
          user_id: req.auth.sub,
          workspace_id: row.workspaceId,
          import_source_category: "trello",
          event_version: ANALYTICS_EVENT_VERSION,
        },
      });
      await evaluateWorkspaceAnalyticsMilestones({ workspaceId: row.workspaceId, actorId: req.auth.sub, supportSession });
      return result.summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "import failed";
      await db.update(trelloImports)
        .set({ status: "failed", error: message, updatedAt: new Date() })
        .where(eq(trelloImports.id, importId));
      throw error;
    }
  });

  app.post("/imports/kanera-board/:importId/commit", async (req) => {
    const { importId } = req.params as { importId: string };
    const body = dto.commitImportBody.parse(req.body);
    const [current] = await db.select().from(kaneraBoardImports).where(eq(kaneraBoardImports.id, importId)).limit(1);
    if (!current) throw notFound("import not found");
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const targetBoardId = await resolveImportTargetBoard(current.workspaceId);

    const [row] = await db.update(kaneraBoardImports)
      .set({ status: "importing", mappings: body, error: null, updatedAt: new Date() })
      .where(and(eq(kaneraBoardImports.id, importId), inArray(kaneraBoardImports.status, ["ready", "failed"])))
      .returning();
    if (!row) throw conflict("import is not ready to commit");

    try {
      const storage = await getStorageForClient(req.auth.cid);
      const result = await db.transaction((tx) =>
        runKaneraBoardImport(tx, {
          source: row.source as BoardExportArchive,
          body,
          workspaceId: row.workspaceId,
          clientId: req.auth.cid,
          actorId: req.auth.sub,
          targetBoardId,
          storage,
        })
      );
      await db.update(kaneraBoardImports)
        .set({ status: "completed", result: result.summary, mappings: body, error: null, updatedAt: new Date() })
        .where(eq(kaneraBoardImports.id, importId));

      // Import replay publishes parents before dependent cards so durable webhook/outbox
      // consumers can rebuild a board without seeing child rows before their workspace data.
      if (!targetBoardId) {
        await emitToBoardAudience(result.board.id, "board:created", { workspaceId: row.workspaceId, board: result.board }, { workspaceId: row.workspaceId });
      }
      for (const list of result.createdLists) await emitToWorkspace(row.workspaceId, "list:created", { workspaceId: row.workspaceId, list });
      for (const cardLabel of result.createdLabels) await emitToWorkspace(row.workspaceId, "cardLabel:created", { workspaceId: row.workspaceId, cardLabel });
      for (const customField of result.createdCustomFields) await emitToWorkspace(row.workspaceId, "customField:created", { workspaceId: row.workspaceId, customField });
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
      for (const { cardId, commentId, type, user } of result.events.reactionsAdded) await emitToBoard(result.board.id, "comment:reaction:added", { boardId: result.board.id, cardId, commentId, type, user });
      for (const card of result.events.cardsUpdated) await emitToBoard(result.board.id, "card:updated", { boardId: result.board.id, card });
      const supportSession = req.auth.authKind === "support";
      void productAnalytics.capture({
        event: "board_imported",
        distinctId: req.auth.sub,
        organizationId: req.auth.cid,
        supportSession,
        properties: {
          user_id: req.auth.sub,
          workspace_id: row.workspaceId,
          import_source_category: "kanera",
          event_version: ANALYTICS_EVENT_VERSION,
        },
      });
      await evaluateWorkspaceAnalyticsMilestones({ workspaceId: row.workspaceId, actorId: req.auth.sub, supportSession });
      return result.summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "import failed";
      await db.update(kaneraBoardImports)
        .set({ status: "failed", error: message, updatedAt: new Date() })
        .where(eq(kaneraBoardImports.id, importId));
      throw error;
    }
  });
}
