import type { CdkDragDrop, CdkDragMove } from "@angular/cdk/drag-drop";
import { CdkDrag, CdkDragHandle, CdkDragPreview, CdkDropList, moveItemInArray, transferArrayItem } from "@angular/cdk/drag-drop";
import { CdkScrollable } from "@angular/cdk/scrolling";
import { NgOptimizedImage } from "@angular/common";
import type {
  ElementRef
} from "@angular/core";
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  HostListener,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import { Router } from "@angular/router";
import { ALLOWED_ATTACHMENT_EXTENSIONS, ALLOWED_ATTACHMENT_MIME } from "@kanera/shared/attachments";
import type { LinkedInternalSummary } from "@kanera/shared/dto";
import { expandWireCard, SERVER_EVENTS, type CardAttachmentRow, type ServerToClientEvents, type WireBoardMemberUser, type WireCard, type WireCardChecklist, type WireCardChecklistItem, type WireCardDetail, type WireCardLabel, type WireCardSummary, type WireChecklistTemplate, type WireCustomFieldOption } from "@kanera/shared/events";
import type { CardCustomFieldValue, CardLabel } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { EditorDrafts } from "../../core/browser/editor-drafts";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import { SocketService } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { attachmentIconClass } from "../../shared/attachment-icons";
import { AttachmentUploadListComponent } from "../../shared/attachments/attachment-upload-list.component";
import { AttachmentUploadQueue } from "../../shared/attachments/attachment-upload-queue.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { ConfirmService } from "../../shared/confirm.service";
import { DraftBannerComponent } from "../../shared/draft-banner.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardPickerPopover, type BoardPickerPick } from "./board-picker.popover";
import { BoardState, type AnyCustomField } from "./board-state";
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
import { LabelPickerPopover } from "./label-picker.popover";
import { MemberPickerPopover } from "./member-picker.popover";
import { SelectPickerPopover } from "./select-picker.popover";
import { WatcherPopoverComponent } from "./watcher-popover.component";

const CARD_ACTIONS_MENU_WIDTH = 220;
const CARD_ACTIONS_MENU_FALLBACK_HEIGHT = 132;
const CARD_ACTIONS_MENU_MARGIN = 8;
const CHECKLIST_DRAG_SCROLL_EDGE_PX = 80;
const CHECKLIST_DRAG_SCROLL_MAX_STEP_PX = 20;

interface FloatingMenuPosition {
  top: number;
  left: number;
  width: number;
}

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
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    CdkDragPreview,
    CdkScrollable,
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
  private readonly unsavedDraftSource = Symbol("card-description-draft");
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly sockets = inject(SocketService);
  private readonly state = inject(BoardState);
  private readonly router = inject(Router);
  private readonly layout = inject(CardDetailLayoutService);
  private readonly confirm = inject(ConfirmService);
  private readonly workspaces = inject(WorkspaceService);
  private readonly notifications = inject(NotificationsService);
  private readonly destroyRef = inject(DestroyRef);
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
  readonly descViewerInner = viewChild<ElementRef<HTMLElement>>("descViewerInner");
  readonly addItemInput = viewChild<ElementRef<HTMLInputElement>>("addItemInput");
  readonly addChecklistInput = viewChild<ElementRef<HTMLInputElement>>("addChecklistInput");
  readonly checklistTitleInput = viewChild<ElementRef<HTMLInputElement>>("checklistTitleInput");
  readonly checklistItemInput = viewChild<ElementRef<HTMLInputElement>>("checklistItemInput");
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
    // From Assigned Work the route guard owns the prompt. On a board this is only a query-param
    // change, so Angular keeps the route alive and the card detail must guard it directly.
    if (this.router.url.split("?", 1)[0].startsWith("/b/") && !this.unsavedWork.confirmNavigation()) return;
    void this.router.navigate(["/b", this.boardId()]);
  }

  async copyCardLink() {
    const tree = this.router.createUrlTree(["/b", this.boardId()], { queryParams: { cardId: this.card().id } });
    const url = new URL(this.router.serializeUrl(tree), window.location.origin).toString();
    await navigator.clipboard?.writeText(url).catch(() => undefined);
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

  requestClose() {
    if (!this.unsavedWork.confirmNavigation()) return;
    this.closing.set(true);
    setTimeout(() => this.close.emit(), 110);
  }

  readonly acceptAttr = [
    ...Object.keys(ALLOWED_ATTACHMENT_MIME),
    ...ALLOWED_ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`),
  ].join(",");
  readonly uploads = inject(AttachmentUploadQueue);
  // Derived so the existing drag/paste guards and dropzone label keep working unchanged.
  readonly uploadingAttachment = computed(() => this.uploads.busy());
  readonly attachmentDragActive = signal(false);
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
  // Attachment presentation is stable until the attachment collection changes. Precomputing it
  // avoids repeating MIME, signed-URL, size, and date formatting work on unrelated signal updates.
  readonly attachmentDisplayById = computed(() => new Map(this.attachments().map((attachment) => [
    attachment.id,
    {
      isImage: this.isImageMime(attachment.mimeType),
      thumbnailUrl: this.attachmentThumbUrl(attachment),
      iconClass: attachmentIconClass(attachment.mimeType, attachment.fileName),
      subtitle: `${attachment.uploadedByName} • ${this.formatFeedTime(attachment.createdAt)} • ${this.formatBytes(attachment.byteSize)}`,
    },
  ])));

  linkedItemHref(item: LinkedInternalSummary): string {
    if (item.kind === "card") {
      const tree = this.router.createUrlTree(["/b", item.boardId], { queryParams: { cardId: item.id } });
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

  readonly currentUserId = computed(() => this.auth.user()?.id);
  readonly memberPickerOpen = signal(false);
  readonly checklistItemAssigneePickerId = signal<string | null>(null);
  readonly checklistItemDueDatePickerId = signal<string | null>(null);
  readonly bulkChecklistAssigneePickerId = signal<string | null>(null);
  readonly bulkChecklistDueDatePickerId = signal<string | null>(null);
  readonly labelPickerOpen = signal(false);
  readonly dueDatePickerOpen = signal(false);
  // Id of the custom field whose select/user/date picker is currently open (one at a time).
  readonly cfPickerFieldId = signal<string | null>(null);
  readonly moveToListOpen = signal(false);
  readonly actionsMenuOpen = signal(false);
  readonly actionsMenuPosition = signal<FloatingMenuPosition>({ top: 0, left: 0, width: CARD_ACTIONS_MENU_WIDTH });
  readonly copyToBoardOpen = signal(false);
  readonly moveToBoardOpen = signal(false);
  readonly duplicating = signal(false);
  readonly savingCompletion = signal(false);
  readonly workspaceId = computed(() => this.workspaces.workspaceIdForBoard(this.boardId()));
  // Labels the card's source board so users on the assigned-work views know where it lives;
  // resolves for any registered board, not just the route-scoped one in BoardState.
  readonly boardSummary = computed(() => this.workspaces.boardSummaryFor(this.boardId()));

  readonly currentList = computed(() => this.state.lists().find((l) => l.id === this.card().listId));
  readonly otherLists = computed(() => this.state.visibleLists().filter((l) => l.id !== this.card().listId));

  toggleMoveToList(e: MouseEvent) {
    e.stopPropagation();
    this.closePopoversExcept("moveList");
    this.moveToListOpen.update((v) => !v);
  }

  private closePopoversExcept(except: "moveList" | "member" | "checklistTemplate" | "checklistItemAssignee" | "checklistItemDueDate" | "bulkChecklistAssignee" | "bulkChecklistDueDate" | "label" | "dueDate" | "actions" | "copyBoard" | "moveBoard") {
    if (except !== "moveList") this.moveToListOpen.set(false);
    if (except !== "member") this.memberPickerOpen.set(false);
    if (except !== "checklistTemplate") this.checklistTemplatePickerOpen.set(false);
    if (except !== "checklistItemAssignee") this.checklistItemAssigneePickerId.set(null);
    if (except !== "checklistItemDueDate") this.checklistItemDueDatePickerId.set(null);
    if (except !== "bulkChecklistAssignee") this.bulkChecklistAssigneePickerId.set(null);
    if (except !== "bulkChecklistDueDate") this.bulkChecklistDueDatePickerId.set(null);
    if (except !== "label") this.labelPickerOpen.set(false);
    if (except !== "dueDate") this.dueDatePickerOpen.set(false);
    if (except !== "actions" && except !== "copyBoard" && except !== "moveBoard") {
      this.actionsMenuOpen.set(false);
      this.copyToBoardOpen.set(false);
      this.moveToBoardOpen.set(false);
    }
    if (except !== "copyBoard") this.copyToBoardOpen.set(false);
    if (except !== "moveBoard") this.moveToBoardOpen.set(false);
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
    e.stopPropagation();
    this.closePopoversExcept("actions");
    const next = !this.actionsMenuOpen();
    if (next) this.positionActionsMenu(e.currentTarget);
    this.actionsMenuOpen.set(next);
  }

  private positionActionsMenu(anchor: EventTarget | null) {
    if (!(anchor instanceof HTMLElement)) return;
    const rect = anchor.getBoundingClientRect();
    const margin = CARD_ACTIONS_MENU_MARGIN;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const width = Math.min(CARD_ACTIONS_MENU_WIDTH, Math.max(0, viewportW - margin * 2));

    let left = rect.right - width;
    if (left < margin) left = margin;
    if (left + width > viewportW - margin) left = viewportW - width - margin;

    let top = rect.bottom + 4;
    if (top + CARD_ACTIONS_MENU_FALLBACK_HEIGHT > viewportH - margin) {
      const above = rect.top - 4 - CARD_ACTIONS_MENU_FALLBACK_HEIGHT;
      top = above >= margin ? above : Math.max(margin, viewportH - CARD_ACTIONS_MENU_FALLBACK_HEIGHT - margin);
    }

    this.actionsMenuPosition.set({ top, left, width });
  }

  toggleCopyToBoard(e: MouseEvent) {
    e.stopPropagation();
    this.closePopoversExcept("copyBoard");
    this.copyToBoardOpen.update((v) => !v);
  }

  toggleMoveToBoard(e: MouseEvent) {
    e.stopPropagation();
    this.closePopoversExcept("moveBoard");
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
    if (!this.canEdit()) return;
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
  readonly newChecklistTitle = signal("");
  readonly checklistTemplates = this.state.checklistTemplates;
  readonly checklistTemplatePickerOpen = signal(false);
  readonly checklistTemplateQuery = signal("");
  readonly applyingChecklistTemplates = signal(false);
  private readonly locallyAppliedChecklistTemplateIds = signal<Set<string>>(new Set());
  readonly editingChecklistId = signal<string | null>(null);
  readonly draftChecklistTitle = signal("");
  readonly addingItemChecklistId = signal<string | null>(null);
  readonly newItemText = signal("");
  readonly editingItemId = signal<string | null>(null);
  readonly draftItemText = signal("");
  readonly hideCompletedChecklistItems = signal(this.initialHideCompletedChecklistItems());
  readonly collapsedChecklistIds = signal<Set<string>>(new Set());
  readonly checklistDropListIds = computed(() => this.checklists().map((checklist) => this.checklistDropListId(checklist.id)));
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
    this.destroyRef.onDestroy(() => this.onChecklistDragEnded());
    // path is read lazily at send time, so configuring here (before card() resolves) is safe.
    this.uploads.configure({ path: () => `/cards/${this.card().id}/attachments` });

    document.addEventListener("dragover", this.handleAttachmentDragCapture, { capture: true });
    document.addEventListener("drop", this.handleAttachmentDragCapture, { capture: true });
    this.destroyRef.onDestroy(() => {
      document.removeEventListener("dragover", this.handleAttachmentDragCapture, { capture: true });
      document.removeEventListener("drop", this.handleAttachmentDragCapture, { capture: true });
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

      const socket = this.sockets.connect();
      const handlers: Partial<ServerToClientEvents> = {
        [SERVER_EVENTS.CARD_UPDATED]: ({ card }) => {
          const expanded = expandWireCard(card);
          if (expanded.id !== cardId) return;
          // Mark that a realtime body update landed so an in-flight /detail response (which may
          // carry an older description) does not overwrite it with stale text.
          this.detailRealtimeVersion++;
          if (this.editingDescription()) return;
          this.draftDescription.set(expanded.description ?? "");
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
      // Notification image clicks arrive before /detail may have hydrated attachments;
      // keep retrying via the attachments signal until the requested image exists.
      const attachmentId = this.lightboxAttachmentId();
      if (!attachmentId) {
        this.openedInitialLightboxFor = null;
        return;
      }
      if (this.openedInitialLightboxFor === `${this.cardId()}:${attachmentId}`) return;
      if (this.openAttachmentImage(attachmentId)) {
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
        this.checklistItemInput()?.nativeElement.focus();
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
        // Don't overwrite the description while the user is editing, or if a realtime CARD_UPDATED
        // landed during the request — that body is newer than this (older) response's.
        if (!this.editingDescription() && this.detailRealtimeVersion === realtimeVersion) {
          this.draftDescription.set(detail.card.description ?? "");
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
        this.draftDescription.set(existingDetail.card.description ?? "");
        return;
      }

      const cached = await this.offlineCache.loadCardDetail(cardId).catch(() => null);
      if (seq !== this.detailLoadSeq || !cached) return;
      this.state.setCardDetail(cached.detail);
      this.draftDescription.set(cached.detail.card.description ?? "");
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

  startAddChecklist() {
    this.checklistTemplatePickerOpen.set(false);
    this.addingChecklist.set(true);
    this.newChecklistTitle.set("");
  }

  cancelAddChecklist() {
    this.addingChecklist.set(false);
    this.newChecklistTitle.set("");
  }

  async createChecklist(event?: Event) {
    event?.preventDefault();
    const title = this.newChecklistTitle().trim();
    if (!title) return;
    const checklist = await this.api.post<WireCardChecklist>(`/cards/${this.card().id}/checklists`, { title });
    this.checklistCreated.emit(checklist);
    this.cancelAddChecklist();
    this.startAddItem(checklist.id);
  }

  toggleChecklistTemplatePicker(event: MouseEvent) {
    event.stopPropagation();
    if (!this.canEdit() || this.checklistTemplates().length === 0) return;
    this.addingChecklist.set(false);
    this.closePopoversExcept("checklistTemplate");
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
    if (!await this.confirm.open({ title: `Delete "${checklist.title}"?`, message: "Checklist items will be removed from this card.", danger: true })) return;
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
    this.closePopoversExcept("checklistItemAssignee");
    this.checklistItemAssigneePickerId.update((current) => current === itemId ? null : itemId);
  }

  toggleBulkChecklistAssigneePicker(checklistId: string, event: MouseEvent) {
    event.stopPropagation();
    if (!this.canEdit()) return;
    this.closePopoversExcept("bulkChecklistAssignee");
    this.bulkChecklistAssigneePickerId.update((current) => current === checklistId ? null : checklistId);
  }

  toggleBulkChecklistDueDatePicker(checklistId: string, event: MouseEvent) {
    event.stopPropagation();
    if (!this.canEdit()) return;
    this.closePopoversExcept("bulkChecklistDueDate");
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
    this.closePopoversExcept("checklistItemDueDate");
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
    await this.api.delete(`/cards/${this.card().id}/checklists/${checklistId}/items/${item.id}`);
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

  private positionBetween(prev: string | null, next: string | null): string {
    if (prev === null && next === null) return "1000.0000000000";
    if (prev === null) return (Number(next) / 2).toFixed(10);
    if (next === null) return (Number(prev) + 1000).toFixed(10);
    return ((Number(prev) + Number(next)) / 2).toFixed(10);
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

  @HostListener("document:click", ["$event"])
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
      const targetItemId = target?.closest(".checklist-item")?.getAttribute("data-checklist-item-id") ?? null;
      const isChecklistItemTitleControl = Boolean(target?.closest(".checklist-item-text, .checklist-item-input"));
      if (targetItemId !== editingItemId || !isChecklistItemTitleControl) this.cancelChecklistItem();
    }
    const addingItemChecklistId = this.addingItemChecklistId();
    if (addingItemChecklistId) {
      const targetChecklistId = target?.closest(".checklist-block")?.getAttribute("data-checklist-id") ?? null;
      if (targetChecklistId !== addingItemChecklistId) this.cancelAddItem();
    }
    if (!target?.closest(".move-list-wrap")) this.moveToListOpen.set(false);
    if (!target?.closest(".member-picker-wrap")) this.memberPickerOpen.set(false);
    if (!target?.closest(".checklist-template-wrap")) this.checklistTemplatePickerOpen.set(false);
    if (!target?.closest(".checklist-assignee-wrap")) this.checklistItemAssigneePickerId.set(null);
    if (!target?.closest(".checklist-duedate-wrap")) this.checklistItemDueDatePickerId.set(null);
    if (!target?.closest(".checklist-bulk-wrap")) {
      this.bulkChecklistAssigneePickerId.set(null);
      this.bulkChecklistDueDatePickerId.set(null);
    }
    if (!target?.closest(".label-picker-wrap")) this.labelPickerOpen.set(false);
    if (!target?.closest(".due-picker-wrap")) this.dueDatePickerOpen.set(false);
    if (!target?.closest(".cf-picker-wrap")) this.cfPickerFieldId.set(null);
    if (!target?.closest(".card-actions-wrap")) {
      this.actionsMenuOpen.set(false);
      this.copyToBoardOpen.set(false);
      this.moveToBoardOpen.set(false);
    }
  }

  @HostListener("document:keydown", ["$event"])
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
    this.closePopoversExcept("member");
    this.memberPickerOpen.update((v) => !v);
  }

  toggleLabelPicker(e: MouseEvent) {
    e.stopPropagation();
    this.closePopoversExcept("label");
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
    this.closePopoversExcept("dueDate");
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

  @HostListener("document:dragover", ["$event"])
  onDocumentAttachmentDragOver(event: DragEvent) {
    if (!this.canEdit()) return;
    this.onAttachmentDragOver(event);
  }

  @HostListener("document:drop", ["$event"])
  async onDocumentAttachmentDrop(event: DragEvent) {
    if (!this.canEdit()) return;
    await this.onAttachmentDrop(event);
  }

  @HostListener("document:dragend")
  @HostListener("document:dragexit")
  onDocumentAttachmentDragEnd() {
    this.attachmentDragActive.set(false);
  }

  private readonly handleAttachmentDragCapture = (event: DragEvent) => {
    if (!this.hasDraggedFiles(event)) return;
    if (!this.canEdit() || !this.isDragInsidePanel(event) || this.isEditorDropTarget(event.target) || this.isEditablePasteTarget(event.target)) {
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

  // Thumbnail URL for an image attachment, or null when its signed token has
  // expired (e.g. from a restored offline snapshot). A null result shows a
  // placeholder icon instead of firing a guaranteed 404; the live card fetch
  // re-signs the attachment URLs shortly after.
  attachmentThumbUrl(attachment: CardAttachmentRow): string | null {
    return visibleSignedMediaUrl(attachment.thumbnailUrl ?? attachment.url);
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
