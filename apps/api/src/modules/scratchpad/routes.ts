import { dto } from "@kanera/shared";
import { getAllowedAttachmentExtension } from "@kanera/shared/attachments";
import type { ScratchpadNoteAttachmentRow } from "@kanera/shared/dto";
import { SERVER_EVENTS, type WireScratchpadNote } from "@kanera/shared/events";
import {
  MAX_SCRATCHPAD_NOTES,
  scratchpadNoteAttachments,
  scratchpadNotes,
  type ScratchpadNote,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../../db.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import {
  assertCanUploadAttachment,
  formatStorageBytes,
  getUploadEntitlements,
  isStorageFull,
  storageQuotaExceededError,
} from "../../lib/entitlements.js";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.js";
import { signEmbeddedMediaUrls, stripSignedEmbeddedMediaUrls, unsignedMediaUrl } from "../../lib/media-keys.js";
import { between } from "../../lib/position.js";
import { rebalanceScratchpadNotes } from "../../lib/rebalance.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { scratchpadNoteAttachmentStorageKey } from "../../lib/storage/keys.js";
import type { StorageProvider } from "../../lib/storage/types.js";
import { stripAttachmentReferences } from "../../lib/strip-attachment-refs.js";
// `emitToUserDurable`, not the fire-and-forget `emitToUser`: awaiting the durable write means the
// response is only sent once the event is recorded, so a process that dies immediately after
// responding still leaves the user's other sessions a row to converge from. It also makes the
// rebalance-before-move ordering below a real ordering rather than two racing background writes.
// Failures are caught and logged inside the helper, so awaiting cannot fail the request.
import { emitToUserDurable } from "../../realtime/emit.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

/**
 * Load a scratchpad page the requester owns.
 *
 * The ownership check is inline rather than an `assertX` helper because there is no helper for
 * user-only resources — `assertBoardAccess` / `assertWorkspaceAccess` both resolve tenancy through a
 * workspace, and routing a scratchpad read through either would introduce the very org-level
 * authority this feature must not have. (Work views take the same inline approach for the same
 * reason.) `scratchpad_note.client_id` is deliberately not consulted: an org admin has no more claim
 * on someone's scratchpad than a stranger does.
 *
 * 404-then-403 rather than a flat 404 for a foreign page: page ids are uuidv7 and never exposed to
 * anyone but their owner, so there is no id-enumeration surface to protect, and a distinguishable
 * 403 makes the privacy boundary directly assertable in tests.
 */
async function loadOwned(id: string, req: FastifyRequest): Promise<ScratchpadNote> {
  const [note] = await db.select().from(scratchpadNotes).where(eq(scratchpadNotes.id, id)).limit(1);
  if (!note) throw notFound();
  if (note.userId !== req.auth.sub) throw forbidden();
  return note;
}

/** Row-locked ownership check for writes that reconcile a page body with its attachment rows. */
async function loadOwnedForUpdate(id: string, req: FastifyRequest, tx: Tx): Promise<ScratchpadNote> {
  const [note] = await tx
    .select()
    .from(scratchpadNotes)
    .where(eq(scratchpadNotes.id, id))
    .for("update")
    .limit(1);
  if (!note) throw notFound();
  if (note.userId !== req.auth.sub) throw forbidden();
  return note;
}

/** Serialise page-list writes even when the owner has no rows for a normal row lock to acquire. */
async function lockScratchpadForWrite(userId: string, tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`scratchpad:${userId}`}, 0))`);
}

/**
 * Re-sign the media URLs embedded in the page body.
 *
 * Signed from the page's own `client_id`, not the requester's `req.auth.cid`. They are the same org
 * today (a page's client_id is copied from its owner, who belongs to exactly one org), but signing
 * from the row keeps the signature correct if a user is ever moved between organisations, which would
 * otherwise silently break every image in their scratchpad.
 */
function wire(note: ScratchpadNote): WireScratchpadNote {
  return { ...note, content: signEmbeddedMediaUrls(note.content, note.clientId) ?? "" };
}

function fileTooLargeError(maxFileBytes: number, attemptedBytes?: number) {
  return new AppError(
    400,
    "FILE_TOO_LARGE",
    `File is too large. The maximum file size is ${formatStorageBytes(maxFileBytes)}.`,
    { limit: "fileSize", maxFileBytes, ...(attemptedBytes !== undefined ? { attemptedBytes } : {}) },
  );
}

async function putAttachmentFile(storage: StorageProvider, key: string, body: Buffer, contentType: string) {
  try {
    await storage.put(key, body, contentType);
  } catch {
    throw new AppError(503, "STORAGE_UNAVAILABLE", "attachment storage unavailable");
  }
}

/** Neighbour positions for a move, over the owner's flat page list. */
async function neighbourPositions(
  userId: string,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
  tx: DbLike = db,
): Promise<{ prev: string | null; next: string | null }> {
  const owned = eq(scratchpadNotes.userId, userId);
  if (afterId === null && beforeId === undefined) {
    const [first] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(owned)
      .orderBy(asc(scratchpadNotes.position))
      .limit(1);
    return { prev: null, next: first?.position ?? null };
  }
  if (afterId) {
    const [after] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(and(owned, eq(scratchpadNotes.id, afterId)))
      .limit(1);
    if (!after) throw badRequest("anchor page not found");
    const [next] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(and(owned, gt(scratchpadNotes.position, after.position)))
      .orderBy(asc(scratchpadNotes.position))
      .limit(1);
    return { prev: after.position, next: next?.position ?? null };
  }
  if (beforeId) {
    const [before] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(and(owned, eq(scratchpadNotes.id, beforeId)))
      .limit(1);
    if (!before) throw badRequest("anchor page not found");
    const [prev] = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(and(owned, lt(scratchpadNotes.position, before.position)))
      .orderBy(desc(scratchpadNotes.position))
      .limit(1);
    return { prev: prev?.position ?? null, next: before.position };
  }
  // `beforeNoteId: null`, or no anchor at all — append.
  const [last] = await tx
    .select({ position: scratchpadNotes.position })
    .from(scratchpadNotes)
    .where(owned)
    .orderBy(desc(scratchpadNotes.position))
    .limit(1);
  return { prev: last?.position ?? null, next: null };
}

/**
 * Private per-user scratchpad pages.
 *
 * No `recordActivity` anywhere in this module — deliberately, and matching the notes module, which
 * records none either. An activity row is an organisation-visible audit artefact (the org activity
 * feed is scoped by `client_id`, not by actor), so writing one per autosave tick would both leak that
 * a private page exists and drown the feed in keystroke-rate noise.
 */
export async function scratchpadRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/scratchpad/notes", async (req) => {
    const rows = await db
      .select()
      .from(scratchpadNotes)
      .where(eq(scratchpadNotes.userId, req.auth.sub))
      .orderBy(asc(scratchpadNotes.position));
    // Full content for every page, not a metadata list: the count is capped at MAX_SCRATCHPAD_NOTES
    // and this is the panel's only fetch, so shipping the bodies up front makes tab switching
    // instant instead of a request per tab.
    return rows.map(wire);
  });

  app.post("/scratchpad/notes", async (req, reply) => {
    const body = dto.createScratchpadNoteBody.parse(req.body ?? {});

    const note = await db.transaction(async (tx) => {
      // A row lock cannot serialise the first create because an empty scratchpad has nothing to lock.
      // Every create takes this user-keyed advisory lock first, so concurrent tabs see one
      // authoritative count and last position even at the empty-list boundary.
      await lockScratchpadForWrite(req.auth.sub, tx);
      const rows = await tx
        .select({ position: scratchpadNotes.position })
        .from(scratchpadNotes)
        .where(eq(scratchpadNotes.userId, req.auth.sub))
        .for("update")
        .orderBy(desc(scratchpadNotes.position));
      if (rows.length >= MAX_SCRATCHPAD_NOTES) {
        throw badRequest(`a scratchpad holds at most ${MAX_SCRATCHPAD_NOTES} pages`);
      }
      const { position } = between(rows[0]?.position ?? null, null);
      const [created] = await tx
        .insert(scratchpadNotes)
        .values({
          userId: req.auth.sub,
          // Denormalized from the caller's org for storage/quota/signing only — never for access.
          clientId: req.auth.cid,
          title: body.title ?? "",
          position,
        })
        .returning();
      return created!;
    });

    const wired = wire(note);
    await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_CREATED, { note: wired });
    return reply.status(201).send(wired);
  });

  /**
   * Autosave write. Last-write-wins on purpose.
   *
   * There is deliberately no edit lock and no `baseUpdatedAt` staleness check — both of which the
   * `notes` module has, and both of which would be actively wrong here. A scratchpad page has exactly
   * one writer, so the only "conflict" possible is that writer's own second device or second tab, and
   * answering their autosave with a 409 would interrupt them with a conflict against themselves. The
   * client instead treats the returned `updatedAt` as an echo watermark: the `scratchpadNote:updated`
   * event this emits comes back to the same user's other sessions, and each one compares that
   * timestamp against its own last-saved marker to decide whether the payload is its own echo (ignore)
   * or a genuine remote edit (apply if the local editor is clean).
   *
   * The loss window this accepts: two devices typing simultaneously, where the older write is
   * overwritten. The web client keeps the losing text in its local `EditorDrafts` entry, so nothing
   * the user typed disappears from the machine they typed it on.
   */
  app.patch("/scratchpad/notes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateScratchpadNoteBody.parse(req.body);

    // Signed media URLs are per-request and expiring, so the body is normalised back to its unsigned
    // form before storage (identical to notes/cards) and re-signed by `wire` on the way out.
    const content = body.content !== undefined
      ? stripSignedEmbeddedMediaUrls(body.content, req.auth.cid) ?? ""
      : undefined;

    const { updated, removedAttachments } = await db.transaction(async (tx) => {
      const current = await loadOwnedForUpdate(id, req, tx);
      const attachments = content === undefined
        ? []
        : await tx
            .select({
              id: scratchpadNoteAttachments.id,
              fileKey: scratchpadNoteAttachments.fileKey,
              url: scratchpadNoteAttachments.url,
            })
            .from(scratchpadNoteAttachments)
            .where(eq(scratchpadNoteAttachments.scratchpadNoteId, id));

      // Only reclaim rows that were reachable from the previously saved body and are absent from
      // the new one. A freshly uploaded row is not yet in `current.content`; excluding it prevents an
      // older autosave that was already in flight from deleting an upload before TipTap inserts it.
      const removedAttachments = content === undefined
        ? []
        : attachments.filter((attachment) =>
            current.content.includes(attachment.url) && !content.includes(attachment.url));

      const [updated] = await tx
        .update(scratchpadNotes)
        .set({
          ...(body.title !== undefined && { title: body.title }),
          ...(content !== undefined && { content }),
          // Set explicitly: `updatedAt` is the client's echo watermark, so it must advance on every
          // accepted write even when the text is byte-identical to what was already stored.
          updatedAt: new Date(),
        })
        .where(eq(scratchpadNotes.id, id))
        .returning();
      if (!updated) throw notFound();

      if (removedAttachments.length > 0) {
        await tx
          .delete(scratchpadNoteAttachments)
          .where(inArray(scratchpadNoteAttachments.id, removedAttachments.map((row) => row.id)));
      }
      return { updated, removedAttachments };
    });

    // The DB row and body are already consistent. Physical deletion is best-effort, matching every
    // other attachment delete path: a storage outage must not resurrect a removed embed.
    if (removedAttachments.length > 0) {
      const storage = await getStorageForClient(updated.clientId);
      await Promise.all(removedAttachments.map((row) => storage.delete(row.fileKey).catch(() => undefined)));
    }

    const wired = wire(updated);
    await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED, { note: wired });
    return wired;
  });

  app.patch("/scratchpad/notes/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveScratchpadNoteBody.parse(req.body ?? {});
    const note = await loadOwned(id, req);

    const prevPosition = note.position;
    const { position, rebalancedPositions } = await db.transaction(async (tx) => {
      const { prev, next } = await neighbourPositions(
        req.auth.sub,
        body.afterNoteId ?? undefined,
        body.beforeNoteId ?? undefined,
        tx,
      );
      const result = between(prev, next);
      let position = result.position;
      await tx
        .update(scratchpadNotes)
        .set({ position })
        .where(eq(scratchpadNotes.id, id));

      // Reordering tabs is not a document edit, so `updatedAt` is intentionally left alone above: a
      // drag must not make every neighbouring page look freshly written, and must not advance the
      // echo watermark of a page whose text nobody touched.
      const rebalancedPositions = result.needsRebalance ? await rebalanceScratchpadNotes(req.auth.sub, tx) : null;
      if (rebalancedPositions) position = rebalancedPositions.find((row) => row.id === id)?.position ?? position;
      return { position, rebalancedPositions };
    });

    // Rebalance before moved, per the repo-wide ordering rule: a client that applied `moved` first
    // would place the page against positions the rebalance is about to renumber, landing it in the
    // wrong slot until the next full fetch.
    if (rebalancedPositions) {
      await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_REBALANCED, { positions: rebalancedPositions });
    }
    await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_MOVED, { noteId: id, position, prevPosition });
    return { id, position };
  });

  app.delete("/scratchpad/notes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { attachments, clientId } = await db.transaction(async (tx) => {
      // Lock the page while collecting keys and hard-deleting its rows. Without one transaction, an
      // upload could commit between the key query and note delete: its row would cascade away, but its
      // physical object key would be lost forever.
      const note = await loadOwnedForUpdate(id, req, tx);
      const attachments = await tx
        .select({ fileKey: scratchpadNoteAttachments.fileKey })
        .from(scratchpadNoteAttachments)
        .where(eq(scratchpadNoteAttachments.scratchpadNoteId, id));

      // Be explicit about the hard delete rather than relying only on the FK cascade. This keeps the
      // attachment lifecycle obvious here and leaves no rows contributing to storage quota.
      await tx
        .delete(scratchpadNoteAttachments)
        .where(eq(scratchpadNoteAttachments.scratchpadNoteId, id));
      await tx.delete(scratchpadNotes).where(eq(scratchpadNotes.id, id));
      return { attachments, clientId: note.clientId };
    });

    // Best-effort after the committed row deletion, matching the other attachment paths: a storage
    // outage may leave an unreachable provider object, but must not resurrect the note or its rows.
    const storage = await getStorageForClient(clientId);
    await Promise.all(attachments.map((row) => storage.delete(row.fileKey).catch(() => undefined)));

    await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_DELETED, { noteId: id });
    return reply.status(204).send();
  });

  /**
   * Upload a file embedded in a scratchpad page (pasted screenshot, dropped image).
   *
   * Diverges from the notes upload path in one way: there is no host-pays split. A note charges the
   * org owning its workspace, which can differ from the uploader's org for cross-organisation guests.
   * A scratchpad page has no workspace and its owner is the only possible uploader, so quota,
   * accounting, and physical storage are all the requester's own org — `req.auth.cid` throughout.
   */
  app.post("/scratchpad/notes/:id/attachments", async (req, reply) => {
    const { id } = req.params as { id: string };
    await loadOwned(id, req);

    const uploadEntitlements = await getUploadEntitlements(db, req.auth.cid);
    // Reject a full org before reading the body so it never wastes bandwidth on an unstorable file.
    if (isStorageFull(uploadEntitlements)) throw storageQuotaExceededError(uploadEntitlements);

    const file = await req
      .file({ limits: { fileSize: uploadEntitlements.maxFileBytes, files: 1 } })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          throw fileTooLargeError(uploadEntitlements.maxFileBytes);
        }
        return null;
      });
    if (!file) throw badRequest("no file uploaded");

    const ext = getAllowedAttachmentExtension(file.mimetype, file.filename);
    if (!ext) throw badRequest("unsupported file type");

    const buffer = await file.toBuffer().catch((err: unknown) => {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw fileTooLargeError(uploadEntitlements.maxFileBytes);
      }
      throw err;
    });
    if (buffer.byteLength > uploadEntitlements.maxFileBytes) {
      throw fileTooLargeError(uploadEntitlements.maxFileBytes, buffer.byteLength);
    }
    await assertCanUploadAttachment(db, req.auth.cid, buffer.byteLength);

    const fileKey = scratchpadNoteAttachmentStorageKey(id, ext);
    const storage = await getStorageForClient(req.auth.cid);
    await putAttachmentFile(storage, fileKey, buffer, file.mimetype);
    const url = unsignedMediaUrl(req.auth.cid, fileKey)!;

    let inserted: typeof scratchpadNoteAttachments.$inferSelect;
    try {
      const [row] = await db
        .insert(scratchpadNoteAttachments)
        .values({
          scratchpadNoteId: id,
          clientId: req.auth.cid,
          fileName: file.filename,
          mimeType: file.mimetype,
          byteSize: buffer.byteLength,
          fileKey,
          url,
        })
        .returning();
      inserted = row!;
    } catch (err) {
      await storage.delete(fileKey).catch(() => undefined);
      throw err;
    }

    // Deliberately no page update and no realtime event. The editor inserts the returned URL into the
    // body and the content autosave that follows carries the embed, so bumping `updatedAt` here would
    // advance the echo watermark *before* that save lands — every other session would then treat the
    // real content write as its own echo and never render the image.
    const attachment: ScratchpadNoteAttachmentRow = shapeAttachmentMedia({
      id: inserted.id,
      scratchpadNoteId: inserted.scratchpadNoteId,
      fileName: inserted.fileName,
      mimeType: inserted.mimeType,
      byteSize: inserted.byteSize,
      url: inserted.url,
      createdAt: inserted.createdAt,
    });
    return reply.status(201).send(attachment);
  });

  /**
   * Roll back an upload that TipTap could not insert, and provide a direct cleanup path for clients.
   * If the file was already embedded, remove the reference atomically with its row so no saved page
   * can retain an invisible, broken quota consumer.
   */
  app.delete("/scratchpad/notes/:id/attachments/:attachmentId", async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };

    const { attachment, updated } = await db.transaction(async (tx) => {
      const note = await loadOwnedForUpdate(id, req, tx);
      const [attachment] = await tx
        .select()
        .from(scratchpadNoteAttachments)
        .where(and(
          eq(scratchpadNoteAttachments.id, attachmentId),
          eq(scratchpadNoteAttachments.scratchpadNoteId, id),
        ))
        .limit(1);
      if (!attachment) throw notFound();

      const stripped = stripAttachmentReferences(note.content, attachment.url);
      const [updated] = stripped.changed
        ? await tx
            .update(scratchpadNotes)
            .set({ content: stripped.body ?? "", updatedAt: new Date() })
            .where(eq(scratchpadNotes.id, id))
            .returning()
        : [null];
      await tx.delete(scratchpadNoteAttachments).where(eq(scratchpadNoteAttachments.id, attachmentId));
      return { attachment, updated };
    });

    const storage = await getStorageForClient(attachment.clientId);
    await storage.delete(attachment.fileKey).catch(() => undefined);

    if (updated) {
      const wired = wire(updated);
      await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED, { note: wired });
    }
    return reply.status(204).send();
  });
}
