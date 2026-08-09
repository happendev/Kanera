import type { CdkDragDrop, CdkDragMove } from "@angular/cdk/drag-drop";
import { CdkDrag, CdkDragPreview, CdkDropList } from "@angular/cdk/drag-drop";
import type { ElementRef, OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, HostBinding, computed, effect, inject, input, output, signal, viewChild } from "@angular/core";
import type { CardAttachmentRow, WireCard, WireCardSummary } from "@kanera/shared/events";
import type { Card, CardCustomFieldValue, List } from "@kanera/shared/schema";
import { visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";
import { vibrateCardDragEnd, vibrateCardDragStart } from "../../core/browser/haptics";
import { AvatarComponent } from "../../shared/avatar.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import type { AnyCustomField } from "./board-state";
import { CardDragCoordinator } from "./card-drag-coordinator.service";
import { CARD_DRAG_START_DELAY, cardDragEdgeScrollStep } from "./card-drag-scroll";
import { CardComponent, type CardAssigneePresentation, type CardBulkMenuIntent, type CardLabelPresentation, type CardSelectionIntent } from "./card.component";
import { CardLabelsComponent } from "./card-labels.component";
import type { BulkCardMenuPayload, BulkCardSelectionPayload } from "./list.component";
import type { CardGroup } from "./table-view/table-view.types";

type AnyCard = Card | WireCard | WireCardSummary;
const EMPTY_FIELD_VALUES = new Map<string, CardCustomFieldValue>();

// Same incremental-mount strategy as `k-list`: a grouped board can put every card of a large board
// into one column (grouping by a label only a few cards carry, say), so a column renders a leading
// slice and grows it. The cap only grows, so a card mid-drag is never unmounted.
const INITIAL_RENDER_CAP = 30;
const RENDER_CAP_PAGE = 60;
const GROW_NEAR_BOTTOM_PX = 600;
const COLUMN_DRAG_EDGE_SCROLL_MULTIPLIER = 2;

export interface GroupCardDropPayload {
  cardId: string;
  /** The receiving column, identified by `CardGroup.key`. */
  toGroupKey: string;
  /** The column the card came from, so multi-value dimensions can swap rather than replace. */
  fromGroupKey: string | null;
}

/**
 * One kanban column when the board is grouped by something other than its lists.
 *
 * Deliberately not `k-list`: a list column owns separators, a bulk list menu, an inline composer and
 * a real `lists.id` to POST against, none of which exist for a bucket like "Alex" or "High". What
 * this shares with `k-list` is the tile rendering and the drag plumbing, and nothing else.
 *
 * Intra-column ordering is disabled on purpose. A group's cards are drawn from every list on the
 * board, so `cards.position` — which orders a card *within its list* — cannot express an order
 * across them. Rather than silently discarding a reorder, the column does not offer one: dropping
 * here means "give this card this column's value", full stop.
 */
@Component({
  selector: "k-board-group-column",
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragPreview, AvatarComponent, CardComponent, CardLabelsComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./board-group-column.component.html",
  styleUrl: "./board-group-column.component.scss",
})
export class BoardGroupColumnComponent implements OnDestroy {
  private readonly dragCoordinator = inject(CardDragCoordinator);
  private readonly cardsEl = viewChild<ElementRef<HTMLElement>>("cardsEl");
  protected readonly dragStartDelay = CARD_DRAG_START_DELAY;
  private edgeScrollFrame: number | null = null;
  private lastDragPointer: { x: number; y: number } | null = null;

  readonly group = input.required<CardGroup>();
  readonly workspaceId = input<string | null>(null);
  readonly lists = input<Pick<List, "id" | "name">[]>([]);
  readonly customFields = input<AnyCustomField[]>([]);
  readonly customFieldValuesByCardAndField = input<Map<string, Map<string, CardCustomFieldValue>>>(new Map());
  readonly labelsByCard = input<Map<string, CardLabelPresentation[]>>(new Map());
  readonly assigneesByCard = input<Map<string, CardAssigneePresentation[]>>(new Map());
  readonly attachmentCountByCard = input<Map<string, number>>(new Map());
  readonly coverAttachmentById = input<Map<string, CardAttachmentRow>>(new Map());
  readonly commentCounts = input<Map<string, number>>(new Map());
  readonly selectedCardId = input<string | null>(null);
  readonly bulkSelectedCardIds = input<Set<string>>(new Set());
  readonly priorityRanksByCard = input<Map<string, number>>(new Map());
  readonly canEdit = input(true);
  readonly canEditRole = input(true);
  readonly canCreateCards = input(true);
  /**
   * Whether dropping into this column can write the grouping value. False for dimensions whose
   * buckets are ranges rather than values (due-date buckets like "This week"), where there is no one
   * date a drop could mean.
   */
  readonly acceptsDrop = input(true);

  readonly cardDropped = output<GroupCardDropPayload>();
  readonly cardOpened = output<string>();
  readonly addRequested = output<string>();
  readonly bulkSelectionRequested = output<BulkCardSelectionPayload>();
  readonly bulkMenuRequested = output<BulkCardMenuPayload>();

  readonly receiving = signal(false);
  private readonly renderCap = signal(INITIAL_RENDER_CAP);

  readonly cards = computed(() => this.group().cards as AnyCard[]);
  readonly cardCount = computed(() => this.cards().length);
  readonly renderedCards = computed(() => {
    const cards = this.cards();
    const cap = this.renderCap();
    return cards.length > cap ? cards.slice(0, cap) : cards;
  });
  readonly hiddenCardCount = computed(() => Math.max(0, this.cardCount() - this.renderedCards().length));

  readonly colorToken = computed(() => {
    const color = this.group().color;
    return color ? `var(--color-${color})` : null;
  });

  @HostBinding("class.is-drop-target")
  get isDropTarget() {
    return this.receiving();
  }

  /**
   * The board canvas locates the column a drag started in (to arm edge scrolling and release mobile
   * scroll snapping) by this attribute, the same way it locates a list column.
   */
  @HostBinding("attr.data-list-id")
  get hostGroupKey() {
    return this.group().key;
  }

  constructor() {
    effect(() => {
      if (this.dragCoordinator.active()) return;
      this.lastDragPointer = null;
      this.receiving.set(false);
      this.stopEdgeScrollLoop();
    });

    effect((onCleanup) => {
      if (this.hiddenCardCount() === 0) return;
      const el = this.cardsEl()?.nativeElement;
      if (!el) return;
      // Kept off the template so a scroll event does not mark the component dirty on every frame,
      // and detached entirely once the whole column is mounted.
      let pendingFrame: number | null = null;
      const onScroll = () => {
        if (pendingFrame !== null) return;
        pendingFrame = requestAnimationFrame(() => {
          pendingFrame = null;
          if (this.shouldGrow(el)) this.growRenderedCards();
        });
      };
      el.addEventListener("scroll", onScroll, { passive: true });
      onCleanup(() => {
        el.removeEventListener("scroll", onScroll);
        if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      });
    });
  }

  ngOnDestroy(): void {
    this.stopEdgeScrollLoop();
  }

  private shouldGrow(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= GROW_NEAR_BOTTOM_PX;
  }

  private growRenderedCards(): void {
    if (this.hiddenCardCount() === 0) return;
    this.renderCap.update((cap) => cap + RENDER_CAP_PAGE);
  }

  // ─── Card presentation (mirrors k-list; the tile takes the same inputs either way) ──────────

  labelsForCard(cardId: string): CardLabelPresentation[] {
    return this.labelsByCard().get(cardId) ?? [];
  }

  assigneesForCard(cardId: string): CardAssigneePresentation[] {
    return this.assigneesByCard().get(cardId) ?? [];
  }

  customFieldValuesForCard(cardId: string): Map<string, CardCustomFieldValue> {
    return this.customFieldValuesByCardAndField().get(cardId) ?? EMPTY_FIELD_VALUES;
  }

  coverUrlForCard(card: AnyCard): string | null {
    const coverId = (card as Card).coverAttachmentId;
    const summaryCoverUrl = "coverUrl" in card ? card.coverUrl : null;
    const coverAttachment = coverId ? this.coverAttachmentById().get(coverId) : null;
    const resolved = coverId
      ? (coverAttachment?.thumbnailUrl ?? coverAttachment?.url ?? summaryCoverUrl)
      : summaryCoverUrl;
    // An offline snapshot can carry a signed URL whose token has expired; rendering it only yields
    // a 404 until the live load replaces it.
    return visibleSignedMediaUrl(resolved);
  }

  coverColorForCard(card: AnyCard): string {
    const coverId = (card as Card).coverAttachmentId;
    const attachmentColor = coverId ? this.coverAttachmentById().get(coverId)?.coverImageColor : null;
    return attachmentColor ?? ("coverImageColor" in card ? card.coverImageColor : null) ?? "var(--accent)";
  }

  attachmentCountForCard(cardId: string): number {
    return this.attachmentCountByCard().get(cardId) ?? 0;
  }

  commentCountForCard(cardId: string): number {
    return this.commentCounts().get(cardId) ?? 0;
  }

  isSelectedCard(cardId: string): boolean {
    return this.selectedCardId() === cardId;
  }

  isBulkSelectedCard(cardId: string): boolean {
    return this.bulkSelectedCardIds().has(cardId);
  }

  onCardSelectionIntent(intent: CardSelectionIntent): void {
    this.bulkSelectionRequested.emit({ ...intent, orderedCardIds: this.cards().map((card) => card.id) });
  }

  onCardBulkMenuIntent(intent: CardBulkMenuIntent): void {
    this.bulkMenuRequested.emit(intent);
  }

  // ─── Drag ───────────────────────────────────────────────────────────────────

  onDragStarted(): void {
    vibrateCardDragStart();
    this.dragCoordinator.start(this.group().key);
    this.startEdgeScrollLoop();
  }

  onDragMoved(event: CdkDragMove<AnyCard>): void {
    this.lastDragPointer = event.pointerPosition;
    this.dragCoordinator.move(event.pointerPosition);
  }

  onDragEnded(): void {
    vibrateCardDragEnd();
    this.dragCoordinator.end();
    this.stopEdgeScrollLoop();
    this.receiving.set(false);
    this.lastDragPointer = null;
  }

  onDropListEntered(): void {
    this.receiving.set(true);
  }

  onDrop(event: CdkDragDrop<AnyCard[]>): void {
    this.receiving.set(false);
    // A same-column drop is a reorder, and this surface has no order to write (see the class note).
    if (event.previousContainer === event.container) return;
    const card = event.item.data as AnyCard | undefined;
    if (!card) return;

    const toGroupKey = this.group().key;
    // Mobile settles onto the receiving column once scroll snapping is re-enabled.
    document.dispatchEvent(new CustomEvent<string>(APP_DOM_EVENTS.CARD_DROP_TARGET, { detail: toGroupKey }));
    // Keep the incoming card mounted: it lands past the current slice on a column already at cap.
    this.renderCap.update((cap) => Math.max(cap, this.cardCount() + 1));
    this.cardDropped.emit({
      cardId: card.id,
      toGroupKey,
      fromGroupKey: String(event.previousContainer.id).replace(/^gc-/, "") || null,
    });
  }

  private startEdgeScrollLoop(): void {
    if (this.edgeScrollFrame !== null) return;
    const tick = () => {
      this.edgeScrollFrame = window.requestAnimationFrame(tick);
      const pointer = this.lastDragPointer;
      const el = this.cardsEl()?.nativeElement;
      if (!pointer || !el) return;
      const rect = el.getBoundingClientRect();
      if (pointer.x < rect.left || pointer.x > rect.right) return;
      const yStep = cardDragEdgeScrollStep(pointer.y - rect.top, rect.height);
      if (yStep === 0) return;
      // Only mount more cards when the pointer is genuinely edge-scrolling through hidden rows;
      // a drag hovering the visible top of a long column should stay cheap.
      if (yStep > 0 && this.hiddenCardCount() > 0 && this.shouldGrow(el)) this.growRenderedCards();
      el.scrollTop += yStep * COLUMN_DRAG_EDGE_SCROLL_MULTIPLIER;
    };
    this.edgeScrollFrame = window.requestAnimationFrame(tick);
  }

  private stopEdgeScrollLoop(): void {
    if (this.edgeScrollFrame === null) return;
    window.cancelAnimationFrame(this.edgeScrollFrame);
    this.edgeScrollFrame = null;
  }
}
