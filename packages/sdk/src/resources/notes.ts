import type { Attachment, ColorToken, Note, NoteDetail, NoteScope, PositionAnchor, Uuid } from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

/** Notes hang off either a standard workspace or a board — never both. */
export type NoteTarget =
  | { type: "workspace"; workspaceId: Uuid }
  | { type: "board"; boardId: Uuid };

export interface CreateNoteInput {
  /** `personal` notes are private to the credential's owner; `team` notes are shared. */
  scope?: NoteScope;
  parentNoteId?: Uuid | null;
  title?: string;
  icon?: string | null;
  color?: ColorToken | null;
}

export interface UpdateNoteInput {
  title?: string;
  /** Markdown body. */
  content?: string;
  icon?: string | null;
  color?: ColorToken | null;
  /**
   * The `updatedAt` the edit was based on. Supply it to make the write conflict rather than
   * silently overwrite a concurrent edit.
   */
  baseUpdatedAt?: string;
}

function targetPath(target: NoteTarget): string {
  return target.type === "board" ? `/api/v1/boards/${target.boardId}/notes` : `/api/v1/workspaces/${target.workspaceId}/notes`;
}

/**
 * Note deletion is deliberately absent: the public API registers note routes with deletes disabled,
 * so a `delete` method here could only ever fail. Remove notes in the Kanera UI.
 */
export class Notes {
  constructor(private readonly ctx: ResourceContext) {}

  /** Flat metadata; `parentNoteId` expresses the hierarchy. Bodies come from {@link get}. */
  list(target: NoteTarget, options: { scope?: NoteScope; limit?: number; offset?: number } & CallOptions = {}): Promise<Note[]> {
    const { scope = "team", limit, offset, ...call } = options;
    return this.ctx.http.get<Note[]>(targetPath(target), { ...call, query: { scope, limit, offset } });
  }

  get(noteId: Uuid, options: CallOptions = {}): Promise<NoteDetail> {
    return this.ctx.http.get<NoteDetail>(`/api/v1/notes/${noteId}`, options);
  }

  create(target: NoteTarget, body: CreateNoteInput = {}, options: CallOptions = {}): Promise<NoteDetail> {
    return this.ctx.http.post<NoteDetail>(targetPath(target), { scope: "team", ...body }, options);
  }

  update(noteId: Uuid, body: UpdateNoteInput, options: CallOptions = {}): Promise<NoteDetail> {
    return this.ctx.http.patch<NoteDetail>(`/api/v1/notes/${noteId}`, body, options);
  }

  move(
    noteId: Uuid,
    body: { parentNoteId: Uuid | null; anchor?: PositionAnchor },
    options: CallOptions = {},
  ): Promise<Note> {
    const anchor = body.anchor
      ? body.anchor.side === "after" ? { afterNoteId: body.anchor.id } : { beforeNoteId: body.anchor.id }
      : {};
    return this.ctx.http.patch<Note>(`/api/v1/notes/${noteId}/move`, { parentNoteId: body.parentNoteId, ...anchor }, options);
  }

  duplicate(noteId: Uuid, body: { parentNoteId?: Uuid | null; title?: string } = {}, options: CallOptions = {}): Promise<NoteDetail> {
    return this.ctx.http.post<NoteDetail>(`/api/v1/notes/${noteId}/duplicate`, body, options);
  }

  /** Cards and notes that link to this note. */
  backlinks(noteId: Uuid, options: CallOptions = {}): Promise<{ cards: unknown[]; notes: unknown[] }> {
    return this.ctx.http.get(`/api/v1/notes/${noteId}/backlinks`, options);
  }

  listAttachments(noteId: Uuid, options: CallOptions = {}): Promise<Attachment[]> {
    return this.ctx.http.get<Attachment[]>(`/api/v1/notes/${noteId}/attachments`, options);
  }

  addAttachment(
    noteId: Uuid,
    file: Blob | { bytes: Uint8Array; fileName: string; contentType?: string },
    options: CallOptions = {},
  ): Promise<Attachment> {
    return this.ctx.http.upload<Attachment>(`/api/v1/notes/${noteId}/attachments`, file, options);
  }

  deleteAttachment(noteId: Uuid, attachmentId: Uuid, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.delete<void>(`/api/v1/notes/${noteId}/attachments/${attachmentId}`, options);
  }
}
