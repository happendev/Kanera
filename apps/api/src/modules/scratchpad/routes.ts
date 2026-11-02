import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { scratchpadNotes } from "@kanera/shared/schema";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { readAttachmentUpload } from "../../lib/read-attachment-upload.js";
import { assertWriteCapableCredential } from "../../lib/access.js";
// `emitToUserDurable`, not the fire-and-forget `emitToUser`: awaiting the durable write means the
// response is only sent once the event is recorded, so a process that dies immediately after
// responding still leaves the user's other sessions a row to converge from. It also makes the
// rebalance-before-move ordering (see `move-scratchpad-note.ts`) a real ordering rather than two
// racing background writes. Failures are caught and logged inside the helper, so awaiting cannot
// fail the request.
import { emitToUserDurable } from "../../realtime/emit.js";
import { captureScratchpadTask } from "./capture-scratchpad-task.js";
import { createScratchpadNote } from "./create-scratchpad-note.js";
import { deleteScratchpadNote } from "./delete-scratchpad-note.js";
import { emitScratchpadNoteMoved, moveScratchpadNote } from "./move-scratchpad-note.js";
import { assertPersonalCredential, loadOwned, wire } from "./route-support.js";
import { deleteScratchpadAttachment, prepareScratchpadUpload, storeScratchpadAttachment } from "./scratchpad-attachments.js";
import { updateScratchpadNote } from "./update-scratchpad-note.js";

/**
 * Private per-user, per-organisation scratchpad pages.
 *
 * No `recordActivity` anywhere in this module — deliberately, and matching the notes module, which
 * records none either. An activity row is an organisation-visible audit artefact (the org activity
 * feed is scoped by `client_id`, not by actor), so writing one per autosave tick would both leak that
 * a private page exists and drown the feed in keystroke-rate noise.
 */
export async function scratchpadRoutes(
  app: FastifyInstance,
  // The public API omits page deletion (permanent, and agents never need it for capture) and the
  // embed-upload pair, which only the web editor's paste/drop flow uses.
  options: { allowDeletes?: boolean; exposeAttachments?: boolean } = {},
) {
  const { allowDeletes = true, exposeAttachments = true } = options;
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (req) => assertPersonalCredential(req.auth));

  app.get("/scratchpad/notes", async (req) => {
    const rows = await db
      .select()
      .from(scratchpadNotes)
      .where(and(
        eq(scratchpadNotes.userId, req.auth.sub),
        eq(scratchpadNotes.clientId, req.auth.cid),
      ))
      .orderBy(asc(scratchpadNotes.position));
    // Full content for every page, not a metadata list: the count is capped at MAX_SCRATCHPAD_NOTES
    // and this is the panel's only fetch, so shipping the bodies up front makes tab switching
    // instant instead of a request per tab.
    return rows.map(wire);
  });

  // Every mutating route below calls assertWriteCapableCredential. The scratchpad has no workspace
  // and no role ranks — ownership alone is the only check — so on the public API this is the only
  // thing stopping a read-scoped personal key from writing the owner's private pages.
  app.post("/scratchpad/notes", async (req, reply) => {
    assertWriteCapableCredential(req.auth);
    const body = dto.createScratchpadNoteBody.parse(req.body ?? {});

    const note = await createScratchpadNote({ auth: req.auth, body });

    const wired = wire(note);
    await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_CREATED, { note: wired });
    return reply.status(201).send(wired);
  });

  app.post("/scratchpad/capture", async (req, reply) => {
    assertWriteCapableCredential(req.auth);
    const body = dto.captureScratchpadItemBody.parse(req.body ?? {});

    const { note, created, line } = await captureScratchpadTask({ auth: req.auth, body });

    const wired = wire(note);
    await emitToUserDurable(
      req.auth.sub,
      created ? SERVER_EVENTS.SCRATCHPAD_NOTE_CREATED : SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED,
      { note: wired },
    );
    return reply.status(created ? 201 : 200).send({ note: wired, created, item: line });
  });

  app.patch("/scratchpad/notes/:id", async (req) => {
    assertWriteCapableCredential(req.auth);
    const { id } = req.params as { id: string };
    const body = dto.updateScratchpadNoteBody.parse(req.body);

    const updated = await updateScratchpadNote({ auth: req.auth, id, body });

    const wired = wire(updated);
    await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED, { note: wired });
    return wired;
  });

  app.patch("/scratchpad/notes/:id/move", async (req) => {
    assertWriteCapableCredential(req.auth);
    const { id } = req.params as { id: string };
    const body = dto.moveScratchpadNoteBody.parse(req.body ?? {});
    const note = await loadOwned(id, req.auth);

    const result = await moveScratchpadNote({ auth: req.auth, note, body });

    await emitScratchpadNoteMoved({ auth: req.auth, result });
    return result.response;
  });

  if (allowDeletes) app.delete("/scratchpad/notes/:id", async (req, reply) => {
    assertWriteCapableCredential(req.auth);
    const { id } = req.params as { id: string };

    await deleteScratchpadNote({ auth: req.auth, id });

    await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_DELETED, {
      clientId: req.auth.cid,
      noteId: id,
    });
    return reply.status(204).send();
  });

  if (exposeAttachments) app.post("/scratchpad/notes/:id/attachments", async (req, reply) => {
    assertWriteCapableCredential(req.auth);
    const { id } = req.params as { id: string };
    const { uploadEntitlements } = await prepareScratchpadUpload({ auth: req.auth, id });
    const { file, ext, buffer } = await readAttachmentUpload(req, uploadEntitlements.maxFileBytes);
    const attachment = await storeScratchpadAttachment({
      auth: req.auth,
      id,
      upload: { fileName: file.filename, mimeType: file.mimetype, ext, buffer },
    });
    return reply.status(201).send(attachment);
  });

  if (exposeAttachments) app.delete("/scratchpad/notes/:id/attachments/:attachmentId", async (req, reply) => {
    assertWriteCapableCredential(req.auth);
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };

    const { updated } = await deleteScratchpadAttachment({ auth: req.auth, id, attachmentId });

    if (updated) {
      const wired = wire(updated);
      await emitToUserDurable(req.auth.sub, SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED, { note: wired });
    }
    return reply.status(204).send();
  });
}
