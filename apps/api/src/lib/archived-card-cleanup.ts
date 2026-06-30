import { boards, cards, workspaces } from "@kanera/shared/schema";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { collectAttachmentFileKeys, deleteStorageFiles } from "./attachment-cleanup.js";
import { getStorageForClient } from "./storage/index.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1,440 minutes
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 43,200 minutes

export interface ArchivedCardCleanupDeps {
  db: Db;
  log: FastifyBaseLogger;
}

export async function runArchivedCardCleanup({ db, log }: ArchivedCardCleanupDeps, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  const rows = await db
    .select({ id: cards.id, clientId: workspaces.clientId })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(isNotNull(cards.archivedAt), lt(cards.archivedAt, cutoff)));

  if (rows.length === 0) return 0;

  // Capture storage keys before deleting any rows: cardAttachments cascade-delete with their
  // card, so the file-key metadata is only available pre-delete. Group by client because
  // storage is client-scoped.
  const cardIdsByClient = new Map<string, string[]>();
  for (const row of rows) {
    const ids = cardIdsByClient.get(row.clientId) ?? [];
    ids.push(row.id);
    cardIdsByClient.set(row.clientId, ids);
  }
  const fileKeysByClient = new Map<string, string[]>();
  for (const [clientId, cardIds] of cardIdsByClient) {
    fileKeysByClient.set(clientId, await collectAttachmentFileKeys(cardIds));
  }

  // Delete DB rows first (atomically), THEN storage. Ordering matters: if we deleted files
  // first and crashed before the row delete, surviving rows would point at missing files.
  // With rows gone first, a crash before storage cleanup only leaks orphaned objects, which
  // is strictly safer than a dangling reference. Delete by the captured ids so a card archived
  // between the select and the delete isn't swept without its keys collected.
  const cardIds = rows.map((row) => row.id);
  await db.transaction(async (tx) => {
    await tx.delete(cards).where(inArray(cards.id, cardIds));
  });

  for (const [clientId, keys] of fileKeysByClient) {
    if (keys.length === 0) continue;
    const storage = await getStorageForClient(clientId);
    await deleteStorageFiles(storage, keys);
  }

  log.info({ deletedCount: rows.length }, "purged archived cards past retention");
  return rows.length;
}

export function startArchivedCardCleanupScheduler(deps: ArchivedCardCleanupDeps): () => void {
  return startSweepScheduler({
    name: "archived-card-cleanup",
    task: () => runArchivedCardCleanup(deps),
    nextDelayMs: CLEANUP_INTERVAL_MS,
    log: deps.log,
  }).stop;
}
