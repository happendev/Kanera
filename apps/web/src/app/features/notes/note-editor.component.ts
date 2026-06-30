import type {
  ElementRef,
  OnDestroy} from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { ALLOWED_ATTACHMENT_EXTENSIONS, ALLOWED_ATTACHMENT_MIME } from "@kanera/shared/attachments";
import { SERVER_EVENTS, type NoteAttachmentRow, type ServerToClientEvents, type WireBoardMemberUser, type WireNote, type WireNoteLock } from "@kanera/shared/events";
import type { BacklinkSummary, NoteBacklinksResponse } from "@kanera/shared/dto";
import type { ColorToken } from "@kanera/shared/colors";
import { AuthService } from "../../core/auth/auth.service";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { EditorDrafts } from "../../core/browser/editor-drafts";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import { SocketService } from "../../core/realtime/socket.service";
import { ConfirmService } from "../../shared/confirm.service";
import { attachmentIconClass } from "../../shared/attachment-icons";
import { AttachmentUploadListComponent } from "../../shared/attachments/attachment-upload-list.component";
import { AttachmentUploadQueue } from "../../shared/attachments/attachment-upload-queue.service";
import { DraftBannerComponent } from "../../shared/draft-banner.component";
import { IconPickerComponent } from "../../shared/icon-picker.component";
import { ColorPickerComponent } from "../../shared/color-picker.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DescriptionEditorComponent, type EditorSaveEvent } from "../board/description-editor.component";
import { DescriptionViewerComponent } from "../board/description-viewer.component";
import { ImageLightboxService } from "../board/image-lightbox.service";
import { NotesState } from "./notes.service";

const LOCK_HEARTBEAT_MS = 30_000; // 30 seconds
const OFFLINE_DRAFT_MESSAGES = new Set([
  "You're offline - your draft was preserved. Reconnect before editing notes.",
  "Saved as draft. Reconnect to publish.",
]);
@Component({
  selector: "k-note-editor",
  standalone: true,
  imports: [DescriptionEditorComponent, DescriptionViewerComponent, DraftBannerComponent, IconPickerComponent, ColorPickerComponent, TooltipDirective, AttachmentUploadListComponent],
  // Component-scoped so each open note has its own upload queue.
  providers: [AttachmentUploadQueue],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (note(); as n) {
      <div #shell class="ne-shell" [class.is-attachment-drag-active]="attachmentDragActive()" (paste)="onNotePaste($event)">
        @if (attachmentDragActive()) {
          <div class="ne-drop-overlay" aria-hidden="true">
            <i class="ti ti-upload"></i>
            <span>Drop to attach</span>
          </div>
        }
        @if (heldByOther()) {
          <div class="ne-banner">
            <i class="ti ti-lock"></i>
            @if (activeLock(); as lock) {
              @if (visibleMediaUrl(lock.editingUserAvatarUrl); as avatarUrl) {
                <img class="ne-lock-avatar" [src]="avatarUrl" alt="" />
              }
              <span>{{ lockHolderName(lock) }} is editing this note. Your view is read-only{{ lockTimeHint(lock) }}.</span>
              @if (lockExpired()) {
                <button type="button" class="ne-banner-action" (click)="startBodyEdit()">Edit anyway</button>
              }
            }
          </div>
        }
        @if (saveError(); as err) {
          <div class="ne-banner is-error" role="alert">
            <i class="ti ti-alert-triangle"></i>
            <span>{{ err }}</span>
            <button type="button" class="ne-banner-dismiss" (click)="saveError.set(null)" aria-label="Dismiss">
              <i class="ti ti-x"></i>
            </button>
          </div>
        }
        @if (preservedDraft()) {
          <k-draft-banner class="ne-preserved-draft-banner" mode="saved" [showEdit]="false" (discard)="discardPreservedDraft()" />
        }
        <div class="ne-scroll">
          <div class="ne-doc">
            <div class="ne-head">
              <k-icon-picker
                [value]="icon() || 'file-text'"
                [color]="color()"
                [disabled]="!canEdit() || lockedByOther()"
                [disabledTitle]="disabledTitle()"
                (valueChange)="onIconChange($event)" />
              <k-color-picker
                [value]="color()"
                (valueChange)="onColorChange($event)" />
              @if (editingTitle()) {
                <input
                  class="ne-title-input"
                  type="text"
                  placeholder="Untitled"
                  [value]="title()"
                  [disabled]="!canEdit() || lockedByOther() || acquiringLock()"
                  (input)="title.set($any($event.target).value)"
                  (blur)="saveTitle()"
                  (keydown.enter)="saveTitle()"
                  (keydown.escape)="cancelTitleEdit()"
                  autofocus />
              } @else {
                <h2 class="ne-title" [class.is-readonly]="!canEdit() || lockedByOther()" (click)="startTitleEdit()">{{ title() || 'Untitled' }}</h2>
              }
              <button type="button" class="ne-copy-link" (click)="copyNoteLink(n); $event.stopPropagation()" aria-label="Copy note link" kTooltip="Copy note link">
                <i class="ti ti-link"></i>
              </button>
            </div>
            <div class="ne-meta">
              <span class="ne-meta-chip" [class.personal]="n.scope === 'personal'" [class.team]="n.scope === 'team'">
                @if (n.scope === 'personal') {
                  <i class="ti ti-user"></i><span>Private</span>
                } @else {
                  <i class="ti ti-users"></i><span>Team</span>
                }
              </span>
            </div>
            @if (backlinks().length) {
              <div class="ne-backlinks">
                <div class="ne-backlinks-label">
                  <i class="ti ti-arrow-back-up"></i>
                  <span>Backlinks</span>
                </div>
                <div class="ne-backlinks-list">
                  @for (link of backlinks(); track link.kind + ':' + link.id) {
                    <a class="ne-backlink" [href]="backlinkHref(link)">
                      <i [class]="'ti ti-' + backlinkIcon(link)"
                        [style.color]="backlinkColor(link) ? 'var(--color-' + backlinkColor(link) + ')' : null"></i>
                      <span class="ne-backlink-title">{{ link.title || 'Untitled' }}</span>
                      <span class="ne-backlink-hint">{{ backlinkHint(link) }}</span>
                    </a>
                  }
                </div>
              </div>
            }
            <div class="ne-editor">
              @if (editing() && editorKey() !== null) {
                @if (recoveredBodyDraft()) {
                  <k-draft-banner mode="recovered" (discard)="discardBodyDraft()" />
                }
                <k-description-editor
                  [value]="editorInitialValue()"
                  [cardId]="n.id"
                  [attachmentTarget]="{ kind: 'note', id: n.id }"
                  [editable]="canEdit() && !lockedByOther()"
                  [mentionMembers]="mentionMembers()"
                  [autofocus]="false"
                  [showCancel]="true"
                  [submitLabel]="'Save'"
                  [placeholder]="'Write your note in markdown…'"
                  (contentChange)="onBodyDraftChange($event)"
                  (cancel)="cancelBodyEdit()"
                  (save)="onContentSave($event)" />
              } @else {
                @if (recoveredBodyDraft()) {
                  <k-draft-banner mode="saved" [canEdit]="canEdit()" [canStartEdit]="canEdit() && !lockedByOther()" (edit)="startBodyEdit()" (discard)="discardBodyDraft()" />
                }
                <div class="ne-viewer dv-copy-hover-scope" [class.is-readonly]="!canEdit() || lockedByOther()" (click)="startBodyEdit()" [kTooltip]="viewerTitle()">
                  <k-description-viewer
                    [value]="recoveredBodyDraft() ? editorInitialValue() : (n.content || '')"
                    [workspaceId]="n.workspaceId"
                    [mentionMembers]="mentionMembers()"
                    [showCopy]="true"
                    [emptyLabel]="lockedByOther() ? lockedEmptyLabel() : 'Add a description…'"
                    [emptyIcon]="lockedByOther() ? 'lock' : 'pencil'"
                    (imageClick)="imageLightbox.open({ src: $event })" />
                </div>
              }
            </div>
            <section class="ne-attachments">
              <div class="ne-section-label">
                <i class="ti ti-paperclip"></i>
                <span>Attachments</span>
                @if (attachments().length) {
                  <span class="ne-count">{{ attachments().length }}</span>
                }
              </div>

              @if (canChangeAttachments()) {
                <div class="ne-attach-dropzone" [class.is-drag-active]="attachmentDragActive()">
                  <label class="ne-attach-upload">
                    <i class="ti ti-upload"></i>
                    Add attachment
                    <input type="file" hidden multiple [accept]="acceptAttr" (change)="onAttachmentSelected($event)" />
                  </label>
                  <div class="ne-attach-drop-hint" aria-hidden="true">
                    <i class="ti ti-drag-drop"></i>
                    Drop files here
                  </div>
                </div>

                @if (uploads.validationError(); as err) {
                  <p class="ne-attach-error"><i class="ti ti-alert-circle"></i> {{ err }}</p>
                }
                <k-attachment-upload-list [items]="uploads.items()" (retry)="uploads.retry($event)" (dismiss)="uploads.dismiss($event)" />
              }

              @if (attachments().length) {
                <ul class="ne-attach-list">
                  @for (a of attachments(); track a.id) {
                    <li class="ne-attach-row">
                      @if (isImageMime(a.mimeType)) {
                        <button type="button" class="ne-attach-thumb is-image" (click)="openAttachmentImage(a.id, $event)" [kTooltip]="a.fileName">
                          @if (visibleMediaUrl(a.url); as thumb) {
                          <img [src]="thumb" [alt]="a.fileName" />
                          } @else {
                          <i class="ti ti-photo"></i>
                          }
                        </button>
                      } @else {
                        <a class="ne-attach-thumb is-doc" [href]="a.url" (click)="downloadAttachment(a.url, a.fileName); $event.preventDefault()" [kTooltip]="a.fileName">
                          <i class="ti {{ attachmentIconClass(a.mimeType, a.fileName) }}"></i>
                        </a>
                      }
                      <div class="ne-attach-meta">
                        <div class="ne-attach-name-row">
                          @if (isImageMime(a.mimeType)) {
                            <a class="ne-attach-name" [href]="a.url" (click)="openAttachmentImage(a.id, $event)">{{ a.fileName }}</a>
                          } @else {
                            <a class="ne-attach-name" [href]="a.url" (click)="downloadAttachment(a.url, a.fileName); $event.preventDefault()">{{ a.fileName }}</a>
                          }
                          @if (a.source === 'description') {
                            <span class="ne-source-pill" kTooltip="Added in description"><i class="ti ti-align-left"></i> description</span>
                          }
                        </div>
                        <span class="ne-attach-sub">{{ a.uploadedByName }} • {{ formatFeedTime(a.createdAt) }} • {{ formatBytes(a.byteSize) }}</span>
                      </div>
                      <div class="ne-attach-actions">
                        <button type="button" class="ne-icon-btn" (click)="downloadAttachment(a.url, a.fileName)" kTooltip="Download" aria-label="Download attachment">
                          <i class="ti ti-download"></i>
                        </button>
                        @if (canChangeAttachments()) {
                          <button type="button" class="ne-icon-btn" (click)="confirmDeleteAttachment(a.id, a.fileName)" kTooltip="Delete" aria-label="Delete attachment">
                            <i class="ti ti-trash"></i>
                          </button>
                        }
                      </div>
                    </li>
                  }
                </ul>
              }
            </section>
          </div>
        </div>
      </div>
    } @else {
      <div class="ne-placeholder">
        <span class="ne-ph-icon"><i class="ti ti-notebook"></i></span>
        <span class="ne-ph-title">No note selected</span>
        <span class="ne-ph-hint">Pick one from the tree or create a new note to start writing.</span>
      </div>
    }
  `,
  styleUrl: "./note-editor.component.scss",
})
export class NoteEditorComponent implements OnDestroy {
  private readonly notesState = inject(NotesState);
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiClient);
  private readonly editorDrafts = inject(EditorDrafts);
  private readonly confirm = inject(ConfirmService);
  private readonly sockets = inject(SocketService);
  readonly imageLightbox = inject(ImageLightboxService);

  readonly note = input.required<WireNote | null>();
  readonly mentionMembers = input<WireBoardMemberUser[]>([]);
  readonly canEdit = input(true);
  readonly editorKey = computed(() => this.note()?.id ?? null);

  readonly title = signal<string>("");
  readonly icon = signal<string | null>(null);
  readonly color = signal<ColorToken | null>(null);
  readonly editingTitle = signal(false);
  readonly editing = signal(false);
  readonly editorInitialValue = signal("");
  readonly saveError = signal<string | null>(null);
  readonly preservedDraft = signal<string | null>(null);
  readonly recoveredBodyDraft = signal(false);
  readonly backlinks = signal<BacklinkSummary[]>([]);
  readonly attachments = signal<NoteAttachmentRow[]>([]);
  readonly uploads = inject(AttachmentUploadQueue);
  // Derived so the existing drag/paste guards and dropzone label keep working unchanged.
  readonly uploadingAttachment = computed(() => this.uploads.busy());
  readonly attachmentDragActive = signal(false);
  readonly acquiringLock = signal(false);
  readonly clock = signal(Date.now());
  readonly lockError = output<string>();
  private readonly shell = viewChild<ElementRef<HTMLElement>>("shell");
  private readonly descriptionEditor = viewChild(DescriptionEditorComponent);
  readonly acceptAttr = [
    ...Object.keys(ALLOWED_ATTACHMENT_MIME),
    ...ALLOWED_ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`),
  ].join(",");
  readonly canChangeAttachments = computed(() => this.canEdit() && !this.lockedByOther());
  readonly imageAttachments = computed(() => this.attachments()
    .filter((attachment) => this.isImageMime(attachment.mimeType))
    .flatMap((attachment) => {
      const src = visibleSignedMediaUrl(attachment.url);
      return src ? {
        id: attachment.id,
        src,
        fileName: attachment.fileName,
        createdAt: attachment.createdAt,
      } : [];
    }));
  readonly lightboxImages = computed(() => this.imageAttachments().map(({ id: _id, ...image }) => image));

  readonly currentUserId = computed(() => this.auth.user()?.id ?? null);
  readonly activeLock = computed(() => this.notesState.lockFor(this.note()));
  readonly lockExpired = computed(() => {
    this.clock();
    return this.notesState.isLockExpired(this.activeLock());
  });
  readonly heldByOther = computed(() => {
    const n = this.note();
    if (!n || n.scope !== "team") return false;
    const lock = this.activeLock();
    return Boolean(lock && lock.editingUserId !== this.currentUserId());
  });
  readonly lockedByOther = computed(() => {
    const n = this.note();
    if (!n || n.scope !== "team") return false;
    const lock = this.activeLock();
    if (!lock || lock.editingUserId === this.currentUserId()) return false;
    return !this.notesState.isLockExpired(lock);
  });

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private currentLockedId: string | null = null;
  private displayedNoteId: string | null = null;
  private editBaseUpdatedAt: string | null = null;
  private titleSaveInFlight = false;

  constructor() {
    // path is read lazily at send time. onUploaded prepends locally (the realtime
    // note:attachment:created event also dedupes by id, matching the prior behavior).
    this.uploads.configure({
      path: () => `/notes/${this.note()!.id}/attachments`,
      onUploaded: (row) => {
        const attachment = row as NoteAttachmentRow;
        this.attachments.update((rows) => (rows.some((r) => r.id === attachment.id) ? rows : [attachment, ...rows]));
      },
    });

    document.addEventListener("dragover", this.handleAttachmentDragCapture, { capture: true });
    document.addEventListener("drop", this.handleAttachmentDragCapture, { capture: true });
    // When the note input changes, reset local draft state and leave edit mode.
    effect(() => {
      const n = this.note();
      const nextId = n?.id ?? null;
      if (nextId !== this.displayedNoteId) {
        this.displayedNoteId = nextId;
        this.title.set(n?.title ?? "");
        this.icon.set(n?.icon ?? null);
        this.color.set(n?.color ?? null);
        this.editorInitialValue.set(n?.content ?? "");
        this.editBaseUpdatedAt = n ? this.dateString(n.updatedAt) : null;
        this.editingTitle.set(false);
        this.editing.set(false);
        this.recoveredBodyDraft.set(false);
        this.uploads.reset(); // drop any in-flight/failed uploads belonging to the previous note
        void this.refreshBacklinks(nextId);
        void this.refreshAttachments(nextId);
        void this.releaseLockForDifferentNote(nextId);
        void this.restoreNoteBodyDraft(n);
        return;
      }
      if (!this.editing() && !this.editingTitle()) {
        this.title.set(n?.title ?? "");
        this.icon.set(n?.icon ?? null);
        this.color.set(n?.color ?? null);
        this.editorInitialValue.set(n?.content ?? "");
        this.editBaseUpdatedAt = n ? this.dateString(n.updatedAt) : null;
      }
    });
    effect(() => {
      if (this.canEdit() || (!this.editing() && !this.editingTitle())) return;
      const wasEditingBody = this.editing();
      this.preserveCurrentDraft();
      this.editing.set(false);
      this.editingTitle.set(false);
      // Body drafts already render the shared saved-draft banner; adding the
      // generic offline error would show two draft notices for one action.
      if (!wasEditingBody) this.saveError.set("You're offline - your draft was preserved. Reconnect before editing notes.");
      this.releaseCurrentLock();
    });
    effect(() => {
      const err = this.saveError();
      if (this.canEdit() && err && OFFLINE_DRAFT_MESSAGES.has(err)) this.saveError.set(null);
    });
    effect((onCleanup) => {
      const noteId = this.note()?.id;
      if (!noteId) return;
      const socket = this.sockets.connect();
      const handlers: Partial<ServerToClientEvents> = {
        [SERVER_EVENTS.NOTE_ATTACHMENT_CREATED]: ({ note, attachment }) => {
          if (note.id !== noteId) return;
          this.attachments.update((rows) => rows.some((row) => row.id === attachment.id) ? rows : [attachment, ...rows]);
        },
        [SERVER_EVENTS.NOTE_ATTACHMENT_DELETED]: ({ note, attachmentId }) => {
          if (note.id !== noteId) return;
          this.attachments.update((rows) => rows.filter((row) => row.id !== attachmentId));
        },
      };
      onCleanup(registerSocketHandlers(socket, handlers));
    }, { allowSignalWrites: true });
    this.clockTimer = setInterval(() => this.clock.set(Date.now()), 10_000);
  }

  ngOnDestroy() {
    document.removeEventListener("dragover", this.handleAttachmentDragCapture, { capture: true });
    document.removeEventListener("drop", this.handleAttachmentDragCapture, { capture: true });
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.stopHeartbeat();
    if (this.currentLockedId) void this.notesState.releaseLock(this.currentLockedId).catch(() => undefined);
    this.currentLockedId = null;
  }

  @HostListener("document:visibilitychange")
  onVisibilityChange() {
    if (document.visibilityState === "hidden" && this.currentLockedId) {
      const id = this.currentLockedId;
      this.currentLockedId = null;
      this.stopHeartbeat();
      void this.notesState.releaseLock(id).catch(() => undefined);
    } else if (document.visibilityState === "visible") {
      const n = this.note();
      if (n && this.editing()) void this.syncLock(n);
    }
  }

  private async releaseLockForDifferentNote(nextId: string | null) {
    if (!this.currentLockedId || this.currentLockedId === nextId) return;
    const prev = this.currentLockedId;
    this.currentLockedId = null;
    this.stopHeartbeat();
    await this.notesState.releaseLock(prev).catch(() => undefined);
  }

  private async syncLock(n: WireNote | null): Promise<boolean> {
    if (this.currentLockedId && (!n || n.id !== this.currentLockedId)) {
      // Switching to a different note — release the previous lock.
      const prev = this.currentLockedId;
      this.currentLockedId = null;
      this.stopHeartbeat();
      void this.notesState.releaseLock(prev).catch(() => undefined);
    }
    if (!n || n.scope !== "team") return true;
    if (this.currentLockedId === n.id) return true;
    try {
      this.acquiringLock.set(true);
      await this.notesState.acquireLock(n.id);
      this.currentLockedId = n.id;
      this.startHeartbeat();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { lock?: WireNoteLock } | null;
        if (body?.lock) this.notesState.receiveLock(body.lock);
        // Lock held by someone else — UI shows the read-only banner.
        this.currentLockedId = null;
      }
      return false;
    } finally {
      this.acquiringLock.set(false);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.currentLockedId) return;
      void this.notesState.acquireLock(this.currentLockedId).catch((err) => this.handleRenewalFailure(err));
    }, LOCK_HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  onIconChange(icon: string) {
    const n = this.note();
    if (!n || !this.canEdit() || this.lockedByOther()) return;
    this.icon.set(icon);
    void this.notesState
      .updateNote(n.id, { icon })
      .then((updated) => {
        // The icon write bumps the note's updatedAt. If a title or body edit is
        // in progress, advance the optimistic-concurrency base so the user's own
        // icon change doesn't make their pending save look stale (NOTE_STALE).
        if (this.editing() || this.editingTitle()) {
          this.editBaseUpdatedAt = this.dateString(updated.updatedAt);
        }
      })
      .catch(() => undefined);
  }

  onColorChange(color: ColorToken | null) {
    const n = this.note();
    if (!n || !this.canEdit() || this.lockedByOther()) return;
    this.color.set(color);
    void this.notesState
      .updateNote(n.id, { color })
      .then((updated) => {
        // Like the icon write, the color write bumps the note's updatedAt. Advance the
        // optimistic-concurrency base for any in-progress title/body edit so the user's own
        // color change doesn't make their pending save look stale (NOTE_STALE).
        if (this.editing() || this.editingTitle()) {
          this.editBaseUpdatedAt = this.dateString(updated.updatedAt);
        }
      })
      .catch(() => undefined);
  }

  async saveTitle() {
    if (this.titleSaveInFlight) return;
    const n = this.note();
    if (!n || !this.canEdit() || this.lockedByOther()) return;
    this.editingTitle.set(false);
    if (this.title() === n.title) {
      this.releaseLockIfIdle();
      return;
    }
    this.titleSaveInFlight = true;
    const acquired = await this.syncLock(n);
    if (!acquired) {
      this.titleSaveInFlight = false;
      this.preservedDraft.set(this.title());
      this.saveError.set("This note is being edited by someone else. Your title draft was preserved.");
      return;
    }
    try {
      this.saveError.set(null);
      const updated = await this.notesState.updateNote(n.id, { title: this.title(), baseUpdatedAt: this.editBaseUpdatedAt ?? this.dateString(n.updatedAt) });
      // Saving the title bumps updatedAt. If the body editor is still open,
      // advance the base so the user's own title save doesn't make a following
      // body save look stale.
      this.editBaseUpdatedAt = this.dateString(updated.updatedAt);
      this.releaseLockIfIdle();
    } catch (err) {
      this.preservedDraft.set(this.title());
      this.handleSaveError(err);
    } finally {
      this.titleSaveInFlight = false;
    }
  }

  async onContentSave(event: EditorSaveEvent) {
    const n = this.note();
    if (!n || !this.canEdit() || this.lockedByOther()) {
      if (n && !this.canEdit() && !this.lockedByOther()) {
        this.preserveBodyDraft(event.markdown);
        this.saveError.set(null);
        this.editing.set(false);
        this.releaseLockIfIdle();
      }
      this.descriptionEditor()?.setSaving(false);
      // Someone else may have taken the lock while this editor was still open
      // (e.g. during a simultaneous title edit). Preserve the draft and surface
      // the conflict instead of dropping the body silently.
      if (n && this.lockedByOther()) {
        this.preserveBodyDraft(event.markdown);
        this.saveError.set("Someone else started editing this note. Your draft was preserved.");
      }
      return;
    }
    this.saveError.set(null);
    try {
      const updated = await this.notesState.updateNote(n.id, { content: event.markdown, baseUpdatedAt: this.editBaseUpdatedAt ?? this.dateString(n.updatedAt) });
      // Advance the base in case the title input is still open — a following
      // title save should build on the timestamp this write just produced.
      this.editBaseUpdatedAt = this.dateString(updated.updatedAt);
      this.editorInitialValue.set(event.markdown);
      this.editorDrafts.clear(this.currentUserId(), "note-body", n.id);
      this.recoveredBodyDraft.set(false);
      this.preservedDraft.set(null);
      this.editing.set(false);
      void this.refreshBacklinks(updated.id);
      if (event.attachmentIds.length) void this.refreshAttachments(updated.id);
      this.releaseLockIfIdle();
    } catch (err) {
      this.handleSaveError(err);
    } finally {
      this.descriptionEditor()?.setSaving(false);
    }
  }

  async startTitleEdit() {
    const n = this.note();
    if (!n || !this.canEdit() || this.lockedByOther()) return;
    const acquired = await this.syncLock(n);
    if (!acquired) return;
    this.title.set(n.title ?? "");
    this.editBaseUpdatedAt = this.dateString(n.updatedAt);
    this.editingTitle.set(true);
  }

  cancelTitleEdit() {
    const n = this.note();
    this.title.set(n?.title ?? "");
    this.editingTitle.set(false);
    this.releaseLockIfIdle();
  }

  async startBodyEdit() {
    const n = this.note();
    if (!n || !this.canEdit() || this.lockedByOther() || this.editing()) return;
    const acquired = await this.syncLock(n);
    if (!acquired) return;
    const recovered = this.editorDrafts.load(this.currentUserId(), "note-body", n.id);
    this.editorInitialValue.set(recovered?.markdown ?? n.content ?? "");
    this.recoveredBodyDraft.set(Boolean(recovered));
    if (recovered) this.preservedDraft.set(null);
    this.editBaseUpdatedAt = this.dateString(n.updatedAt);
    this.editing.set(true);
  }

  cancelBodyEdit() {
    this.discardBodyDraft();
  }

  onBodyDraftChange(markdown: string) {
    const n = this.note();
    if (!n) return;
    this.editorDrafts.save({
      userId: this.currentUserId(),
      kind: "note-body",
      entityId: n.id,
      noteId: n.id,
      markdown,
      baseMarkdown: n.content ?? "",
    });
  }

  discardBodyDraft() {
    const n = this.note();
    if (n) this.editorDrafts.clear(this.currentUserId(), "note-body", n.id);
    this.editorInitialValue.set(n?.content ?? "");
    this.recoveredBodyDraft.set(false);
    this.preservedDraft.set(null);
    this.saveError.set(null);
    this.editing.set(false);
    this.releaseLockIfIdle();
  }

  lockHolderName(lock: WireNoteLock): string {
    const member = this.mentionMembers().find((m) => m.userId === lock.editingUserId);
    return member?.displayName || lock.editingUserName || "Someone";
  }

  lockTimeHint(lock: WireNoteLock): string {
    this.clock();
    const remainingMs = new Date(lock.editingExpiresAt).getTime() - Date.now();
    if (remainingMs <= 0) return ", but their edit session has expired";
    const seconds = Math.ceil(remainingMs / 1000);
    return ` for about ${seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}`;
  }

  lockedEmptyLabel(): string {
    const lock = this.activeLock();
    return lock ? `${this.lockHolderName(lock)} is writing this note…` : "This note is being edited…";
  }

  viewerTitle(): string {
    if (!this.canEdit() || this.lockedByOther()) return "";
    return "Click to edit";
  }

  disabledTitle(): string | null {
    if (!this.canEdit()) return "You're offline - changes are paused";
    if (this.lockedByOther()) return "This note is being edited";
    return null;
  }

  discardPreservedDraft() {
    this.preservedDraft.set(null);
    this.saveError.set(null);
  }

  private async restoreNoteBodyDraft(n: WireNote | null) {
    if (!n || !this.canEdit()) return;
    const draft = this.editorDrafts.load(this.currentUserId(), "note-body", n.id);
    if (!draft) return;

    if (this.lockedByOther()) {
      this.editorInitialValue.set(draft.markdown);
      this.recoveredBodyDraft.set(true);
      this.preservedDraft.set(null);
      this.saveError.set("This note is being edited by someone else.");
      return;
    }

    const acquired = await this.syncLock(n);
    if (!acquired) {
      this.editorInitialValue.set(draft.markdown);
      this.recoveredBodyDraft.set(true);
      this.preservedDraft.set(null);
      this.saveError.set("This note is being edited by someone else.");
      return;
    }

    if (this.note()?.id !== n.id) return;
    this.editorInitialValue.set(draft.markdown);
    this.editBaseUpdatedAt = this.dateString(n.updatedAt);
    this.recoveredBodyDraft.set(true);
    this.editing.set(true);
  }

  private releaseCurrentLock() {
    if (!this.currentLockedId) return;
    const id = this.currentLockedId;
    this.currentLockedId = null;
    this.stopHeartbeat();
    void this.notesState.releaseLock(id).catch(() => undefined);
  }

  /**
   * Release the lock only when no edit is still in progress. The title input and
   * body editor can be open at the same time and share one lock, so saving or
   * cancelling one must not drop the lock out from under the other. Callers clear
   * their own edit flag before invoking this.
   */
  private releaseLockIfIdle() {
    if (this.editing() || this.editingTitle()) return;
    this.releaseCurrentLock();
  }

  private handleSaveError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.status === 409) {
        this.lockError.emit("locked");
        this.preserveCurrentDraft();
        const body = err.body as { code?: string; lock?: WireNoteLock } | null;
        if (body?.lock) this.notesState.receiveLock(body.lock);
        this.saveError.set(body?.code === "NOTE_STALE"
          ? "This note changed since you started editing. Your draft was preserved."
          : "Someone else started editing this note. Your draft was preserved.");
        return;
      }
      if (err.status === 401) {
        this.saveError.set("Your session expired. Refresh the page and sign in again.");
        return;
      }
      const body = err.body as { message?: string } | null;
      this.saveError.set(body?.message ? `Failed to save: ${body.message}` : `Failed to save (${err.status}).`);
      return;
    }
    this.saveError.set("Failed to save. Check your connection and try again.");
  }

  private preserveCurrentDraft() {
    if (this.editing()) {
      this.preserveBodyDraft();
      return;
    }
    if (this.editingTitle()) this.preservedDraft.set(this.title());
  }

  private preserveBodyDraft(markdown = this.descriptionEditor()?.markdown() ?? this.editorInitialValue()) {
    const n = this.note();
    if (!n) return null;
    const draft = this.editorDrafts.save({
      userId: this.currentUserId(),
      kind: "note-body",
      entityId: n.id,
      noteId: n.id,
      markdown,
      baseMarkdown: n.content ?? "",
    });
    this.editorInitialValue.set(draft?.markdown ?? markdown);
    this.recoveredBodyDraft.set(Boolean(draft));
    this.preservedDraft.set(null);
    return draft;
  }

  private handleRenewalFailure(err: unknown) {
    this.preserveCurrentDraft();
    this.stopHeartbeat();
    this.currentLockedId = null;
    this.editing.set(false);
    this.editingTitle.set(false);
    if (err instanceof ApiError && err.status === 401) {
      this.saveError.set("Your session expired. Your draft was preserved.");
      return;
    }
    this.saveError.set("Your edit session ended before saving. Your draft was preserved.");
  }

  private async refreshBacklinks(noteId: string | null) {
    if (!noteId) {
      this.backlinks.set([]);
      return;
    }
    try {
      const response = await this.api.get<NoteBacklinksResponse>(`/notes/${noteId}/backlinks`);
      if (this.note()?.id === noteId) this.backlinks.set(response.backlinks ?? []);
    } catch {
      if (this.note()?.id === noteId) this.backlinks.set([]);
    }
  }

  private async refreshAttachments(noteId: string | null) {
    if (!noteId) {
      this.attachments.set([]);
      this.uploads.reset();
      return;
    }
    try {
      const rows = await this.api.get<NoteAttachmentRow[]>(`/notes/${noteId}/attachments`);
      if (this.note()?.id === noteId) this.attachments.set(rows);
    } catch {
      if (this.note()?.id === noteId) this.attachments.set([]);
    }
  }

  async onAttachmentSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await this.uploadAttachmentFiles(files);
  }

  @HostListener("document:dragover", ["$event"])
  onDocumentAttachmentDragOver(event: DragEvent) {
    if (!this.canChangeAttachments()) return;
    this.onAttachmentDragOver(event);
  }

  @HostListener("document:drop", ["$event"])
  async onDocumentAttachmentDrop(event: DragEvent) {
    if (!this.canChangeAttachments()) return;
    await this.onAttachmentDrop(event);
  }

  @HostListener("document:dragend")
  @HostListener("document:dragexit")
  onDocumentAttachmentDragEnd() {
    this.attachmentDragActive.set(false);
  }

  private readonly handleAttachmentDragCapture = (event: DragEvent) => {
    if (!this.hasDraggedFiles(event)) return;
    if (
      !this.canChangeAttachments()
      || !this.isDragInsideShell(event)
      || this.isEditorDropTarget(event.target)
      || this.isEditablePasteTarget(event.target)
    ) {
      this.attachmentDragActive.set(false);
    }
  };

  onAttachmentDragEnter(event: DragEvent) {
    if (!this.shouldHandleAttachmentDrag(event)) return;
    event.preventDefault();
    this.attachmentDragActive.set(!this.uploadingAttachment());
  }

  onAttachmentDragOver(event: DragEvent) {
    if (!this.shouldHandleAttachmentDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (!this.uploadingAttachment()) this.attachmentDragActive.set(true);
  }

  onAttachmentDragLeave(event: DragEvent) {
    if (!this.hasDraggedFiles(event)) return;
    const current = this.shell()?.nativeElement ?? event.currentTarget as Node | null;
    const related = event.relatedTarget as Node | null;
    if (!current || !related || !current.contains(related)) {
      this.attachmentDragActive.set(false);
    }
  }

  async onAttachmentDrop(event: DragEvent) {
    if (!this.shouldHandleAttachmentDrag(event)) return;
    event.preventDefault();
    this.attachmentDragActive.set(false);
    await this.uploadAttachmentFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  async onNotePaste(event: ClipboardEvent) {
    if (event.defaultPrevented || !this.canChangeAttachments() || this.isEditablePasteTarget(event.target)) return;

    const files = this.clipboardAttachmentFiles(event.clipboardData);
    if (files.length === 0) return;

    event.preventDefault();
    await this.uploadAttachmentFiles(files);
  }

  private clipboardAttachmentFiles(data: DataTransfer | null): File[] {
    if (!data) return [];
    const files: File[] = [];
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files.length > 0 ? files : Array.from(data.files ?? []);
  }

  private isEditablePasteTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
  }

  private shouldHandleAttachmentDrag(event: DragEvent): boolean {
    if (event.defaultPrevented || !this.hasDraggedFiles(event) || !this.isDragInsideShell(event)) return false;
    if (this.isEditorDropTarget(event.target) || this.isEditablePasteTarget(event.target)) {
      this.attachmentDragActive.set(false);
      return false;
    }
    return true;
  }

  private isEditorDropTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    // The note body editor inserts dropped files into markdown, so the shell-level
    // note attachment target must yield while the pointer is over that editor.
    return Boolean(target.closest("k-description-editor"));
  }

  private isDragInsideShell(event: DragEvent): boolean {
    const shell = this.shell()?.nativeElement;
    if (!shell) return false;
    const target = this.dragTargetElement(event);
    return Boolean(target && shell.contains(target));
  }

  private dragTargetElement(event: DragEvent): Element | null {
    if (event.target instanceof Element) return event.target;
    if (event.clientX || event.clientY) return document.elementFromPoint(event.clientX, event.clientY);
    return null;
  }

  private async uploadAttachmentFiles(files: File[]) {
    if (!this.note() || files.length === 0 || !this.canChangeAttachments()) return;
    // Validation, per-file progress, retry, and error formatting all live in the queue; on success
    // it prepends the new attachment via the onUploaded hook configured in the constructor.
    this.uploads.add(files);
  }

  private hasDraggedFiles(event: DragEvent): boolean {
    const data = event.dataTransfer;
    if (!data) return false;
    if (Array.from(data.types ?? []).some((type) => type === "Files" || type === "application/x-moz-file")) return true;
    return Array.from(data.items ?? []).some((item) => item.kind === "file");
  }

  async confirmDeleteAttachment(attachmentId: string, fileName: string) {
    const n = this.note();
    if (!n || !this.canChangeAttachments()) return;
    if (!await this.confirm.open({ title: `Delete "${fileName}"?`, message: "This cannot be undone.", danger: true })) return;
    await this.api.delete(`/notes/${n.id}/attachments/${attachmentId}`);
    this.attachments.update((rows) => rows.filter((row) => row.id !== attachmentId));
  }

  openAttachmentImage(attachmentId: string, event?: Event): boolean {
    const imageAttachments = this.imageAttachments();
    const initialIndex = imageAttachments.findIndex((attachment) => attachment.id === attachmentId);
    if (initialIndex < 0) return false;

    const selected = imageAttachments[initialIndex]!;
    this.imageLightbox.open({
      src: selected.src,
      fileName: selected.fileName,
      createdAt: selected.createdAt,
      images: this.lightboxImages(),
      initialIndex,
    }, event);
    return true;
  }

  formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  isImageMime(mime: string): boolean {
    return mime.startsWith("image/");
  }

  // Suppress an attachment image / lock avatar whose signed token has expired
  // (e.g. from a cached note payload) so it shows a placeholder rather than a 404.
  visibleMediaUrl(url: string | null | undefined): string | null {
    return visibleSignedMediaUrl(url);
  }

  attachmentIconClass(mimeType: string, fileName: string): string {
    return attachmentIconClass(mimeType, fileName);
  }

  formatFeedTime(value: string | Date): string {
    const date = typeof value === "string" ? new Date(value) : value;
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  async downloadAttachment(url: string, fileName: string) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Attachment download failed with status ${response.status}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        this.triggerAttachmentDownload(objectUrl, fileName);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      return;
    } catch {
      this.triggerAttachmentDownload(url, fileName);
    }
  }

  private triggerAttachmentDownload(url: string, fileName: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
  }

  backlinkHref(link: BacklinkSummary): string {
    if (link.kind === "card") return `/b/${link.boardId}?cardId=${link.id}`;
    if (link.kind === "board") return `/b/${link.boardId}`;
    return link.boardId
      ? `/b/${link.boardId}?view=notes&noteId=${link.id}`
      : `/w/${link.workspaceId}/notes?noteId=${link.id}`;
  }

  backlinkIcon(link: BacklinkSummary): string {
    if (link.kind === "card") return link.icon || "cardboards";
    if (link.kind === "board") return link.icon || "layout-board";
    return link.icon || "file-text";
  }

  // Only notes carry a palette color; cards/boards keep their default icon tint here.
  backlinkColor(link: BacklinkSummary): string | null {
    return link.kind === "note" ? link.color : null;
  }

  backlinkHint(link: BacklinkSummary): string {
    if (link.kind === "card") return `${link.boardName} - ${link.listName}`;
    if (link.kind === "board") return "Board";
    return link.boardName ?? (link.scope === "personal" ? "Private note" : "Team note");
  }

  async copyNoteLink(note: WireNote) {
    const path = note.boardId
      ? `/b/${note.boardId}?view=notes&noteId=${note.id}`
      : `/w/${note.workspaceId}/notes?noteId=${note.id}`;
    await navigator.clipboard?.writeText(new URL(path, window.location.origin).toString()).catch(() => undefined);
  }

  private dateString(value: string | Date): string {
    return typeof value === "string" ? value : value.toISOString();
  }
}
