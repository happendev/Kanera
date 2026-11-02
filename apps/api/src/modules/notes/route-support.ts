import type { ColorToken } from "@kanera/shared/colors";
import type { ServerToClientEvents, WireNote } from "@kanera/shared/events";
import { notes, users, workspaces, type Note, type NoteScope } from "@kanera/shared/schema";
import { asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertBoardAccess, assertWorkspaceAccess, assertWriteCapableCredential } from "../../lib/access.js";
import { AppError, conflict, forbidden, notFound } from "../../lib/errors.js";
import { signedAvatarUrl, signEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { between } from "../../lib/position.js";
import { emitToBoard, emitToUser, emitToWorkspace } from "../../realtime/emit.js";
import { siblingFilter, type DbLike, type SiblingKey } from "./note-positions.js";

export const MAX_NOTE_TREE_DEPTH = 3;

type LastEditor = {
  id: string;
  clientId: string;
  displayName: string;
  avatarUrl: string | null;
};

function wireNote(note: Note, clientId: string, editor: LastEditor): WireNote {
  return {
    ...note,
    content: signEmbeddedMediaUrls(note.content, clientId) ?? "",
    lastEditedByName: editor.displayName,
    lastEditedByAvatarUrl: signedAvatarUrl(editor.clientId, editor.avatarUrl),
  };
}

/**
 * Directory listings page in SQL. Notes carry full markdown bodies, so applying limit/offset in JS
 * meant selecting every note in the workspace (or on the board) to return one page of them.
 */
export async function pageNotes(filter: SQL | undefined, directory: { limit?: number; offset: number }): Promise<Note[]> {
  const query = db.select().from(notes).where(filter).orderBy(asc(notes.position));
  if (directory.limit === undefined) return query;
  return query.limit(directory.limit).offset(directory.offset);
}

export async function wireNotes(rows: Note[], clientId: string): Promise<WireNote[]> {
  if (rows.length === 0) return [];
  const editorIds = [...new Set(rows.map((note) => note.lastEditedById))];
  const editors = await db
    .select({
      id: users.id,
      clientId: users.clientId,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, editorIds));
  const editorById = new Map(editors.map((editor) => [editor.id, editor]));
  return rows.map((note) => {
    const editor = editorById.get(note.lastEditedById);
    // The FK is restrictive and non-null, so absence means the database is inconsistent rather than
    // an attribution state clients should have to represent.
    if (!editor) throw new Error(`last editor ${note.lastEditedById} not found for note ${note.id}`);
    return wireNote(note, clientId, editor);
  });
}

export async function shapeNote(note: Note, clientId: string): Promise<WireNote> {
  return (await wireNotes([note], clientId))[0]!;
}

function assertScopeAccess(note: Pick<Note, "scope" | "ownerId">, userId: string) {
  if (note.scope === "personal" && note.ownerId !== userId) throw forbidden();
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

export function emitNoteEvent<E extends NoteEventName>(
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

export async function loadOrFail(id: string): Promise<Note> {
  const [note] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  if (!note) throw notFound();
  return note;
}

/**
 * Notes can be switched off per workspace (and so per standalone board, via its hidden workspace).
 * Run after the access check so outsiders still get the ordinary 403/404 rather than learning the
 * workspace's settings. Rows are kept while disabled, so every read and write path is closed here
 * instead of deleting anything.
 */
export async function assertNotesEnabled(workspaceId: string) {
  const [workspace] = await db.select({ notesEnabled: workspaces.notesEnabled }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace) throw notFound();
  if (!workspace.notesEnabled) throw new AppError(403, "NOTES_DISABLED", "notes are disabled for this workspace");
}

export async function authoriseRead(auth: AuthClaims, note: Note) {
  if (note.boardId) await assertBoardAccess(auth, note.boardId, "observer");
  else await assertWorkspaceAccess(auth, note.workspaceId, "member");
  assertScopeAccess(note, auth.sub);
  await assertNotesEnabled(note.workspaceId);
}

// Returns the org that owns the note's workspace (host-pays storage attribution). Both access
// helpers resolve clientId from workspaces.client_id, so this is the host org even for cross-org guests.
export async function authoriseWrite(auth: AuthClaims, note: Note): Promise<{ clientId: string }> {
  // Personal notes authorise at plain member/observer, so the role ranks cannot catch a read-scoped
  // credential: gate it here (see assertWriteCapableCredential).
  assertWriteCapableCredential(auth);
  // Board and workspace roles are different scales. Personal notes only need read-level access to
  // manage one's own; team notes are shared, so board team notes need editor. Workspace team notes
  // are editable by every workspace member: they are the team's shared space, not admin config.
  const ctx = note.boardId
    ? await assertBoardAccess(auth, note.boardId, note.scope === "personal" ? "observer" : "editor")
    : await assertWorkspaceAccess(auth, note.workspaceId, "member");
  assertScopeAccess(note, auth.sub);
  await assertNotesEnabled(note.workspaceId);
  return { clientId: ctx.clientId };
}

export async function resolveParent(
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

export async function noteDepth(note: Pick<Note, "id" | "parentNoteId"> | null): Promise<number> {
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

export async function insertNote(input: {
  workspaceId: string;
  boardId: string | null;
  parentNoteId: string | null;
  scope: NoteScope;
  ownerId: string;
  lastEditedById: string;
  title: string;
  content?: string;
  icon: string | null;
  color: ColorToken | null;
  id?: string;
}, tx: DbLike = db): Promise<Note> {
  const base: SiblingKey = {
    workspaceId: input.workspaceId,
    boardId: input.boardId,
    scope: input.scope,
    ownerId: input.ownerId,
    parentNoteId: input.parentNoteId,
  };
  const [last] = await tx
    .select({ position: notes.position })
    .from(notes)
    .where(siblingFilter(base))
    .orderBy(desc(notes.position))
    .limit(1);
  const { position } = between(last?.position ?? null, null);
  const [note] = await tx
    .insert(notes)
    .values({
      ...(input.id && { id: input.id }),
      workspaceId: input.workspaceId,
      boardId: input.boardId,
      parentNoteId: input.parentNoteId,
      scope: input.scope,
      ownerId: input.ownerId,
      lastEditedById: input.lastEditedById,
      title: input.title,
      content: input.content ?? "",
      icon: input.icon,
      color: input.color,
      position,
    })
    .returning();
  return note!;
}
