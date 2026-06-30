import { dto } from "@kanera/shared";
import { getAllowedAttachmentExtension } from "@kanera/shared/attachments";
import type { ColorToken } from "@kanera/shared/colors";
import { NOTE_ATTACHMENT_SOURCES, type NoteAttachmentRow, type NoteAttachmentSource } from "@kanera/shared/dto";
import type { ServerToClientEvents, WireNote, WireNoteLock } from "@kanera/shared/events";
import { internalLinks, noteAttachments, notes, users, type Note, type NoteScope } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess, assertWorkspaceAccess } from "../../lib/access.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { assertCanUploadAttachment, formatStorageBytes, getUploadEntitlements, isStorageFull, storageQuotaExceededError } from "../../lib/entitlements.js";
import { signEmbeddedMediaUrls, stripSignedEmbeddedMediaUrls, unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { between, positionAtIndex } from "../../lib/position.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { noteAttachmentStorageKey } from "../../lib/storage/keys.js";
import type { StorageProvider } from "../../lib/storage/types.js";
import { stripAttachmentReferences } from "../../lib/strip-attachment-refs.js";
import { emitToBoard, emitToUser, emitToWorkspace } from "../../realtime/emit.js";
import { loadBacklinksForNote, repairInternalLinksAroundNote, replaceInternalLinksForSource } from "../../lib/internal-links.js";

const LOCK_TTL_MS = 90_000; // 90 seconds
const MAX_NOTE_TREE_DEPTH = 3;

type SiblingKey = Pick<Note, "workspaceId" | "boardId" | "scope" | "ownerId" | "parentNoteId">;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

const noteAttachmentRowColumns = {
  id: noteAttachments.id,
  noteId: noteAttachments.noteId,
  fileName: noteAttachments.fileName,
  mimeType: noteAttachments.mimeType,
  byteSize: noteAttachments.byteSize,
  url: noteAttachments.url,
  fileKey: noteAttachments.fileKey,
  createdAt: noteAttachments.createdAt,
  uploadedById: noteAttachments.uploadedById,
  uploadedByName: users.displayName,
  uploadedByAvatarUrl: users.avatarUrl,
  source: noteAttachments.source,
} as const;

type NoteAttachmentRowWithKeys = NoteAttachmentRow & { fileKey: string };

function siblingFilter(key: SiblingKey) {
  const ownerCondition = key.scope === "personal" ? eq(notes.ownerId, key.ownerId) : sql`true`;
  return and(
    eq(notes.workspaceId, key.workspaceId),
    key.boardId === null ? isNull(notes.boardId) : eq(notes.boardId, key.boardId),
    eq(notes.scope, key.scope),
    key.parentNoteId === null ? isNull(notes.parentNoteId) : eq(notes.parentNoteId, key.parentNoteId),
    ownerCondition,
  );
}

async function neighbourPositions(
  base: SiblingKey,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
  tx: DbLike = db,
): Promise<{ prev: string | null; next: string | null }> {
  let prev: string | null = null;
  let next: string | null = null;
  if (afterId === null && beforeId === undefined) {
    const [first] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(siblingFilter(base))
      .orderBy(asc(notes.position))
      .limit(1);
    next = first?.position ?? null;
  } else if (beforeId === null && afterId === undefined) {
    const [last] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(siblingFilter(base))
      .orderBy(desc(notes.position))
      .limit(1);
    prev = last?.position ?? null;
  } else if (afterId) {
    const [after] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(and(siblingFilter(base), eq(notes.id, afterId)))
      .limit(1);
    if (!after) return { prev: null, next: null };
    const [nextRow] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(and(siblingFilter(base), gt(notes.position, after.position)))
      .orderBy(asc(notes.position))
      .limit(1);
    prev = after.position;
    next = nextRow?.position ?? null;
  } else if (beforeId) {
    const [before] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(and(siblingFilter(base), eq(notes.id, beforeId)))
      .limit(1);
    if (!before) return { prev: null, next: null };
    const [prevRow] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(and(siblingFilter(base), lt(notes.position, before.position)))
      .orderBy(desc(notes.position))
      .limit(1);
    next = before.position;
    prev = prevRow?.position ?? null;
  } else {
    const [last] = await tx
      .select({ position: notes.position })
      .from(notes)
      .where(siblingFilter(base))
      .orderBy(desc(notes.position))
      .limit(1);
    prev = last?.position ?? null;
  }
  return { prev, next };
}

async function rebalanceSiblings(base: SiblingKey, tx: DbLike = db): Promise<{ id: string; position: string }[]> {
  const rows = await tx
    .select({ id: notes.id, position: notes.position })
    .from(notes)
    .where(siblingFilter(base))
    .orderBy(asc(notes.position));
  const updates = rows
    .map((row, index) => ({ id: row.id, position: positionAtIndex(index), previousPosition: row.position }))
    .filter((row) => row.position !== row.previousPosition);
  await Promise.all(
    updates.map((row) =>
      tx.update(notes).set({ position: row.position, updatedAt: new Date() }).where(eq(notes.id, row.id)),
    ),
  );
  return updates.map(({ id, position }) => ({ id, position }));
}

function wireNote(note: Note, clientId: string): WireNote {
  return {
    ...note,
    content: signEmbeddedMediaUrls(note.content, clientId) ?? "",
  };
}

function isNoteAttachmentSource(value: unknown): value is NoteAttachmentSource {
  return typeof value === "string" && (NOTE_ATTACHMENT_SOURCES as readonly string[]).includes(value);
}

async function selectNoteAttachmentRow(attachmentId: string): Promise<NoteAttachmentRowWithKeys> {
  const [row] = await db
    .select(noteAttachmentRowColumns)
    .from(noteAttachments)
    .innerJoin(users, eq(users.id, noteAttachments.uploadedById))
    .where(eq(noteAttachments.id, attachmentId))
    .limit(1);
  if (!row) throw notFound();
  return row as NoteAttachmentRowWithKeys;
}

function assertScopeAccess(note: Pick<Note, "scope" | "ownerId">, userId: string) {
  if (note.scope === "personal" && note.ownerId !== userId) throw forbidden();
}

function isLockedByOther(note: Pick<Note, "editingUserId" | "editingExpiresAt">, userId: string): boolean {
  if (!note.editingUserId || note.editingUserId === userId) return false;
  if (!note.editingExpiresAt) return false;
  return note.editingExpiresAt.getTime() > Date.now();
}

function isLockHeldBy(note: Pick<Note, "editingUserId" | "editingExpiresAt">, userId: string): boolean {
  if (note.editingUserId !== userId || !note.editingExpiresAt) return false;
  return note.editingExpiresAt.getTime() > Date.now();
}

function sameInstant(a: Date | string, b: Date | string): boolean {
  const base = new Date(a).getTime();
  const value = new Date(b).getTime();
  return value >= base && value < base + 1;
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

function sameWireTimestamp(column: typeof notes.updatedAt, value: string) {
  const base = new Date(value);
  return sql`${column} >= ${base} and ${column} < ${new Date(base.getTime() + 1)}`;
}

async function buildNoteLockForUser(
  noteId: string,
  editingUserId: string,
  editingExpiresAt: Date,
  clientId: string,
): Promise<WireNoteLock> {
  const [user] = await db
    .select({ displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, editingUserId))
    .limit(1);
  const signed = withSignedMedia(clientId, {
    avatarUrl: user?.avatarUrl ?? null,
  });
  return {
    noteId,
    editingUserId,
    editingUserName: user?.displayName ?? "Someone",
    editingUserAvatarUrl: signed.avatarUrl,
    editingExpiresAt: editingExpiresAt.toISOString(),
  };
}

async function buildNoteLock(note: Pick<Note, "id" | "editingUserId" | "editingExpiresAt">, clientId: string): Promise<WireNoteLock> {
  if (!note.editingUserId || !note.editingExpiresAt) throw new Error("cannot build lock payload without lock");
  return buildNoteLockForUser(note.id, note.editingUserId, note.editingExpiresAt, clientId);
}

type NoteEventName =
  | "note:created"
  | "note:updated"
  | "note:moved"
  | "note:deleted"
  | "note:locked"
  | "note:unlocked"
  | "note:attachment:created"
  | "note:attachment:deleted";
type EventPayload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];

function emitNoteEvent<E extends NoteEventName>(
  note: Pick<Note, "scope" | "ownerId" | "workspaceId" | "boardId">,
  event: E,
  payload: EventPayload<E>,
) {
  // The generic E narrows the payload type at call sites; the emit helpers are
  // permissive about the runtime payload shape so the cast is safe.
  const emit = (target: (id: string, e: E, p: EventPayload<E>) => void, id: string) => target(id, event, payload);
  if (note.scope === "personal") emit(emitToUser as never, note.ownerId);
  else if (note.boardId) emit(emitToBoard as never, note.boardId);
  else emit(emitToWorkspace as never, note.workspaceId);
}

function emitRebalanceEvent(
  base: SiblingKey,
  positions: { id: string; position: string }[],
) {
  const payload = {
    scope: base.scope,
    workspaceId: base.workspaceId,
    boardId: base.boardId,
    parentNoteId: base.parentNoteId,
    ownerId: base.ownerId,
    positions,
  };
  if (base.scope === "personal") {
    emitToUser(base.ownerId, "note:rebalanced", payload);
  } else if (base.boardId) {
    return emitToBoard(base.boardId, "note:rebalanced", payload);
  } else {
    return emitToWorkspace(base.workspaceId, "note:rebalanced", payload);
  }
  return Promise.resolve(null);
}

async function loadOrFail(id: string): Promise<Note> {
  const [note] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  if (!note) throw notFound();
  return note;
}

async function authoriseRead(req: FastifyRequest, note: Note) {
  if (note.boardId) await assertBoardAccess(req.auth, note.boardId, "observer");
  else await assertWorkspaceAccess(req.auth, note.workspaceId, "observer");
  assertScopeAccess(note, req.auth.sub);
}

// Returns the org that owns the note's workspace (host-pays storage attribution). Both access
// helpers resolve clientId from workspaces.clientId, so this is the host org even for cross-org guests.
async function authoriseWrite(req: FastifyRequest, note: Note): Promise<{ clientId: string }> {
  const minRole = note.scope === "personal" ? "observer" : "editor";
  const ctx = note.boardId
    ? await assertBoardAccess(req.auth, note.boardId, minRole)
    : await assertWorkspaceAccess(req.auth, note.workspaceId, minRole);
  assertScopeAccess(note, req.auth.sub);
  return { clientId: ctx.clientId };
}

async function resolveParent(
  workspaceId: string,
  boardId: string | null,
  parentNoteId: string | null,
  scope: NoteScope,
  userId: string,
): Promise<Note | null> {
  if (!parentNoteId) return null;
  const [parent] = await db.select().from(notes).where(eq(notes.id, parentNoteId)).limit(1);
  if (!parent) throw notFound("parent note not found");
  if (parent.workspaceId !== workspaceId || parent.boardId !== boardId || parent.scope !== scope) {
    throw forbidden("parent note in different scope");
  }
  if (scope === "personal" && parent.ownerId !== userId) throw forbidden();
  return parent;
}

async function noteDepth(note: Pick<Note, "id" | "parentNoteId"> | null): Promise<number> {
  if (!note) return 0;
  let depth = 1;
  let cursorId = note.parentNoteId;
  const visited = new Set<string>([note.id]);
  while (cursorId) {
    if (visited.has(cursorId)) throw conflict("note tree contains a cycle");
    visited.add(cursorId);
    const [parent] = await db
      .select({ id: notes.id, parentNoteId: notes.parentNoteId })
      .from(notes)
      .where(eq(notes.id, cursorId))
      .limit(1);
    if (!parent) break;
    depth += 1;
    cursorId = parent.parentNoteId;
  }
  return depth;
}

async function descendantDepth(noteId: string): Promise<number> {
  const children = await db
    .select({ id: notes.id })
    .from(notes)
    .where(eq(notes.parentNoteId, noteId));
  if (children.length === 0) return 1;
  const childDepths = await Promise.all(children.map((child) => descendantDepth(child.id)));
  return 1 + Math.max(...childDepths);
}

async function insertNote(input: {
  workspaceId: string;
  boardId: string | null;
  parentNoteId: string | null;
  scope: NoteScope;
  ownerId: string;
  title: string;
  icon: string | null;
  color: ColorToken | null;
}): Promise<Note> {
  const base: SiblingKey = {
    workspaceId: input.workspaceId,
    boardId: input.boardId,
    scope: input.scope,
    ownerId: input.ownerId,
    parentNoteId: input.parentNoteId,
  };
  const [last] = await db
    .select({ position: notes.position })
    .from(notes)
    .where(siblingFilter(base))
    .orderBy(desc(notes.position))
    .limit(1);
  const { position } = between(last?.position ?? null, null);
  const [note] = await db
    .insert(notes)
    .values({
      workspaceId: input.workspaceId,
      boardId: input.boardId,
      parentNoteId: input.parentNoteId,
      scope: input.scope,
      ownerId: input.ownerId,
      title: input.title,
      content: "",
      icon: input.icon,
      color: input.color,
      position,
    })
    .returning();
  return note!;
}

export async function noteRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces/:wsId/notes", async (req) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    const query = dto.listNotesQuery.parse(req.query);
    await assertWorkspaceAccess(req.auth, workspaceId, "observer");

    const baseFilter = and(
      eq(notes.workspaceId, workspaceId),
      isNull(notes.boardId),
      eq(notes.scope, query.scope),
      query.scope === "personal" ? eq(notes.ownerId, req.auth.sub) : sql`true`,
    );
    const rows = await db.select().from(notes).where(baseFilter).orderBy(asc(notes.position));
    return rows.map((n) => wireNote(n, req.auth.cid));
  });

  app.get("/boards/:boardId/notes", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const query = dto.listNotesQuery.parse(req.query);
    const { workspaceId } = await assertBoardAccess(req.auth, boardId, "observer");

    const baseFilter = and(
      eq(notes.workspaceId, workspaceId),
      eq(notes.boardId, boardId),
      eq(notes.scope, query.scope),
      query.scope === "personal" ? eq(notes.ownerId, req.auth.sub) : sql`true`,
    );
    const rows = await db.select().from(notes).where(baseFilter).orderBy(asc(notes.position));
    return rows.map((n) => wireNote(n, req.auth.cid));
  });

  app.get("/notes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseRead(req, note);
    return wireNote(note, req.auth.cid);
  });

  app.get("/notes/:id/backlinks", async (req) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseRead(req, note);
    await repairInternalLinksAroundNote(req.auth, note);
    return { backlinks: await loadBacklinksForNote(req.auth, note) };
  });

  app.post("/workspaces/:wsId/notes", async (req, reply) => {
    const { wsId: workspaceId } = req.params as { wsId: string };
    const body = dto.createNoteBody.parse(req.body);
    await assertWorkspaceAccess(req.auth, workspaceId, body.scope === "team" ? "editor" : "observer");

    const parent = await resolveParent(workspaceId, null, body.parentNoteId ?? null, body.scope, req.auth.sub);
    if (await noteDepth(parent) >= MAX_NOTE_TREE_DEPTH) throw conflict("notes can only be nested 3 levels deep");
    const note = await insertNote({
      workspaceId,
      boardId: null,
      parentNoteId: parent?.id ?? null,
      scope: body.scope,
      ownerId: req.auth.sub,
      title: body.title ?? "",
      icon: body.icon ?? null,
      // New child notes inherit the parent's color when one isn't given, so a colored
      // section keeps a consistent tint. Later recolors of the parent are not propagated.
      color: body.color ?? parent?.color ?? null,
    });
    emitNoteEvent(note, "note:created", { scope: note.scope, note: wireNote(note, req.auth.cid) });
    return reply.status(201).send(wireNote(note, req.auth.cid));
  });

  app.post("/boards/:boardId/notes", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.createNoteBody.parse(req.body);
    const { workspaceId } = await assertBoardAccess(req.auth, boardId, body.scope === "team" ? "editor" : "observer");

    const parent = await resolveParent(workspaceId, boardId, body.parentNoteId ?? null, body.scope, req.auth.sub);
    if (await noteDepth(parent) >= MAX_NOTE_TREE_DEPTH) throw conflict("notes can only be nested 3 levels deep");
    const note = await insertNote({
      workspaceId,
      boardId,
      parentNoteId: parent?.id ?? null,
      scope: body.scope,
      ownerId: req.auth.sub,
      title: body.title ?? "",
      icon: body.icon ?? null,
      // New child notes inherit the parent's color when one isn't given, so a colored
      // section keeps a consistent tint. Later recolors of the parent are not propagated.
      color: body.color ?? parent?.color ?? null,
    });
    emitNoteEvent(note, "note:created", { scope: note.scope, note: wireNote(note, req.auth.cid) });
    return reply.status(201).send(wireNote(note, req.auth.cid));
  });

  app.patch("/notes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateNoteBody.parse(req.body);
    const note = await loadOrFail(id);
    await authoriseWrite(req, note);

    const now = new Date();
    if (note.scope === "team" && isLockedByOther(note, req.auth.sub)) {
      throw new AppError(409, "NOTE_LOCKED", "note is being edited by another user", {
        lock: await buildNoteLock(note, req.auth.cid),
      });
    }

    if (body.baseUpdatedAt && !sameInstant(body.baseUpdatedAt, note.updatedAt)) {
      throw new AppError(409, "NOTE_STALE", "note has changed since editing started", {
        note: wireNote(note, req.auth.cid),
      });
    }

    const content =
      body.content !== undefined ? stripSignedEmbeddedMediaUrls(body.content, req.auth.cid) ?? "" : undefined;
    const shouldReleaseLock = note.scope === "team"
      && isLockHeldBy(note, req.auth.sub)
      && (body.title !== undefined || content !== undefined);
    const writeGuards = [
      eq(notes.id, id),
      ...(body.baseUpdatedAt ? [sameWireTimestamp(notes.updatedAt, body.baseUpdatedAt)] : []),
      ...(note.scope === "team"
        ? [
          or(
            isNull(notes.editingUserId),
            eq(notes.editingUserId, req.auth.sub),
            lt(notes.editingExpiresAt, now),
          ),
        ]
        : []),
    ];

    const [updated] = await db.transaction(async (tx) => {
      const rows = await tx
        .update(notes)
        .set({
          ...(body.title !== undefined && { title: body.title }),
          ...(content !== undefined && { content }),
          ...(body.icon !== undefined && { icon: body.icon }),
          // color is metadata like icon — it is intentionally absent from shouldReleaseLock,
          // so tinting a team note never releases another user's edit lock.
          ...(body.color !== undefined && { color: body.color }),
          ...(shouldReleaseLock && { editingUserId: null, editingExpiresAt: null }),
          updatedAt: new Date(),
        })
        .where(and(...writeGuards))
        .returning();

      if (rows[0] && content !== undefined) {
        await replaceInternalLinksForSource({
          tx,
          claims: req.auth,
          workspaceId: note.workspaceId,
          sourceType: "note",
          sourceId: id,
          markdown: content,
        });
      }
      return rows;
    });

    if (!updated) {
      const latest = await loadOrFail(id);
      if (latest.scope === "team" && isLockedByOther(latest, req.auth.sub)) {
        throw new AppError(409, "NOTE_LOCKED", "note is being edited by another user", {
          lock: await buildNoteLock(latest, req.auth.cid),
        });
      }
      throw new AppError(409, "NOTE_STALE", "note has changed since editing started", {
        note: wireNote(latest, req.auth.cid),
      });
    }

    emitNoteEvent(updated, "note:updated", { note: wireNote(updated, req.auth.cid) });
    if (shouldReleaseLock) emitNoteEvent(updated, "note:unlocked", { noteId: id });
    return wireNote(updated, req.auth.cid);
  });

  app.patch("/notes/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveNoteBody.parse(req.body);
    const note = await loadOrFail(id);
    await authoriseWrite(req, note);

    let targetParent: Note | null = null;
    if (body.parentNoteId) {
      if (body.parentNoteId === id) throw conflict("cannot reparent into self");
      targetParent = await resolveParent(note.workspaceId, note.boardId, body.parentNoteId, note.scope, note.ownerId);
      // Walk ancestors to ensure we are not nesting into a descendant.
      let cursorId: string | null = body.parentNoteId;
      const visited = new Set<string>();
      while (cursorId) {
        if (visited.has(cursorId)) break;
        visited.add(cursorId);
        if (cursorId === id) throw conflict("cannot reparent into descendant");
        const [next] = await db
          .select({ parentNoteId: notes.parentNoteId })
          .from(notes)
          .where(eq(notes.id, cursorId))
          .limit(1);
        cursorId = next?.parentNoteId ?? null;
      }
    }
    const targetParentDepth = await noteDepth(targetParent);
    const subtreeDepth = await descendantDepth(id);
    if (targetParentDepth + subtreeDepth > MAX_NOTE_TREE_DEPTH) {
      throw conflict("notes can only be nested 3 levels deep");
    }

    const newParentId = body.parentNoteId;
    const base: SiblingKey = {
      workspaceId: note.workspaceId,
      boardId: note.boardId,
      scope: note.scope,
      ownerId: note.ownerId,
      parentNoteId: newParentId,
    };

    const prevPosition = note.position;
    const { position, rebalancedPositions } = await db.transaction(async (tx) => {
      const { prev, next } = await neighbourPositions(base, body.afterNoteId ?? undefined, body.beforeNoteId ?? undefined, tx);
      const result = between(prev, next);
      let position = result.position;

      await tx.update(notes).set({ parentNoteId: newParentId, position, updatedAt: new Date() }).where(eq(notes.id, id));

      const rebalancedPositions = result.needsRebalance ? await rebalanceSiblings(base, tx) : null;
      if (rebalancedPositions) position = rebalancedPositions.find((p) => p.id === id)?.position ?? position;
      return { position, rebalancedPositions };
    });

    if (rebalancedPositions) await emitRebalanceEvent(base, rebalancedPositions);

    emitNoteEvent(note, "note:moved", { noteId: id, parentNoteId: newParentId, position, prevPosition });
    return { id, position, parentNoteId: newParentId };
  });

  app.get("/notes/:id/attachments", async (req) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseRead(req, note);

    const rows = await db
      .select(noteAttachmentRowColumns)
      .from(noteAttachments)
      .innerJoin(users, eq(users.id, noteAttachments.uploadedById))
      .where(eq(noteAttachments.noteId, id))
      .orderBy(desc(noteAttachments.createdAt));

    return rows.map((row) => ({
      ...shapeAttachmentMedia(row),
      uploadedByAvatarUrl: withSignedMedia(req.auth.cid, { uploadedByAvatarUrl: row.uploadedByAvatarUrl }).uploadedByAvatarUrl,
    }));
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
    const { clientId: ownerClientId } = await authoriseWrite(req, note);

    // Host-pays: charge the org that owns the note's workspace, not the uploader's own org. Physical
    // storage stays under the uploader's tenant (req.auth.cid) — accounting only moves to the host.
    const uploadEntitlements = await getUploadEntitlements(db, ownerClientId);
    // If the host org's storage pool is already full, reject before reading the upload body so a full
    // org never wastes bandwidth streaming a file that cannot be stored.
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
    await assertCanUploadAttachment(db, ownerClientId, buffer.byteLength);

    const fileKey = noteAttachmentStorageKey(id, ext);
    const storage = await getStorageForClient(req.auth.cid);
    await putAttachmentFile(storage, fileKey, buffer, file.mimetype);
    const url = unsignedMediaUrl(req.auth.cid, fileKey)!;

    let inserted: typeof noteAttachments.$inferSelect;
    try {
      const [row] = await db
        .insert(noteAttachments)
        .values({
          noteId: id,
          clientId: ownerClientId,
          uploadedById: req.auth.sub,
          fileName: file.filename,
          mimeType: file.mimetype,
          byteSize: buffer.byteLength,
          fileKey,
          url,
          source,
        })
        .returning();
      inserted = row!;
    } catch (err) {
      await storage.delete(fileKey).catch(() => undefined);
      throw err;
    }

    const attachmentRow = await selectNoteAttachmentRow(inserted.id);
    const attachment = {
      ...shapeAttachmentMedia(attachmentRow),
      uploadedByAvatarUrl: withSignedMedia(req.auth.cid, { uploadedByAvatarUrl: attachmentRow.uploadedByAvatarUrl }).uploadedByAvatarUrl,
    };
    emitNoteEvent(note, "note:attachment:created", {
      note: wireNote(note, req.auth.cid),
      attachment,
    });
    return reply.status(201).send(attachment);
  });

  app.delete("/notes/:id/attachments/:attachmentId", async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const note = await loadOrFail(id);
    await authoriseWrite(req, note);

    const [attachment] = await db
      .select()
      .from(noteAttachments)
      .where(and(eq(noteAttachments.id, attachmentId), eq(noteAttachments.noteId, id)))
      .limit(1);
    if (!attachment) throw notFound();

    await db.delete(noteAttachments).where(eq(noteAttachments.id, attachmentId));

    const storage = await getStorageForClient(req.auth.cid);
    await storage.delete(attachment.fileKey).catch(() => undefined);

    let updatedNote: Note | null = null;
    const storedAttachmentUrl = unsignedMediaUrl(req.auth.cid, attachment.fileKey)!;
    const stripped = stripAttachmentReferences(note.content, storedAttachmentUrl);
    if (stripped.changed) {
      const [updated] = await db
        .update(notes)
        .set({ content: stripped.body ?? "", updatedAt: new Date() })
        .where(eq(notes.id, id))
        .returning();
      updatedNote = updated ?? null;
    }

    const eventNote = updatedNote ?? note;
    if (updatedNote) {
      emitNoteEvent(updatedNote, "note:updated", { note: wireNote(updatedNote, req.auth.cid) });
    }
    emitNoteEvent(eventNote, "note:attachment:deleted", {
      note: wireNote(eventNote, req.auth.cid),
      attachmentId,
    });

    return reply.status(204).send();
  });

  app.delete("/notes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseWrite(req, note);
    await db.transaction(async (tx) => {
      await tx.delete(internalLinks).where(or(
        and(eq(internalLinks.sourceType, "note"), eq(internalLinks.sourceId, id)),
        and(eq(internalLinks.targetType, "note"), eq(internalLinks.targetId, id)),
      ));
      await tx.delete(notes).where(eq(notes.id, id));
    });
    emitNoteEvent(note, "note:deleted", { noteId: id });
    return reply.status(204).send();
  });

  app.post("/notes/:id/lock", async (req) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseWrite(req, note);
    if (note.scope === "personal") {
      const expiresAt = new Date(Date.now() + LOCK_TTL_MS);
      return buildNoteLockForUser(id, req.auth.sub, expiresAt, req.auth.cid);
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
    const [updated] = await db
      .update(notes)
      .set({ editingUserId: req.auth.sub, editingExpiresAt: expiresAt })
      .where(
        and(
          eq(notes.id, id),
          or(
            isNull(notes.editingUserId),
            eq(notes.editingUserId, req.auth.sub),
            lt(notes.editingExpiresAt, now),
          ),
        ),
      )
      .returning();
    if (!updated) {
      throw new AppError(409, "NOTE_LOCKED", "note is being edited by another user", {
        lock: await buildNoteLock(note, req.auth.cid),
      });
    }
    emitNoteEvent(updated, "note:locked", {
      ...(await buildNoteLock(updated, req.auth.cid)),
    });
    return buildNoteLock(updated, req.auth.cid);
  });

  app.post("/notes/:id/unlock", async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = await loadOrFail(id);
    await authoriseWrite(req, note);
    if (note.scope === "personal") return reply.status(204).send();
    const [updated] = await db
      .update(notes)
      .set({ editingUserId: null, editingExpiresAt: null })
      .where(and(eq(notes.id, id), eq(notes.editingUserId, req.auth.sub)))
      .returning();
    if (updated) emitNoteEvent(updated, "note:unlocked", { noteId: id });
    return reply.status(204).send();
  });
}
