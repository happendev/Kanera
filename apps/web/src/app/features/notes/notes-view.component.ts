import type {
  OnDestroy,
  OnInit} from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import type { WireBoardMemberUser, WireWorkspaceMember } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { ApiError } from "../../core/api/api.client";
import { notesTabKey } from "../../core/browser/browser-contracts";
import { ConfirmService } from "../../shared/confirm.service";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { NoteEditorComponent } from "./note-editor.component";
import { NotesTreeComponent, type NoteMoveRequest } from "./notes-tree.component";
import { NotesState } from "./notes.service";
import type { NoteScopeValue } from "./notes.types";

/**
 * Shared two-pane Notes view used by both the board Notes view and the
 * workspace-level Notes page. Owns scope tab state (My / Team) and a single
 * selected-note signal.
 */
@Component({
  selector: "k-notes-view",
  standalone: true,
  imports: [NotesTreeComponent, NoteEditorComponent, TooltipDirective],
  providers: [NotesState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="nv-shell" [class.sidebar-open]="sidebarOpen()">
      <div class="nv-backdrop" (click)="closeSidebar()" aria-hidden="true"></div>
      <aside class="nv-sidebar">
        <div class="nv-tabs" role="tablist">
          <button
            type="button"
            class="nv-tab"
            role="tab"
            [attr.aria-selected]="activeTab() === 'personal'"
            [class.active]="activeTab() === 'personal'"
            (click)="setTab('personal')">
            <i class="ti ti-user"></i>
            <span>My notes</span>
          </button>
          <button
            type="button"
            class="nv-tab"
            role="tab"
            [attr.aria-selected]="activeTab() === 'team'"
            [class.active]="activeTab() === 'team'"
            (click)="setTab('team')">
            <i class="ti ti-users"></i>
            <span>Team</span>
          </button>
        </div>
        <div class="nv-toolbar">
          <button class="nv-new-btn" type="button" (click)="createRoot()" [disabled]="!canEdit()" [kTooltip]="offlineTitle()">
            <i class="ti ti-plus"></i>
            <span>New note</span>
          </button>
        </div>
        <div class="nv-tree">
          @if (state.loading()) {
            <div class="nv-loading">
              <i class="ti ti-loader-2"></i>
              <span>Loading…</span>
            </div>
          } @else {
            <k-notes-tree
              [items]="visibleNotes()"
              [selectedId]="state.selectedId()"
              [currentUserId]="currentUserId()"
              [canEdit]="canEdit()"
              (selectNote)="selectNote($event)"
              (newChild)="createChild($event)"
              (noteDuplicate)="duplicateNote($event)"
              (noteDelete)="deleteNote($event)"
              (move)="moveNote($event)" />
          }
        </div>
      </aside>
      <section class="nv-main">
        <button
          type="button"
          class="nv-sidebar-toggle"
          (click)="toggleSidebar()"
          [attr.aria-label]="sidebarOpen() ? 'Close notes sidebar' : 'Open notes sidebar'">
          <i [class]="sidebarOpen() ? 'ti ti-x' : 'ti ti-notes'"></i>
          <span>{{ sidebarOpen() ? "Close" : "Notes menu" }}</span>
        </button>
        <k-note-editor [note]="selectedNote()" [mentionMembers]="editorMentionMembers()" [canEdit]="canEdit()" />
      </section>
    </div>
  `,
  styleUrl: "./notes-view.component.scss",
})
export class NotesViewComponent implements OnInit, OnDestroy {
  protected readonly state = inject(NotesState);
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly confirmService = inject(ConfirmService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly workspaceId = input.required<string>();
  readonly boardId = input<string | null>(null);
  readonly noteId = input<string | undefined>();
  readonly mentionMembers = input<WireBoardMemberUser[] | null>(null);

  readonly activeTab = signal<NoteScopeValue>("personal");
  readonly sidebarOpen = signal(false);
  readonly workspaceMentionMembers = signal<WireBoardMemberUser[]>([]);
  readonly currentUserId = computed(() => this.auth.user()?.id ?? null);
  readonly canEdit = computed(() => this.state.online());
  readonly offlineTitle = computed(() => this.canEdit() ? null : "You're offline - changes are paused");
  readonly editorMentionMembers = computed(() => this.mentionMembers() ?? this.workspaceMentionMembers());

  readonly visibleNotes = computed(() => {
    const tab = this.activeTab();
    return this.state.notes().filter((n) => n.scope === tab);
  });

  readonly selectedNote = computed(() => {
    const id = this.state.selectedId();
    if (!id) return null;
    return this.state.notes().find((n) => n.id === id) ?? null;
  });

  constructor() {
    // Persist active tab per scope.
    effect(() => {
      const key = this.storageKey();
      const stored = key ? localStorage.getItem(key) : null;
      if (stored === "team" || stored === "personal") {
        // Read-once during component lifecycle init; no-op after.
        if (this.activeTab() !== stored) this.activeTab.set(stored);
      }
    }, { allowSignalWrites: true });
  }

  async ngOnInit() {
    const wsId = this.workspaceId();
    const boardId = this.boardId();
    try {
      await this.state.init({ workspaceId: wsId, boardId });
      if (!this.mentionMembers()) await this.loadWorkspaceMentionMembers(wsId);
      this.restoreSelectedNote();
    } catch (err) {
      console.error("Failed to load notes", err);
    }
  }

  ngOnDestroy() {
    this.state.dispose();
  }

  private storageKey(): string | null {
    const wsId = this.workspaceId();
    if (!wsId) return null;
    const boardId = this.boardId();
    return notesTabKey(boardId ?? "ws", wsId);
  }

  setTab(tab: NoteScopeValue) {
    this.activeTab.set(tab);
    const key = this.storageKey();
    if (key) localStorage.setItem(key, tab);
    this.state.selectedId.set(null);
    this.writeSelectedNoteToUrl(null);
  }

  toggleSidebar() {
    this.sidebarOpen.update((v) => !v);
  }

  closeSidebar() {
    this.sidebarOpen.set(false);
  }

  selectNote(id: string) {
    this.state.selectedId.set(id);
    this.writeSelectedNoteToUrl(id);
    this.closeSidebar();
  }

  async createRoot() {
    if (!this.canEdit()) return;
    try {
      const note = await this.state.createNote({
        scope: this.activeTab(),
        parentNoteId: null,
        title: "Untitled",
      });
      this.state.selectedId.set(note.id);
      this.writeSelectedNoteToUrl(note.id);
    } catch (err) {
      console.error("Failed to create note", err);
    }
  }

  async createChild(parentId: string | null) {
    if (!this.canEdit()) return;
    try {
      const note = await this.state.createNote({
        scope: this.activeTab(),
        parentNoteId: parentId,
        title: "Untitled",
      });
      this.state.selectedId.set(note.id);
      this.writeSelectedNoteToUrl(note.id);
    } catch (err) {
      console.error("Failed to create note", err);
    }
  }

  async duplicateNote(id: string) {
    if (!this.canEdit()) return;
    const source = this.state.notes().find((n) => n.id === id);
    if (!source) return;
    try {
      const note = await this.state.createNote({
        scope: source.scope,
        parentNoteId: source.parentNoteId,
        title: this.duplicateTitle(source.title),
        icon: source.icon,
      });
      if (source.content) {
        await this.state.updateNote(note.id, {
          content: source.content,
          baseUpdatedAt: this.wireTimestamp(note.updatedAt),
        });
      }
      this.state.selectedId.set(note.id);
      this.activeTab.set(note.scope);
      this.writeSelectedNoteToUrl(note.id);
    } catch (err) {
      console.error("Failed to duplicate note", err);
    }
  }

  async deleteNote(id: string) {
    if (!this.canEdit()) return;
    const note = this.state.notes().find((n) => n.id === id);
    const title = note?.title?.trim() || "Untitled";
    const hasChildren = this.state.notes().some((n) => n.parentNoteId === id);
    const confirmed = await this.confirmService.open({
      title: `Delete "${title}"?`,
      message: hasChildren
        ? "This note and all of its sub-notes will be permanently deleted."
        : "This note will be permanently deleted.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await this.state.deleteNote(id);
      if (this.state.selectedId() === null) this.writeSelectedNoteToUrl(null);
    } catch (err) {
      console.error("Failed to delete note", err);
    }
  }

  async moveNote(request: NoteMoveRequest) {
    if (!this.canEdit()) return;
    try {
      await this.state.moveNote(request.noteId, request.newParentId, {
        afterNoteId: request.afterNoteId,
        beforeNoteId: request.beforeNoteId,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Cycle or other conflict — refetch a clean snapshot.
        console.warn("Note move rejected:", err.body);
      } else {
        console.error("Failed to move note", err);
      }
    }
  }

  private restoreSelectedNote() {
    const noteId = this.noteId();
    if (!noteId) return;
    const note = this.state.notes().find((n) => n.id === noteId);
    if (!note) {
      this.writeSelectedNoteToUrl(null);
      return;
    }
    this.activeTab.set(note.scope);
    const key = this.storageKey();
    if (key) localStorage.setItem(key, note.scope);
    this.state.selectedId.set(note.id);
  }

  private writeSelectedNoteToUrl(noteId: string | null) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { noteId },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  private duplicateTitle(title: string): string {
    const base = title.trim() || "Untitled";
    const suffix = " copy";
    return base.length + suffix.length <= 200
      ? `${base}${suffix}`
      : `${base.slice(0, 200 - suffix.length).trimEnd()}${suffix}`;
  }

  private wireTimestamp(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : value;
  }

  private async loadWorkspaceMentionMembers(workspaceId: string) {
    const rows = await this.api.get<WireWorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
    this.workspaceMentionMembers.set(rows
      .map((row) => ({
        userId: row.userId,
        displayName: row.displayName ?? row.email ?? "",
        avatarUrl: row.avatarUrl ?? null,
        role: row.role,
        source: "workspace" as const,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)));
  }
}
