import { Injectable, computed, inject, signal } from "@angular/core";
import type { ColorToken } from "@kanera/shared/colors";
import type { ServerToClientEvents, WireNote, WireNoteLock } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { SocketService } from "../../core/realtime/socket.service";
import type { NoteScopeValue } from "./notes.types";

interface ScopeContext {
  workspaceId: string;
  boardId: string | null;
}

/**
 * Per-route NotesState. Holds both personal and team notes for whichever scope
 * (workspace or board) is active, fetches them, and consumes the realtime
 * events so multiple tabs stay in sync.
 *
 * Lifecycle:
 *   - call init(ctx) once when the view mounts.
 *   - call dispose() when the view tears down to detach socket handlers.
 */
@Injectable()
export class NotesState {
  private readonly api = inject(ApiClient);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly sockets = inject(SocketService);

  private ctx: ScopeContext | null = null;
  private detach: (() => void) | null = null;

  readonly loading = signal(false);
  readonly notes = signal<WireNote[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly locks = signal<Record<string, WireNoteLock>>({});
  readonly online = this.sockets.displayedOnline;

  readonly personalNotes = computed(() => this.notes().filter((n) => n.scope === "personal"));
  readonly teamNotes = computed(() => this.notes().filter((n) => n.scope === "team"));

  context(): ScopeContext | null {
    return this.ctx;
  }

  async init(ctx: ScopeContext) {
    this.ctx = ctx;
    this.loading.set(true);
    try {
      const [personal, team] = await Promise.all([
        this.fetchScope("personal"),
        this.fetchScope("team"),
      ]);
      this.notes.set([...personal, ...team]);
      this.persistSnapshot();
    } catch (error) {
      const cached = await this.offlineCache.loadNotes(ctx.workspaceId, ctx.boardId).catch(() => null);
      if (!cached) throw error;
      this.notes.set(cached.notes);
    } finally {
      this.loading.set(false);
    }
    this.attachSocket();
  }

  dispose() {
    this.detach?.();
    this.detach = null;
    this.ctx = null;
    this.notes.set([]);
    this.locks.set({});
    this.selectedId.set(null);
  }

  private basePath(): string {
    if (!this.ctx) throw new Error("NotesState not initialised");
    return this.ctx.boardId
      ? `/boards/${this.ctx.boardId}/notes`
      : `/workspaces/${this.ctx.workspaceId}/notes`;
  }

  private async fetchScope(scope: NoteScopeValue): Promise<WireNote[]> {
    return this.api.get<WireNote[]>(`${this.basePath()}?scope=${scope}`);
  }

  async createNote(input: {
    scope: NoteScopeValue;
    parentNoteId: string | null;
    title?: string;
    icon?: string | null;
  }): Promise<WireNote> {
    this.assertOnline();
    const note = await this.api.post<WireNote>(this.basePath(), {
      scope: input.scope,
      parentNoteId: input.parentNoteId,
      title: input.title ?? "",
      icon: input.icon ?? null,
    });
    this.upsertNote(note);
    this.persistSnapshot();
    return note;
  }

  async updateNote(
    id: string,
    patch: { title?: string; content?: string; icon?: string | null; color?: ColorToken | null; baseUpdatedAt?: string },
  ): Promise<WireNote> {
    this.assertOnline();
    const note = await this.api.patch<WireNote>(`/notes/${id}`, patch);
    this.upsertNote(note);
    this.persistSnapshot();
    return note;
  }

  async moveNote(
    id: string,
    parentNoteId: string | null,
    anchor: { afterNoteId?: string | null; beforeNoteId?: string | null },
  ): Promise<void> {
    this.assertOnline();
    const body = {
      parentNoteId,
      ...(anchor.afterNoteId !== undefined ? { afterNoteId: anchor.afterNoteId } : {}),
      ...(anchor.beforeNoteId !== undefined ? { beforeNoteId: anchor.beforeNoteId } : {}),
    };
    const moved = await this.api.patch<{ id: string; position: string; parentNoteId: string | null }>(
      `/notes/${id}/move`,
      body,
    );
    this.notes.update((rows) =>
      rows.map((n) => (n.id === id ? { ...n, position: moved.position, parentNoteId: moved.parentNoteId } : n)),
    );
    this.persistSnapshot();
  }

  async deleteNote(id: string): Promise<void> {
    this.assertOnline();
    await this.api.delete(`/notes/${id}`);
    this.removeWithDescendants(id);
    this.persistSnapshot();
  }

  async fetchOne(id: string): Promise<WireNote> {
    const note = await this.api.get<WireNote>(`/notes/${id}`);
    this.upsertNote(note);
    this.persistSnapshot();
    return note;
  }

  async acquireLock(id: string): Promise<WireNoteLock> {
    this.assertOnline();
    const lock = await this.api.post<WireNoteLock>(`/notes/${id}/lock`, {});
    this.applyLock(lock);
    return lock;
  }

  async releaseLock(id: string): Promise<void> {
    if (!this.online()) return;
    await this.api.post<unknown>(`/notes/${id}/unlock`, {});
    this.clearLock(id);
  }

  lockFor(note: WireNote | null): WireNoteLock | null {
    if (!note?.editingUserId || !note.editingExpiresAt) return null;
    const expiresAt = typeof note.editingExpiresAt === "string" ? note.editingExpiresAt : note.editingExpiresAt.toISOString();
    const lock = this.locks()[note.id];
    return lock ?? {
      noteId: note.id,
      editingUserId: note.editingUserId,
      editingUserName: "Someone",
      editingUserAvatarUrl: null,
      editingExpiresAt: expiresAt,
    };
  }

  isLockExpired(lock: Pick<WireNoteLock, "editingExpiresAt"> | null): boolean {
    if (!lock) return true;
    return new Date(lock.editingExpiresAt).getTime() <= Date.now();
  }

  receiveLock(lock: WireNoteLock) {
    this.applyLock(lock);
  }

  private upsertNote(note: WireNote) {
    this.notes.update((rows) => {
      const existing = rows.findIndex((n) => n.id === note.id);
      if (existing === -1) return [...rows, note];
      const next = rows.slice();
      next[existing] = note;
      return next;
    });
  }

  private persistSnapshot() {
    if (!this.ctx) return;
    void this.offlineCache.saveNotes(this.ctx.workspaceId, this.ctx.boardId, this.notes()).catch(() => undefined);
  }

  private assertOnline() {
    if (!this.online()) {
      throw new Error("You're offline - changes are paused");
    }
  }

  private applyLock(lock: WireNoteLock) {
    this.locks.update((locks) => ({ ...locks, [lock.noteId]: lock }));
    this.notes.update((rows) =>
      rows.map((n) =>
        n.id === lock.noteId
          ? { ...n, editingUserId: lock.editingUserId, editingExpiresAt: new Date(lock.editingExpiresAt) as unknown as Date | null }
          : n,
      ),
    );
  }

  private clearLock(noteId: string) {
    this.locks.update((locks) => {
      const next = { ...locks };
      delete next[noteId];
      return next;
    });
    this.notes.update((rows) =>
      rows.map((n) => (n.id === noteId ? { ...n, editingUserId: null, editingExpiresAt: null } : n)),
    );
  }

  private removeWithDescendants(id: string) {
    this.notes.update((rows) => {
      const toRemove = new Set<string>([id]);
      let added = true;
      while (added) {
        added = false;
        for (const n of rows) {
          if (n.parentNoteId && toRemove.has(n.parentNoteId) && !toRemove.has(n.id)) {
            toRemove.add(n.id);
            added = true;
          }
        }
      }
      return rows.filter((n) => !toRemove.has(n.id));
    });
    if (this.selectedId() && this.notes().every((n) => n.id !== this.selectedId())) {
      this.selectedId.set(null);
    }
  }

  private isCurrentScope(note: { workspaceId: string; boardId: string | null }): boolean {
    if (!this.ctx) return false;
    return note.workspaceId === this.ctx.workspaceId && note.boardId === this.ctx.boardId;
  }

  private attachSocket() {
    const socket = this.sockets.connect();
    let leaveWorkspace: (() => void) | null = null;
    // Workspace-scoped team notes ride on the workspace room; board-scoped notes
    // ride on the board room (which the board page already joins).
    if (!this.ctx?.boardId && this.ctx) {
      leaveWorkspace = this.sockets.joinWorkspace(this.ctx.workspaceId);
    }

    const handlers: Partial<ServerToClientEvents> = {
      "note:created": ({ note }) => {
        if (!this.isCurrentScope(note)) return;
        this.upsertNote(note);
        this.persistSnapshot();
      },
      "note:updated": ({ note }) => {
        if (!this.isCurrentScope(note)) return;
        this.upsertNote(note);
        this.persistSnapshot();
      },
      "note:moved": ({ noteId, parentNoteId, position }) => {
        if (!this.notes().some((n) => n.id === noteId)) return;
        this.notes.update((rows) =>
          rows.map((n) => (n.id === noteId ? { ...n, parentNoteId, position } : n)),
        );
        this.persistSnapshot();
      },
      "note:rebalanced": ({ positions }) => {
        const byId = new Map(positions.map((p) => [p.id, p.position]));
        if (!this.notes().some((n) => byId.has(n.id))) return;
        this.notes.update((rows) =>
          rows.map((n) => {
            const position = byId.get(n.id);
            return position ? { ...n, position } : n;
          }),
        );
        this.persistSnapshot();
      },
      "note:deleted": ({ noteId }) => {
        if (!this.notes().some((n) => n.id === noteId)) return;
        this.removeWithDescendants(noteId);
        this.persistSnapshot();
      },
      "note:locked": (lock) => this.applyLock(lock),
      "note:unlocked": ({ noteId }) => {
        this.clearLock(noteId);
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      socket.on(event as keyof ServerToClientEvents, handler as never);
    }

    this.detach = () => {
      for (const [event, handler] of Object.entries(handlers)) {
        socket.off(event as keyof ServerToClientEvents, handler as never);
      }
      leaveWorkspace?.();
    };
  }
}
