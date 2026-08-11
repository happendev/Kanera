import {
  activityEvents,
  boardInvitations,
  cardAttachments,
  cardKeyPrefixReservations,
  cards,
  clientGuestSeats,
  clientMembers,
  clients,
  comments,
  directRealtimeOutbox,
  emailQueue,
  githubAppInstallations,
  inviteTokens,
  kaneraBoardImports,
  noteAttachments,
  notes,
  notifications,
  oauthGrants,
  planActions,
  pushQueue,
  pushSubscriptions,
  scratchpadNotes,
  standaloneBoardGroups,
  trelloImports,
  workspaceApiKeys,
  workspaces,
  workViews,
} from "@kanera/shared/schema";
import { and, asc, eq, isNotNull, isNull, like, ne, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, pool } from "../db.js";
import { cancelBillingForPermanentDeletion } from "./billing.js";
import { parseMediaReference, unsignedMediaUrl } from "./media-keys.js";
import { getStorageForClient } from "./storage/index.js";
import type { StorageProvider } from "./storage/types.js";
import { startSweepScheduler } from "./sweep-scheduler.js";
import { sendOpsAlert } from "./ops-alerts.js";

const PURGE_INTERVAL_MS = 30_000;
const STUCK_DELETION_MS = 15 * 60_000;

type StoredFile = { key: string; contentType: string };

async function copyStoredFiles(source: StorageProvider, target: StorageProvider, files: StoredFile[]) {
  for (const file of files) {
    await target.put(file.key, await source.get(file.key), file.contentType);
  }
}

async function relocateCrossOrganisationAttachments(clientId: string, source: StorageProvider) {
  const mediaPattern = `%/api/media/${clientId}/%`;
  const [cardRows, noteRows] = await Promise.all([
    db.select({
      id: cardAttachments.id,
      cardId: cardAttachments.cardId,
      targetClientId: cardAttachments.clientId,
      mimeType: cardAttachments.mimeType,
      fileKey: cardAttachments.fileKey,
      url: cardAttachments.url,
      thumbnailFileKey: cardAttachments.thumbnailFileKey,
      coverImageFileKey: cardAttachments.coverImageFileKey,
    }).from(cardAttachments)
      .innerJoin(clients, eq(clients.id, cardAttachments.clientId))
      .where(and(ne(cardAttachments.clientId, clientId), isNull(clients.deletedAt), like(cardAttachments.url, mediaPattern))),
    db.select({
      id: noteAttachments.id,
      noteId: noteAttachments.noteId,
      targetClientId: noteAttachments.clientId,
      mimeType: noteAttachments.mimeType,
      fileKey: noteAttachments.fileKey,
      url: noteAttachments.url,
    }).from(noteAttachments)
      .innerJoin(clients, eq(clients.id, noteAttachments.clientId))
      .where(and(ne(noteAttachments.clientId, clientId), isNull(clients.deletedAt), like(noteAttachments.url, mediaPattern))),
  ]);

  const cardMigrations: Array<(typeof cardRows)[number] & { nextUrl: string; nextThumbnailUrl: string | null; nextCoverImageUrl: string | null }> = [];
  for (const row of cardRows) {
    const reference = parseMediaReference(row.url, clientId);
    if (!reference) continue;
    const target = await getStorageForClient(row.targetClientId);
    await copyStoredFiles(source, target, [
      { key: row.fileKey, contentType: row.mimeType },
      ...(row.thumbnailFileKey ? [{ key: row.thumbnailFileKey, contentType: "application/octet-stream" }] : []),
      ...(row.coverImageFileKey ? [{ key: row.coverImageFileKey, contentType: "application/octet-stream" }] : []),
    ]);
    cardMigrations.push({
      ...row,
      nextUrl: unsignedMediaUrl(row.targetClientId, reference.key)!,
      nextThumbnailUrl: unsignedMediaUrl(row.targetClientId, row.thumbnailFileKey),
      nextCoverImageUrl: unsignedMediaUrl(row.targetClientId, row.coverImageFileKey),
    });
  }

  const noteMigrations: Array<(typeof noteRows)[number] & { nextUrl: string }> = [];
  for (const row of noteRows) {
    const reference = parseMediaReference(row.url, clientId);
    if (!reference) continue;
    const target = await getStorageForClient(row.targetClientId);
    await copyStoredFiles(source, target, [{ key: row.fileKey, contentType: row.mimeType }]);
    noteMigrations.push({ ...row, nextUrl: unsignedMediaUrl(row.targetClientId, reference.key)! });
  }

  if (cardMigrations.length === 0 && noteMigrations.length === 0) return;
  await db.transaction(async (tx) => {
    for (const migration of cardMigrations) {
      await tx.update(cardAttachments).set({
        url: migration.nextUrl,
        thumbnailUrl: migration.nextThumbnailUrl,
        coverImageUrl: migration.nextCoverImageUrl,
      }).where(eq(cardAttachments.id, migration.id));
      // Inline Markdown stores the same unsigned URL as the attachment row. Relocation is an
      // infrastructure change, so rewrite it without manufacturing user-edit timestamps/activity.
      await tx.update(cards).set({ description: sql`replace(${cards.description}, ${migration.url}, ${migration.nextUrl})` })
        .where(and(eq(cards.id, migration.cardId), isNotNull(cards.description)));
      await tx.update(comments).set({ body: sql`replace(${comments.body}, ${migration.url}, ${migration.nextUrl})` })
        .where(eq(comments.cardId, migration.cardId));
    }
    for (const migration of noteMigrations) {
      await tx.update(noteAttachments).set({ url: migration.nextUrl }).where(eq(noteAttachments.id, migration.id));
      await tx.update(notes).set({ content: sql`replace(${notes.content}, ${migration.url}, ${migration.nextUrl})` })
        .where(eq(notes.id, migration.noteId));
    }
  });
}

export async function purgeOrganisation(clientId: string, log: FastifyBaseLogger): Promise<boolean> {
  const connection = await pool.connect();
  const lockName = `organisation-purge:${clientId}`;
  try {
    const lock = await connection.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext($1)) as locked", [lockName]);
    if (!lock.rows[0]?.locked) return false;

    const [client] = await db.select({
      requestedAt: clients.permanentDeletionRequestedAt,
      completedAt: clients.permanentDeletionCompletedAt,
    }).from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!client?.requestedAt || client.completedAt) return false;

    await cancelBillingForPermanentDeletion(clientId);
    const storage = await getStorageForClient(clientId);
    await relocateCrossOrganisationAttachments(clientId, storage);

    // Purge the namespace before metadata so a provider failure remains retryable with the tenant's
    // encrypted storage configuration still present. A second pass below closes the in-flight upload
    // window after every write-capable database object has been removed.
    await storage.deleteAll();
    await db.transaction(async (tx) => {
      await tx.delete(oauthGrants).where(eq(oauthGrants.orgClientId, clientId));
      await tx.delete(workspaceApiKeys).where(eq(workspaceApiKeys.clientId, clientId));
      await tx.delete(workspaces).where(eq(workspaces.clientId, clientId));
      await tx.delete(boardInvitations).where(eq(boardInvitations.clientId, clientId));
      await tx.delete(activityEvents).where(eq(activityEvents.clientId, clientId));
      await tx.delete(kaneraBoardImports).where(eq(kaneraBoardImports.clientId, clientId));
      await tx.delete(trelloImports).where(eq(trelloImports.clientId, clientId));
      await tx.delete(standaloneBoardGroups).where(eq(standaloneBoardGroups.clientId, clientId));
      await tx.delete(githubAppInstallations).where(eq(githubAppInstallations.clientId, clientId));
      await tx.delete(pushQueue).where(eq(pushQueue.clientId, clientId));
      await tx.delete(inviteTokens).where(eq(inviteTokens.clientId, clientId));
      await tx.delete(planActions).where(eq(planActions.clientId, clientId));
      await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.clientId, clientId));
      await tx.delete(directRealtimeOutbox).where(eq(directRealtimeOutbox.clientId, clientId));
      // Billing/digest emails predate a first-class client_id column; their typed payload carries it.
      await tx.delete(emailQueue).where(sql`${emailQueue.data}->>'clientId' = ${clientId}`);
      await tx.delete(workViews).where(eq(workViews.clientId, clientId));
      await tx.delete(notifications).where(eq(notifications.clientId, clientId));
      await tx.delete(noteAttachments).where(eq(noteAttachments.clientId, clientId));
      // Scratchpad pages are user-private but organisation-scoped, so deleting an org deletes only
      // each member's scratchpad for this org. Attachment rows cascade from the note; their files live
      // in this tenant's namespace and are removed by `storage.deleteAll()` above. They are deliberately
      // absent from `relocateCrossOrganisationAttachments`: a scratchpad embed is always stored and
      // quota-accounted in its page's own org, never in a foreign tenant.
      await tx.delete(scratchpadNotes).where(eq(scratchpadNotes.clientId, clientId));
      await tx.delete(cardAttachments).where(eq(cardAttachments.clientId, clientId));
      await tx.delete(clientGuestSeats).where(eq(clientGuestSeats.clientId, clientId));
      await tx.delete(clientMembers).where(eq(clientMembers.clientId, clientId));
      await tx.delete(cardKeyPrefixReservations).where(eq(cardKeyPrefixReservations.clientId, clientId));
    });
    await storage.deleteAll();
    await db.update(clients).set({
      name: "Deleted organisation",
      logoUrl: null,
      storageConfig: null,
      smtpConfig: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionItemId: null,
      permanentDeletionCompletedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(clients.id, clientId), isNull(clients.permanentDeletionCompletedAt)));
    log.info({ clientId }, "permanently purged organisation data and storage");
    return true;
  } finally {
    await connection.query("select pg_advisory_unlock(hashtext($1))", [lockName]).catch(() => undefined);
    connection.release();
  }
}

export async function runOrganisationDeletionSweep(log: FastifyBaseLogger): Promise<number> {
  const pending = await db.select({ id: clients.id, requestedAt: clients.permanentDeletionRequestedAt })
    .from(clients)
    .where(and(isNotNull(clients.permanentDeletionRequestedAt), isNull(clients.permanentDeletionCompletedAt)))
    .orderBy(asc(clients.permanentDeletionRequestedAt))
    .limit(10);
  let purged = 0;
  for (const client of pending) {
    if (client.requestedAt && Date.now() - client.requestedAt.getTime() >= STUCK_DELETION_MS) {
      void sendOpsAlert({
        service: "worker",
        type: "error",
        title: "Organisation deletion stuck",
        error: new Error(`Organisation deletion has remained incomplete for at least 15 minutes: ${client.id}`),
        throttleKey: `organisation-delete:stuck:${client.id}`,
      }, { log });
    }
    try {
      if (await purgeOrganisation(client.id, log)) purged += 1;
    } catch (err) {
      // One tenant's Stripe/storage outage must not prevent later deletion requests in the batch.
      // The durable request remains pending and the scheduler retries it on the next sweep.
      log.error({ err, clientId: client.id }, "organisation deletion purge failed");
      void sendOpsAlert({
        service: "worker",
        type: "error",
        title: "Organisation deletion failed",
        error: new Error(`Organisation deletion purge failed for ${client.id}`),
        throttleKey: `organisation-delete:purge:${client.id}`,
      }, { log });
    }
  }
  return purged;
}

export function startOrganisationDeletionScheduler(log: FastifyBaseLogger): () => Promise<void> {
  return startSweepScheduler({
    name: "organisation-deletion",
    task: () => runOrganisationDeletionSweep(log),
    nextDelayMs: (count) => count ? 0 : PURGE_INTERVAL_MS,
    log,
  }).stop;
}
