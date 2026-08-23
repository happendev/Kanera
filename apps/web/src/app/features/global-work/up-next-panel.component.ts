import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
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
  imports: [AnchoredPickerPopover, PriorityQueueComponent, TooltipDirective],
  templateUrl: "./up-next-panel.component.html",
  styleUrl: "./up-next-panel.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpNextPanelComponent {
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

  /** The header "+" picker. The inline "Add card" under the last row is the queue's own. */
  readonly headAddOpen = signal(false);

  onHeadAddPicked(cardId: string): void {
    this.headAddOpen.set(false);
    this.added.emit({ cardId, beforeId: null });
  }
}
