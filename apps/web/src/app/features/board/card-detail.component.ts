import type { CdkDragDrop, CdkDragMove } from "@angular/cdk/drag-drop";
import { CdkDrag, CdkDragHandle, CdkDragPreview, CdkDropList, moveItemInArray, transferArrayItem } from "@angular/cdk/drag-drop";
import { CdkScrollable } from "@angular/cdk/scrolling";
import { NgOptimizedImage, NgTemplateOutlet } from "@angular/common";
import type {
  ElementRef,
  TemplateRef,
} from "@angular/core";
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import { Router } from "@angular/router";
import { ALLOWED_ATTACHMENT_EXTENSIONS, ALLOWED_ATTACHMENT_MIME } from "@kanera/shared/attachments";
import type { CardMirrorStatus, LinkedInternalSummary } from "@kanera/shared/dto";
import { expandWireCard, SERVER_EVENTS, type CardAttachmentRow, type ServerToClientEvents, type WireBoardMemberUser, type WireCard, type WireCardChecklist, type WireCardChecklistItem, type WireCardDetail, type WireCardLabel, type WireCardSummary, type WireChecklistTemplate, type WireCustomFieldOption } from "@kanera/shared/events";
import type { CardCustomFieldValue, CardLabel } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { EditorDrafts } from "../../core/browser/editor-drafts";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { MediaDownloadService } from "../../core/media/media-download.service";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import { SocketService } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { attachmentIconClass } from "../../shared/attachment-icons";
import { CardKeyDisplayService } from "../../shared/card-key-display.service";
import { attachmentPreviewType, type AttachmentPreviewType } from "../../shared/attachment-preview";
import { AttachmentUploadListComponent } from "../../shared/attachments/attachment-upload-list.component";
import { AttachmentUploadQueue } from "../../shared/attachments/attachment-upload-queue.service";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { AvatarComponent } from "../../shared/avatar.component";
import { ConfirmService } from "../../shared/confirm.service";
import { DraftBannerComponent } from "../../shared/draft-banner.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardPickerPopover, type BoardPickerPick } from "./board-picker.popover";
import { BoardState, betweenBoardPositions, type AnyCustomField } from "./board-state";
import { CardActivityComponent } from "./card-activity.component";
import { CardDetailLayoutService } from "./card-detail-layout.service";
import { DatePickerPopover } from "./date-picker.popover";
import { DescriptionEditorComponent } from "./description-editor.component";
import { DescriptionViewerComponent } from "./description-viewer.component";
import {
  dueDateInputValue,
  dueDateSlotFor,
  formatDueDate,
  isDueSoon,
  isOverdue,
  type DueDateSlotSelection,
} from "./due-date.util";
import { ImageLightboxService } from "./image-lightbox.service";
import type { ImageLightboxItem } from "./image-lightbox.component";
import { LabelPickerPopover } from "./label-picker.popover";
import { MemberPickerPopover } from "./member-picker.popover";
import { SelectPickerPopover } from "./select-picker.popover";
import { WatcherPopoverComponent } from "./watcher-popover.component";
import { BoardMirrorsService } from "../board-mirrors/board-mirrors.service";

const CHECKLIST_DRAG_SCROLL_EDGE_PX = 80;
const CHECKLIST_DRAG_SCROLL_MAX_STEP_PX = 20;

// The detail column is its own scroller, so CDK's document auto-scroll cannot reveal checklist
// rows above or below the viewport. Increase the nudge as the pointer approaches either edge.
// The scroller carries `cdkScrollable` so CDK tracks it as a scrollable parent: that is what makes
// each manual scrollTop change re-sort the drag against the newly revealed rows. Without the
// registration CDK ignores the scroll event and the drop indicator freezes at its pre-scroll slot.
export function checklistDragScrollStep(pointerY: number, top: number, bottom: number): number {
  if (pointerY < top + CHECKLIST_DRAG_SCROLL_EDGE_PX) {
    const distance = top + CHECKLIST_DRAG_SCROLL_EDGE_PX - pointerY;
    return -Math.ceil(Math.min(1, Math.max(0, distance / CHECKLIST_DRAG_SCROLL_EDGE_PX)) * CHECKLIST_DRAG_SCROLL_MAX_STEP_PX);
  }
  if (pointerY > bottom - CHECKLIST_DRAG_SCROLL_EDGE_PX) {
    const distance = pointerY - (bottom - CHECKLIST_DRAG_SCROLL_EDGE_PX);
    return Math.ceil(Math.min(1, Math.max(0, distance / CHECKLIST_DRAG_SCROLL_EDGE_PX)) * CHECKLIST_DRAG_SCROLL_MAX_STEP_PX);
  }
  return 0;
}

@Component({
  selector: "k-card-detail",
  standalone: true,
  imports: [
    NgOptimizedImage,
    NgTemplateOutlet,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    CdkDragPreview,
    CdkScrollable,
    AnchoredPanelDirective,
    AvatarComponent,
    MemberPickerPopover,
    LabelPickerPopover,
    DatePickerPopover,
    SelectPickerPopover,
    BoardPickerPopover,
    CardActivityComponent,
    DraftBannerComponent,
    DescriptionEditorComponent,
    DescriptionViewerComponent,
    TooltipDirective,
    WatcherPopoverComponent,
    AttachmentUploadListComponent,
  ],
  // Component-scoped so each open card has its own upload queue.
  providers: [AttachmentUploadQueue],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./card-detail.component.html",
  styleUrl: "./card-detail.component.scss",
})
export class CardDetailComponent {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly editorDrafts = inject(EditorDrafts);
  private readonly unsavedWork = inject(UnsavedWorkService);
  private readonly mediaDownloads = inject(MediaDownloadService);
  private readonly unsavedDraftSource = Symbol("card-description-draft");
  private readonly checklistItemUnsavedDraftSource = Symbol("checklist-item-description-draft");
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly sockets = inject(SocketService);
  private readonly state = inject(BoardState);
  private readonly router = inject(Router);
  private readonly layout = inject(CardDetailLayoutService);
  private readonly confirm = inject(ConfirmService);
  private readonly workspaces = inject(WorkspaceService);
  private readonly notifications = inject(NotificationsService);
  private readonly mirrors = inject(BoardMirrorsService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;
  private readonly customFieldSaveKeys = new Map<string, string>();
  readonly imageLightbox = inject(ImageLightboxService);

  // effectiveMode forces modal below lg (panel option removed); canToggle hides
  // the layout switch there so the forced modal can't be flipped back to panel.
  readonly mode = this.layout.effectiveMode;
  readonly canToggle = this.layout.canToggle;
  readonly canArchive = this.state.canEdit;
  // Role-only counterpart of canArchive for STRUCTURAL gating of the archive/actions UI, so it
  // stays mounted (disabled) across offline blips instead of unmounting. canArchive still gates
  // the actual mutations and button disabled state.
  readonly canArchiveRole = this.state.canEditRole;
  readonly canEdit = computed(() => this.state.canEdit() && !this.card().archivedAt);
  // Role-based permission without the connectivity check. Drives structural @if gating
  // in the template so edit controls stay mounted (and merely disable) across offline
  // blips instead of unmounting/remounting. See `BoardState.canEditRole`.
  readonly canEditRole = computed(() => this.state.canEditRole() && !this.card().archivedAt);
  readonly sourceLists = this.state.visibleLists;
  readonly isWatchingCard = computed(() => this.notifications.isWatchingCard(this.card().id));
  readonly showCardWatchButton = computed(() => !this.notifications.isWatchingBoard(this.boardId()));
  readonly watcherPopoverOpen = signal(false);
  readonly panel = viewChild<ElementRef<HTMLElement>>("panel");
  readonly detailScroller = viewChild<ElementRef<HTMLElement>>("detailScroller");
  readonly descriptionEditor = viewChild<DescriptionEditorComponent>("descriptionEditor");
  readonly checklistItemDescriptionEditor = viewChild<DescriptionEditorComponent>("checklistItemDescriptionEditor");
  readonly descViewerInner = viewChild<ElementRef<HTMLElement>>("descViewerInner");
  readonly addItemInput = viewChild<ElementRef<HTMLInputElement>>("addItemInput");
  readonly addChecklistInput = viewChild<ElementRef<HTMLInputElement>>("addChecklistInput");
  readonly checklistTitleInput = viewChild<ElementRef<HTMLInputElement>>("checklistTitleInput");
  readonly checklistItemInput = viewChild<ElementRef<HTMLInputElement>>("checklistItemInput");
  readonly checklistItemPanelTitleInput = viewChild<ElementRef<HTMLInputElement>>("checklistItemPanelTitleInput");
  readonly checklistList = viewChild.required<TemplateRef<{ checklists: WireCardChecklist[]; showItemMeta: boolean }>>("checklistList");
  readonly descriptionExpanded = signal(false);
  readonly descriptionOverflows = signal(false);
  private checklistDragPointerY: number | null = null;
  private checklistDragScrollFrame: number | null = null;

  onChecklistDragStarted() {
    document.body.classList.add("is-checklist-dragging");
    // Drag handles commonly have an open tooltip when the pointer goes down; dismiss it before
    // CDK creates the preview so it cannot obscure the destination rows.
    document.dispatchEvent(new CustomEvent("kanera:drag-start"));
  }

  onChecklistDragMoved(event: CdkDragMove<unknown>) {
    this.checklistDragPointerY = event.pointerPosition.y;
    if (this.checklistDragScrollFrame !== null) return;

    const tick = () => {
      this.checklistDragScrollFrame = window.requestAnimationFrame(tick);
      const scroller = this.detailScroller()?.nativeElement;
      if (this.checklistDragPointerY === null || !scroller) return;
      const rect = scroller.getBoundingClientRect();
      const step = checklistDragScrollStep(this.checklistDragPointerY, rect.top, rect.bottom);
      if (step !== 0) scroller.scrollTop += step;
    };
    this.checklistDragScrollFrame = window.requestAnimationFrame(tick);
  }

  onChecklistDragEnded() {
    document.body.classList.remove("is-checklist-dragging");
    this.checklistDragPointerY = null;
    if (this.checklistDragScrollFrame === null) return;
    window.cancelAnimationFrame(this.checklistDragScrollFrame);
    this.checklistDragScrollFrame = null;
  }

  toggleLayoutMode() {
    this.layout.toggle();
  }

  goToBoard() {
    // On a board this is only a query-param change, so Angular keeps the route alive and the card
    // detail must guard it directly.
    if (this.router.url.split("?", 1)[0].startsWith("/b/") && !this.unsavedWork.confirmNavigation()) return;
    void this.router.navigate(["/b", this.boardId()]);
  }

  async copyCardLink() {
    const tree = this.router.createUrlTree(["/c", this.card().key]);
    const url = new URL(this.router.serializeUrl(tree), window.location.origin).toString();
    await navigator.clipboard?.writeText(url).catch(() => undefined);
  }

  async copyCardKey() {
    await navigator.clipboard?.writeText(this.card().key).catch(() => undefined);
  }

  async toggleCardWatch() {
    await this.notifications.toggleCardWatch(this.card().id);
  }

  toggleCardWatcherPopover(event: MouseEvent) {
    event.stopPropagation();
    this.watcherPopoverOpen.update((open) => !open);
  }

  toggleDescriptionExpanded(e: Event) {
    e.stopPropagation();
    this.descriptionExpanded.update((v) => !v);
  }

  onDescriptionViewerClick() {
    if (this.descriptionOverflows() && !this.descriptionExpanded()) {
      this.descriptionExpanded.set(true);
      return;
    }

    if (!this.canEdit()) return;
    this.startEditDescription();
  }

  readonly card = input.required<WireCard | WireCardSummary>();
  readonly boardId = input.required<string>();
  readonly customFields = input<AnyCustomField[]>([]);
  readonly customFieldValues = input<CardCustomFieldValue[]>([]);
  readonly cardLabels = input<(CardLabel | WireCardLabel)[]>([]);
  readonly cardLabelIds = input<string[]>([]);
  readonly members = input<WireBoardMemberUser[]>([]);
  readonly assigneeIds = input<string[]>([]);
  readonly attachments = input<CardAttachmentRow[]>([]);
  readonly lightboxAttachmentId = input<string | null | undefined>();
  readonly checklists = input<WireCardChecklist[]>([]);
  readonly appliedChecklistTemplateIds = input<string[]>([]);
  readonly linkedNotes = input<LinkedInternalSummary[]>([]);
  readonly close = output<void>();
  readonly checklistCreated = output<WireCardChecklist>();
  readonly closing = signal(false);
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  requestClose() {
    if (!this.unsavedWork.confirmNavigation()) return;
    this.closing.set(true);
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.close.emit();
    }, 110);
  }

  readonly acceptAttr = [
    ...Object.keys(ALLOWED_ATTACHMENT_MIME),
    ...ALLOWED_ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`),
  ].join(",");
  readonly uploads = inject(AttachmentUploadQueue);
  // Derived so the existing drag/paste guards and dropzone label keep working unchanged.
  readonly uploadingAttachment = computed(() => this.uploads.busy());
  readonly attachmentDragActive = signal(false);
  // Keep every format the shared lightbox can render in attachment order so navigation can cross
  // images, playback media, and documents without exposing download-only files in the sequence.
  readonly lightboxAttachments = computed(() => this.attachments()
    .flatMap((attachment) => {
      const mediaType = attachmentPreviewType(attachment.mimeType, attachment.fileName);
      const src = visibleSignedMediaUrl(attachment.url);
      return src && mediaType ? [{
        id: attachment.id,
        src,
        fileName: attachment.fileName,
        createdAt: attachment.createdAt,
        mediaType,
        mimeType: attachment.mimeType,
      }] : [];
    }));
  readonly lightboxItems = computed<ImageLightboxItem[]>(() => this.lightboxAttachments()
    .map(({ id: _id, ...item }) => item));
  // Attachment presentation is stable until the attachment collection changes. Precomputing it
  // avoids repeating MIME, signed-URL, size, and date formatting work on unrelated signal updates.
  readonly attachmentDisplayById = computed(() => new Map(this.attachments().map((attachment) => [
    attachment.id,
    {
      isImage: this.isImageMime(attachment.mimeType),
      isVideo: this.isVideoMime(attachment.mimeType),
      isAudio: this.isAudioMime(attachment.mimeType),
      isPdf: attachmentPreviewType(attachment.mimeType, attachment.fileName) === "pdf",
      isMarkdown: attachmentPreviewType(attachment.mimeType, attachment.fileName) === "markdown",
      thumbnailUrl: this.attachmentThumbUrl(attachment),
      iconClass: attachmentIconClass(attachment.mimeType, attachment.fileName),
      subtitle: `${attachment.uploadedByName} • ${this.formatFeedTime(attachment.createdAt)} • ${this.formatBytes(attachment.byteSize)}`,
    },
  ])));

  linkedItemHref(item: LinkedInternalSummary): string {
    if (item.kind === "card") {
      const tree = this.router.createUrlTree(["/c", item.key]);
      return this.router.serializeUrl(tree);
    }
    const tree = item.boardId
      ? this.router.createUrlTree(["/b", item.boardId], { queryParams: { view: "notes", noteId: item.id } })
      : this.router.createUrlTree(["/w", item.workspaceId, "notes"], { queryParams: { noteId: item.id } });
    return this.router.serializeUrl(tree);
  }

  linkedItemIcon(item: LinkedInternalSummary): string {
    return item.kind === "card" ? (item.icon || "cardboards") : (item.icon || "file-text");
  }

  // Only linked notes carry a palette color to tint their icon.
  linkedItemColor(item: LinkedInternalSummary): string | null {
    return item.kind === "note" ? item.color : null;
  }

  linkedItemMeta(item: LinkedInternalSummary): string {
    if (item.kind === "card") return `${item.boardName} - ${item.listName}`;
    return item.boardName || (item.scope === "personal" ? "Private note" : "Team note");
  }

  readonly coverUrl = computed((): string | null => {
    const card = this.card();
    const coverId = card.coverAttachmentId;
    const summaryCoverUrl = "coverUrl" in card ? card.coverUrl : null;
    const resolved = coverId ? (this.attachments().find((a) => a.id === coverId)?.url ?? summaryCoverUrl) : summaryCoverUrl;
    // Suppress a cover whose signed token has already expired (e.g. from a
    // restored offline snapshot) so it does not render as a broken 404 before
    // the live card detail fetch supplies a freshly-signed URL. See
    // coverUrlForCard in list.component.ts for the board-view equivalent.
    return visibleSignedMediaUrl(resolved);
  });

  openCoverLightbox(event?: Event) {
    const url = this.coverUrl();
    if (!url) return;

    const coverId = this.card().coverAttachmentId;
    if (coverId) {
      const opened = this.openAttachmentImage(coverId, event);
      if (opened) return;
    }

    this.imageLightbox.open({ src: url }, event);
  }

  openAttachmentImage(attachmentId: string, event?: Event): boolean {
    return this.openAttachmentPreview(attachmentId, "image", event);
  }

  openAttachmentVideo(attachmentId: string, event?: Event): boolean {
    return this.openAttachmentPreview(attachmentId, "video", event);
  }

  openAttachmentAudio(attachmentId: string, event?: Event): boolean {
    return this.openAttachmentPreview(attachmentId, "audio", event);
  }

  openAttachmentPdf(attachmentId: string, event?: Event): boolean {
    return this.openAttachmentPreview(attachmentId, "pdf", event);
  }

  openAttachmentMarkdown(attachmentId: string, event?: Event): boolean {
    return this.openAttachmentPreview(attachmentId, "markdown", event);
  }

  private openAttachmentPreview(attachmentId: string, mediaType: AttachmentPreviewType, event?: Event): boolean {
    const attachments = this.lightboxAttachments();
    const initialIndex = attachments.findIndex((attachment) => attachment.id === attachmentId);
    const selected = attachments[initialIndex];
    if (!selected || selected.mediaType !== mediaType) return false;

    const { id: _id, ...item } = selected;
    this.imageLightbox.open({
      ...item,
      images: this.lightboxItems(),
      initialIndex,
    }, event);
    return true;
  }

  openInlineAttachment(attachment: {
    src: string;
    fileName: string;
    mediaType: AttachmentPreviewType;
    mimeType: string;
  }, event?: Event) {
    this.imageLightbox.open(attachment, event);
  }

  // Every card-detail surface uses the same preview set and mixed-media navigation behavior.
  openAttachmentMedia(attachmentId: string, event?: Event): boolean {
    return this.openAttachmentImage(attachmentId, event)
      || this.openAttachmentVideo(attachmentId, event)
      || this.openAttachmentAudio(attachmentId, event)
      || this.openAttachmentPdf(attachmentId, event)
      || this.openAttachmentMarkdown(attachmentId, event);
  }

  readonly currentUserId = computed(() => this.auth.user()?.id);
  readonly memberPickerOpen = signal(false);
  readonly checklistItemAssigneePickerId = signal<string | null>(null);
  readonly checklistItemDueDatePickerId = signal<string | null>(null);
  readonly checklistItemActionsMenuId = signal<string | null>(null);
  readonly checklistItemActionsMenuPlacement = { align: "end", width: 180, gap: 4 } as const;
  readonly bulkChecklistAssigneePickerId = signal<string | null>(null);
  readonly bulkChecklistDueDatePickerId = signal<string | null>(null);
  readonly labelPickerOpen = signal(false);
  readonly dueDatePickerOpen = signal(false);
  // Id of the custom field whose select/user/date picker is currently open (one at a time).
  readonly cfPickerFieldId = signal<string | null>(null);
  readonly moveToListOpen = signal(false);
  readonly moveToListAnchor = signal<HTMLElement | null>(null);
  readonly moveToListPlacement = { width: 220, maxHeight: 320, minHeight: 150 } as const;
  readonly actionsMenuOpen = signal(false);
  readonly actionsMenuPlacement = { align: "end", width: 220, maxHeight: 320, minHeight: 130, gap: 4 } as const;
  readonly copyToBoardOpen = signal(false);
  readonly moveToBoardOpen = signal(false);
  readonly canMoveToBoard = computed(() => this.state.workspaceKind() !== "board");
  readonly duplicating = signal(false);
  readonly savingCompletion = signal(false);
  readonly workspaceId = computed(() => this.workspaces.workspaceIdForBoard(this.boardId()));
  // Labels the card's source board so users on cross-board views know where it lives;
  // resolves for any registered board, not just the route-scoped one in BoardState.
  readonly boardSummary = computed(() => this.workspaces.boardSummaryFor(this.boardId()));

  readonly currentList = computed(() => this.state.lists().find((l) => l.id === this.card().listId));
  readonly otherLists = computed(() => this.state.visibleLists().filter((l) => l.id !== this.card().listId));

  toggleMoveToList(e: MouseEvent) {
    const next = !this.moveToListOpen();
    if (next && e.currentTarget instanceof HTMLElement) this.moveToListAnchor.set(e.currentTarget);
    this.moveToListOpen.set(next);
  }

  async moveToList(listId: string) {
    if (!this.canEdit()) return;
    this.moveToListOpen.set(false);
    const card = this.card();
    const position = this.state.positionForCardDrop(card.id, listId, null, undefined);
    this.state.moveCard(card.id, listId, position);
    await this.api.post(`/cards/${card.id}/move`, { listId, beforeCardId: null });
  }

  toggleActionsMenu(e: MouseEvent) {
    this.actionsMenuOpen.update((value) => !value);
  }

  toggleCopyToBoard(e: MouseEvent) {
    e.stopPropagation();
    this.copyToBoardOpen.update((v) => !v);
  }

  toggleMoveToBoard(e: MouseEvent) {
    if (!this.canMoveToBoard()) return;
    e.stopPropagation();
    this.moveToBoardOpen.update((v) => !v);
  }

  async duplicateCard() {
    if (!this.canEdit() || this.duplicating()) return;
    this.duplicating.set(true);
    try {
      await this.api.post(`/cards/${this.card().id}/duplicate`, {});
      this.actionsMenuOpen.set(false);
    } finally {
      this.duplicating.set(false);
    }
  }

  async toggleCompletion() {
    if (!this.canEdit() || this.savingCompletion()) return;
    this.savingCompletion.set(true);
    try {
      const card = await this.api.patch<WireCard>(`/cards/${this.card().id}/completion`, {
        completed: !this.card().completedAt,
      });
      this.state.updateCard(card);
    } finally {
      this.savingCompletion.set(false);
    }
  }

  async copyToBoard(target: BoardPickerPick) {
    if (!this.canEdit()) return;
    this.copyToBoardOpen.set(false);
    this.actionsMenuOpen.set(false);
    await this.api.post(`/cards/${this.card().id}/duplicate`, { boardId: target.boardId, listId: target.listId });
  }

  async moveToBoard(target: BoardPickerPick) {
    if (!this.canEdit() || !this.canMoveToBoard()) return;
    this.moveToBoardOpen.set(false);
    this.actionsMenuOpen.set(false);
    await this.api.post(`/cards/${this.card().id}/move-to-board`, { boardId: target.boardId });
    this.close.emit();
  }

  readonly draftTitle = signal("");
  readonly editingTitle = signal(false);
  readonly draftDescription = signal("");
  readonly savingDescription = signal(false);
  readonly editingDescription = signal(false);
  readonly editorInitialValue = signal("");
  readonly recoveredDescriptionDraft = signal(false);
  readonly confirmingDelete = signal(false);
  readonly archiving = signal(false);
  readonly activeTab = signal<'detail' | 'comments'>('detail');
  readonly wideLayout = signal(false);
  readonly shouldRenderActivity = computed(() => this.wideLayout() || this.activeTab() === "comments");
  readonly addingChecklist = signal(false);
  readonly newChecklistParentItemId = signal<string | null>(null);
  readonly newChecklistTitle = signal("");
  readonly checklistTemplates = this.state.checklistTemplates;
  readonly checklistTemplatePickerOpen = signal(false);
  readonly checklistTemplateQuery = signal("");
  readonly applyingChecklistTemplates = signal(false);
  private readonly locallyAppliedChecklistTemplateIds = signal<Set<string>>(new Set());
  readonly editingChecklistId = signal<string | null>(null);
  readonly draftChecklistTitle = signal("");
  readonly openChecklistItemId = signal<string | null>(null);
  readonly openChecklistItem = computed(() => {
    const itemId = this.openChecklistItemId();
    if (!itemId) return null;
    for (const checklist of this.checklists()) {
      const item = checklist.items.find((candidate) => candidate.id === itemId);
      if (item) return item;
    }
    return null;
  });
  readonly openChecklistItemChecklistId = computed(() => {
    const itemId = this.openChecklistItemId();
    if (!itemId) return null;
    return this.checklists().find((checklist) => checklist.items.some((item) => item.id === itemId))?.id ?? null;
  });
  readonly topLevelChecklists = computed(() => this.checklists().filter((checklist) => checklist.parentItemId === null));
  readonly openItemSubChecklists = computed(() => {
    const itemId = this.openChecklistItemId();
    return itemId ? this.checklists().filter((checklist) => checklist.parentItemId === itemId) : [];
  });
  readonly subChecklistProgressByItemId = computed(() => {
    const progress = new Map<string, { done: number; total: number }>();
    for (const checklist of this.checklists()) {
      if (!checklist.parentItemId) continue;
      const current = progress.get(checklist.parentItemId) ?? { done: 0, total: 0 };
      current.done += checklist.items.reduce((count, item) => count + (item.completedAt ? 1 : 0), 0);
      current.total += checklist.items.length;
      progress.set(checklist.parentItemId, current);
    }
    return progress;
  });
  readonly editingChecklistItemDescription = signal(false);
  readonly checklistItemDescriptionInitialValue = signal("");
  readonly recoveredChecklistItemDescriptionDraft = signal(false);
  readonly checklistItemDescriptionDisplayValue = computed(() => {
    const item = this.openChecklistItem();
    if (!item) return "";
    return this.recoveredChecklistItemDescriptionDraft()
      ? this.checklistItemDescriptionInitialValue()
      : item.description ?? "";
  });
  readonly addingItemChecklistId = signal<string | null>(null);
  readonly newItemText = signal("");
  readonly editingItemId = signal<string | null>(null);
  readonly draftItemText = signal("");
  readonly hideCompletedChecklistItems = signal(this.initialHideCompletedChecklistItems());
  readonly collapsedChecklistIds = signal<Set<string>>(new Set());
  readonly appliedChecklistTemplateIdSet = computed(() => {
    const ids = new Set(this.appliedChecklistTemplateIds());
    for (const id of this.locallyAppliedChecklistTemplateIds()) ids.add(id);
    return ids;
  });
  readonly filteredChecklistTemplates = computed(() => {
    const query = this.checklistTemplateQuery().trim().toLowerCase();
    const templates = this.checklistTemplates();
    if (!query) return templates;
    return templates.filter((template) => template.title.toLowerCase().includes(query));
  });
  readonly availableChecklistTemplates = computed(() =>
    this.checklistTemplates().filter((template) => !this.appliedChecklistTemplateIdSet().has(template.id)),
  );
  readonly visibleChecklistItemsByChecklistId = computed(() => {
    const hideCompleted = this.hideCompletedChecklistItems();
    return new Map(this.checklists().map((checklist) => [
      checklist.id,
      hideCompleted ? checklist.items.filter((item) => !item.completedAt) : checklist.items,
    ]));
  });
  // Precompute per-checklist progress once per checklists() change instead of re-filtering the
  // items array on every change detection pass (the template reads done/complete/text/fill for
  // each checklist multiple times).
  readonly checklistProgressById = computed(() => {
    const map = new Map<string, { done: number; total: number; complete: boolean; text: string; fillPct: number }>();
    for (const checklist of this.checklists()) {
      const total = checklist.items.length;
      const done = checklist.items.reduce((count, item) => (item.completedAt ? count + 1 : count), 0);
      map.set(checklist.id, {
        done,
        total,
        complete: total > 0 && done === total,
        text: `${done}/${total}`,
        fillPct: total > 0 ? (done / total) * 100 : 0,
      });
    }
    return map;
  });
  // Indexed lookups keep custom-field and checklist rendering linear. These sections can contain
  // many rows, and their previous template helpers repeatedly scanned the same input arrays.
  readonly membersById = computed(() => new Map(this.members().map((member) => [member.userId, member])));
  readonly customFieldValuesByFieldId = computed(() => {
    const cardId = this.card().id;
    return new Map(this.customFieldValues()
      .filter((value) => value.cardId === cardId)
      .map((value) => [value.fieldId, value]));
  });
  readonly selectedOptionsByFieldId = computed(() => {
    const values = this.customFieldValuesByFieldId();
    return new Map(this.customFields().map((field) => {
      const optionsById = new Map(("options" in field ? field.options : []).map((option) => [option.id, option]));
      const options = (values.get(field.id)?.valueOptionIds ?? []).flatMap((id) => {
        const option = optionsById.get(id);
        return option ? [option] : [];
      });
      return [field.id, options] as const;
    }));
  });
  readonly selectedUsersByFieldId = computed(() => {
    const members = this.members();
    return new Map([...this.customFieldValuesByFieldId()].map(([fieldId, value]) => {
      const selectedIds = new Set(value.valueUserIds ?? []);
      return [fieldId, members.filter((member) => selectedIds.has(member.userId))] as const;
    }));
  });
  readonly checklistItemPresentationById = computed(() => {
    const presentation = new Map<string, {
      hasDueDate: boolean;
      dueDateText: string;
      dueDateInputValue: string;
      dueDateSlot: DueDateSlotSelection;
      overdue: boolean;
      assignee: WireBoardMemberUser | null;
    }>();
    const members = this.membersById();
    for (const checklist of this.checklists()) {
      for (const item of checklist.items) {
        presentation.set(item.id, {
          hasDueDate: Boolean(item.dueDateLocalDate),
          dueDateText: formatDueDate(item.dueDateLocalDate, item.dueDateSlot, item.dueDateTimezone),
          dueDateInputValue: dueDateInputValue(item.dueDateLocalDate),
          dueDateSlot: dueDateSlotFor(item.dueDateSlot),
          overdue: !item.completedAt && isOverdue(item.dueDateLocalDate, item.dueDateSlot, item.dueDateTimezone),
          assignee: item.assigneeId ? members.get(item.assigneeId) ?? null : null,
        });
      }
    }
    return presentation;
  });

  private readonly cardId = computed(() => this.card().id);
  private readonly previouslyFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  private openedInitialLightboxFor: string | null = null;
  private detailLoadSeq = 0;
  private mirrorLoadSeq = 0;
  readonly mirrorStatus = signal<CardMirrorStatus | null>(null);
  // Bumped when a CARD_UPDATED for the open card lands via socket. refreshDetailFromNetwork
  // snapshots it before the /detail request so a slower response can't revert a newer realtime body.
  private detailRealtimeVersion = 0;

  // Detail load lifecycle. The detail-dependent body (attachments, checklists, linked items,
  // custom-field values) all come from /cards/:id/detail, so they render together behind one gate
  // instead of popping in piece-by-piece. detailLoading is only meaningful before we have detail;
  // a background refresh of an already-hydrated card must never blank the body.
  readonly detailLoading = signal(false);
  readonly detailError = signal(false);
  readonly hasDetail = computed(() => Boolean(this.state.detailForCard(this.cardId())));
  // Render the body once we already have detail or the initial fetch has settled (success or error).
  readonly detailReady = computed(() => this.hasDetail() || !this.detailLoading());

  constructor() {
    effect((onCleanup) => {
      this.unsavedWork.setDirty(this.unsavedDraftSource, this.recoveredDescriptionDraft());
      onCleanup(() => this.unsavedWork.setDirty(this.unsavedDraftSource, false));
    });
    effect((onCleanup) => {
      this.unsavedWork.setDirty(this.checklistItemUnsavedDraftSource, this.recoveredChecklistItemDescriptionDraft());
      onCleanup(() => this.unsavedWork.setDirty(this.checklistItemUnsavedDraftSource, false));
    });
    effect(() => {
      const itemId = this.openChecklistItemId();
      if (!itemId) {
        this.editingChecklistItemDescription.set(false);
        this.recoveredChecklistItemDescriptionDraft.set(false);
        return;
      }
      const item = untracked(() => this.openChecklistItem());
      if (!item) {
        this.openChecklistItemId.set(null);
        return;
      }
      const recovered = untracked(() => this.editorDrafts.load(this.currentUserId(), "checklist-item-description", itemId));
      this.checklistItemDescriptionInitialValue.set(recovered?.markdown ?? item.description ?? "");
      this.recoveredChecklistItemDescriptionDraft.set(Boolean(recovered));
      this.editingChecklistItemDescription.set(Boolean(recovered && untracked(() => this.canEdit())));
    });
    effect(() => {
      const itemId = this.openChecklistItemId();
      if (itemId && !this.openChecklistItem()) this.openChecklistItemId.set(null);
    });
    this.destroyRef.onDestroy(() => this.onChecklistDragEnded());
    // path is read lazily at send time, so configuring here (before card() resolves) is safe.
    this.uploads.configure({ path: () => `/cards/${this.card().id}/attachments` });

    document.addEventListener("dragover", this.handleAttachmentDragCapture, { capture: true });
    document.addEventListener("drop", this.handleAttachmentDragCapture, { capture: true });
    document.addEventListener("click", this.handleDocumentClick);
    document.addEventListener("keydown", this.handleDocumentKeydown);
    document.addEventListener("dragover", this.handleDocumentAttachmentDragOver);
    document.addEventListener("drop", this.handleDocumentAttachmentDrop);
    document.addEventListener("dragend", this.handleDocumentAttachmentDragEnd);
    document.addEventListener("dragexit", this.handleDocumentAttachmentDragEnd);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener("dragover", this.handleAttachmentDragCapture, { capture: true });
      document.removeEventListener("drop", this.handleAttachmentDragCapture, { capture: true });
      document.removeEventListener("click", this.handleDocumentClick);
      document.removeEventListener("keydown", this.handleDocumentKeydown);
      document.removeEventListener("dragover", this.handleDocumentAttachmentDragOver);
      document.removeEventListener("drop", this.handleDocumentAttachmentDrop);
      document.removeEventListener("dragend", this.handleDocumentAttachmentDragEnd);
      document.removeEventListener("dragexit", this.handleDocumentAttachmentDragEnd);
      if (this.closeTimer !== null) clearTimeout(this.closeTimer);
      if (this.previouslyFocusedElement?.isConnected) this.previouslyFocusedElement.focus();
    });

    effect((onCleanup) => {
      // Track only the card id so updates that replace the summary object reference
      // (e.g. setCardDetail → updateCard) don't retrigger this fetch effect.
      const cardId = this.cardId();
      void this.boardId();

      const initialDescription = untracked(() => {
        const existingDetail = this.state.detailForCard(cardId);
        if (existingDetail) return existingDetail.card.description ?? "";
        const card = this.card();
        return "description" in card ? card.description ?? "" : "";
      });
      this.draftDescription.set(initialDescription);
      this.uploads.reset(); // drop any in-flight/failed uploads belonging to the previously open card
      this.editingTitle.set(false);
      const recovered = untracked(() => this.editorDrafts.load(this.currentUserId(), "card-description", cardId));
      this.editorInitialValue.set(recovered?.markdown ?? initialDescription);
      // Read canEdit untracked: this effect must only re-run when the open card changes, NOT when
      // connectivity toggles. canEdit depends on displayedOnline, so tracking it here would re-run
      // this whole initializer on every offline/online blip — resetting draft/editing/expansion
      // state and re-registering socket handlers, which looked like the modal rebuilding itself.
      const canEditNow = untracked(() => this.canEdit());
      this.editingDescription.set(Boolean(recovered && canEditNow));
      this.recoveredDescriptionDraft.set(Boolean(recovered && canEditNow));
      this.descriptionExpanded.set(false);
      this.checklistTemplatePickerOpen.set(false);
      this.checklistTemplateQuery.set("");
      this.locallyAppliedChecklistTemplateIds.set(new Set());
      this.openChecklistItemId.set(null);

      const socket = this.sockets.connect();
      const handlers: Partial<ServerToClientEvents> = {
        [SERVER_EVENTS.CARD_UPDATED]: ({ card }) => {
          const expanded = expandWireCard(card);
          if (expanded.id !== cardId) return;
          // Mark that a realtime body update landed so an in-flight /detail response (which may
          // carry an older description) does not overwrite it with stale text.
          this.detailRealtimeVersion++;
          this.applyPublishedDescription(expanded.description ?? "");
        },
        [SERVER_EVENTS.BOARD_MIRROR_CREATED]: () => this.refreshMirrorStatus(cardId),
        [SERVER_EVENTS.BOARD_MIRROR_UPDATED]: () => this.refreshMirrorStatus(cardId),
        [SERVER_EVENTS.BOARD_MIRROR_DELETED]: () => this.refreshMirrorStatus(cardId),
        [SERVER_EVENTS.CARD_MIRROR_LINKED]: ({ sourceCardId, targetCardId }) => {
          if (sourceCardId === cardId || targetCardId === cardId) this.refreshMirrorStatus(cardId);
        },
        [SERVER_EVENTS.CARD_MIRROR_UNLINKED]: ({ sourceCardId, targetCardId }) => {
          if (sourceCardId === cardId || targetCardId === cardId) this.refreshMirrorStatus(cardId);
        },
      };

      onCleanup(registerSocketHandlers(socket, handlers));
    });

    effect(() => {
      const cardId = this.cardId();
      const boardId = this.boardId();
      if (this.sockets.displayedOnline()) {
        // The loader synchronously inspects detail state before its first await. Keep that read out
        // of this card/connectivity-scoped effect or hydration itself retriggers a duplicate request.
        untracked(() => void this.refreshDetailFromNetwork(cardId, boardId));
      } else {
        untracked(() => void this.loadCachedDetail(cardId));
      }
    });

    effect(() => {
      const cardId = this.cardId();
      void this.sockets.displayedOnline();
      // Clear synchronously on every card transition, including offline transitions, so a cached
      // badge from the previous card can never point at an unrelated relationship.
      untracked(() => this.refreshMirrorStatus(cardId));
    });

    effect(() => {
      // Notification media clicks arrive before /detail may have hydrated attachments;
      // keep retrying via the attachments signal until the requested attachment exists.
      const attachmentId = this.lightboxAttachmentId();
      if (!attachmentId) {
        this.openedInitialLightboxFor = null;
        return;
      }
      if (this.openedInitialLightboxFor === `${this.cardId()}:${attachmentId}`) return;
      if (this.openAttachmentMedia(attachmentId)) {
        this.openedInitialLightboxFor = `${this.cardId()}:${attachmentId}`;
      }
    });

    effect(() => {
      if (this.canEdit() || !this.editingDescription()) return;
      const existingDraft = this.editorDrafts.load(this.currentUserId(), "card-description", this.card().id);
      const editorMarkdown = this.descriptionEditor()?.markdown();
      const baseMarkdown = this.draftDescription();
      const markdown = editorMarkdown?.trim() === baseMarkdown.trim()
        ? existingDraft?.markdown ?? editorMarkdown
        : editorMarkdown;
      const draft = this.editorDrafts.save({
        userId: this.currentUserId(),
        kind: "card-description",
        entityId: this.card().id,
        cardId: this.card().id,
        markdown: markdown ?? existingDraft?.markdown ?? this.editorInitialValue(),
        baseMarkdown,
      });
      this.editorInitialValue.set(draft?.markdown ?? this.editorInitialValue());
      this.recoveredDescriptionDraft.set(Boolean(draft));
      this.descriptionEditor()?.setSaving(false);
      this.exitDescriptionEdit();
    });

    effect((onCleanup) => {
      const cardId = this.cardId();
      const boardId = this.boardId();
      // Register the open card even when offline so sibling tabs can suppress
      // local unread badges immediately; the notification service gates the
      // server-side read mutation on connectivity.
      const cleanup = untracked(() => this.notifications.beginViewingCard(cardId, boardId));
      onCleanup(cleanup);
    });

    afterRenderEffect(() => {
      void this.draftDescription();
      void this.mode();

      if (this.editingDescription()) {
        this.descriptionOverflows.set(false);
        return;
      }
      if (this.descriptionExpanded()) return;
      const el = this.descViewerInner()?.nativeElement;
      if (!el) {
        this.descriptionOverflows.set(false);
        return;
      }
      this.descriptionOverflows.set(el.scrollHeight > 324);
    });

    afterRenderEffect(() => {
      // Focus add-item input when a checklist's add-item form opens
      if (this.addingItemChecklistId()) {
        this.addItemInput()?.nativeElement.focus();
      }
      // Focus add-checklist input when the add-checklist form opens
      if (this.addingChecklist()) {
        this.addChecklistInput()?.nativeElement.focus();
      }
      if (this.editingChecklistId()) {
        this.checklistTitleInput()?.nativeElement.focus();
      }
      if (this.editingItemId()) {
        // Renaming from the drawer leaves the row underneath in edit mode too, so both title inputs
        // exist and share draftItemText. The drawer's is the one on screen, so it takes the caret.
        const panelTitle = this.checklistItemPanelTitleInput()?.nativeElement;
        if (panelTitle) {
          if (document.activeElement !== panelTitle) panelTitle.focus();
        } else {
          this.checklistItemInput()?.nativeElement.focus();
        }
      }
    });

    effect((onCleanup) => {
      const panel = this.panel()?.nativeElement;
      if (!panel) return;

      const updateWideLayout = (width: number) => {
        this.wideLayout.set(width >= 860);
      };

      updateWideLayout(panel.getBoundingClientRect().width);

      if (typeof ResizeObserver === "undefined") return;

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        updateWideLayout(entry.contentRect.width);
      });
      observer.observe(panel);
      onCleanup(() => observer.disconnect());
    });

    effect(() => {
      const panel = this.panel()?.nativeElement;
      if (!panel) return;

      queueMicrotask(() => {
        if (!panel.isConnected || panel.contains(document.activeElement)) return;
        panel.focus();
      });
    });

    effect(() => {
      localStorage.setItem(STORAGE_KEYS.HIDE_COMPLETED_CHECKLIST_ITEMS, this.hideCompletedChecklistItems() ? "1" : "0");
    });

    effect(() => {
      const cardId = this.cardId();
      this.collapsedChecklistIds.set(this.initialCollapsedChecklistIds(cardId));
    });

    effect(() => {
      const cardId = this.cardId();
      const checklists = this.checklists();
      // Card detail checklists can arrive after the shell opens. Avoid treating that
      // loading gap as "no checklists" or we would erase the user's saved collapse state.
      if (checklists.length === 0) return;
      const existingIds = new Set(checklists.map((checklist) => checklist.id));
      const collapsedIds = this.collapsedChecklistIds();
      const next = new Set([...collapsedIds].filter((id) => existingIds.has(id)));
      if (next.size !== collapsedIds.size) this.collapsedChecklistIds.set(next);
      this.persistCollapsedChecklistIds(cardId, next);
    });
  }

  private refreshMirrorStatus(cardId: string) {
    const seq = ++this.mirrorLoadSeq;
    this.mirrorStatus.set(null);
    if (!this.sockets.displayedOnline()) return;
    void this.mirrors.cardStatus(cardId).then((status) => {
      if (seq === this.mirrorLoadSeq && cardId === this.cardId()) this.mirrorStatus.set({ asSource: status.asSource ?? [], asTarget: status.asTarget ?? [] });
    }).catch(() => {
      if (seq === this.mirrorLoadSeq) this.mirrorStatus.set(null);
    });
  }

  private async refreshDetailFromNetwork(cardId: string, boardId: string) {
    const seq = ++this.detailLoadSeq;
    // Only show the loading gate when we have no detail yet, so a background/reconnect refresh of an
    // already-hydrated card doesn't blank the body. Snapshot the realtime version to detect a
    // CARD_UPDATED that lands mid-request (its body is newer than this response's).
    const hadDetail = this.hasDetail();
    const realtimeVersion = this.detailRealtimeVersion;
    // Snapshot the card's realtime-mutation revision. Labels, assignees, custom fields, attachments,
    // and checklists arrive via their own board-level socket events (not CARD_UPDATED), so
    // detailRealtimeVersion alone can't tell whether a slow /detail response is about to revert them.
    const detailRevision = this.state.cardDetailRealtimeRevision(cardId);
    this.detailLoading.set(!hadDetail);
    this.detailError.set(false);
    try {
      const detail = await this.api.get<WireCardDetail>(`/cards/${cardId}/detail`);
      if (seq !== this.detailLoadSeq) return;
      // Mirror the response back into board state only when it can't clobber newer realtime state.
      // On an initial load there is no complete detail object to retain, so retry from a revision
      // captured after the socket mutation; that hydrates the missing body without replacing the
      // newer realtime values with this stale response.
      const realtimeMutatedDuringFetch = this.state.cardDetailRealtimeRevision(cardId) !== detailRevision;
      if (!hadDetail && realtimeMutatedDuringFetch) {
        void this.refreshDetailFromNetwork(cardId, boardId);
        return;
      }
      if (!realtimeMutatedDuringFetch) {
        this.state.setCardDetail(detail);
        // Keep the published baseline current without clobbering a dirty editor. If the editor
        // opened before /detail filled in the real description, the helper hydrates that clean
        // empty editor once the authoritative body arrives.
        if (this.detailRealtimeVersion === realtimeVersion) {
          this.applyPublishedDescription(detail.card.description ?? "");
        }
        const boardSnapshot = this.state.snapshot();
        if (boardSnapshot) void this.offlineCache.saveBoard(boardId, boardSnapshot).catch(() => undefined);
        const cached = await this.offlineCache.loadCardDetail(cardId).catch(() => null);
        if (seq === this.detailLoadSeq) {
          void this.offlineCache.saveCardDetail(cardId, detail, cached?.feed ?? []).catch(() => undefined);
        }
      }
      if (seq === this.detailLoadSeq) {
        this.detailError.set(false);
        this.detailLoading.set(false);
      }
    } catch {
      // loadCachedDetail bumps detailLoadSeq and finalizes loading/error itself, so guard on the
      // original seq before delegating and don't double-finalize here.
      if (seq === this.detailLoadSeq) await this.loadCachedDetail(cardId);
    }
  }

  private async loadCachedDetail(cardId: string) {
    const seq = ++this.detailLoadSeq;
    try {
      const existingDetail = this.state.detailForCard(cardId);
      if (existingDetail) {
        this.applyPublishedDescription(existingDetail.card.description ?? "");
        return;
      }

      const cached = await this.offlineCache.loadCardDetail(cardId).catch(() => null);
      if (seq !== this.detailLoadSeq || !cached) return;
      this.state.setCardDetail(cached.detail);
      this.applyPublishedDescription(cached.detail.card.description ?? "");
    } finally {
      if (seq === this.detailLoadSeq) {
        this.detailLoading.set(false);
        // No detail from state or cache → surface the inline error/Retry banner for the body.
        this.detailError.set(!this.hasDetail());
      }
    }
  }

  retryDetail() {
    void this.refreshDetailFromNetwork(this.cardId(), this.boardId());
  }

  editTitle() {
    if (!this.canEdit()) return;
    this.draftTitle.set(this.card().title);
    this.editingTitle.set(true);
  }

  async saveTitle() {
    if (!this.editingTitle()) return;
    // Connectivity can drop while a title edit is open (the input stays mounted, gated only by
    // role). Don't attempt a mutation offline — exit edit mode and keep the current title.
    if (!this.canEdit()) {
      this.editingTitle.set(false);
      return;
    }
    const next = this.draftTitle().trim();
    this.editingTitle.set(false);
    if (next && next !== this.card().title) {
      const card = await this.api.patch<WireCard>(`/cards/${this.card().id}`, { title: next });
      this.state.updateCard(card);
    }
  }

  cancelTitle() {
    this.editingTitle.set(false);
  }

  startEditDescription() {
    if (!this.canEdit()) return;
    const recovered = this.editorDrafts.load(this.currentUserId(), "card-description", this.card().id);
    this.editorInitialValue.set(recovered?.markdown ?? this.draftDescription());
    this.recoveredDescriptionDraft.set(Boolean(recovered));
    this.editingDescription.set(true);
  }

  cancelEditDescription() {
    this.discardDescriptionDraft();
  }

  onDescriptionDraftChange(markdown: string) {
    // The editor component reads its value only when it is created. Keep the latest live text here
    // so browser visibility, role, or detail refreshes that remount the editor cannot reopen it
    // with an older/empty initial value.
    this.editorInitialValue.set(markdown);
    this.editorDrafts.save({
      userId: this.currentUserId(),
      kind: "card-description",
      entityId: this.card().id,
      cardId: this.card().id,
      markdown,
      baseMarkdown: this.draftDescription(),
    });
  }

  discardDescriptionDraft() {
    this.editorDrafts.clear(this.currentUserId(), "card-description", this.card().id);
    this.recoveredDescriptionDraft.set(false);
    const detail = this.state.detailForCard(this.card().id);
    const card = this.card();
    this.draftDescription.set(detail?.card.description ?? ("description" in card ? card.description ?? "" : ""));
    this.exitDescriptionEdit();
  }

  async onSaveDescription(event: { markdown: string; attachmentIds: string[] }) {
    // The editor stays mounted (and typeable) during offline blips, so a save can be triggered
    // while offline. Treat that as an explicit draft save: persist locally, close the editor, and
    // leave the recovered-draft banner ready for the next edit attempt without implying sync.
    if (!this.canEdit()) {
      const draft = this.editorDrafts.save({
        userId: this.currentUserId(),
        kind: "card-description",
        entityId: this.card().id,
        cardId: this.card().id,
        markdown: event.markdown,
        baseMarkdown: this.draftDescription(),
      });
      this.editorInitialValue.set(draft?.markdown ?? event.markdown);
      this.recoveredDescriptionDraft.set(Boolean(draft));
      this.descriptionEditor()?.setSaving(false);
      this.exitDescriptionEdit();
      return;
    }
    this.savingDescription.set(true);
    try {
      const card = await this.api.patch<WireCard>(`/cards/${this.card().id}`, { description: event.markdown });
      this.state.updateCard(card);
      this.draftDescription.set(card.description ?? "");
      this.editorDrafts.clear(this.currentUserId(), "card-description", card.id);
      this.recoveredDescriptionDraft.set(false);
      this.exitDescriptionEdit();
      void this.refreshDetailFromNetwork(card.id, card.boardId);
    } finally {
      this.savingDescription.set(false);
    }
  }

  private exitDescriptionEdit() {
    this.descriptionExpanded.set(false);
    this.editingDescription.set(false);
  }

  private applyPublishedDescription(markdown: string) {
    const previousBaseline = this.draftDescription();
    this.draftDescription.set(markdown);

    if (!this.editingDescription()) {
      if (!this.recoveredDescriptionDraft()) this.editorInitialValue.set(markdown);
      return;
    }

    const editor = this.descriptionEditor();
    if (!editor) {
      if (!this.recoveredDescriptionDraft() && this.editorInitialValue().trim() === previousBaseline.trim()) {
        this.editorInitialValue.set(markdown);
      }
      return;
    }
    const cleanEditorStillShowsPreviousBaseline = editor
      && !editor.isDirty()
      && editor.markdown().trim() === previousBaseline.trim()
      && this.editorInitialValue().trim() === previousBaseline.trim();
    // If the editor opened before /detail hydrated the real description, promote the published
    // value into that still-clean editor. A dirty editor keeps the user's draft untouched.
    if (cleanEditorStillShowsPreviousBaseline) {
      this.editorInitialValue.set(markdown);
      editor.replaceWithCleanMarkdown(markdown);
    }
  }

  private valueRow(fieldId: string): CardCustomFieldValue | undefined {
    return this.customFieldValuesByFieldId().get(fieldId);
  }

  optionIdsFor(fieldId: string): string[] {
    return this.valueRow(fieldId)?.valueOptionIds ?? [];
  }

  userIdsFor(fieldId: string): string[] {
    return this.valueRow(fieldId)?.valueUserIds ?? [];
  }

  /** Active options for a field, tolerating the plain CustomField shape (no options). */
  optionsForField(field: AnyCustomField): WireCustomFieldOption[] {
    return "options" in field ? field.options : [];
  }

  async setCheckboxField(field: AnyCustomField, checked: boolean) {
    if (!this.canEdit()) return;
    await this.api.put(`/cards/${this.card().id}/custom-fields/${field.id}`, { valueCheckbox: checked });
  }

  async setField(field: AnyCustomField, value: string) {
    if (!this.canEdit()) return;
    const fieldKey = this.customFieldRequestKey(field.id);
    if (value === "") {
      await this.saveCustomFieldOnce(fieldKey, "delete", () => this.api.delete(`/cards/${this.card().id}/custom-fields/${field.id}`));
      return;
    }
    const valueNumber = field.type === "number" ? this.roundNumberFieldValue(value) : value;
    if (valueNumber === null) return;
    await this.saveCustomFieldOnce(
      fieldKey,
      field.type === "number" ? `number:${valueNumber}` : `text:${value}`,
      () => this.api.put(
        `/cards/${this.card().id}/custom-fields/${field.id}`,
        field.type === "number" ? { valueNumber } : { valueText: value },
      ),
    );
  }

  async setDateField(field: AnyCustomField, value: string) {
    if (!this.canEdit()) return;
    this.cfPickerFieldId.set(null);
    if (!value) {
      await this.api.delete(`/cards/${this.card().id}/custom-fields/${field.id}`);
      return;
    }
    await this.api.put(`/cards/${this.card().id}/custom-fields/${field.id}`, { valueDate: value });
  }

  async setUrlField(field: AnyCustomField, value: string) {
    if (!this.canEdit()) return;
    const fieldKey = this.customFieldRequestKey(field.id);
    const trimmed = value.trim();
    if (!trimmed) {
      await this.saveCustomFieldOnce(fieldKey, "delete", () => this.api.delete(`/cards/${this.card().id}/custom-fields/${field.id}`));
      return;
    }
    await this.saveCustomFieldOnce(fieldKey, `url:${trimmed}`, () => this.api.put(`/cards/${this.card().id}/custom-fields/${field.id}`, { valueUrl: trimmed }));
  }

  /** Toggle one option on a select field, honouring single vs multi cardinality. */
  async toggleSelectOption(field: AnyCustomField, optionId: string) {
    if (!this.canEdit()) return;
    const current = this.optionIdsFor(field.id);
    const allowMultiple = "allowMultiple" in field && field.allowMultiple;
    let next: string[];
    if (allowMultiple) {
      next = current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId];
    } else {
      next = current.includes(optionId) ? [] : [optionId];
      this.cfPickerFieldId.set(null);
    }
    await this.writeIds(field.id, "valueOptionIds", next);
  }

  /** Toggle one user on a user field, honouring single vs multi cardinality. */
  async toggleUserValue(field: AnyCustomField, userId: string) {
    if (!this.canEdit()) return;
    const current = this.userIdsFor(field.id);
    const allowMultiple = "allowMultiple" in field && field.allowMultiple;
    let next: string[];
    if (allowMultiple) {
      next = current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId];
    } else {
      next = current.includes(userId) ? [] : [userId];
      this.cfPickerFieldId.set(null);
    }
    await this.writeIds(field.id, "valueUserIds", next);
  }

  async clearCfField(field: AnyCustomField) {
    if (!this.canEdit()) return;
    this.cfPickerFieldId.set(null);
    await this.api.delete(`/cards/${this.card().id}/custom-fields/${field.id}`);
  }

  private async writeIds(fieldId: string, key: "valueOptionIds" | "valueUserIds", ids: string[]) {
    if (ids.length === 0) {
      await this.api.delete(`/cards/${this.card().id}/custom-fields/${fieldId}`);
      return;
    }
    await this.api.put(`/cards/${this.card().id}/custom-fields/${fieldId}`, { [key]: ids });
  }

  private customFieldRequestKey(fieldId: string): string {
    return `${this.card().id}:${fieldId}`;
  }

  private async saveCustomFieldOnce(fieldKey: string, saveKey: string, save: () => Promise<unknown>) {
    if (this.customFieldSaveKeys.get(fieldKey) === saveKey) return;
    this.customFieldSaveKeys.set(fieldKey, saveKey);
    try {
      await save();
    } catch (err) {
      if (this.customFieldSaveKeys.get(fieldKey) === saveKey) this.customFieldSaveKeys.delete(fieldKey);
      throw err;
    }
  }

  toggleCfPicker(fieldId: string, e: MouseEvent) {
    e.stopPropagation();
    this.cfPickerFieldId.update((open) => (open === fieldId ? null : fieldId));
  }

  private roundNumberFieldValue(value: string): string | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return String(Math.round((parsed + Number.EPSILON) * 100) / 100);
  }

  visibleChecklistItems(checklist: WireCardChecklist): WireCardChecklistItem[] {
    return this.visibleChecklistItemsByChecklistId().get(checklist.id) ?? checklist.items;
  }

  hiddenChecklistItemCount(checklist: WireCardChecklist): number {
    if (!this.hideCompletedChecklistItems()) return 0;
    return this.checklistProgressById().get(checklist.id)?.done ?? 0;
  }

  toggleCompletedChecklistItems() {
    this.hideCompletedChecklistItems.update((value) => !value);
  }

  isChecklistCollapsed(checklistId: string): boolean {
    return this.collapsedChecklistIds().has(checklistId);
  }

  toggleChecklistCollapsed(checklistId: string) {
    const cardId = this.cardId();
    this.collapsedChecklistIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(checklistId)) {
        next.delete(checklistId);
      } else {
        next.add(checklistId);
      }
      this.persistCollapsedChecklistIds(cardId, next);
      return next;
    });
  }

  startAddChecklist(parentItemId: string | null = null) {
    // The API intentionally permits one nested level only. Keep programmatic callers aligned with
    // the drawer UI so an item already inside a sub-checklist cannot start an invalid third level.
    if (parentItemId && !this.checklists().some((checklist) =>
      checklist.parentItemId === null && checklist.items.some((item) => item.id === parentItemId)
    )) return;
    this.checklistTemplatePickerOpen.set(false);
    this.addingChecklist.set(true);
    this.newChecklistParentItemId.set(parentItemId);
    this.newChecklistTitle.set("");
  }

  cancelAddChecklist() {
    this.addingChecklist.set(false);
    this.newChecklistParentItemId.set(null);
    this.newChecklistTitle.set("");
  }

  async createChecklist(event?: Event) {
    event?.preventDefault();
    const title = this.newChecklistTitle().trim();
    if (!title) return;
    const parentItemId = this.newChecklistParentItemId();
    const checklist = await this.api.post<WireCardChecklist>(`/cards/${this.card().id}/checklists`, {
      title,
      ...(parentItemId && { parentItemId }),
    });
    this.checklistCreated.emit(checklist);
    this.cancelAddChecklist();
    this.startAddItem(checklist.id);
  }

  toggleChecklistTemplatePicker(event: MouseEvent) {
    event.stopPropagation();
    if (!this.canEdit() || this.checklistTemplates().length === 0) return;
    this.addingChecklist.set(false);
    this.checklistTemplatePickerOpen.update((value) => !value);
  }

  isChecklistTemplateApplied(templateId: string): boolean {
    return this.appliedChecklistTemplateIdSet().has(templateId);
  }

  async applyChecklistTemplate(template: WireChecklistTemplate) {
    if (!this.canEdit() || this.applyingChecklistTemplates() || this.isChecklistTemplateApplied(template.id)) return;
    this.applyingChecklistTemplates.set(true);
    try {
      const result = await this.api.post<{ checklists: WireCardChecklist[]; skippedTemplateIds: string[] }>(
        `/cards/${this.card().id}/checklist-templates/apply`,
        { templateIds: [template.id] },
      );
      const created = result.checklists ?? [];
      for (const checklist of created) this.checklistCreated.emit(checklist);
      this.locallyAppliedChecklistTemplateIds.update((ids) => new Set(ids).add(template.id));
      this.checklistTemplatePickerOpen.set(false);
      this.checklistTemplateQuery.set("");
    } finally {
      this.applyingChecklistTemplates.set(false);
    }
  }

  startEditChecklist(checklist: WireCardChecklist) {
    if (!this.canEdit()) return;
    this.editingChecklistId.set(checklist.id);
    this.draftChecklistTitle.set(checklist.title);
  }

  async saveChecklistTitle(checklist: WireCardChecklist) {
    if (this.editingChecklistId() !== checklist.id) return;
    const title = this.draftChecklistTitle().trim();
    this.editingChecklistId.set(null);
    if (title && title !== checklist.title) {
      await this.api.patch(`/cards/${this.card().id}/checklists/${checklist.id}`, { title });
    }
  }

  cancelChecklistTitle() {
    this.editingChecklistId.set(null);
    this.draftChecklistTitle.set("");
  }

  async deleteChecklist(checklist: WireCardChecklist) {
    // Empty checklists, including item-owned sub-checklists, have no child work to lose and can
    // be removed immediately. Keep the destructive confirmation when items would be removed.
    if (checklist.items.length > 0 && !await this.confirm.open({ title: `Delete "${checklist.title}"?`, message: "Checklist items will be removed from this card.", danger: true })) return;
    await this.api.delete(`/cards/${this.card().id}/checklists/${checklist.id}`);
  }

  startAddItem(checklistId: string) {
    this.addingItemChecklistId.set(checklistId);
    this.newItemText.set("");
  }

  cancelAddItem() {
    this.addingItemChecklistId.set(null);
    this.newItemText.set("");
  }

  async createChecklistItem(checklistId: string, event?: Event) {
    event?.preventDefault();
    const text = this.newItemText().trim();
    if (!text) return;
    await this.api.post(`/cards/${this.card().id}/checklists/${checklistId}/items`, { text });
    // Keep the form open for batch entry — just clear and refocus
    this.newItemText.set("");
    this.addItemInput()?.nativeElement.focus();
  }

  startEditItem(item: WireCardChecklistItem) {
    if (!this.canEdit()) return;
    this.editingItemId.set(item.id);
    this.draftItemText.set(item.text);
  }

  openChecklistItemDetailsFromMenu(item: WireCardChecklistItem) {
    this.checklistItemActionsMenuId.set(null);
    this.openChecklistItemDetail(item);
  }

  startEditChecklistItemFromMenu(item: WireCardChecklistItem) {
    this.checklistItemActionsMenuId.set(null);
    this.startEditItem(item);
  }

  async deleteChecklistItemFromMenu(checklistId: string, item: WireCardChecklistItem) {
    this.checklistItemActionsMenuId.set(null);
    await this.deleteChecklistItem(checklistId, item);
  }

  async saveChecklistItem(checklistId: string, item: WireCardChecklistItem) {
    if (this.editingItemId() !== item.id) return;
    const text = this.draftItemText().trim();
    this.editingItemId.set(null);
    if (text && text !== item.text) {
      await this.api.patch(`/cards/${this.card().id}/checklists/${checklistId}/items/${item.id}`, { text });
    }
  }

  cancelChecklistItem() {
    this.editingItemId.set(null);
    this.draftItemText.set("");
  }

  toggleChecklistItemAssigneePicker(itemId: string, event: MouseEvent) {
    event.stopPropagation();
    this.checklistItemAssigneePickerId.update((current) => current === itemId ? null : itemId);
  }

  toggleBulkChecklistAssigneePicker(checklistId: string, event: MouseEvent) {
    event.stopPropagation();
    if (!this.canEdit()) return;
    this.bulkChecklistAssigneePickerId.update((current) => current === checklistId ? null : checklistId);
  }

  toggleBulkChecklistDueDatePicker(checklistId: string, event: MouseEvent) {
    event.stopPropagation();
    if (!this.canEdit()) return;
    this.bulkChecklistDueDatePickerId.update((current) => current === checklistId ? null : checklistId);
  }

  async bulkSetChecklistItemAssignee(checklist: WireCardChecklist, userId: string | null) {
    if (!this.canEdit() || checklist.items.length === 0) return;
    // Bulk checklist actions intentionally cover every item, including completed items hidden by the local view filter.
    const targets = checklist.items.filter((item) => item.assigneeId !== userId);
    if (targets.length === 0) {
      this.bulkChecklistAssigneePickerId.set(null);
      return;
    }

    const previous = new Map(targets.map((item) => [item.id, item]));
    for (const item of targets) {
      this.state.updateChecklistItem(this.card().id, checklist.id, { ...item, assigneeId: userId });
    }

    try {
      const result = await this.api.patch<{ items: WireCardChecklistItem[] }>(`/cards/${this.card().id}/checklists/${checklist.id}/items/bulk`, { assigneeId: userId });
      for (const item of result.items) this.state.updateChecklistItem(this.card().id, checklist.id, item);
      this.bulkChecklistAssigneePickerId.set(null);
    } catch (e) {
      for (const item of previous.values()) this.state.updateChecklistItem(this.card().id, checklist.id, item);
      throw e;
    }
  }

  async setChecklistItemAssignee(checklistId: string, item: WireCardChecklistItem, userId: string | null) {
    if (!this.canEdit()) return;
    const assigneeId = item.assigneeId === userId ? null : userId;
    if (item.assigneeId === assigneeId) {
      this.checklistItemAssigneePickerId.set(null);
      return;
    }

    // Checklist-item assignment is independent of card assignment: it must not add the user to
    // the card's assignees (the server no longer does either). It only updates the item itself.
    const previous = item;
    const next = { ...item, assigneeId };
    this.state.updateChecklistItem(this.card().id, checklistId, next);
    try {
      await this.api.patch(`/cards/${this.card().id}/checklists/${checklistId}/items/${item.id}`, { assigneeId });
      this.checklistItemAssigneePickerId.set(null);
    } catch (e) {
      this.state.updateChecklistItem(this.card().id, checklistId, previous);
      throw e;
    }
  }

  toggleChecklistItemDueDatePicker(itemId: string, event: MouseEvent) {
    event.stopPropagation();
    this.checklistItemDueDatePickerId.update((current) => current === itemId ? null : itemId);
  }

  async setChecklistItemDueDate(checklistId: string, item: WireCardChecklistItem, dateStr: string, slot: DueDateSlotSelection = "anyTime") {
    if (!this.canEdit()) return;
    const dueDateLocalDate = dateStr || null;
    const previous = item;
    // Optimistic update; the server resolves dueDateTimezone from the actor and
    // the authoritative item arrives via the checklistItem:updated event.
    const next = { ...item, dueDateLocalDate, dueDateSlot: dueDateLocalDate ? slot : null };
    this.state.updateChecklistItem(this.card().id, checklistId, next);
    if (!dueDateLocalDate) this.checklistItemDueDatePickerId.set(null);
    try {
      await this.api.patch(`/cards/${this.card().id}/checklists/${checklistId}/items/${item.id}`, {
        dueDateLocalDate,
        dueDateSlot: dueDateLocalDate ? slot : null,
      });
    } catch (e) {
      this.state.updateChecklistItem(this.card().id, checklistId, previous);
      throw e;
    }
  }

  async bulkSetChecklistItemDueDate(checklist: WireCardChecklist, dateStr: string, slot: DueDateSlotSelection = "anyTime") {
    if (!this.canEdit() || checklist.items.length === 0) return;
    const dueDateLocalDate = dateStr || null;
    const dueDateSlot = dueDateLocalDate ? slot : null;
    const targets = checklist.items.filter((item) => item.dueDateLocalDate !== dueDateLocalDate || item.dueDateSlot !== dueDateSlot);
    if (targets.length === 0) {
      if (!dueDateLocalDate) this.bulkChecklistDueDatePickerId.set(null);
      return;
    }

    // The server fills dueDateTimezone per actor; optimistic rows keep their current timezone until realtime confirms.
    const previous = new Map(targets.map((item) => [item.id, item]));
    for (const item of targets) {
      this.state.updateChecklistItem(this.card().id, checklist.id, { ...item, dueDateLocalDate, dueDateSlot });
    }

    try {
      const result = await this.api.patch<{ items: WireCardChecklistItem[] }>(`/cards/${this.card().id}/checklists/${checklist.id}/items/bulk`, { dueDateLocalDate, dueDateSlot });
      for (const item of result.items) this.state.updateChecklistItem(this.card().id, checklist.id, item);
      if (!dueDateLocalDate) this.bulkChecklistDueDatePickerId.set(null);
    } catch (e) {
      for (const item of previous.values()) this.state.updateChecklistItem(this.card().id, checklist.id, item);
      throw e;
    }
  }

  async toggleChecklistItem(checklistId: string, item: WireCardChecklistItem) {
    if (!this.canEdit()) return;
    await this.api.patch(`/cards/${this.card().id}/checklists/${checklistId}/items/${item.id}`, {
      completed: !item.completedAt,
    });
  }

  async deleteChecklistItem(checklistId: string, item: WireCardChecklistItem) {
    if (!this.canEdit()) return;
    const hasItemDetail = Boolean(item.description?.trim()) || this.subChecklistsFor(item).length > 0;
    if (hasItemDetail && !await this.confirm.open({
      title: `Delete "${item.text}"?`,
      message: "Its description and nested checklists will also be deleted.",
      danger: true,
    })) return;
    await this.api.delete(`/cards/${this.card().id}/checklists/${checklistId}/items/${item.id}`);
    if (this.openChecklistItemId() !== item.id) return;
    // Deleting the entity also discards its local-only description draft. Close directly instead
    // of running the unsaved-navigation prompt for work that can no longer be published.
    this.editorDrafts.clear(this.currentUserId(), "checklist-item-description", item.id);
    this.recoveredChecklistItemDescriptionDraft.set(false);
    this.editingChecklistItemDescription.set(false);
    this.editingItemId.set(null);
    this.openChecklistItemId.set(null);
    this.checklistItemAssigneePickerId.set(null);
    this.checklistItemDueDatePickerId.set(null);
    this.cancelAddChecklist();
  }

  async dropChecklist(event: CdkDragDrop<WireCardChecklist[]>) {
    if (!this.canEdit() || event.previousIndex === event.currentIndex) return;
    const next = [...event.container.data];
    moveItemInArray(next, event.previousIndex, event.currentIndex);
    const moved = next[event.currentIndex];
    const after = next[event.currentIndex - 1] ?? null;
    const before = next[event.currentIndex + 1] ?? null;
    if (!moved) return;
    this.state.moveChecklist(this.card().id, moved.id, this.positionBetween(after?.position ?? null, before?.position ?? null));
    await this.api.post(`/cards/${this.card().id}/checklists/${moved.id}/move`, { afterChecklistId: after?.id ?? null });
  }

  async dropChecklistItem(event: CdkDragDrop<WireCardChecklistItem[]>, targetChecklistId: string) {
    if (!this.canEdit()) return;
    const moved = event.item.data as WireCardChecklistItem;
    const target = [...event.container.data];
    if (event.previousContainer === event.container) {
      if (event.previousIndex === event.currentIndex) return;
      moveItemInArray(target, event.previousIndex, event.currentIndex);
    } else {
      const source = [...event.previousContainer.data];
      transferArrayItem(source, target, event.previousIndex, event.currentIndex);
    }
    const after = target[event.currentIndex - 1] ?? null;
    const before = target[event.currentIndex + 1] ?? null;
    this.state.moveChecklistItem(
      this.card().id,
      moved.id,
      moved.checklistId,
      targetChecklistId,
      this.positionBetween(after?.position ?? null, before?.position ?? null),
    );
    await this.api.post(`/cards/${this.card().id}/checklists/${moved.checklistId}/items/${moved.id}/move`, {
      checklistId: targetChecklistId,
      afterItemId: after?.id ?? null,
    });
  }

  checklistDropListId(checklistId: string): string {
    return `checklist-items-${checklistId}`;
  }

  checklistDropListIdsFor(checklists: WireCardChecklist[]): string[] {
    return checklists.map((checklist) => this.checklistDropListId(checklist.id));
  }

  subChecklistsFor(item: WireCardChecklistItem): WireCardChecklist[] {
    return this.checklists().filter((checklist) => checklist.parentItemId === item.id);
  }

  openChecklistItemDetail(item: WireCardChecklistItem) {
    // Nested checklist items are terminal rows. Their API supports text and completion only, so
    // never expose the mini-card drawer even if this method is reached outside the row template.
    const containingChecklist = this.checklists().find((checklist) => checklist.items.some((candidate) => candidate.id === item.id));
    if (!containingChecklist || containingChecklist.parentItemId !== null) return;
    this.openChecklistItemId.set(item.id);
  }

  closeChecklistItemDetail() {
    // Only this drawer's own description editor should gate its close — an unsaved card-description
    // or comment editor elsewhere on the card stays mounted and must not prompt here (that global
    // check belongs to closing the card / navigating away). Combine the mounted editor's live-edit
    // state with the recovered-draft source so both surface a prompt; the item's EditorDraft is
    // preserved either way if the user chooses to leave.
    const dirty = this.unsavedWork.isDirty(this.checklistItemUnsavedDraftSource)
      || (this.checklistItemDescriptionEditor()?.isDirty() ?? false);
    if (!this.unsavedWork.confirm(dirty)) return;
    this.openChecklistItemId.set(null);
    this.checklistItemAssigneePickerId.set(null);
    this.checklistItemDueDatePickerId.set(null);
    this.cancelAddChecklist();
  }

  startEditChecklistItemDescription() {
    const item = this.openChecklistItem();
    if (!item || !this.canEdit()) return;
    const recovered = this.editorDrafts.load(this.currentUserId(), "checklist-item-description", item.id);
    this.checklistItemDescriptionInitialValue.set(recovered?.markdown ?? item.description ?? "");
    this.recoveredChecklistItemDescriptionDraft.set(Boolean(recovered));
    this.editingChecklistItemDescription.set(true);
  }

  onChecklistItemDescriptionDraftChange(markdown: string) {
    const item = this.openChecklistItem();
    if (!item) return;
    // The drawer can be remounted by responsive/layout or permission transitions; keep the current
    // markdown as its next creation value so local edits never fall back to the published text.
    this.checklistItemDescriptionInitialValue.set(markdown);
    this.editorDrafts.save({
      userId: this.currentUserId(),
      kind: "checklist-item-description",
      entityId: item.id,
      cardId: this.card().id,
      markdown,
      baseMarkdown: item.description ?? "",
    });
  }

  cancelEditChecklistItemDescription() {
    const item = this.openChecklistItem();
    if (item) this.editorDrafts.clear(this.currentUserId(), "checklist-item-description", item.id);
    this.recoveredChecklistItemDescriptionDraft.set(false);
    this.editingChecklistItemDescription.set(false);
  }

  async saveChecklistItemDescription(event: { markdown: string; attachmentIds: string[] }) {
    const item = this.openChecklistItem();
    const checklistId = this.openChecklistItemChecklistId();
    if (!item || !checklistId) return;
    if (!this.canEdit()) {
      const draft = this.editorDrafts.save({
        userId: this.currentUserId(),
        kind: "checklist-item-description",
        entityId: item.id,
        cardId: this.card().id,
        markdown: event.markdown,
        baseMarkdown: item.description ?? "",
      });
      this.checklistItemDescriptionInitialValue.set(draft?.markdown ?? event.markdown);
      this.recoveredChecklistItemDescriptionDraft.set(Boolean(draft));
      this.checklistItemDescriptionEditor()?.setSaving(false);
      this.editingChecklistItemDescription.set(false);
      return;
    }
    try {
      const description = event.markdown || null;
      const updated = await this.api.patch<WireCardChecklistItem>(
        `/cards/${this.card().id}/checklists/${checklistId}/items/${item.id}`,
        { description },
      );
      this.state.updateChecklistItem(this.card().id, checklistId, updated);
      this.editorDrafts.clear(this.currentUserId(), "checklist-item-description", item.id);
      this.recoveredChecklistItemDescriptionDraft.set(false);
      this.editingChecklistItemDescription.set(false);
    } finally {
      this.checklistItemDescriptionEditor()?.setSaving(false);
    }
  }

  private positionBetween(prev: string | null, next: string | null): string {
    return betweenBoardPositions(prev, next);
  }

  private initialHideCompletedChecklistItems(): boolean {
    return localStorage.getItem(STORAGE_KEYS.HIDE_COMPLETED_CHECKLIST_ITEMS) === "1";
  }

  private initialCollapsedChecklistIds(cardId: string): Set<string> {
    const stored = this.readCollapsedChecklistsStorage();
    if (Array.isArray(stored)) return new Set(stored);
    return new Set(stored[cardId] ?? []);
  }

  private persistCollapsedChecklistIds(cardId: string, ids: Set<string>) {
    const stored = this.readCollapsedChecklistsStorage();
    const next = Array.isArray(stored) ? {} : { ...stored };
    if (ids.size) {
      next[cardId] = [...ids];
    } else {
      delete next[cardId];
    }
    localStorage.setItem(STORAGE_KEYS.COLLAPSED_CHECKLISTS, JSON.stringify(next));
  }

  private readCollapsedChecklistsStorage(): Record<string, string[]> | string[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.COLLAPSED_CHECKLISTS) ?? "[]");
      if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === "string");
      if (!parsed || typeof parsed !== "object") return {};
      const entries = Object.entries(parsed).flatMap(([cardId, ids]) => {
        if (!Array.isArray(ids)) return [];
        return [[cardId, ids.filter((id): id is string => typeof id === "string")]] as const;
      });
      return Object.fromEntries(entries);
    } catch {
      return {};
    }
  }

  onDocumentClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (this.addingChecklist() && !target?.closest(".checklist-add, .checklist-add-btn")) this.cancelAddChecklist();
    const editingChecklistId = this.editingChecklistId();
    if (editingChecklistId) {
      const targetChecklistId = target?.closest(".checklist-block")?.getAttribute("data-checklist-id") ?? null;
      const isChecklistTitleControl = Boolean(target?.closest(".checklist-title, .checklist-title-input"));
      if (targetChecklistId !== editingChecklistId || !isChecklistTitleControl) this.cancelChecklistTitle();
    }
    const editingItemId = this.editingItemId();
    if (editingItemId) {
      const isDrawerTitleControl = Boolean(target?.closest(".checklist-item-panel-title"));
      const targetItemId = isDrawerTitleControl
        ? this.openChecklistItemId()
        : target?.closest(".checklist-item")?.getAttribute("data-checklist-item-id") ?? null;
      // Rename starts editing on the same click that bubbles here (from the row action menu on
      // desktop or the item title control in the drawer). Treat it as an in-item edit control so
      // this handler doesn't immediately cancel the edit it just triggered.
      const isChecklistItemTitleControl = isDrawerTitleControl || Boolean(target?.closest(".checklist-item-text, .checklist-item-input, .checklist-item-rename"));
      if (targetItemId !== editingItemId || !isChecklistItemTitleControl) this.cancelChecklistItem();
    }
    const addingItemChecklistId = this.addingItemChecklistId();
    if (addingItemChecklistId) {
      const targetChecklistId = target?.closest(".checklist-block")?.getAttribute("data-checklist-id") ?? null;
      if (targetChecklistId !== addingItemChecklistId) this.cancelAddItem();
    }
    if (!target?.closest(".member-picker-wrap")) this.memberPickerOpen.set(false);
    if (!target?.closest(".checklist-assignee-wrap")) this.checklistItemAssigneePickerId.set(null);
    if (!target?.closest(".checklist-duedate-wrap")) this.checklistItemDueDatePickerId.set(null);
    if (!target?.closest(".checklist-bulk-wrap")) {
      this.bulkChecklistAssigneePickerId.set(null);
      this.bulkChecklistDueDatePickerId.set(null);
    }
    if (!target?.closest(".label-picker-wrap")) this.labelPickerOpen.set(false);
    if (!target?.closest(".due-picker-wrap")) this.dueDatePickerOpen.set(false);
    if (!target?.closest(".cf-picker-wrap")) this.cfPickerFieldId.set(null);
  }

  onDocumentKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      if (this.closing()) return;
      const anyPopoverOpen = this.moveToListOpen() || this.memberPickerOpen() || this.checklistTemplatePickerOpen() || this.checklistItemAssigneePickerId() || this.checklistItemDueDatePickerId() || this.bulkChecklistAssigneePickerId() || this.bulkChecklistDueDatePickerId() || this.labelPickerOpen() ||
        this.dueDatePickerOpen() || this.cfPickerFieldId() || this.actionsMenuOpen() || this.copyToBoardOpen() || this.moveToBoardOpen();
      if (anyPopoverOpen) {
        this.moveToListOpen.set(false);
        this.memberPickerOpen.set(false);
        this.checklistTemplatePickerOpen.set(false);
        this.checklistItemAssigneePickerId.set(null);
        this.checklistItemDueDatePickerId.set(null);
        this.bulkChecklistAssigneePickerId.set(null);
        this.bulkChecklistDueDatePickerId.set(null);
        this.labelPickerOpen.set(false);
        this.dueDatePickerOpen.set(false);
        this.cfPickerFieldId.set(null);
        this.actionsMenuOpen.set(false);
        this.copyToBoardOpen.set(false);
        this.moveToBoardOpen.set(false);
      } else if (this.openChecklistItemId()) {
        this.closeChecklistItemDetail();
      } else {
        this.requestClose();
      }
      return;
    }

    if (event.key !== "Tab") return;

    const panel = this.panel()?.nativeElement;
    if (!panel || this.closing()) return;

    const focusable = this.focusableElements(panel);
    if (!focusable.length) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const active = document.activeElement;
    const currentIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    const nextIndex = event.shiftKey
      ? currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
      : currentIndex === -1 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;

    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  private focusableElements(root: HTMLElement): HTMLElement[] {
    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => {
      if (el.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    });
  }

  async toggleLabel(labelId: string) {
    if (!this.canEdit()) return;
    const current = this.cardLabelIds();
    const next = current.includes(labelId)
      ? current.filter((id) => id !== labelId)
      : [...current, labelId];
    await this.api.put(`/cards/${this.card().id}/labels`, { labelIds: next });
  }

  assignedMembers(): WireBoardMemberUser[] {
    const ids = this.assigneeIds();
    if (ids.length === 0) return [];
    return this.members().filter((m) => ids.includes(m.userId));
  }

  initialFor(name: string): string {
    return (name || "?").charAt(0).toUpperCase();
  }

  toggleMemberPicker(e: MouseEvent) {
    e.stopPropagation();
    this.memberPickerOpen.update((v) => !v);
  }

  toggleLabelPicker(e: MouseEvent) {
    e.stopPropagation();
    this.labelPickerOpen.update((v) => !v);
  }

  assignedLabels() {
    const ids = this.cardLabelIds();
    if (ids.length === 0) return [];
    return this.cardLabels().filter((l) => ids.includes(l.id));
  }

  readonly isOverdue = isOverdue;
  readonly formatDueDate = formatDueDate;

  toggleDueDatePicker(e: MouseEvent) {
    e.stopPropagation();
    this.dueDatePickerOpen.update((v) => !v);
  }

  async setDueDate(dateStr: string, slot: DueDateSlotSelection = "anyTime") {
    if (!this.canEdit()) return;
    const dueDateLocalDate = dateStr || null;
    const card = await this.api.patch<WireCard>(`/cards/${this.card().id}`, {
      dueDateLocalDate,
      dueDateSlot: dueDateLocalDate ? slot : null,
    });
    this.state.updateCard(card);
    if (!dueDateLocalDate) this.dueDatePickerOpen.set(false);
  }

  dueDateInputValue(): string {
    return dueDateInputValue(this.card().dueDateLocalDate);
  }

  dueDateSlot(): DueDateSlotSelection {
    return dueDateSlotFor(this.card().dueDateSlot);
  }

  hasDueDate(): boolean {
    return Boolean(this.card().dueDateLocalDate);
  }

  dueDateText(): string {
    const card = this.card();
    return formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  dueDateOverdue(): boolean {
    const card = this.card();
    return !card.archivedAt && !card.completedAt && isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  dueDateDueSoon(): boolean {
    const card = this.card();
    return !card.archivedAt && !card.completedAt && isDueSoon(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  async toggleAssignee(userId: string) {
    if (!this.canEdit()) return;
    const assignableIds = new Set(this.members().filter((member) => member.role !== "observer").map((member) => member.userId));
    const current = this.assigneeIds().filter((id) => assignableIds.has(id));
    const next = current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId];
    this.state.setCardAssignees(this.card().id, next);
    try {
      await this.api.put(`/cards/${this.card().id}/assignees`, { userIds: next });
    } catch (e) {
      this.state.setCardAssignees(this.card().id, current);
      throw e;
    }
  }

  async onAttachmentSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await this.uploadAttachmentFiles(files);
  }

  onDocumentAttachmentDragOver(event: DragEvent) {
    if (!this.canEdit()) return;
    this.onAttachmentDragOver(event);
  }

  async onDocumentAttachmentDrop(event: DragEvent) {
    if (!this.canEdit()) return;
    await this.onAttachmentDrop(event);
  }

  onDocumentAttachmentDragEnd() {
    this.attachmentDragActive.set(false);
  }

  private readonly handleAttachmentDragCapture = (event: DragEvent) => {
    if (!this.hasDraggedFiles(event)) return;
    if (!this.canEdit() || !this.isDragInsidePanel(event) || this.isEditorDropTarget(event.target) || this.isEditablePasteTarget(event.target)) {
      this.attachmentDragActive.set(false);
    }
  };

  private readonly handleDocumentClick = (event: MouseEvent) => this.onDocumentClick(event);
  private readonly handleDocumentKeydown = (event: KeyboardEvent) => this.onDocumentKeydown(event);
  private readonly handleDocumentAttachmentDragOver = (event: DragEvent) => this.onDocumentAttachmentDragOver(event);
  private readonly handleDocumentAttachmentDrop = (event: DragEvent) => void this.onDocumentAttachmentDrop(event);
  private readonly handleDocumentAttachmentDragEnd = () => this.onDocumentAttachmentDragEnd();

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
    const current = this.panel()?.nativeElement ?? event.currentTarget as Node | null;
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

  async onCardDetailPaste(event: ClipboardEvent) {
    if (event.defaultPrevented || !this.canEdit() || this.isEditablePasteTarget(event.target)) return;

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

    if (files.length > 0) return files;
    return Array.from(data.files ?? []);
  }

  private isEditablePasteTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
  }

  private shouldHandleAttachmentDrag(event: DragEvent): boolean {
    if (event.defaultPrevented || !this.hasDraggedFiles(event)) return false;
    if (!this.isDragInsidePanel(event)) {
      this.attachmentDragActive.set(false);
      return false;
    }
    if (this.isEditorDropTarget(event.target) || this.isEditablePasteTarget(event.target)) {
      this.attachmentDragActive.set(false);
      return false;
    }
    return true;
  }

  private isEditorDropTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    // Description/comment editors upload and insert files into their markdown,
    // so panel-level attachment drops must not preempt their own drop handlers.
    return Boolean(target.closest("k-description-editor"));
  }

  private isDragInsidePanel(event: DragEvent): boolean {
    const panel = this.panel()?.nativeElement;
    if (!panel) return false;
    const target = this.dragTargetElement(event);
    return Boolean(target && panel.contains(target));
  }

  private dragTargetElement(event: DragEvent): Element | null {
    if (event.target instanceof Element) return event.target;
    if (event.clientX || event.clientY) return document.elementFromPoint(event.clientX, event.clientY);
    return null;
  }

  private async uploadAttachmentFiles(files: File[]) {
    if (!this.canEdit() || files.length === 0) return;
    // Validation, per-file progress, retry, and error formatting all live in the queue; the new
    // attachment lands in attachments() via the card:attachment:created realtime event.
    this.uploads.add(files);
  }

  private hasDraggedFiles(event: DragEvent): boolean {
    const data = event.dataTransfer;
    if (!data) return false;
    if (Array.from(data.types ?? []).some((type) => type === "Files" || type === "application/x-moz-file")) return true;
    return Array.from(data.items ?? []).some((item) => item.kind === "file");
  }

  async setCover(attachmentId: string) {
    if (!this.canEdit()) return;
    const isCurrent = this.card().coverAttachmentId === attachmentId;
    await this.api.patch(`/cards/${this.card().id}/cover`, { attachmentId: isCurrent ? null : attachmentId });
  }

  async confirmDeleteAttachment(attachmentId: string, fileName: string) {
    if (!this.canEdit()) return;
    if (!await this.confirm.open({ title: `Delete "${fileName}"?`, message: "This cannot be undone.", danger: true })) return;
    await this.api.delete(`/cards/${this.card().id}/attachments/${attachmentId}`);
  }

  formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  isImageMime(mime: string): boolean {
    return mime.startsWith("image/");
  }

  isVideoMime(mime: string): boolean {
    return mime.startsWith("video/");
  }

  isAudioMime(mime: string): boolean {
    return mime.startsWith("audio/");
  }

  // Thumbnail URL for an image attachment, or null when its signed token has
  // expired (e.g. from a restored offline snapshot). A null result shows a
  // placeholder icon instead of firing a guaranteed 404; the live card fetch
  // re-signs the attachment URLs shortly after.
  attachmentThumbUrl(attachment: CardAttachmentRow): string | null {
    return visibleSignedMediaUrl(attachment.thumbnailUrl ?? attachment.url);
  }

  async downloadAttachment(url: string, fileName: string) {
    await this.mediaDownloads.download(url, fileName);
  }

  async setArchived(archived: boolean) {
    // Gate on canArchive (role + online, archive-agnostic) not canEdit: canEdit is false for an
    // already-archived card, but unarchiving must still work. Both are blocked while offline.
    if (!this.canArchive() || this.archiving()) return;
    this.archiving.set(true);
    try {
      const card = await this.api.patch<WireCard>(`/cards/${this.card().id}/archive`, { archived });
      this.state.updateCard(card);
      this.confirmingDelete.set(false);
    } finally {
      this.archiving.set(false);
    }
  }

  formatFeedTime(createdAt: string | Date): string {
    const date = new Date(createdAt as string);
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

}
