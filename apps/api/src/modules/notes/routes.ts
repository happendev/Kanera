import { dto } from "@kanera/shared";
import type { NoteAttachmentSource } from "@kanera/shared/dto";
import { notes } from "@kanera/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { assertBoardAccess, assertWorkspaceAccess, assertWriteCapableCredential } from "../../lib/access.js";
import { readAttachmentUpload } from "../../lib/read-attachment-upload.js";
import { badRequest } from "../../lib/errors.js";
import { emitInternalLinksChanged, loadBacklinksForNote, repairInternalLinksAroundNote } from "../../lib/internal-links.js";
import { createNote } from "./create-note.js";
import { deleteNote } from "./delete-note.js";
import { duplicateNote } from "./duplicate-note.js";
import { emitMoveNote, moveNote } from "./move-note.js";
import { addNoteAttachment, deleteNoteAttachment, isNoteAttachmentSource, listNoteAttachments } from "./note-attachments.js";
import { lockNote, unlockNote } from "./note-locks.js";
import { assertNotesEnabled, authoriseRead, authoriseWrite, emitNoteEvent, loadOrFail, pageNotes, shapeNote, wireNotes } from "./route-support.js";
import { emitUpdateNote, updateNote } from "./update-note.js";

export { removeNoteAttachment } from "./note-attachments.js";

export interface NoteRoutesOptions {
  // Public integrations can create, edit, duplicate, and move notes, but deletion stays a deliberate
  // in-app action. This also keeps agents from removing note attachments as an indirect destructive edit.
  allowDeletes?: boolean;
}

export async function noteRoutes(app: FastifyInstance, options: NoteRoutesOptions = {}) {
  const allowDeletes = options.allowDeletes ?? true;
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces/:wsId/notes", async (req) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    const query = dto.listNotesQuery.parse(req.query);
    const directory = dto.agentDirectoryQuery.parse(req.query ?? {});
    await assertWorkspaceAccess(req.auth, workspaceId, "member");
    await assertNotesEnabled(workspaceId);

    const baseFilter = and(
      eq(notes.workspaceId, workspaceId),
      isNull(notes.boardId),
      eq(notes.scope, query.scope),
      query.scope === "personal" ? eq(notes.ownerId, req.auth.sub) : sql`true`,
    );
    // Paginate in SQL, not with slice(): notes carry full markdown bodies, so fetching every note in
    // the workspace to return ten of them read (and transferred) the whole set for nothing.
    const page = await pageNotes(baseFilter, directory);
    return wireNotes(page, req.auth.cid);
  });

  app.get("/boards/:boardId/notes", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const query = dto.listNotesQuery.parse(req.query);
    const directory = dto.agentDirectoryQuery.parse(req.query ?? {});
    const { workspaceId } = await assertBoardAccess(req.auth, boardId, "observer");
    await assertNotesEnabled(workspaceId);

    const baseFilter = and(
      eq(notes.workspaceId, workspaceId),
      eq(notes.boardId, boardId),
      eq(notes.scope, query.scope),
      query.scope === "personal" ? eq(notes.ownerId, req.auth.sub) : sql`true`,
    );
    const page = await pageNotes(baseFilter, directory);
    return wireNotes(page, req.auth.cid);
  });

  app.get("/notes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseRead(req.auth, note);
    return shapeNote(note, req.auth.cid);
  });

  app.get("/notes/:id/backlinks", async (req) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseRead(req.auth, note);
    // Healing with the viewer's claims can reveal links the author could not record, but its
    // workspace-wide scan must not block this read; the next open can consume the repair.
    void repairInternalLinksAroundNote(req.auth, note).catch((err: unknown) =>
      req.log.warn({ err, noteId: id }, "failed to repair internal links around note"),
    );
    return { backlinks: await loadBacklinksForNote(req.auth, note) };
  });

  app.post("/workspaces/:wsId/notes", async (req, reply) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    const body = dto.createNoteBody.parse(req.body);
    // Creation passes at plain member for both scopes (team notes are shared with every workspace
    // member), so gate read-scoped credentials explicitly.
    assertWriteCapableCredential(req.auth);
    await assertWorkspaceAccess(req.auth, workspaceId, "member");
    await assertNotesEnabled(workspaceId);

    const { note, responseNote } = await createNote({ auth: req.auth, workspaceId, boardId: null, body });
    emitNoteEvent(note, "note:created", { scope: note.scope, note: responseNote });
    return reply.status(201).send(responseNote);
  });

  app.post("/boards/:boardId/notes", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.createNoteBody.parse(req.body);
    // Same read-scope gate as the workspace create route: personal scope passes at observer.
    assertWriteCapableCredential(req.auth);
    const { workspaceId } = await assertBoardAccess(req.auth, boardId, body.scope === "team" ? "editor" : "observer");
    await assertNotesEnabled(workspaceId);

    const { note, responseNote } = await createNote({ auth: req.auth, workspaceId, boardId, body });
    emitNoteEvent(note, "note:created", { scope: note.scope, note: responseNote });
    return reply.status(201).send(responseNote);
  });

  app.patch("/notes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateNoteBody.parse(req.body);
    const note = await loadOrFail(id);
    await authoriseWrite(req.auth, note);

    const result = await updateNote({ auth: req.auth, note, body });
    await emitUpdateNote(result);
    return result.responseNote;
  });

  app.post("/notes/:id/duplicate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.duplicateNoteBody.parse(req.body ?? {});
    const source = await loadOrFail(id);
    const { clientId: ownerClientId } = await authoriseWrite(req.auth, source);

    const { duplicate, responseNote, linkFanout } = await duplicateNote({ auth: req.auth, source, ownerClientId, body });
    emitNoteEvent(duplicate, "note:created", {
      scope: duplicate.scope,
      note: responseNote,
    });
    await emitInternalLinksChanged(linkFanout);
    return reply.status(201).send(responseNote);
  });

  app.patch("/notes/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveNoteBody.parse(req.body);
    const note = await loadOrFail(id);
    await authoriseWrite(req.auth, note);

    const result = await moveNote({ note, body });
    await emitMoveNote(result);
    return { id, position: result.position, parentNoteId: result.newParentId };
  });

  app.get("/notes/:id/attachments", async (req) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseRead(req.auth, note);

    return listNoteAttachments(id);
  });

  app.post("/notes/:id/attachments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { source?: string };
    const sourceParam = query.source;
    if (sourceParam !== undefined && !isNoteAttachmentSource(sourceParam)) {
      throw badRequest("invalid source");
    }
    const source: NoteAttachmentSource = sourceParam ?? "attachment";

    const note = await loadOrFail(id);
    const { clientId: ownerClientId } = await authoriseWrite(req.auth, note);

    const { editedNote, responseNote, attachment } = await addNoteAttachment({
      auth: req.auth,
      note,
      ownerClientId,
      source,
      readUpload: (maxFileBytes) => readAttachmentUpload(req, maxFileBytes),
    });
    emitNoteEvent(editedNote, "note:attachment:created", {
      note: responseNote,
      attachment,
    });
    return reply.status(201).send(attachment);
  });

  if (allowDeletes) {
    app.delete("/notes/:id/attachments/:attachmentId", async (req, reply) => {
      const { id, attachmentId } = req.params as { id: string; attachmentId: string };
      const note = await loadOrFail(id);
      await authoriseWrite(req.auth, note);

      await deleteNoteAttachment({ auth: req.auth, note, attachmentId });

      return reply.status(204).send();
    });

    app.delete("/notes/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const note = await loadOrFail(id);
      await authoriseWrite(req.auth, note);

      const { linkFanout } = await deleteNote({ note });
      emitNoteEvent(note, "note:deleted", { noteId: id });
      await emitInternalLinksChanged(linkFanout);
      return reply.status(204).send();
    });
  }

  app.post("/notes/:id/lock", async (req) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseWrite(req.auth, note);
    return lockNote({ auth: req.auth, note });
  });

  app.post("/notes/:id/unlock", async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseWrite(req.auth, note);
    await unlockNote({ auth: req.auth, note });
    return reply.status(204).send();
  });
}
