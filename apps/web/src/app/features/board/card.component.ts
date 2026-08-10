import { NgOptimizedImage } from "@angular/common";
import { ChangeDetectionStrategy, Component, HostBinding, computed, effect, inject, input, output, signal } from "@angular/core";
import type { WireBoardMemberUser, WireCard, WireCardDetail, WireCardChecklist, WireCardChecklistItem, WireCardSummary, WireCustomFieldOption } from "@kanera/shared/events";
import type { Card, CardCustomFieldValue } from "@kanera/shared/schema";
import type { AnyCustomField, AnyList } from "./board-state";
import { ApiClient } from "../../core/api/api.client";
import { hasCoarsePointer } from "../../core/browser/input-modality";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { unreadMarkLabel } from "../../core/notifications/unread-mark";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { CardKeyDisplayService } from "../../shared/card-key-display.service";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardState } from "./board-state";
import { BoardMenuCoordinator } from "./board-menu-coordinator.service";
import { CardDragCoordinator } from "./card-drag-coordinator.service";
import { CardActionsMenuPopover } from "./card-actions-menu.popover";
import { priorityRankHeat } from "../../shared/priority-rank";
import { CardLabelsComponent, type CardLabelPresentation } from "./card-labels.component";
import { openCardDetailInNewTab } from "./card-navigation.util";
import { formatDueDate, isDueSoon, isOverdue } from "./due-date.util";
import { WatcherPopoverComponent } from "./watcher-popover.component";

type AnyCard = Card | WireCard | WireCardSummary;
export type { CardLabelPresentation } from "./card-labels.component";
export type CardAssigneePresentation = Pick<
  WireBoardMemberUser,
  "userId" | "displayName" | "avatarUrl" | "lastOnlineAt"
>;
export interface CardSelectionIntent {
  cardId: string;
  shiftKey: boolean;
  additive: boolean;
}

export interface CardBulkMenuIntent {
  cardId: string;
  point: { x: number; y: number };
}

const COVER_HEIGHT_FALLBACK_PX = "160px";

@Component({
  selector: "k-card",
  standalone: true,
  imports: [CardActionsMenuPopover, CardLabelsComponent, NgOptimizedImage, AvatarComponent, TooltipDirective, WatcherPopoverComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./card.component.html",
  styleUrl: "./card.component.scss",
})
export class CardComponent {
  private readonly state = inject(BoardState);
  private readonly api = inject(ApiClient);
  private readonly notifications = inject(NotificationsService);
  private readonly workspaces = inject(WorkspaceService);
  private readonly menuCoordinator = inject(BoardMenuCoordinator);
  private readonly dragCoordinator = inject(CardDragCoordinator);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;

  readonly card = input.required<AnyCard>();
  readonly customFields = input<AnyCustomField[]>([]);
  readonly customFieldValuesByField = input<Map<string, CardCustomFieldValue>>(new Map());
  readonly labels = input<CardLabelPresentation[]>([]);
  readonly assignees = input<CardAssigneePresentation[]>([]);
  readonly coverUrl = input<string | null>(null);
  // Only the first card in each list opts into NgOptimizedImage `priority` so the likely
  // LCP cover preloads, while the rest lazy-load. Marking every tile priority would flood
  // the preload scanner with one <link rel=preload> per card on large boards.
  readonly coverPriority = input<boolean>(false);
  readonly attachmentCount = input<number>(0);
  readonly commentCount = input<number>(0);
  readonly selected = input<boolean>(false);
  readonly bulkSelected = input<boolean>(false);
  readonly showActions = input<boolean>(true);
  readonly allowDuplicate = input<boolean>(true);
  readonly allowCopyToBoard = input<boolean>(true);
  readonly allowMoveToBoard = input<boolean>(true);
  readonly allowBoardNavigation = input<boolean>(false);
  readonly boardSummary = input<{ id: string; name: string; icon: string | null; iconColor: string | null } | null>(null);
  // Consolidated work surfaces render the same card tile for cards from source boards with
  // different roles. These overrides keep the presentation shared without flattening those
  // source-specific permissions into the route-local BoardState.
  readonly canEditOverride = input<boolean | null>(null);
  readonly canEditRoleOverride = input<boolean | null>(null);
  readonly sourceListsOverride = input<Pick<AnyList, "id" | "name">[] | null>(null);
  readonly workspaceIdOverride = input<string | null>(null);
  // Suppress the completed-card tint where completion is already implied by
  // context (e.g. the completed-cards drawer, where every card is complete).
  readonly hideCompletedAccent = input<boolean>(false);
  // The card's rank in the focused person's Up next queue, shown as an accent pill beside the
  // title. Null everywhere no queue is in focus (regular boards, multi-person team views), which
  // is why this is a plain input rather than something the tile derives itself.
  readonly priorityRank = input<number | null>(null);
  // Offers the hover "+ Up next" affordance. Eligibility (curation rights, capacity, not already
  // ranked) is the host's call — the tile only draws the button and reports the click.
  readonly canAddToPriority = input<boolean>(false);

  // Drives the rank pill's --rank-heat: the top of the queue wears a deeper accent tint.
  protected readonly rankHeat = priorityRankHeat;

  readonly openCard = output<string>();
  readonly boardOpened = output<string>();
  readonly addToPriority = output<string>();
  readonly selectionIntent = output<CardSelectionIntent>();
  readonly bulkMenuIntent = output<CardBulkMenuIntent>();

  readonly isOverdue = isOverdue;
  readonly formatDueDate = formatDueDate;

  readonly canEdit = computed(() => this.canEditOverride() ?? this.state.canEdit());
  // Role-only permission for STRUCTURAL gating (e.g. the card actions affordance) so it stays
  // mounted across offline/online blips instead of being torn down and recreated. Interaction
  // is still gated by the online-aware `canEdit`. See [[card-detail]] for the same pattern.
  readonly canEditRole = computed(() => this.canEditRoleOverride() ?? this.state.canEditRole());
  readonly sourceLists = computed<Pick<AnyList, "id" | "name">[]>(
    () => this.sourceListsOverride() ?? this.state.visibleLists()
  );
  readonly workspaceId = computed(() =>
    this.workspaceIdOverride() ?? this.workspaces.workspaceIdForBoard(this.card().boardId)
  );
  readonly isWatchingCard = computed(() => this.notifications.isWatchingCard(this.card().id));
  readonly cardUnreadCount = computed(() => this.notifications.cardUnreadCount(this.card().id));
  readonly hasUnreadNotifications = computed(() => this.cardUnreadCount() > 0);
  readonly unreadMarkLabel = computed(() => unreadMarkLabel(this.cardUnreadCount()));
  readonly showCardWatchIndicator = computed(() => this.isWatchingCard() && !this.notifications.isWatchingBoard(this.card().boardId));
  readonly actionsMenuOpen = signal(false);
  readonly actionsMenuPoint = signal<{ x: number; y: number } | null>(null);
  readonly watcherPopoverOpen = signal(false);
  readonly checklistExpanded = computed(() => this.state.isCardChecklistExpanded(this.card().id));
  readonly detailLoading = signal(false);
  readonly checklists = computed(() => this.state.checklistsForCard(this.card().id).filter((checklist) => checklist.parentItemId === null));
  // Server-provided derivative dimensions let CSS reserve the final proportional geometry before
  // download. Legacy covers deliberately retain the fixed fallback; never reintroduce per-image
  // load callbacks or DOM width reads here because they move the scroll range under the pointer.
  readonly coverAspectRatio = computed(() => {
    const card = this.card();
    if (!("coverImageWidth" in card) || !("coverImageHeight" in card)) return null;
    const width = card.coverImageWidth;
    const height = card.coverImageHeight;
    return typeof width === "number" && width > 0 && typeof height === "number" && height > 0
      ? `${width} / ${height}`
      : null;
  });
  readonly coverHeightPx = computed(() => this.coverAspectRatio() ? null : COVER_HEIGHT_FALLBACK_PX);

  private detailLoadSeq = 0;
  private readonly detailLoaded = signal(false);

  constructor() {
    effect((onCleanup) => {
      const unregister = this.menuCoordinator.registerCardMenu(this.card().id, this.actionsMenuOpen);
      onCleanup(unregister);
    });
  }

  @HostBinding("class.is-selected")
  get isSelectedClass(): boolean {
    return this.selected();
  }

  @HostBinding("class.is-bulk-selected")
  get isBulkSelectedClass(): boolean {
    return this.bulkSelected();
  }

  @HostBinding("class.no-complete-accent")
  get noCompleteAccentClass(): boolean {
    return this.hideCompletedAccent();
  }

  @HostBinding("class.is-completed-card")
  get isCompletedCardClass(): boolean {
    return Boolean(this.card().completedAt);
  }

  // Drives the tile-wide unread treatment (left stripe, heavier title). The badge beside the title
  // says how much is new; this says "something here is new" from across a full column.
  @HostBinding("class.has-unread")
  get hasUnreadClass(): boolean {
    return this.hasUnreadNotifications();
  }

  private static readonly MAX_VISIBLE_ASSIGNEES = 3;

  readonly visibleAssignees = computed(() =>
    this.assignees().slice(0, CardComponent.MAX_VISIBLE_ASSIGNEES),
  );

  readonly assigneeOverflow = computed(() =>
    Math.max(0, this.assignees().length - CardComponent.MAX_VISIBLE_ASSIGNEES),
  );

  onCardLinkClick(event: MouseEvent) {
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      this.closeActionsMenu();
      this.selectionIntent.emit({
        cardId: this.card().id,
        shiftKey: event.shiftKey,
        additive: event.metaKey || event.ctrlKey,
      });
      return;
    }
    if (event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    this.openCard.emit(this.card().id);
  }

  onCardLinkAuxClick(event: MouseEvent) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    const card = this.card();
    openCardDetailInNewTab(card.organisationKey, card.key);
  }

  openBoard(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.boardOpened.emit(this.card().boardId);
  }

  onAddToPriority(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.addToPriority.emit(this.card().id);
  }

  onCardContextMenu(event: MouseEvent) {
    if (!this.canEdit() || !this.showActions()) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.isTouchDragContextMenu(event)) return;
    if (this.bulkSelected()) {
      this.closeActionsMenu();
      this.bulkMenuIntent.emit({ cardId: this.card().id, point: { x: event.clientX, y: event.clientY } });
      return;
    }
    this.actionsMenuPoint.set({ x: event.clientX, y: event.clientY });
    this.menuCoordinator.openCardMenu(this.card().id);
  }

  private isTouchDragContextMenu(event: MouseEvent): boolean {
    // Mobile browsers often fire `contextmenu` after long-press, which collides
    // with CDK's long-press-to-drag gesture. Suppress those without affecting
    // desktop right-click.
    if (this.dragCoordinator.active()) return true;
    const pointerType = "pointerType" in event ? (event as PointerEvent).pointerType : "";
    return pointerType === "touch" || pointerType === "pen" || (hasCoarsePointer() && event.button === 0);
  }

  toggleActionsMenu(event: MouseEvent) {
    event.stopPropagation();
    if (this.bulkSelected()) {
      this.closeActionsMenu();
      this.bulkMenuIntent.emit({ cardId: this.card().id, point: this.menuPointFromEvent(event) });
      return;
    }
    this.actionsMenuPoint.set(null);
    const next = !this.actionsMenuOpen();
    if (next) this.menuCoordinator.openCardMenu(this.card().id);
    else this.menuCoordinator.closeCardMenu(this.card().id);
  }

  closeActionsMenu() {
    this.actionsMenuPoint.set(null);
    this.menuCoordinator.closeCardMenu(this.card().id);
  }

  private menuPointFromEvent(event: MouseEvent): { x: number; y: number } {
    const target = event.currentTarget;
    if (target instanceof HTMLElement) {
      const rect = target.getBoundingClientRect();
      return { x: rect.right, y: rect.bottom };
    }
    return { x: event.clientX, y: event.clientY };
  }

  toggleWatcherPopover(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.watcherPopoverOpen.update((open) => !open);
  }

  toggleChecklistExpanded(event: Event) {
    event.preventDefault();
    event.stopPropagation();

    const next = !this.checklistExpanded();
    this.state.setCardChecklistExpanded(this.card().id, next);
    if (next) void this.ensureChecklistsLoaded();
  }

  async toggleChecklistItem(checklistId: string, item: WireCardChecklistItem, event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.canEdit()) return;

    const cardId = this.card().id;
    const previous = item;
    const next = { ...item, completedAt: item.completedAt ? null : new Date() };
    this.state.updateChecklistItem(cardId, checklistId, next);
    try {
      await this.api.patch(`/cards/${cardId}/checklists/${checklistId}/items/${item.id}`, { completed: !item.completedAt });
    } catch {
      this.state.updateChecklistItem(cardId, checklistId, previous);
    }
  }

  checklistDoneCountFor(checklist: WireCardChecklist): number {
    return checklist.items.filter((item) => item.completedAt).length;
  }

  private async ensureChecklistsLoaded() {
    const cardId = this.card().id;
    if (this.detailLoaded() || this.state.detailForCard(cardId)) {
      this.detailLoaded.set(true);
      return;
    }

    // Card tiles only carry checklist counts. Fetch the existing detail payload
    // on first expansion so inline toggles share state with the detail drawer.
    const seq = ++this.detailLoadSeq;
    this.detailLoading.set(true);
    try {
      const detail = await this.api.get<WireCardDetail>(`/cards/${cardId}/detail`);
      if (seq === this.detailLoadSeq) {
        this.state.setCardDetail(detail);
        this.detailLoaded.set(true);
      }
    } catch {
      // Keep the tile usable with its summary counts; a later expand can retry.
      if (seq === this.detailLoadSeq) this.detailLoaded.set(false);
    } finally {
      if (seq === this.detailLoadSeq) this.detailLoading.set(false);
    }
  }

  initialFor(name: string): string {
    return (name || "?").charAt(0).toUpperCase();
  }

  urlFor(fieldId: string): string | null {
    return this.customFieldValuesByField().get(fieldId)?.valueUrl?.trim() || null;
  }

  hasValues(): boolean {
    for (const value of this.customFieldValuesByField().values()) {
      if (
        value.valueText ||
        value.valueNumber ||
        value.valueCheckbox != null ||
        value.valueDate ||
        value.valueUrl ||
        value.valueOptionIds?.length ||
        value.valueUserIds?.length
      )
        return true;
    }
    return false;
  }

  hasVisibleCustomFieldBadges(): boolean {
    return this.customFields().some((field) => field.showOnCard && this.hasBadge(field));
  }

  hasDescription(): boolean {
    const card = this.card();
    return "hasDescription" in card ? card.hasDescription : Boolean(card.description);
  }

  checklistDoneCount(): number {
    const card = this.card();
    return "checklistDoneCount" in card ? card.checklistDoneCount : 0;
  }

  checklistTotalCount(): number {
    const card = this.card();
    return "checklistTotalCount" in card ? card.checklistTotalCount : 0;
  }

  checklistComplete(): boolean {
    const total = this.checklistTotalCount();
    return total > 0 && this.checklistDoneCount() === total;
  }

  hasDueDate(): boolean {
    return Boolean(this.card().dueDateLocalDate);
  }

  // Derived from the card() input as computeds so they memoize across change-detection
  // cycles instead of recomputing on every CD pass while the card is unchanged. The
  // template still calls them as dueDateText()/dueDateOverdue()/dueDateDueSoon().
  readonly dueDateText = computed(() => {
    const card = this.card();
    return formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  });

  readonly dueDateOverdue = computed(() => {
    const card = this.card();
    return !card.archivedAt && !card.completedAt && isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  });

  readonly dueDateDueSoon = computed(() => {
    const card = this.card();
    return !card.archivedAt && !card.completedAt && isDueSoon(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  });

  valueFor(fieldId: string): string {
    const v = this.customFieldValuesByField().get(fieldId);
    if (v?.valueCheckbox != null) return v.valueCheckbox ? "true" : "false";
    return v?.valueText ?? v?.valueNumber ?? v?.valueDate ?? v?.valueUrl ?? "";
  }

  checkboxFor(fieldId: string): boolean {
    const v = this.customFieldValuesByField().get(fieldId);
    return v?.valueCheckbox === true;
  }

  /** Whether a field has any value worth rendering as a card-front badge. */
  hasBadge(field: AnyCustomField): boolean {
    if (field.type === "checkbox") return this.checkboxFor(field.id);
    const v = this.customFieldValuesByField().get(field.id);
    if (!v) return false;
    switch (field.type) {
      case "select":
        return Boolean(v.valueOptionIds?.length);
      case "user":
        return Boolean(v.valueUserIds?.length);
      default:
        return Boolean(this.valueFor(field.id));
    }
  }

  /** Selected options for a select field, resolved against the field's options. */
  selectedOptions(field: AnyCustomField): WireCustomFieldOption[] {
    const options = "options" in field ? field.options : [];
    const ids = this.customFieldValuesByField().get(field.id)?.valueOptionIds ?? [];
    return ids.map((id) => options.find((o) => o.id === id)).filter((o): o is WireCustomFieldOption => Boolean(o));
  }

  userCountFor(fieldId: string): number {
    return this.customFieldValuesByField().get(fieldId)?.valueUserIds?.length ?? 0;
  }

}
