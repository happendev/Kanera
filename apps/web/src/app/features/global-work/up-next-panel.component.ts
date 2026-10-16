import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { CdkDrag, CdkDropList } from "@angular/cdk/drag-drop";
import type { WorkCatalog, WorkPrioritiesResponse } from "@kanera/shared/dto";
import { AnchoredPickerPopover } from "../../shared/anchored-picker.popover";
import { CardKeyDisplayService } from "../../shared/card-key-display.service";
import type { PickerGroup } from "../../shared/picker-list.component";
import { priorityAddGroups, type PriorityAddableCard } from "../../shared/priority-queue/priority-add-cards";
import {
  PriorityQueueComponent,
  type PriorityAnchor,
  type PriorityReorder,
} from "../../shared/priority-queue/priority-queue.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { icu } from "../../core/i18n/icu";
import { CardDragCoordinator } from "../board/card-drag-coordinator.service";
import { formatDueDate, isDueSoon, isOverdue } from "../board/due-date.util";

export type { PriorityAnchor, PriorityReorder };
/**
 * Kept exported from here rather than moved: `team-priorities-view` and the Global Work page both
 * import it under this name, and the type itself is now shared (see `priority-add-cards`).
 */
export type UpNextAddableCard = PriorityAddableCard;

/**
 * The Up next dock: the viewer's (or a focused teammate's) ordered queue, docked beside whichever
 * display the Global Work page is showing.
 *
 * A thin frame around `k-priority-queue` — the header, the "Add card" affordance in that header,
 * and the error banner are all this dock has of its own; every row, gesture and anchor rule lives
 * in the shared component so the dock, the shell drawer and Home cannot drift apart.
 *
 * The queue is deliberately filter-independent. Docked beside the filtered display rather than
 * rendered as a lane inside it, that stops needing an explanatory chip: a separate panel is
 * visibly a separate scope.
 */
@Component({
  selector: "k-up-next-panel",
  standalone: true,
  imports: [AnchoredPickerPopover, CdkDrag, CdkDropList, PriorityQueueComponent, TooltipDirective],
  templateUrl: "./up-next-panel.component.html",
  styleUrl: "./up-next-panel.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpNextPanelComponent {
  private readonly cardDrag = inject(CardDragCoordinator);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;

  readonly priorities = input<WorkPrioritiesResponse | null>(null);
  /** For board/list names on optimistic rows, whose server-resolved `context` has not arrived. */
  readonly catalog = input<WorkCatalog | null>(null);
  readonly boardSummariesById = input<Map<string, { id: string; name: string; icon: string | null; iconColor: string | null }>>(new Map());
  /** False while the page is not interaction-ready, or when the viewer may not curate this queue. */
  readonly canDrag = input(false);
  /** The queue owner's name when curating somebody else; null reads as "your own". */
  readonly targetName = input<string | null>(null);
  readonly maxEntries = input(50);
  readonly error = input<string | null>(null);
  readonly selectedCardId = input<string | null>(null);
  readonly addableCards = input<UpNextAddableCard[]>([]);
  readonly editableCardIds = input<ReadonlySet<string>>(new Set());
  /**
   * Offer the row-level "mark complete". Only meaningful for the viewer's own queue: completing a
   * teammate's card from a manager's dock is a different act with different rights, and the queue
   * response carries no board role to gate it on.
   */
  readonly allowQuickComplete = input(false);

  readonly reordered = output<PriorityReorder>();
  readonly removed = output<{ priorityId: string }>();
  readonly added = output<PriorityAnchor & { cardId: string }>();
  readonly cardOpened = output<string>();
  readonly completed = output<{ cardId: string; completed: boolean }>();
  readonly closed = output<void>();

  readonly totalCount = computed(() => this.priorities()?.totalCount ?? 0);
  readonly atCapacity = computed(() => this.totalCount() >= this.maxEntries());
  readonly canReorder = computed(() => this.canDrag() && (this.priorities()?.canReorder ?? false));
  readonly addGroups = computed<PickerGroup[]>(() =>
    priorityAddGroups(this.addableCards(), { showCardKeys: this.showCardKeys() })
  );

  readonly addTooltip = computed(() => {
    if (this.atCapacity()) {
      return icu($localize`:Tooltip on a disabled add button when the Up next queue is full:Full at {count, plural, one {# card} other {# cards}}`, { count: this.maxEntries() });
    }
    return this.addableCards().length === 0
      ? $localize`:Tooltip on a disabled add button:Every card shown is already in Up next or cannot be added`
      : $localize`:Tooltip, add a card to Up next:Add card`;
  });

  targetTooltip(name: string): string {
    return $localize`:Tooltip naming whose Up next queue is shown:Up next for ${name}:person:`;
  }

  /** The header "+" picker. The inline "Add card" under the last row is the queue's own. */
  readonly headAddOpen = signal(false);

  onHeadAddPicked(cardId: string): void {
    this.headAddOpen.set(false);
    this.added.emit({ cardId, beforeId: null });
  }

  /* ── Not queued ──────────────────────────────────────────────────────────────
   *
   * The person's open cards that are not in Up next yet, listed under the queue. Sequencing someone's
   * work is choosing among what they already own, so the candidates sit in view instead of behind a
   * search picker. It is the same pool the picker offers (`addableCards`), so the two always agree.
   */

  protected readonly emptyHint = $localize`:Empty state hint in the Up next panel; Not queued is the list heading below:Drag a card up from Not queued, or press + beside it, to say what gets done first.`;

  /** The queue's drop list, which accepts these rows as it accepts board tiles. */
  protected readonly queueDropListId = "up-next-drop";
  readonly notQueuedCollapsed = signal(false);

  /**
   * Board sections in the order the host supplies them (sidebar order), and due date first inside
   * each: this list exists to decide what comes next, which nobody does from titles alone.
   */
  readonly notQueuedGroups = computed<NotQueuedGroup[]>(() => {
    const now = new Date();
    const groups = new Map<string, NotQueuedGroup>();
    for (const card of this.addableCards()) {
      const group = groups.get(card.boardId) ?? {
        boardId: card.boardId,
        boardName: card.boardName,
        boardIconClass: `ti ti-${card.boardIcon ?? "layout-kanban"}`,
        boardIconColor: card.boardIconColor ? `var(--color-${card.boardIconColor})` : null,
        rows: [],
      };
      group.rows.push({
        card,
        // A drag payload in the board tile's shape, which is the only shape the queue accepts.
        dragData: { kind: "card", card: { id: card.id } },
        listIconClass: `ti ti-${card.listIcon ?? "list"}`,
        listColor: card.listColor ? `var(--color-${card.listColor})` : null,
        due: card.dueDateLocalDate ? formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone) : null,
        overdue: isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone, now),
        dueSoon: isDueSoon(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone, now),
      });
      groups.set(card.boardId, group);
    }
    // Stable sort, so undated cards keep the host's list-then-position order among themselves.
    for (const group of groups.values()) {
      group.rows.sort((a, b) => dueKey(a.card).localeCompare(dueKey(b.card)));
    }
    return [...groups.values()];
  });

  readonly notQueuedTooltip = computed(() => this.atCapacity()
    ? icu($localize`:Tooltip on a disabled add button when the Up next queue is full:Full at {count, plural, one {# card} other {# cards}}`, { count: this.maxEntries() })
    : $localize`:Tooltip, add a card to the end of Up next:Add to the end of Up next`);

  notQueuedToggleLabel(collapsed: boolean): string {
    return collapsed
      ? $localize`:Button that shows the Not queued list in the Up next panel:Show cards not in Up next`
      : $localize`:Button that hides the Not queued list in the Up next panel:Hide cards not in Up next`;
  }

  onNotQueuedAdd(cardId: string): void {
    this.added.emit({ cardId, beforeId: null });
  }

  // Registered like the queue's own drags, so a realtime refresh waits for the drop to settle.
  onNotQueuedDragStarted(): void {
    this.cardDrag.start("up-next-not-queued");
  }

  onNotQueuedDragEnded(): void {
    this.cardDrag.end();
  }
}

type NotQueuedRow = {
  card: UpNextAddableCard;
  dragData: { kind: "card"; card: { id: string } };
  listIconClass: string;
  listColor: string | null;
  due: string | null;
  overdue: boolean;
  dueSoon: boolean;
};

type NotQueuedGroup = {
  boardId: string;
  boardName: string;
  boardIconClass: string;
  boardIconColor: string | null;
  rows: NotQueuedRow[];
};

/** ISO dates sort as strings; undated cards go last. */
function dueKey(card: UpNextAddableCard): string {
  return card.dueDateLocalDate ?? "9999-12-31";
}
