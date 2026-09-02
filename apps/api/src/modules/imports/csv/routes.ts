import { dto } from "@kanera/shared";
import type { CsvColumnMapping } from "@kanera/shared/dto";
import { CSV_PREVIEW_ROWS, MAX_CSV_IMPORT_BYTES } from "@kanera/shared/dto";
import { csvImports } from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../../db.js";
import { assertWorkspaceAccess } from "../../../lib/access.js";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { getStorageForClient } from "../../../lib/storage/index.js";
import { runKaneraBoardImport } from "../kanera-importer.js";
import { emitImportResult, finishImportAnalytics } from "../route-helpers.js";
import { resolveImportTargetBoard } from "../target-board.js";
import { deriveCsvImport } from "./derive.js";
import { detectHeaderRow, parseCsv, type CsvSource } from "./parse.js";
import { suggestColumnMapping } from "./suggest.js";

export async function csvImportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/imports/csv/analyze", async (req, reply) => {
    const { id: workspaceId } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    await resolveImportTargetBoard(workspaceId);
    const file = await req.file({ limits: { fileSize: MAX_CSV_IMPORT_BYTES, files: 1 } });
    if (!file) throw badRequest("upload a CSV file");
    const buffer = await file.toBuffer();
    const source = parseCsv(buffer);
    const hasHeaderRow = detectHeaderRow(source.rows);
    const suggestedMapping = suggestColumnMapping(source.rows, hasHeaderRow);
    const now = new Date();
    const derived = deriveCsvImport(source, suggestedMapping, {
      actorId: req.auth.sub,
      workspaceId,
      fileName: file.filename,
      now,
    });
    const importId = crypto.randomUUID();
    const sourceFileKey = `imports/csv/${importId}/source.csv`;
    const storage = await getStorageForClient(req.auth.cid);
    await storage.put(sourceFileKey, buffer, file.mimetype || "text/csv");

    await db.insert(csvImports).values({
      id: importId,
      workspaceId,
      clientId: req.auth.cid,
      createdById: req.auth.sub,
      status: "analyzed",
      sourceFileKey,
      sourceFileName: file.filename,
      manifest: derived.manifest,
      source,
      columnMapping: null,
      createdAt: now,
      updatedAt: now,
    });

    const sampleRows = hasHeaderRow ? source.rows.slice(1) : source.rows;
    const columns = Array.from({ length: source.columnCount }, (_, index) => ({
      index,
      name: hasHeaderRow ? source.rows[0]?.[index] ?? `Column ${index + 1}` : `Column ${index + 1}`,
      samples: sampleRows.map((row) => row[index]?.trim() ?? "").filter(Boolean).slice(0, 3),
    }));
    return reply.status(201).send({
      importId,
      preview: {
        columns,
        firstRows: source.rows.slice(0, CSV_PREVIEW_ROWS),
        rowCount: sampleRows.length,
        delimiter: source.delimiter,
        encoding: source.encoding,
        suggestedMapping,
      },
      manifest: derived.manifest,
      issues: derived.issues,
    });
  });

  app.post("/imports/csv/:importId/columns", async (req) => {
    const { importId } = req.params as { importId: string };
    const mapping = dto.csvColumnMapping.parse(req.body);
    const [row] = await db.select().from(csvImports).where(eq(csvImports.id, importId)).limit(1);
    if (!row) throw notFound("import not found");
    await assertWorkspaceAccess(req.auth, row.workspaceId, "admin");
    if (!["analyzed", "ready", "failed"].includes(row.status)) throw conflict("import columns cannot be changed now");

    const derived = deriveCsvImport(row.source as CsvSource, mapping, {
      actorId: req.auth.sub,
      workspaceId: row.workspaceId,
      fileName: row.sourceFileName,
      now: row.createdAt,
    });
    if (mapping.dateOrder === "auto" && derived.issues.ambiguousDateColumns.length > 0) {
      throw badRequest("choose a day/month order for ambiguous dates");
    }
    await db.update(csvImports).set({
      columnMapping: mapping,
      manifest: derived.manifest,
      status: "ready",
      error: null,
      updatedAt: new Date(),
    }).where(eq(csvImports.id, importId));
    return { manifest: derived.manifest, issues: derived.issues };
  });

  app.post("/imports/csv/:importId/commit", async (req) => {
    const { importId } = req.params as { importId: string };
    const body = dto.commitImportBody.parse(req.body);
    // Only the access check needs the row here; the guarded update below returns the full row
    // (including the parsed `source` jsonb), so avoid reading that blob twice per commit.
    const [current] = await db.select({ workspaceId: csvImports.workspaceId }).from(csvImports).where(eq(csvImports.id, importId)).limit(1);
    if (!current) throw notFound("import not found");
    await assertWorkspaceAccess(req.auth, current.workspaceId, "admin");
    const targetBoardId = await resolveImportTargetBoard(current.workspaceId);

    const [row] = await db.update(csvImports)
      .set({ status: "importing", mappings: body, error: null, updatedAt: new Date() })
      .where(and(eq(csvImports.id, importId), inArray(csvImports.status, ["ready", "failed"])))
      .returning();
    if (!row || !row.columnMapping) throw conflict("import is not ready to commit");

    try {
      const mapping = dto.csvColumnMapping.parse(row.columnMapping) as CsvColumnMapping;
      const derived = deriveCsvImport(row.source as CsvSource, mapping, {
        actorId: req.auth.sub,
        workspaceId: row.workspaceId,
        fileName: row.sourceFileName,
        // Stable injected time keeps every synthetic source id and timestamp identical to mapping.
        now: row.createdAt,
      });
      const storage = await getStorageForClient(req.auth.cid);
      const result = await db.transaction((tx) => runKaneraBoardImport(tx, {
        source: derived.archive,
        body,
        workspaceId: row.workspaceId,
        clientId: req.auth.cid,
        actorId: req.auth.sub,
        targetBoardId,
        storage,
        sourceLabel: "csv",
      }));
      await db.update(csvImports).set({
        status: "completed",
        result: result.summary,
        mappings: body,
        error: null,
        updatedAt: new Date(),
      }).where(eq(csvImports.id, importId));
      await emitImportResult(result, row.workspaceId, targetBoardId);
      await finishImportAnalytics(req, row.workspaceId, "csv");
      return result.summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "import failed";
      await db.update(csvImports).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(csvImports.id, importId));
      throw error;
    }
  });
}
