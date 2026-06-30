import { kaneraBoardImports, trelloImports } from "@kanera/shared/schema";
import { lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { getStorageForClient } from "./storage/index.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1,440 minutes
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 10,080 minutes

export interface ImportCleanupDeps {
  db: Db;
  log: FastifyBaseLogger;
}

type ImportSourceFile = {
  id: string;
  clientId: string;
  sourceFileKey: string;
};

async function deleteImportSourceFiles(rows: ImportSourceFile[], log: FastifyBaseLogger) {
  const keysByClient = new Map<string, string[]>();
  for (const row of rows) {
    const keys = keysByClient.get(row.clientId) ?? [];
    keys.push(row.sourceFileKey);
    keysByClient.set(row.clientId, keys);
  }

  for (const [clientId, keys] of keysByClient) {
    const storage = await getStorageForClient(clientId);
    for (const key of keys) {
      try {
        await storage.delete(key);
      } catch (err) {
        // The DB row is already gone, so a storage failure can only leave an orphaned
        // source upload. Log it for operators without blocking cleanup of other tenants.
        log.warn({ err, clientId, sourceFileKey: key }, "failed to delete old import source file");
      }
    }
  }
}

export async function runImportCleanup({ db, log }: ImportCleanupDeps, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  const [trelloRows, kaneraRows] = await db.transaction(async (tx) => {
    const deletedTrello = await tx
      .delete(trelloImports)
      .where(lt(trelloImports.createdAt, cutoff))
      .returning({ id: trelloImports.id, clientId: trelloImports.clientId, sourceFileKey: trelloImports.sourceFileKey });
    const deletedKanera = await tx
      .delete(kaneraBoardImports)
      .where(lt(kaneraBoardImports.createdAt, cutoff))
      .returning({ id: kaneraBoardImports.id, clientId: kaneraBoardImports.clientId, sourceFileKey: kaneraBoardImports.sourceFileKey });
    return [deletedTrello, deletedKanera] as const;
  });

  const rows = [...trelloRows, ...kaneraRows];
  if (rows.length === 0) return 0;
  await deleteImportSourceFiles(rows, log);
  log.info({ deletedCount: rows.length }, "purged import sessions past retention");
  return rows.length;
}

export function startImportCleanupScheduler(deps: ImportCleanupDeps): () => void {
  return startSweepScheduler({
    name: "import-cleanup",
    task: () => runImportCleanup(deps),
    nextDelayMs: CLEANUP_INTERVAL_MS,
    log: deps.log,
  }).stop;
}
