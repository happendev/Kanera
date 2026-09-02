import type { CdkDragDrop } from "@angular/cdk/drag-drop";
import { CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup, moveItemInArray } from "@angular/cdk/drag-drop";
import type { OnDestroy } from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type { WorkTablePresentation } from "@kanera/shared/dto";
import type { WireCustomFieldOption } from "@kanera/shared/events";
import type { CardCustomFieldValue } from "@kanera/shared/schema";
import { ApiClient } from "../../../core/api/api.client";
import { downloadTextFile } from "../../../core/browser/download";
import { NotificationsService } from "../../../core/notifications/notifications.service";
import { unreadMarkLabel } from "../../../core/notifications/unread-mark";
import { AnchoredPanelDirective } from "../../../shared/anchored-panel.directive";
import { AnchoredPickerPopover } from "../../../shared/anchored-picker.popover";
import { AutofocusDirective } from "../../../shared/autofocus.directive";
import { AvatarComponent } from "../../../shared/avatar.component";
import { CardKeyDisplayService } from "../../../shared/card-key-display.service";
import type { PickerGroup } from "../../../shared/picker-list.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { BoardMenuCoordinator } from "../board-menu-coordinator.service";
import { BoardState } from "../board-state";
import { CardActionsMenuPopover } from "../card-actions-menu.popover";
import { CardLabelsComponent } from "../card-labels.component";
import { CARD_DRAG_START_DELAY } from "../card-drag-scroll";
import { openCardDetailInNewTab } from "../card-navigation.util";
import { DatePickerPopover } from "../date-picker.popover";
import { formatDueDate, isOverdue, type DueDateSlotSelection } from "../due-date.util";
import { LabelPickerPopover } from "../label-picker.popover";
import type { BulkCardMenuPayload, BulkCardSelectionPayload, BulkListSelectionPayload, CardDropPayload } from "../list.component";
import { MemberPickerPopover } from "../member-picker.popover";
import { SelectPickerPopover } from "../select-picker.popover";
import { FilterBarComponent, type FilterLabel, type FilterMember } from "./filter-bar.component";
import type { FilterValue } from "./filter.types";
import {
  buildBoardExportPayload,
  buildWorkbookExport,
  sanitizeExportFileName,
  styledSheetData,
  timestampForFileName,
} from "./export.util";
import { groupCards, sortGroupCards } from "./group-by.util";
import type {
  AggregateConfig,
  AggregateMetric,
  AnyCard,
  AnyCustomField,
  AnyLabel,
  AnyList,
  AnyMember,
  CardGroup,
  GroupBy,
  SortBy,
} from "./table-view.types";
import type { SourceBoardRef, SourceOrganisationRef, SourceWorkspaceRef } from "./table-view.types";
import { priorityRankHeat } from "../../../shared/priority-rank";
import { CROSS_BOARD_GROUP_BY_OPTIONS, GROUP_BY_OPTIONS, SORT_BY_OPTIONS } from "./table-view.types";
import { boardStateCardStore, TABLE_CARD_STORE, type TableCardStore } from "./table-card-store";
import {
  ROW_INTERACTION_STOP_SELECTOR,
  applySavedColumnOrder,
  builtinColumnIcon,
  builtinColumnLabel,
  clampWidth,
  cssEscape,
  formatRelativeTime,
  columnWidthsEqual,
  distributeColumnSlack,
  gridTemplateFrom,
  measuredColumnContentWidth,
  measuredColumnContentWidths,
} from "./table-columns.util";
import {
  readAggregateConfig,
  readAggregateSplitBy,
  readColumnOrder,
  readColumnVisibility,
  readColumnWidths,
  readGroupBy,
  readSortBy,
  writeAggregateConfig,
  writeAggregateSplitBy,
  writeColumnOrder,
  writeColumnVisibility,
  writeColumnWidths,
  writeGroupBy,
  writeSortBy,
  type ColumnWidths,
} from "./view-preference";

const TITLE_COLUMN_ID = "title";
const ACTIONS_COLUMN_WIDTH = 38;
/** Mirrors `--tv-run-inset`: the strip the full-width bands pay as inline padding on both sides. */
const TABLE_RUN_INSET = 10;
/** Breathing room after an auto-fit, so the widest value does not sit flush against the divider. */
const AUTO_FIT_SLACK = 4;
/** Regions where a background pan would steal a gesture that already means something else. */
const TABLE_PAN_STOP_SELECTOR = ".tv-row, .tv-header, .tv-footer, .tv-sum-row, .tv-new-task";
/** Shared empty slice, so a collapsed group does not allocate a fresh array on every recompute. */
const EMPTY_CARDS: AnyCard[] = [];
const INITIAL_ROW_CAP = 80;
const ROW_CAP_PAGE = 80;
const GROW_NEAR_BOTTOM_PX = 600;
interface EditingCell {
  cardId: string;
  col: string;
}

interface OpenPicker {
  cardId: string;
  col: string;
}

interface ColumnItem {
  id: string;
  label: string;
  icon: string;
  visible: boolean;
}

/** One group's run of rows, rendered as a bound block with its own drop list. */
export interface TableRunGroup {
  key: string;
  /**
   * Only set when the group *is* a list, which is what makes it a legal drop target and gives it an
   * add row. Grouping by assignee or a select field produces buckets a card cannot simply be dropped
   * into — that would mean an assignment, not a move — so those groups carry null.
   */
  listId: string | null;
  /** Empty when grouping is off, which is what suppresses the run header for the single block. */
  name: string;
  icon: string | null;
  color: string | null;
  avatarUrl: string | null;
  cards: AnyCard[];
  /** Every card in the group, including rows withheld by collapse or incremental rendering. */
  cardIds: string[];
  /** Cards in the whole group — `cards` above can be truncated by the incremental render cap. */
  total: number;
  /** Subtotal rows rendered beneath this group's cards; empty when nothing is summarised. */
  summaries: TableSummaryRow[];
  collapsed: boolean;
}

export interface HostedTableCardReorder {
  groupKey: string;
  cardId: string;
  previousIndex: number;
  currentIndex: number;
}

/**
 * One line of a summary block: the grand breakdown above the footer, or a group's own subtotals.
 *
 * Values are keyed by column id rather than positional so the row survives a column reorder, and a
 * column with nothing to show is simply absent instead of holding a placeholder.
 */
export interface TableSummaryRow {
  key: string;
  label: string;
  values: Record<string, string>;
}

interface GroupByOption {
  value: GroupBy;
  label: string;
  icon: string;
}

@Component({
  selector: "k-board-table-view",
  standalone: true,
  imports: [
    AnchoredPanelDirective,
    AnchoredPickerPopover,
    AutofocusDirective,
    AvatarComponent,
    CardActionsMenuPopover,
    CardLabelsComponent,
    CdkDrag,
    CdkDragHandle,
    CdkDropList,
    CdkDropListGroup,
    DatePickerPopover,
    FilterBarComponent,
    LabelPickerPopover,
    MemberPickerPopover,
    SelectPickerPopover,
    TooltipDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./board-table-view.component.html",
  styleUrl: "./board-table-view.component.scss",
})
export class BoardTableViewComponent implements OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly state = inject(BoardState);
  private readonly notifications = inject(NotificationsService);
  private readonly menuCoordinator = inject(BoardMenuCoordinator);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;
  /**
   * Optimistic writes go to whichever projection is actually rendering these rows. Falls back to
   * the ambient BoardState, so a board page needs no provider; Global Work overrides the token.
   */
  private readonly cardStore: TableCardStore =
    inject(TABLE_CARD_STORE, { optional: true }) ?? boardStateCardStore(this.state, this.api);

  readonly boardId = input.required<string>();
  readonly boardName = input("Board");
  readonly workspaceId = input<string | null>(null);
  readonly cards = input.required<AnyCard[]>();
  readonly lists = input.required<AnyList[]>();
  readonly customFields = input<AnyCustomField[]>([]);
  readonly cardLabels = input<AnyLabel[]>([]);
  readonly members = input<AnyMember[]>([]);
  readonly labelsByCard = input<Map<string, AnyLabel[]>>(new Map());
  readonly assigneesByCard = input<Map<string, AnyMember[]>>(new Map());
  readonly customFieldValuesByCardAndField = input<Map<string, Map<string, CardCustomFieldValue>>>(new Map());
  readonly filteredCardIds = input<Set<string> | null>(null);
  /**
   * "Up next" queue positions by card id, worn as a rank pill beside the title — the same pill the
   * board tile wears, so the queue reads identically whichever display is showing. Empty when the
   * host has no focused person (a plain board page passes the viewer's own queue).
   */
  readonly priorityRanksByCard = input<Map<string, number>>(new Map());
  /**
   * Hosted groups can repeat one card in several meaningful rows (for example, one shared card in
   * two people's priority queues), where a card-id-only rank map would collapse those ranks.
   */
  readonly priorityRanksByGroup = input<ReadonlyMap<string, ReadonlyMap<string, number>>>(new Map());

  // Drives the rank pill's --rank-heat: the top of the queue wears a deeper accent tint.
  protected readonly rankHeat = priorityRankHeat;

  readonly selectedCardId = input<string | null>(null);
  readonly bulkSelectedCardIds = input<Set<string>>(new Set());
  readonly canEdit = input(true);
  readonly canEditRole = input(true);
  readonly currentUserId = input<string | null>(null);
  readonly loading = input(false);
  readonly filterBarValue = input<FilterValue | null>(null);
  readonly filterLabels = input<FilterLabel[]>([]);
  readonly filterMembers = input<FilterMember[]>([]);
  readonly filterCustomFields = input<AnyCustomField[]>([]);
  readonly completedFrom = input("");
  readonly completedTo = input("");
  readonly completedLabel = input("Choose date range");
  readonly archived = input(false);
  readonly searchQuery = input("");

  // ── Cross-board embedding ───────────────────────────────────────────────────────────────
  // Empty on a board, where every row shares one source and a Board column would repeat the page
  // title on every line. Supplying them turns on the Board column and the source group-by axes.
  readonly sourceBoards = input<SourceBoardRef[]>([]);
  readonly sourceWorkspaces = input<SourceWorkspaceRef[]>([]);
  readonly sourceOrganisations = input<SourceOrganisationRef[]>([]);
  /**
   * Optional host-owned grouping and order. The regular board table derives groups from card
   * fields; relation-backed views such as personal priority queues already have a real grouping and
   * sequence that must not be re-derived from assignees or card positions.
   */
  readonly hostCardGroups = input<readonly CardGroup[] | null>(null);
  /** Cards whose host-owned relation may be reordered, keyed by hosted group. */
  readonly hostReorderableCardIdsByGroup = input<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  /** Picker contents for the optional add action in each hosted group header. */
  readonly hostAddGroupsByGroup = input<ReadonlyMap<string, PickerGroup[]>>(new Map());
  /**
   * Group/sort supplied by the host instead of the table's own toolbar menus.
   *
   * Global Work persists both in its saved-view definition and already renders the controls in its
   * page toolbar, so the table defers rather than putting a second, differently-scoped pair of
   * menus on the same screen. `null` keeps the table's own controls, which is the board default.
   */
  readonly hostGroupBy = input<GroupBy | null>(null);
  readonly hostSortBy = input<SortBy | null>(null);
  /**
   * Complete table presentation supplied by a saved-view host.
   *
   * When present, changes are emitted back to the host instead of being written to the table's
   * lens-wide localStorage scope. Board tables leave this null and retain their local preferences.
   */
  readonly hostPresentation = input<WorkTablePresentation | null>(null);
  /**
   * Optional host-owned fold state. Global Work uses this so its table groups survive navigation;
   * board tables keep the transient local behavior by leaving it null.
   */
  readonly hostCollapsedGroupKeys = input<readonly string[] | null>(null);
  /** Overrides the default `board:<id>:table` localStorage namespace for column and aggregate prefs. */
  readonly preferenceScope = input<string | null>(null);
  /**
   * Cards the viewer may actually edit, or null for "all of them".
   *
   * A cross-board sheet routinely mixes boards where the viewer is an editor with boards where they
   * are an observer. Gating on the page-wide `canEdit` alone would offer editors' affordances on
   * rows the API will reject.
   */
  readonly editableCardIds = input<Set<string> | null>(null);
  /** Off where the host owns search and filtering in its own toolbar. */
  readonly showSearch = input(true);
  readonly showFilterBar = input(true);
  /**
   * On where the host has its own card composer. The add-row button then asks the host to open it
   * (via `composeRequested`) instead of expanding a title-only input inside the table.
   */
  readonly hostOwnsComposer = input(false);
  /** Off when the embedding host has no useful grouping or summary-breakdown controls. */
  readonly showGroupingControl = input(true);
  /** Lets an embedding host promote Labels into its default column set without changing boards. */
  readonly labelsVisibleByDefault = input(false);
  /** Lets a priority-focused host show the viewer/group-specific queue position by default. */
  readonly priorityVisibleByDefault = input(false);
  /** Off where the host has no bulk-selection handlers wired. */
  readonly showRowSelection = input(true);
  /**
   * Off where a new row has no unambiguous home: a cross-board group names a status or an assignee,
   * not a board, so there is nothing to create the card in.
   */
  readonly canCreate = input(true);

  readonly cardOpened = output<string>();
  readonly hostCollapsedGroupKeysChange = output<string[]>();
  readonly hostPresentationChange = output<WorkTablePresentation>();
  readonly hostCardReordered = output<HostedTableCardReorder>();
  readonly hostCardAdded = output<{ groupKey: string; cardId: string }>();
  readonly hostCardDragStarted = output<void>();
  readonly hostCardDragEnded = output<void>();
  /** Only reachable from the cross-board Board column. */
  readonly boardOpened = output<string>();
  readonly cardCreated = output<AnyCard>();
  /**
   * Emitted instead of opening the inline title input when the host owns a card composer. The board
   * routes every "add card" affordance to one dialog; Global Work has no equivalent and keeps the
   * inline row.
   */
  readonly composeRequested = output<{ listId: string }>();
  readonly bulkSelectionRequested = output<BulkCardSelectionPayload>();
  readonly bulkMenuRequested = output<BulkCardMenuPayload>();
  readonly bulkListSelectionRequested = output<BulkListSelectionPayload>();
  readonly bulkSelectionCleared = output<void>();
  readonly cardDropped = output<CardDropPayload>();
  readonly filterValueChange = output<FilterValue>();
  readonly filterOpened = output<void>();
  readonly completedChange = output<{ from: string; to: string }>();
  readonly completedClear = output<void>();
  readonly archivedChange = output<boolean>();
  readonly filterClearAll = output<void>();
  readonly searchQueryChange = output<string>();
  /**
   * The table resets its own local preferences before emitting this. Embedded hosts use the event to
   * reset the group/sort values they own; a board table leaves it unhandled because both are local.
   */
  readonly resetRequested = output<void>();

  // Per board by default, so one board's column widths never leak onto another. A cross-board host
  // supplies its own namespace instead — its sheet is not any single board's.
  private readonly prefScope = computed(() => this.preferenceScope() ?? `board:${this.boardId()}:table`);
  readonly columnVisibility = signal<Record<string, boolean>>({});
  readonly columnOrder = signal<string[]>([]);
  readonly columnWidths = signal<ColumnWidths>({});
  readonly sortBy = signal<SortBy>("position");
  readonly groupBy = signal<GroupBy>("list");
  /** What the sheet is actually grouped and sorted by, host control taking precedence. */
  readonly effectiveGroupBy = computed<GroupBy>(() => this.hostGroupBy() ?? this.groupBy());
  readonly effectiveSortBy = computed<SortBy>(() => this.hostSortBy() ?? this.sortBy());
  readonly crossBoard = computed(() => this.sourceBoards().length > 0);
  /** More than one list/label/custom-field vocabulary in play, since all three are workspace-scoped. */
  readonly crossWorkspace = computed(() => this.sourceWorkspaces().length > 1);
  private readonly workspaceNameById = computed(
    () => new Map(this.sourceWorkspaces().map((workspace) => [workspace.id, workspace.name])),
  );
  /**
   * True when the table is a pane inside another page rather than the page itself.
   *
   * Inferred from the host having taken over search and filtering, because that is the same
   * decision: a host that owns the chrome also owns the frame around it, so the sheet stops drawing
   * its own top border and lets its remaining controls sit at the trailing edge.
   */
  readonly embedded = computed(() => !this.showSearch() && !this.showFilterBar());
  /** Secondary dimension every summary is broken down by ("none" = one subtotal per group). */
  readonly aggregateSplitBy = signal<GroupBy>("none");
  readonly aggregateConfig = signal<AggregateConfig>({});
  readonly rowRenderCap = signal(INITIAL_ROW_CAP);
  private readonly localCollapsedGroups = signal<Set<string>>(new Set());
  /** Group keys folded shut, supplied by an embedding host or transiently owned by a board table. */
  readonly collapsedGroups = computed(() => {
    const hosted = this.hostCollapsedGroupKeys();
    return hosted === null ? this.localCollapsedGroups() : new Set(hosted);
  });
  readonly editingCell = signal<EditingCell | null>(null);
  readonly editDraft = signal("");
  readonly openPicker = signal<OpenPicker | null>(null);
  readonly columnsOpen = signal(false);
  // The show/hide panel has two triggers — the toolbar button and the `+` at the end of the header
  // row — but only one instance in the DOM. Anchoring to the element that opened it keeps the panel
  // beside whichever one was clicked; without this it always resolved to its toolbar parent.
  readonly columnsAnchor = signal<HTMLElement | null>(null);
  readonly sortOpen = signal(false);
  readonly groupOpen = signal(false);
  readonly exportOpen = signal(false);
  readonly aggregateOpenFieldId = signal<string | null>(null);
  readonly creatingTask = signal(false);
  /** List whose run label is currently showing an inline composer, if any. */
  readonly runComposeListId = signal<string | null>(null);
  readonly runTaskTitle = signal("");
  readonly actionsMenuPoint = signal<{ x: number; y: number } | null>(null);
  readonly activeActionsCardId = computed(() => this.menuCoordinator.activeCardMenuId());
  readonly hostAddOpenGroupKey = signal<string | null>(null);

  private readonly customFieldSaveKeys = new Map<string, string>();
  private resizingColumn: {
    id: string;
    startX: number;
    startWidth: number;
    removeListeners: () => void;
  } | null = null;

  private backgroundPan: { el: HTMLElement; startX: number; startScrollLeft: number } | null = null;
  private readonly onPanMove = (event: MouseEvent) => {
    const pan = this.backgroundPan;
    if (!pan) return;
    // Text would otherwise be range-selected across the rows the pointer sweeps over.
    event.preventDefault();
    pan.el.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startX);
  };
  private readonly onPanEnd = () => this.endBackgroundPan();

  readonly sortedLists = computed(() => [...this.lists()].sort((a, b) => Number(a.position) - Number(b.position)));
  readonly sortedCustomFields = computed(() =>
    [...this.customFields()].filter((field) => !field.archivedAt).sort((a, b) => Number(a.position) - Number(b.position)),
  );
  readonly customFieldById = computed(() => new Map(this.sortedCustomFields().map((field) => [field.id, field])));
  readonly listById = computed(() => new Map(this.lists().map((list) => [list.id, list])));
  readonly memberById = computed(() => new Map(this.members().map((member) => [member.userId, member])));

  // "board" appears only when the rows actually come from several boards; on a board page it would
  // repeat the page title on every line.
  readonly availableColumns = computed(() => [
    "priority",
    "status",
    ...(this.crossBoard() ? ["board"] : []),
    "assignees",
    "due",
    "labels",
    "checklist",
    "created",
    "updated",
    ...this.sortedCustomFields().map((field) => `cf:${field.id}`),
  ]);

  readonly visibleColumns = computed(() => {
    const visibility = this.columnVisibility();
    const visible = this.availableColumns().filter((id) => this.columnIsVisible(id, visibility));
    return applySavedColumnOrder(visible, this.columnOrder());
  });

  readonly pickableColumns = computed<ColumnItem[]>(() =>
    this.availableColumns().map((id) => ({
      id,
      label: this.columnLabel(id),
      icon: this.columnIcon(id),
      visible: this.columnIsVisible(id, this.columnVisibility()),
    })),
  );

  /**
   * The scrollport's inner width, tracked so the columns can spend whatever the sheet is not using.
   * Zero until the observer has reported once, which the distribution below reads as "unknown" and
   * falls back to the natural widths — the sheet must never render narrower than its content just
   * because a measurement has not arrived yet.
   */
  private readonly scrollportWidth = signal(0);
  /** Intrinsic widths of the currently mounted header and values, refreshed after their DOM renders. */
  private readonly measuredContentWidths = signal<Record<string, number>>({});
  private scrollportObserver: ResizeObserver | null = null;
  private contentObserver: MutationObserver | null = null;
  private contentMeasurementFrame: number | null = null;
  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>("scrollEl");

  /**
   * Columns absorb the leftover width instead of leaving it to the trailing filler track, so a sheet
   * with a handful of narrow columns fills the pane rather than stranding half of it empty.
   *
   * Only the space the row actually has is shared out: the scrollport less the run inset the bands pay
   * as padding and the fixed actions column, both of which sit in the same grid. When the columns
   * already exceed that, there is no slack and the sheet keeps its natural width and scrolls.
   */
  readonly gridTemplate = computed(() => {
    const ids = [TITLE_COLUMN_ID, ...this.visibleColumns()];
    const available = this.scrollportWidth() - TABLE_RUN_INSET * 2 - ACTIONS_COLUMN_WIDTH;
    const widths = distributeColumnSlack({
      ids,
      available,
      baseFor: (id) => this.widthForColumn(id),
      // A width the viewer dragged (or auto-fitted) is theirs; growing it back would undo the gesture.
      isPinned: (id) => this.columnWidths()[id] !== undefined,
      // A missing first-render measurement means "stay at the natural width", never "grow blindly".
      targetFor: (id) => Math.max(
        this.widthForColumn(id),
        Math.ceil(this.measuredContentWidths()[id] ?? 0) + AUTO_FIT_SLACK,
      ),
    });
    return gridTemplateFrom(ids, (id) => widths[id] ?? this.widthForColumn(id), [ACTIONS_COLUMN_WIDTH]);
  });

  readonly groupingContext = computed(() => ({
    lists: this.lists(),
    labels: this.cardLabels(),
    members: this.members(),
    labelsByCard: this.labelsByCard(),
    assigneesByCard: this.assigneesByCard(),
    customFields: this.customFields(),
    customFieldValuesByCardAndField: this.customFieldValuesByCardAndField(),
    currentUserId: this.currentUserId(),
    boards: this.sourceBoards(),
    workspaces: this.sourceWorkspaces(),
    organisations: this.sourceOrganisations(),
  }));

  readonly visibleCards = computed(() => {
    const ids = this.filteredCardIds();
    return ids ? this.cards().filter((card) => ids.has(card.id)) : this.cards();
  });
  readonly resolvedFilterValue = computed<FilterValue>(() => this.filterBarValue() ?? ({
    labelIds: [],
    memberIds: [],
    listIds: [],
    boardIds: [],
    cfConditions: [],
    showUnreadOnly: false,
    showOverdueOnly: false,
    showInactiveOnly: false,
    showPrioritySetOnly: false,
  }));

  /** Rank of each list in board order, so manual sort can order by list before ordering within it. */
  private readonly listRank = computed(() => new Map(this.sortedLists().map((list, index) => [list.id, index])));

  private qualifiedListLabel(listId: string, label: string): string {
    const workspaceId = this.listById().get(listId)?.workspaceId;
    const workspace = workspaceId ? this.workspaceNameById().get(workspaceId) : undefined;
    return workspace ? `${workspace} · ${label}` : label;
  }

  /**
   * The sheet's groups, in render order.
   *
   * Routed through the shared `groupCards` helper so board and cross-board tables bucket and order a
   * dimension identically — a card with two labels appears under both.
   */
  readonly groups = computed<CardGroup[]>(() => {
    const hosted = this.hostCardGroups();
    if (hosted !== null) return hosted.map((group) => ({ ...group, cards: [...group.cards] }));
    const cards = this.visibleCards();
    const mode = this.effectiveGroupBy();
    // No groups at all rather than a column of empty blocks, which is what lets the sheet fall
    // through to its empty state and hand the single bottom add row back to a board with no cards.
    if (!cards.length) return [];
    if (mode === "none") {
      // One unlabelled block. Its empty name is what suppresses the run header downstream.
      return [{ key: "all", label: "", icon: null, color: null, acceptsDrop: false, meta: {}, cards: this.flatSorted(cards) }];
    }
    // `groupByList` enumerates every live list, empty ones included, which is deliberate: an empty
    // status still has an add row and is where its first card goes. Under a filter it is only noise —
    // a narrowed table would be mostly blocks with nothing in them — so those are dropped.
    const filtered = this.filteredCardIds() !== null;
    const groups = groupCards(cards, mode, this.effectiveSortBy(), this.groupingContext())
      .filter((group) => !filtered || group.cards.length > 0)
      // Lists are workspace-scoped and their names repeat, so across workspaces "Doing" would head
      // several unrelated blocks. Qualified here rather than in the list names themselves, because
      // the status *cell* is a narrow pill that a workspace prefix would clip the status out of.
      .map((group) => (mode === "list" && this.crossWorkspace() && group.meta.listId
        ? { ...group, label: this.qualifiedListLabel(group.meta.listId, group.label) }
        : group));
    // `groupByList` only enumerates live lists, so a card sitting in a list that has since been
    // archived is claimed by no group. Silently dropping rows from a table is worse than an extra
    // block, so anything unclaimed is collected rather than lost.
    const claimed = new Set(groups.flatMap((group) => group.cards.map((card) => card.id)));
    const orphans = cards.filter((card) => !claimed.has(card.id));
    if (!orphans.length) return groups;
    return [...groups, {
      key: "__ungrouped__",
      label: "Ungrouped",
      icon: "circle-dashed",
      color: null,
      acceptsDrop: false,
      meta: {},
      cards: sortGroupCards(orphans, this.effectiveSortBy()),
    }];
  });

  priorityRankFor(groupKey: string, cardId: string): number | null {
    return this.priorityRanksByGroup().get(groupKey)?.get(cardId)
      ?? this.priorityRanksByCard().get(cardId)
      ?? null;
  }

  /**
   * Every card on the sheet once, in the order the groups render them.
   *
   * Deduplicated because a multi-value dimension repeats a card in each bucket it belongs to, and
   * every consumer of this list — the count, the aggregates, shift-range selection, select-all —
   * means "the distinct cards in this view", not "the rows drawn".
   */
  readonly rows = computed<AnyCard[]>(() => {
    const seen = new Set<string>();
    const rows: AnyCard[] = [];
    for (const group of this.groups()) {
      for (const card of group.cards) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        rows.push(card);
      }
    }
    return rows;
  });

  /**
   * Export keeps the table's filtered order, but a live bulk selection narrows it further. An empty
   * selection retains the long-standing "export this view" behavior; a non-empty one means exactly
   * the selected cards that are present in the current view.
   */
  readonly exportRows = computed<AnyCard[]>(() => {
    const rows = this.rows();
    const selected = this.bulkSelectedCardIds();
    return selected.size ? rows.filter((card) => selected.has(card.id)) : rows;
  });

  readonly exportScopeLabel = computed(() => {
    if (!this.bulkSelectedCardIds().size) return `${this.exportRows().length} cards in this view`;
    const count = this.exportRows().length;
    return `${count} selected card${count === 1 ? "" : "s"}`;
  });

  readonly footerCount = computed(() => this.rows().length);

  /**
   * Manual sort has to be compound when grouping is off, unlike everywhere else that sorts by
   * `position`.
   *
   * `cards.position` is per-list — `BoardState.positionForCardDrop` derives it from the target list's
   * own cards — so every list independently runs 1000, 2000, 3000… Comparing that number across a
   * board-wide flat list interleaves lists by a value that only means anything inside one: the fourth
   * card of Backlog sorts below the first card of Done, and cards at the same rank in two lists tie.
   * Ordering by list first makes the ungrouped grid read exactly like the kanban scanned
   * left-to-right, top-to-bottom. Every other sort mode is already total across the board.
   */
  private flatSorted(cards: AnyCard[]): AnyCard[] {
    const sorted = sortGroupCards(cards, this.effectiveSortBy());
    if (this.effectiveSortBy() !== "position") return sorted;
    const rank = this.listRank();
    // A card whose list is missing (archived, or not yet arrived over realtime) sorts to the end
    // rather than to the top, which is where a -1 rank would silently put it.
    const rankOf = (listId: string) => rank.get(listId) ?? Number.MAX_SAFE_INTEGER;
    return sorted.sort((a, b) => rankOf(a.listId) - rankOf(b.listId) || Number(a.position) - Number(b.position));
  }
  readonly targetList = computed(() => {
    const selected = this.filterBarValue()?.listIds ?? [];
    if (selected.length === 1) return this.listById().get(selected[0]!) ?? null;
    return this.sortedLists()[0] ?? null;
  });
  private readonly sourceBoardById = computed(() => new Map(this.sourceBoards().map((board) => [board.id, board])));

  /**
   * The lists a given card may legally move between.
   *
   * Lists are workspace-scoped, so a cross-board sheet holds several disjoint sets of them and only
   * the card's own workspace can receive it — offering the rest would be a picker whose other half
   * always 400s. On a board there is one workspace and this is just every list.
   */
  listsForCard(card: AnyCard): AnyList[] {
    if (!this.crossBoard()) return this.sortedLists();
    const workspaceId = this.sourceBoardById().get(card.boardId)?.workspaceId;
    if (!workspaceId) return this.sortedLists();
    return this.sortedLists().filter((list) => list.workspaceId === workspaceId);
  }

  // One ungrouped run of options, matching every other list picker in the app. Emitting a group per
  // list gave each one a heading identical to its own single option, so the popover read as every
  // status printed twice.
  statusGroupsFor(card: AnyCard): PickerGroup[] {
    return [{
      id: "lists",
      options: this.listsForCard(card).map((list) => ({
        id: list.id,
        label: list.name,
        icon: list.icon || "list",
        color: list.color,
      })),
    }];
  }

  /**
   * Whether this specific row is editable. `canEdit` is the page-wide gate (role plus connectivity);
   * `editableCardIds` narrows it per row for sheets that span boards the viewer only observes.
   */
  canEditCard(card: AnyCard): boolean {
    if (!this.canEdit()) return false;
    const editable = this.editableCardIds();
    return editable === null || editable.has(card.id);
  }

  boardFor(card: AnyCard): SourceBoardRef | null {
    return this.sourceBoardById().get(card.boardId) ?? null;
  }

  // Per row rather than a precomputed map: the counts signal changes on every notification the socket
  // delivers, and rebuilding a map over the whole sheet on each one costs more than the row reads.
  unreadCount(cardId: string): number {
    return this.notifications.cardUnreadCount(cardId);
  }

  /** The dot carries no digits, so this is the only place the row states how many. */
  unreadLabel(cardId: string): string {
    return unreadMarkLabel(this.unreadCount(cardId));
  }

  readonly sortOptions = SORT_BY_OPTIONS;

  readonly groupByOptions = computed<GroupByOption[]>(() => [
    ...GROUP_BY_OPTIONS,
    // Only where rows come from more than one board; on a board these would each produce a single
    // block named after the page you are already on.
    ...(this.crossBoard() ? CROSS_BOARD_GROUP_BY_OPTIONS : []),
    ...this.sortedCustomFields().map((field) => ({
      value: `cf:${field.id}` as GroupBy,
      // Same label the column header carries, so a workspace-qualified field reads the same in both.
      label: this.columnLabel(`cf:${field.id}`),
      icon: field.icon || "forms",
    })),
  ]);

  // Anything groupable except the axis already in use: breaking a group down by its own dimension
  // puts every card of that group in one bucket, which is the group over again.
  readonly splitByOptions = computed<GroupByOption[]>(() => [
    { value: "none", label: "No breakdown", icon: "minus" },
    ...this.groupByOptions().filter((option) => option.value !== "none" && option.value !== this.effectiveGroupBy()),
  ]);

  readonly groupByLabel = computed(() =>
    this.groupByOptions().find((option) => option.value === this.effectiveGroupBy())?.label ?? "List",
  );
  readonly splitByLabel = computed(() =>
    this.splitByOptions().find((option) => option.value === this.aggregateSplitBy())?.label ?? "No breakdown",
  );
  readonly sortByLabel = computed(() =>
    SORT_BY_OPTIONS.find((option) => option.value === this.effectiveSortBy())?.label ?? "Manual",
  );

  /**
   * Trigger text for the menu buttons, shared by the visible label, the tooltip and `aria-label`.
   * One source: below the label-drop breakpoint these are icon-only, so the tooltip *is* the label and
   * the two must not be able to say different things.
   *
   * The Group trigger becomes Breakdown when the host owns grouping — then the only dimension left
   * here is the one the footer summaries cross-tab against.
   */
  readonly groupTriggerLabel = computed(() => {
    if (!this.hostGroupBy()) return `Group: ${this.groupByLabel()}`;
    return this.splitActive() ? `Breakdown: ${this.splitByLabel()}` : "Breakdown";
  });
  readonly sortTriggerLabel = computed(() => `Sort: ${this.sortByLabel()}`);

  /**
   * Group / Sort / Columns away from this sheet's defaults, driving the one canonical accent
   * treatment on their triggers. Kept separate from the `is-open` menu state: "the menu is showing"
   * and "this control is changing what you see" are different facts and used to share one class.
   *
   * When the host owns grouping the Group button *is* the breakdown control, so what counts as set
   * there is a live breakdown rather than a non-default group axis.
   */
  readonly groupIsSet = computed(() =>
    this.hostGroupBy() ? this.splitActive() : this.effectiveGroupBy() !== "list",
  );
  readonly sortIsSet = computed(() => this.effectiveSortBy() !== "position");
  /**
   * Only an explicit override counts. `columnVisibility` is sparse — an id absent from it takes the
   * shape-dependent default from `columnIsVisible` — so comparing against that default is what keeps
   * "I re-ticked the box I had unticked" from reading as engaged.
   */
  readonly columnsIsSet = computed(() => {
    const visibility = this.columnVisibility();
    return this.availableColumns().some(
      (id) => id in visibility && visibility[id] !== this.defaultColumnVisible(id),
    );
  });

  constructor() {
    effect(() => {
      const scope = this.prefScope();
      const hosted = this.hostPresentation();
      const loading = this.loading();
      untracked(() => {
        this.columnVisibility.set(hosted?.columnVisibility ?? readColumnVisibility(scope) ?? {});
        this.columnOrder.set(hosted?.columnOrder ?? readColumnOrder(scope) ?? []);
        this.columnWidths.set(hosted?.columnWidths ?? readColumnWidths(scope) ?? {});
        this.sortBy.set(readSortBy(scope) ?? "position");
        this.groupBy.set(this.validDimension(readGroupBy(scope), "list", loading));
        this.aggregateConfig.set(hosted?.aggregates ?? readAggregateConfig(scope) ?? {});
        this.aggregateSplitBy.set(this.validDimension(
          hosted ? hosted.aggregateSplitBy as GroupBy : readAggregateSplitBy(scope),
          "none",
          loading,
        ));
        this.rowRenderCap.set(INITIAL_ROW_CAP);
        this.localCollapsedGroups.set(new Set());
      });
    });
    // Grouping changes how much of the sheet one screen holds, so the incremental cap starts over.
    // Collapse state goes with it: group keys are dimension-scoped, so keeping them would fold a
    // block of the new axis that happens to collide with a key from the old one. Driven off the
    // effective axis rather than `setGroupBy`, so a host-supplied change resets the same way.
    effect(() => {
      this.effectiveGroupBy();
      untracked(() => {
        this.rowRenderCap.set(INITIAL_ROW_CAP);
        this.localCollapsedGroups.set(new Set());
      });
    });
    // The scrollport only exists once the view has rendered, and it is re-created whenever the sheet
    // is torn down and rebuilt, so the observer is attached from the query rather than once on init.
    effect(() => {
      const el = this.scrollEl()?.nativeElement;
      if (el) untracked(() => this.observeScrollport(el));
    });

    // A template `(scroll)` binding marks this component dirty on every scroll event, even when the
    // handler returns without growing the slice — and a dirty pass here re-runs the per-row bindings
    // for every rendered cell. Keep the hot path outside Angular's event wrapper, coalesce the
    // threshold check into one rAF, and drop the listener once every row is mounted. Same pattern
    // k-list already uses for its lane.
    effect((onCleanup) => {
      const el = this.scrollEl()?.nativeElement;
      if (!el || !this.hasHiddenRows()) return;
      let pendingFrame: number | null = null;
      const onScroll = () => {
        if (pendingFrame !== null) return;
        pendingFrame = requestAnimationFrame(() => {
          pendingFrame = null;
          this.onTableScroll(el);
        });
      };
      el.addEventListener("scroll", onScroll, { passive: true });
      onCleanup(() => {
        el.removeEventListener("scroll", onScroll);
        if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      });
    });
  }

  // ── Collapsing ────────────────────────────────────────────────────────────
  toggleGroupCollapsed(key: string) {
    const next = new Set(this.collapsedGroups());
    if (!next.delete(key)) next.add(key);
    this.setCollapsedGroups(next);
  }

  isGroupCollapsed(key: string): boolean {
    return this.collapsedGroups().has(key);
  }

  // Only meaningful with more than one block; with grouping off there is nothing to fold away.
  readonly canCollapseGroups = computed(() => this.runGroups().length > 1);

  readonly allGroupsCollapsed = computed(() => {
    const groups = this.runGroups();
    return groups.length > 0 && groups.every((group) => group.collapsed);
  });

  toggleAllGroups() {
    if (this.allGroupsCollapsed()) {
      this.setCollapsedGroups(new Set());
      return;
    }
    this.setCollapsedGroups(new Set(this.runGroups().map((group) => group.key)));
  }

  private setCollapsedGroups(keys: Set<string>): void {
    if (this.hostCollapsedGroupKeys() !== null) {
      this.hostCollapsedGroupKeysChange.emit([...keys]);
      return;
    }
    this.localCollapsedGroups.set(keys);
  }

  /**
   * A stored dimension is only honoured if it still exists. A `cf:` axis whose field has since been
   * deleted or archived would otherwise leave the sheet silently ungrouped with the menu still
   * claiming otherwise, because `groupCards` falls back to no grouping on an unknown field.
   */
  private validDimension(value: GroupBy | null, fallback: GroupBy, deferCustomFieldValidation = false): GroupBy {
    if (!value) return fallback;
    if (!value.startsWith("cf:")) return value;
    // The table mounts while its board payload is still in flight. Keep a remembered custom-field
    // axis during that empty loading state, then validate it when loading completes; rejecting it on
    // the first pass would permanently replace a valid saved grouping with the fallback for this visit.
    if (deferCustomFieldValidation) return value;
    return this.customFieldById().has(value.slice(3)) ? value : fallback;
  }

  columnLabel(id: string): string {
    if (id === "status") return "Status";
    if (!id.startsWith("cf:")) return builtinColumnLabel(id);
    const field = this.customFieldById().get(id.slice(3));
    if (!field) return id;
    // Custom fields are workspace-scoped, and the same obvious names ("Client", "Hours") recur in
    // every workspace. On a cross-workspace sheet the bare name would leave two different fields
    // with one heading, so each carries the workspace it belongs to.
    if (!this.crossWorkspace()) return field.name;
    return `${this.workspaceNameById().get(field.workspaceId) ?? "Workspace"} · ${field.name}`;
  }

  /** Keeps the compact rank column readable while its picker/export name remains unambiguous. */
  columnHeaderLabel(id: string): string {
    return id === "priority" ? "Up next" : this.columnLabel(id);
  }

  columnIcon(id: string): string {
    if (id.startsWith("cf:")) return this.customFieldById().get(id.slice(3))?.icon || "forms";
    return builtinColumnIcon(id);
  }

  customFieldForColumn(id: string): AnyCustomField | null {
    return id.startsWith("cf:") ? this.customFieldById().get(id.slice(3)) ?? null : null;
  }

  /**
   * Status, assignees and due date are on by default: who / what state / by when is what a table is
   * normally opened to scan. Labels and Up next order stay off unless an embedding host explicitly
   * promotes them for its workflow. Board is on where it exists, since it is the first question a
   * cross-board row raises.
   *
   * Custom fields default on for one workspace — a workspace that defined a field wants to see it —
   * and off across several. Every workspace's fields together is a wall of columns most of which are
   * blank on any given row, so there the Columns menu is how you choose the two you care about.
   */
  columnIsVisible(id: string, visibility = this.columnVisibility()): boolean {
    if (id in visibility) return visibility[id]!;
    return this.defaultColumnVisible(id);
  }

  /** Split out so `columnsIsSet` can ask what the default *would* be for a column that has an override. */
  private defaultColumnVisible(id: string): boolean {
    if (id.startsWith("cf:")) return !this.crossWorkspace();
    if (id === "labels") return this.labelsVisibleByDefault();
    if (id === "priority") return this.priorityVisibleByDefault();
    return id === "status" || id === "assignees" || id === "due" || id === "board";
  }

  /**
   * Reorder columns by dragging their headers.
   *
   * CDK's indices are over the header's drag items, which are exactly the visible columns — the title
   * header and the trailing actions header are in the same container but are not `cdkDrag`, so CDK
   * skips them. Title staying put is the point: it is the sticky first column.
   *
   * Hidden columns are appended in their previously saved order rather than dropped, so unhiding one
   * later returns it to where it was instead of to the end.
   */
  onColumnDrop(event: CdkDragDrop<string[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const nextVisible = [...this.visibleColumns()];
    moveItemInArray(nextVisible, event.previousIndex, event.currentIndex);
    const hidden = applySavedColumnOrder(
      this.availableColumns().filter((id) => !nextVisible.includes(id)),
      this.columnOrder(),
    );
    const nextOrder = [...nextVisible, ...hidden];
    this.columnOrder.set(nextOrder);
    if (!this.emitHostedPresentation()) writeColumnOrder(this.prefScope(), nextOrder);
  }

  toggleColumn(id: string) {
    const next = { ...this.columnVisibility(), [id]: !this.columnIsVisible(id) };
    this.columnVisibility.set(next);
    if (!this.emitHostedPresentation()) writeColumnVisibility(this.prefScope(), next);
  }

  /** One open menu at a time. Each keeps its own signal so a dismissal cannot close a sibling. */
  toggleMenu(name: "group" | "sort" | "columns" | "export") {
    this.groupOpen.set(name === "group" ? !this.groupOpen() : false);
    this.sortOpen.set(name === "sort" ? !this.sortOpen() : false);
    this.columnsOpen.set(name === "columns" ? !this.columnsOpen() : false);
    this.exportOpen.set(name === "export" ? !this.exportOpen() : false);
  }

  /** Both triggers route through here so the single panel instance follows whichever was clicked. */
  toggleColumnsMenu(event: MouseEvent) {
    this.columnsAnchor.set(event.currentTarget as HTMLElement);
    this.toggleMenu("columns");
  }

  setSort(value: string) {
    if (!SORT_BY_OPTIONS.some((option) => option.value === value)) return;
    this.sortBy.set(value as SortBy);
    writeSortBy(this.prefScope(), value as SortBy);
    this.sortOpen.set(false);
  }

  /**
   * Toolbar inline clears — each returns one control to the default its `*IsSet` computed measures
   * against, without the wholesale `resetTable()` (which also drops column order, widths and
   * aggregates the reader never asked to lose).
   *
   * Columns clears the sparse overrides rather than writing every column back to visible: an id
   * absent from `columnVisibility` takes the shape-dependent default, which is what "default" means
   * for this sheet.
   */
  clearColumns() {
    this.columnVisibility.set({});
    if (!this.emitHostedPresentation()) writeColumnVisibility(this.prefScope(), {});
  }

  /** When the host owns grouping this trigger *is* the breakdown control, so that is what clears. */
  clearGroup() {
    if (this.hostGroupBy()) this.setSplitBy("none");
    else this.setGroupBy("list");
  }

  clearSort() {
    this.setSort("position");
  }

  setGroupBy(value: GroupBy) {
    const next = this.validDimension(value, "list");
    this.groupBy.set(next);
    writeGroupBy(this.prefScope(), next);
    // The old axis is a legal breakdown again and the new one no longer is, so a split that has just
    // become a no-op is cleared rather than left selected and silently doing nothing.
    if (this.aggregateSplitBy() === next) this.setSplitBy("none");
    // The render cap and collapse state are reset by the effect watching `effectiveGroupBy`.
    this.groupOpen.set(false);
  }

  setSplitBy(value: GroupBy) {
    // The menu hides these choices in this state, and the guard keeps a stale/programmatic click from
    // persisting a control that cannot change anything on screen.
    if (value !== "none" && !this.hasSummaries()) return;
    const next = this.validDimension(value, "none");
    this.aggregateSplitBy.set(next === this.effectiveGroupBy() ? "none" : next);
    if (!this.emitHostedPresentation()) writeAggregateSplitBy(this.prefScope(), this.aggregateSplitBy());
  }

  /**
   * Restore the table-specific presentation without touching row selection or card data.
   *
   * Search and filtering live in the page toolbar for the board and Global Work, so they are not
   * silently cleared by a layout reset. A host-owned group/sort is reset through `resetRequested`.
   */
  resetTable(): void {
    const scope = this.prefScope();
    const aggregates: AggregateConfig = {};
    this.columnVisibility.set({});
    this.columnOrder.set([]);
    this.columnWidths.set({});
    this.sortBy.set("position");
    this.groupBy.set("list");
    this.aggregateConfig.set(aggregates);
    this.aggregateSplitBy.set("none");
    this.rowRenderCap.set(INITIAL_ROW_CAP);
    this.localCollapsedGroups.set(new Set());
    this.closeToolbarMenus();

    if (!this.emitHostedPresentation()) {
      writeColumnVisibility(scope, {});
      writeColumnOrder(scope, []);
      writeColumnWidths(scope, {});
      writeSortBy(scope, "position");
      writeGroupBy(scope, "list");
      writeAggregateConfig(scope, aggregates);
      writeAggregateSplitBy(scope, "none");
    }

    // Hosted collapse state otherwise survives even though its grouping has just returned to the
    // host default, which could fold a coincidentally matching bucket on the reset table.
    if (this.hostCollapsedGroupKeys() !== null) this.hostCollapsedGroupKeysChange.emit([]);
    this.resetRequested.emit();
  }

  private emitHostedPresentation(): boolean {
    if (this.hostPresentation() === null) return false;
    this.hostPresentationChange.emit({
      columnVisibility: { ...this.columnVisibility() },
      columnOrder: [...this.columnOrder()],
      columnWidths: { ...this.columnWidths() },
      aggregates: { ...this.aggregateConfig() },
      aggregateSplitBy: this.aggregateSplitBy(),
      collapsedGroupKeys: [...this.collapsedGroups()],
    });
    return true;
  }

  private closeToolbarMenus(): void {
    this.groupOpen.set(false);
    this.sortOpen.set(false);
    this.columnsOpen.set(false);
    this.exportOpen.set(false);
    this.aggregateOpenFieldId.set(null);
  }

  onTableScroll(el: HTMLElement) {
    if (!this.hasHiddenRows()) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining <= GROW_NEAR_BOTTOM_PX) this.rowRenderCap.update((cap) => cap + ROW_CAP_PAGE);
  }

  /**
   * Watches the scrollport so the columns can re-spend the slack whenever the pane changes width —
   * a window resize, the sidebar collapsing, the Up next dock opening beside a board.
   *
   * `clientWidth` deliberately, not the observer's `contentRect`: the border box reported there still
   * counts a vertical scrollbar that the columns cannot lay out under, which on an overlay-scrollbar
   * platform is nothing and on a classic one is ~15px of phantom slack that would make the sheet
   * scroll horizontally by exactly that much.
   */
  observeScrollport(el: HTMLElement) {
    this.scrollportWidth.set(el.clientWidth);
    if (typeof ResizeObserver !== "undefined") {
      this.scrollportObserver?.disconnect();
      this.scrollportObserver = new ResizeObserver(() => {
        this.scrollportWidth.set(el.clientWidth);
        this.scheduleContentMeasurement();
      });
      this.scrollportObserver.observe(el);
    }
    if (typeof MutationObserver !== "undefined") {
      this.contentObserver?.disconnect();
      this.contentObserver = new MutationObserver(() => this.scheduleContentMeasurement());
      // Async rows, filters and realtime updates can arrive after the initial scheduled measure. Watch
      // structural/text changes only: observing the grid's style attributes would make the measured
      // width write observe its own layout update and create a feedback loop.
      this.contentObserver.observe(el, { subtree: true, childList: true, characterData: true });
    }
    this.scheduleContentMeasurement();
  }

  private scheduleContentMeasurement(): void {
    if (this.contentMeasurementFrame !== null || typeof requestAnimationFrame === "undefined") return;
    this.contentMeasurementFrame = requestAnimationFrame(() => {
      this.contentMeasurementFrame = null;
      const ids = [TITLE_COLUMN_ID, ...this.visibleColumns()];
      const root = this.scrollEl()?.nativeElement;
      if (!root) return;
      const next = measuredColumnContentWidths(root, ids);
      if (!columnWidthsEqual(this.measuredContentWidths(), next)) this.measuredContentWidths.set(next);
    });
  }

  /**
   * Grab-and-drag the empty space to pan the grid sideways, the same gesture `k-board-canvas` gives
   * the kanban background. Only the space outside the grid qualifies: inside a row the drag belongs
   * to text selection and cell editing, and the header strip owns column resizing.
   */
  startBackgroundPan(el: HTMLElement, event: MouseEvent) {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(TABLE_PAN_STOP_SELECTOR)) return;
    if (el.scrollWidth <= el.clientWidth) return;
    this.endBackgroundPan();
    this.backgroundPan = { el, startX: event.clientX, startScrollLeft: el.scrollLeft };
    el.classList.add("is-panning");
    window.addEventListener("mousemove", this.onPanMove);
    window.addEventListener("mouseup", this.onPanEnd, { once: true });
  }

  startColumnResize(id: string, event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endColumnResize();
    const onMove = (moveEvent: PointerEvent) => {
      const active = this.resizingColumn;
      if (!active) return;
      const next = {
        ...this.columnWidths(),
        [active.id]: this.clampColumn(active.id, active.startWidth + moveEvent.clientX - active.startX),
      };
      this.columnWidths.set(next);
    };
    const onUp = () => {
      if (!this.emitHostedPresentation()) writeColumnWidths(this.prefScope(), this.columnWidths());
      this.endColumnResize();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
    this.resizingColumn = {
      id,
      startX: event.clientX,
      startWidth: this.widthForColumn(id),
      removeListeners: () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      },
    };
    document.body.classList.add("is-table-column-resizing");
  }

  /**
   * Excel's double-click-the-divider gesture: size the column to its widest value.
   *
   * Measured from the DOM rather than from the data because the rendered width is what actually has
   * to fit — icons, avatar stacks, label chips and the title cell's checkbox gutter all count, and
   * none of them are derivable from the string a cell holds. Only mounted rows are measured, so on a
   * board past the render cap this fits what you can see, which is also what Excel does with a
   * filtered sheet. The result still goes through `clampColumn`, so auto-fit can never produce a
   * width the resize handle could not.
   */
  autoFitColumn(id: string, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const cells = this.hostEl.nativeElement.querySelectorAll<HTMLElement>(`[data-col="${cssEscape(id)}"]`);
    let widest = 0;
    for (const cell of cells) widest = Math.max(widest, measuredColumnContentWidth(cell));
    if (!widest) return;
    const next = { ...this.columnWidths(), [id]: this.clampColumn(id, Math.ceil(widest) + AUTO_FIT_SLACK) };
    this.columnWidths.set(next);
    if (!this.emitHostedPresentation()) writeColumnWidths(this.prefScope(), next);
  }

  valueFor(cardId: string, fieldId: string): CardCustomFieldValue | undefined {
    return this.customFieldValuesByCardAndField().get(cardId)?.get(fieldId);
  }

  textValue(card: AnyCard, field: AnyCustomField): string {
    const value = this.valueFor(card.id, field.id);
    if (!value) return "";
    if (field.type === "number") return value.valueNumber ?? "";
    if (field.type === "url") return value.valueUrl ?? "";
    return value.valueText ?? "";
  }

  displayValue(card: AnyCard, field: AnyCustomField): string {
    const value = this.valueFor(card.id, field.id);
    if (!value) return "—";
    switch (field.type) {
      case "text": return value.valueText || "—";
      case "number": return value.valueNumber ?? "—";
      case "url": return value.valueUrl || "—";
      case "date": return value.valueDate || "—";
      case "checkbox": return value.valueCheckbox ? "Checked" : "Unchecked";
      case "select": {
        const options = this.optionLabelsByField().get(field.id);
        return (value.valueOptionIds ?? []).map((id) => options?.get(id) ?? "Unknown").join(", ") || "—";
      }
      case "user":
        return (value.valueUserIds ?? []).map((id) => this.memberById().get(id)?.displayName ?? "Unknown").join(", ") || "—";
    }
  }

  /** The row a bulk selection is anchored on is read-only, so `event` is optional only for the internal
   *  Enter/Tab advance below — every template call passes it. */
  beginEdit(card: AnyCard, col: string, value: string, event?: MouseEvent) {
    if (event && this.consumedBySelection(card, event)) return;
    if (!this.canEditCard(card) || this.rowIsLocked(card.id)) return;
    void this.commitEdit();
    this.closePickers();
    this.editingCell.set({ cardId: card.id, col });
    this.editDraft.set(value);
  }

  isEditing(cardId: string, col: string): boolean {
    const cell = this.editingCell();
    return cell?.cardId === cardId && cell.col === col;
  }

  async commitEdit() {
    const cell = this.editingCell();
    if (!cell) return;
    const draft = this.editDraft();
    this.editingCell.set(null);
    const card = this.rows().find((item) => item.id === cell.cardId);
    if (!card) return;
    if (cell.col === TITLE_COLUMN_ID) {
      const title = draft.trim();
      if (!title || title === card.title) return;
      const updated = await this.api.patch<AnyCard>(`/cards/${card.id}`, { title });
      this.cardStore.updateCard(updated);
      return;
    }
    const field = this.customFieldForColumn(cell.col);
    if (!field) return;
    if (field.type === "url") await this.saveUrlField(card, field, draft);
    else await this.saveTextField(card, field, draft);
  }

  cancelEdit() {
    this.editingCell.set(null);
    this.editDraft.set("");
  }

  onEditKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.cancelEdit();
      return;
    }
    if (event.key !== "Enter" && event.key !== "Tab") return;
    event.preventDefault();
    const current = this.editingCell();
    void this.commitEdit().then(() => {
      if (!current) return;
      const columns = [TITLE_COLUMN_ID, ...this.visibleColumns()];
      const rowIndex = this.rows().findIndex((card) => card.id === current.cardId);
      const colIndex = columns.indexOf(current.col);
      const nextRowIndex = event.key === "Enter" ? rowIndex + 1 : rowIndex + (colIndex === columns.length - 1 ? 1 : 0);
      const nextColIndex = event.key === "Enter" ? colIndex : (colIndex + 1) % columns.length;
      const card = this.rows()[nextRowIndex];
      const col = columns[nextColIndex];
      if (!card || !col || (col !== "title" && !["text", "number", "url"].includes(this.customFieldForColumn(col)?.type ?? ""))) return;
      const value = col === "title" ? card.title : this.textValue(card, this.customFieldForColumn(col)!);
      this.beginEdit(card, col, value);
    });
  }

  openCellPicker(card: AnyCard, col: string, event: MouseEvent) {
    if (this.consumedBySelection(card, event)) return;
    event.stopPropagation();
    if (!this.canEditCard(card)) return;
    // Editors are mounted beside their cell trigger so the anchored directive can follow tv-scroll;
    // cursor-point anchors would remain stranded when the sheet scrolls.
    void this.commitEdit();
    const current = this.openPicker();
    this.openPicker.set(current?.cardId === card.id && current.col === col ? null : { cardId: card.id, col });
  }

  openLabelsCellPicker(card: AnyCard, col: string, event: MouseEvent) {
    // The cell remains the edit trigger, so k-card-labels is deliberately presentational here (a
    // focusable chip inside this button would be invalid nested interaction). Table labels always
    // stay expanded, so a press anywhere in the cell has only one meaning: open the label picker.
    this.openCellPicker(card, col, event);
  }

  pickerIsOpen(cardId: string, col: string): boolean {
    const picker = this.openPicker();
    return picker?.cardId === cardId && picker.col === col;
  }

  closePickers() {
    this.openPicker.set(null);
  }

  async setListForCard(card: AnyCard, listId: string) {
    this.closePickers();
    if (card.listId === listId) return;
    // Ordering and grouping visibly jump on latency, so the store applies the move optimistically
    // and then sends it. Custom fields below deliberately wait for their realtime echo because they
    // do not affect row placement.
    await this.cardStore.moveCardToList(card.id, listId);
  }

  async toggleAssignee(card: AnyCard, userId: string) {
    const current = (this.assigneesByCard().get(card.id) ?? []).map((member) => member.userId);
    const next = current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId];
    this.cardStore.setCardAssignees(card.id, next);
    try {
      await this.api.put(`/cards/${card.id}/assignees`, { userIds: next });
    } catch (error) {
      this.cardStore.setCardAssignees(card.id, current);
      throw error;
    }
  }

  async clearAssignees(card: AnyCard) {
    const current = (this.assigneesByCard().get(card.id) ?? []).map((member) => member.userId);
    this.cardStore.setCardAssignees(card.id, []);
    try {
      await this.api.put(`/cards/${card.id}/assignees`, { userIds: [] });
      this.closePickers();
    } catch (error) {
      this.cardStore.setCardAssignees(card.id, current);
      throw error;
    }
  }

  async setDueDate(card: AnyCard, value: string, slot: DueDateSlotSelection = "anyTime") {
    const dueDateLocalDate = value || null;
    const updated = await this.api.patch<AnyCard>(`/cards/${card.id}`, {
      dueDateLocalDate,
      dueDateSlot: dueDateLocalDate ? slot : null,
    });
    this.cardStore.updateCard(updated);
    this.closePickers();
  }

  async toggleLabel(card: AnyCard, labelId: string) {
    const current = (this.labelsByCard().get(card.id) ?? []).map((label) => label.id);
    const next = current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId];
    this.cardStore.setCardLabels(card.id, next);
    try {
      await this.api.put(`/cards/${card.id}/labels`, { labelIds: next });
    } catch (error) {
      this.cardStore.setCardLabels(card.id, current);
      throw error;
    }
  }

  async setCheckboxField(card: AnyCard, field: AnyCustomField, event: MouseEvent) {
    if (this.consumedBySelection(card, event)) return;
    if (!this.canEditCard(card)) return;
    const checked = !(this.valueFor(card.id, field.id)?.valueCheckbox ?? false);
    await this.api.put(`/cards/${card.id}/custom-fields/${field.id}`, { valueCheckbox: checked });
  }

  async setDateField(card: AnyCard, field: AnyCustomField, value: string) {
    this.closePickers();
    if (!value) await this.api.delete(`/cards/${card.id}/custom-fields/${field.id}`);
    else await this.api.put(`/cards/${card.id}/custom-fields/${field.id}`, { valueDate: value });
  }

  async toggleSelectOption(card: AnyCard, field: AnyCustomField, optionId: string) {
    const current = this.valueFor(card.id, field.id)?.valueOptionIds ?? [];
    const allowMultiple = field.allowMultiple;
    const next = allowMultiple
      ? current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId]
      : current.includes(optionId) ? [] : [optionId];
    await this.writeIds(card, field, "valueOptionIds", next);
    if (!allowMultiple) this.closePickers();
  }

  async toggleUserValue(card: AnyCard, field: AnyCustomField, userId: string) {
    const current = this.valueFor(card.id, field.id)?.valueUserIds ?? [];
    const allowMultiple = field.allowMultiple;
    const next = allowMultiple
      ? current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]
      : current.includes(userId) ? [] : [userId];
    await this.writeIds(card, field, "valueUserIds", next);
    if (!allowMultiple) this.closePickers();
  }

  async clearCustomField(card: AnyCard, field: AnyCustomField) {
    this.closePickers();
    await this.api.delete(`/cards/${card.id}/custom-fields/${field.id}`);
  }

  optionsForField(field: AnyCustomField): WireCustomFieldOption[] {
    return "options" in field ? field.options : [];
  }

  /**
   * option id → label, built once per field instead of once per select cell.
   *
   * `displayValue` is bound at six template sites, so this Map was being rebuilt for every select
   * cell, on every row, on every change-detection pass — while the fields it derives from change
   * only when the workspace's custom fields do.
   */
  private readonly optionLabelsByField = computed(() => {
    const byField = new Map<string, Map<string, string>>();
    for (const field of this.customFields()) {
      if (!("options" in field)) continue;
      byField.set(field.id, new Map(field.options.map((option) => [option.id, option.label])));
    }
    return byField;
  });

  optionIdsFor(card: AnyCard, fieldId: string): string[] {
    return this.valueFor(card.id, fieldId)?.valueOptionIds ?? [];
  }

  userIdsFor(card: AnyCard, fieldId: string): string[] {
    return this.valueFor(card.id, fieldId)?.valueUserIds ?? [];
  }

  labelsForCard(cardId: string): AnyLabel[] {
    return this.labelsByCard().get(cardId) ?? [];
  }

  assigneesForCard(cardId: string): AnyMember[] {
    return this.assigneesByCard().get(cardId) ?? [];
  }

  assigneeIdsForCard(cardId: string): string[] {
    return this.assigneesForCard(cardId).map((member) => member.userId);
  }

  labelIdsForCard(cardId: string): string[] {
    return this.labelsForCard(cardId).map((label) => label.id);
  }

  listName(card: AnyCard): string {
    return this.listById().get(card.listId)?.name ?? "Unknown list";
  }

  listColor(card: AnyCard): string | null {
    return this.listById().get(card.listId)?.color ?? null;
  }

  // Lists may set an icon, a colour, or neither. Falling back to a generic icon keeps the status
  // column legible on workspaces that never assigned colours, where a colour-only cue is blank.
  listIcon(card: AnyCard): string {
    return this.listById().get(card.listId)?.icon || "list-details";
  }

  isNumericColumn(id: string): boolean {
    return this.customFieldForColumn(id)?.type === "number";
  }

  /**
   * Due-date presentation, memoized per card for as long as the card set is unchanged.
   *
   * Both of these are bound inside `@for`, so each is called once per rendered row on every
   * change-detection pass, and `isOverdue` is Intl-heavy. `k-card` solved the same problem with
   * `computed()` because it owns a single card; rows here are plain template bindings, so the memo
   * has to be a Map keyed off the cards signal — the shape the labelsByCard/assigneesByCard inputs
   * already use. Time-relative staleness is the same tradeoff k-card already makes: the flag
   * refreshes when the card set changes, not as the clock passes a due time.
   */
  private readonly dueDatePresentationByCard = computed(() => {
    const presentation = new Map<string, { text: string; overdue: boolean }>();
    const now = new Date();
    for (const card of this.cards()) {
      presentation.set(card.id, {
        text: formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone),
        overdue: !card.completedAt && isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone, now),
      });
    }
    return presentation;
  });

  formattedDue(card: AnyCard): string {
    const memoized = this.dueDatePresentationByCard().get(card.id);
    // A row can be rendered from a source outside `cards()` (an optimistic insert mid-flight), so
    // fall back rather than blank the cell.
    return memoized?.text ?? formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  isCardOverdue(card: AnyCard): boolean {
    const memoized = this.dueDatePresentationByCard().get(card.id);
    if (memoized) return memoized.overdue;
    return !card.completedAt && isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  onTitleClick(card: AnyCard, event: MouseEvent) {
    if (this.consumedBySelection(card, event)) return;
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey) {
      openCardDetailInNewTab(card.organisationKey, card.key);
      return;
    }
    this.beginEdit(card, TITLE_COLUMN_ID, card.title);
  }

  onTitleAuxClick(card: AnyCard, event: MouseEvent) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    openCardDetailInNewTab(card.organisationKey, card.key);
  }

  onRowContextMenu(card: AnyCard, event: MouseEvent) {
    if (!this.canEdit()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(ROW_INTERACTION_STOP_SELECTOR)) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.bulkSelectedCardIds().has(card.id)) {
      this.closeActionsMenu();
      this.bulkMenuRequested.emit({ cardId: card.id, point: { x: event.clientX, y: event.clientY } });
      return;
    }
    this.actionsMenuPoint.set({ x: event.clientX, y: event.clientY });
    this.menuCoordinator.openCardMenu(card.id);
  }

  toggleActionsMenu(card: AnyCard, event: MouseEvent) {
    event.stopPropagation();
    if (this.bulkSelectedCardIds().has(card.id)) {
      const target = event.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      this.bulkMenuRequested.emit({ cardId: card.id, point: { x: rect.right, y: rect.bottom } });
      return;
    }
    this.actionsMenuPoint.set(null);
    if (this.activeActionsCardId() === card.id) this.closeActionsMenu();
    else this.menuCoordinator.openCardMenu(card.id);
  }

  closeActionsMenu() {
    this.actionsMenuPoint.set(null);
    this.menuCoordinator.closeCardMenu();
  }

  toggleRowSelection(card: AnyCard, event: MouseEvent) {
    event.stopPropagation();
    // Controlled the same way as the header checkbox — see `toggleSelectAll`. The parent declines the
    // change outright on a read-only or archived board, which would otherwise leave the box ticked.
    event.preventDefault();
    this.bulkSelectionRequested.emit({
      cardId: card.id,
      orderedCardIds: this.rows().map((row) => row.id),
      shiftKey: event.shiftKey,
      additive: true,
    });
  }

  /** Cells of a bulk-selected row are read-only. See `consumedBySelection`. */
  rowIsLocked(cardId: string): boolean {
    return this.bulkSelectedCardIds().has(cardId);
  }

  // The header checkbox reports on the filtered set, not the board: what it can select is what is on
  // screen, so "all" has to mean the same thing. A selection made before a filter narrowed the view
  // can therefore leave it indeterminate with every visible row ticked, which is honest — clearing it
  // clears those off-screen rows too.
  readonly allRowsSelected = computed(() => {
    const rows = this.rows();
    if (!rows.length) return false;
    const selected = this.bulkSelectedCardIds();
    return selected.size >= rows.length && rows.every((row) => selected.has(row.id));
  });

  readonly someRowsSelected = computed(() =>
    !this.allRowsSelected() && this.bulkSelectedCardIds().size > 0,
  );

  /**
   * One pass per group, not one per binding.
   *
   * The header checkbox reads its group's state four times (checked, indeterminate, aria-label,
   * tooltip) and `groupSomeRowsSelected` used to re-run the "all" scan first, so a group of N cards
   * cost up to 8N membership probes per change-detection pass. A single tri-state per group makes it
   * one pass, shared by every binding.
   */
  private readonly groupSelectionStateByKey = computed(() => {
    const selected = this.bulkSelectedCardIds();
    const states = new Map<string, "none" | "some" | "all">();
    for (const group of this.runGroups()) {
      if (group.cardIds.length === 0) {
        states.set(group.key, "none");
        continue;
      }
      let selectedCount = 0;
      for (const cardId of group.cardIds) if (selected.has(cardId)) selectedCount += 1;
      states.set(group.key, selectedCount === 0 ? "none" : selectedCount === group.cardIds.length ? "all" : "some");
    }
    return states;
  });

  groupAllRowsSelected(group: TableRunGroup): boolean {
    return this.groupSelectionStateByKey().get(group.key) === "all";
  }

  groupSomeRowsSelected(group: TableRunGroup): boolean {
    return this.groupSelectionStateByKey().get(group.key) === "some";
  }

  /** Select or remove a whole group without disturbing cards selected in other groups. */
  toggleGroupSelection(group: TableRunGroup, event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    if (!group.cardIds.length) return;
    this.bulkListSelectionRequested.emit({
      orderedCardIds: group.cardIds,
      mode: this.groupAllRowsSelected(group) ? "remove" : "add",
    });
  }

  // Touch needs a long press before a drag starts so a swipe still scrolls the sheet; mouse is
  // immediate. This is the same constant the kanban lanes use.
  protected readonly dragStartDelay = CARD_DRAG_START_DELAY;

  /** True once the group blocks carry their own add rows, which makes the single bottom one redundant. */
  readonly hasRunAddRows = computed(() => this.canCreate() && this.canEdit() && this.runGroups().some((group) => group.listId));

  /**
   * The groups as rendered: each one a bound block with its slice of cards and its own subtotals.
   *
   * Each block is its own drop list, all connected by a `cdkDropListGroup`. That is what makes a
   * cross-group drag unambiguous — the target list comes from the container the row was released over
   * rather than from guessing which side of an invisible seam the pointer was on — and it lets a group
   * carry a real header and a real add row instead of drawing both inside the first row's padding.
   * Columns still line up with the single shared header because every row keeps its own
   * `--tv-grid-template` grid; the blocks only add vertical structure.
   *
   * The incremental render cap is one budget spent top-to-bottom over the groups rather than a slice
   * per group, so a board past the cap renders its first groups in full instead of the first N rows
   * of every group at once. Slices are always prefixes, which is what keeps CDK's drop indices and
   * the gutter row numbers lined up with the underlying group.
   */
  readonly runGroups = computed<TableRunGroup[]>(() => {
    const grouped = this.effectiveGroupBy() !== "none";
    const collapsedKeys = this.collapsedGroups();
    let budget = this.rowRenderCap();
    return this.groups().map((group) => {
      const total = group.cards.length;
      // A collapsed group draws no rows and spends none of the budget, so collapsing one is what
      // brings the groups below it into view rather than merely hiding what was already rendered.
      const collapsed = collapsedKeys.has(group.key);
      const cards = collapsed ? EMPTY_CARDS : budget >= total ? group.cards : group.cards.slice(0, Math.max(0, budget));
      budget -= cards.length;
      return {
        collapsed,
        key: group.key,
        // Only a list group is a legal drop target and gets an add row; see TableRunGroup.listId.
        listId: group.meta.listId ?? null,
        name: group.label,
        icon: group.icon,
        color: group.color,
        avatarUrl: group.avatarUrl ?? null,
        cards,
        cardIds: group.cards.map((card) => card.id),
        total,
        // Subtotals are of the whole group, not the rendered slice: a total that grew as you scrolled
        // would be worse than no total at all. Suppressed when grouping is off, where the single
        // block's subtotal would just restate the sticky footer directly beneath it.
        summaries: grouped ? this.summaryRowsFor(group.cards, group.key) : [],
      };
    });
  });

  /**
   * Whether any card is still held back by the render cap.
   *
   * Counted over the grouped cards rather than `rows()` because a multi-value dimension draws a card
   * once per bucket, and it is drawn rows the cap is spent on. Collapsed groups are excluded from
   * both sides: their cards are withheld on purpose, and counting them would leave this permanently
   * true and let the scroll handler raise the cap forever without a row ever appearing.
   */
  readonly hasHiddenRows = computed(() => {
    let rendered = 0;
    let total = 0;
    for (const group of this.runGroups()) {
      if (group.collapsed) continue;
      rendered += group.cards.length;
      total += group.total;
    }
    return rendered < total;
  });

  // ── Read-only columns ─────────────────────────────────────────────────────
  // Checklist counts ride along on the card, so no extra input or request is needed for the column.
  checklistSummary(card: AnyCard): { done: number; total: number; progress: number } {
    const total = "checklistTotalCount" in card ? card.checklistTotalCount : 0;
    const done = "checklistDoneCount" in card ? card.checklistDoneCount : 0;
    return { done, total, progress: total === 0 ? 0 : Math.round((done / total) * 100) };
  }

  relativeTime(value: Date | string | null | undefined): string {
    return formatRelativeTime(value);
  }

  /**
   * "Ben, Priya, Nina" for a shared card. A stack of anonymous circles is the least readable cell in
   * the grid; first names fit where full names would not and are unambiguous within one board. A
   * card with one assignee has the room for their full name, so it keeps it.
   */
  assigneeNames(cardId: string): string {
    const assignees = this.assigneesForCard(cardId);
    if (assignees.length === 1) return assignees[0]!.displayName;
    return assignees.map((member) => member.displayName.split(" ")[0]).join(", ");
  }

  /** Columns the table renders but cannot edit in place — they have no cell trigger and no hover. */
  isReadOnlyColumn(id: string): boolean {
    return id === "checklist" || id === "created" || id === "updated";
  }

  /**
   * Ordinary tables reorder only when grouped by list under manual sort: position is the only card
   * order the user owns, and list is the only derived bucket a card can honestly be dropped into.
   * A hosted relation is the other legal case; the host explicitly supplies both its order and the
   * rows the viewer may reorder, and receives a relation event instead of a card-position write.
   */
  readonly dragEnabled = computed(() =>
    this.canEdit() && (
      this.hostCardGroups() !== null
        ? [...this.hostReorderableCardIdsByGroup().values()].some((ids) => ids.size > 0)
        : this.effectiveGroupBy() === "list" && this.effectiveSortBy() === "position"
    ),
  );

  groupDragEnabled(group: TableRunGroup): boolean {
    if (this.hostCardGroups() === null) return this.dragEnabled();
    return this.canEdit() && (this.hostReorderableCardIdsByGroup().get(group.key)?.size ?? 0) > 0;
  }

  rowDragEnabled(group: TableRunGroup, card: AnyCard): boolean {
    if (this.hostCardGroups() === null) return this.dragEnabled();
    return this.groupDragEnabled(group)
      && (this.hostReorderableCardIdsByGroup().get(group.key)?.has(card.id) ?? false);
  }

  /** Hosted relation rows may sort inside their source group, but never transfer across groups. */
  readonly canEnterRun = (drag: CdkDrag, drop: CdkDropList): boolean =>
    this.hostCardGroups() === null || drag.dropContainer === drop;

  /** Why the drag handles are absent, when the board is otherwise editable. */
  readonly dragDisabledHint = computed(() => {
    // A host-owned relation supplies its own grouping and sequence; the usual status/manual-sort
    // advice would describe controls this embedded table deliberately does not offer.
    if (this.hostCardGroups() !== null) return null;
    if (this.dragEnabled() || !this.canEdit()) return null;
    if (this.effectiveGroupBy() !== "list") return "Drag to reorder works when grouped by status";
    return "Drag to reorder works with manual sort";
  });

  /**
   * Drop a row into its new place, and into a new list if it was released over another run's block.
   *
   * Crossing into another block changes the card's status. That is the same thing dragging a card
   * between kanban lanes does, and what Notion does in a grouped table — refusing cross-block drops
   * would make the most natural gesture in the view silently do nothing. The target list now comes
   * from the container the row was dropped into, so there is no seam to adjudicate.
   *
   * Indices are relative to the target block, and `cards` there excludes the dragged row on a
   * cross-block drop and includes it on a reorder, so it is filtered either way before the
   * neighbours are read off it.
   */
  onRowDrop(event: CdkDragDrop<TableRunGroup>) {
    if (!this.dragEnabled()) return;
    const card = event.item.data as AnyCard | undefined;
    if (!card) return;
    if (event.previousContainer === event.container && event.previousIndex === event.currentIndex) return;
    if (this.hostCardGroups() !== null) {
      // Hosted groups describe relations rather than mutable card fields. A cross-group gesture has
      // no honest card write, and the enter predicate normally prevents it before this guard.
      if (event.previousContainer !== event.container) return;
      const group = event.container.data;
      if (!this.rowDragEnabled(group, card)) return;
      this.hostCardReordered.emit({
        groupKey: group.key,
        cardId: card.id,
        previousIndex: event.previousIndex,
        currentIndex: event.currentIndex,
      });
      return;
    }
    const target = event.container.data;
    const toListId = target.listId ?? card.listId;
    const others = target.cards.filter((row) => row.id !== card.id);
    const following = others[event.currentIndex] ?? null;
    const preceding = others[event.currentIndex - 1] ?? null;
    this.cardDropped.emit({
      cardId: card.id,
      toListId,
      // Exactly one anchor: a following card means "insert before it", and
      // its absence means "end of that list", which `afterCardId` expresses (null = list was empty).
      ...(following ? { beforeCardId: following.id } : { afterCardId: preceding?.id ?? null }),
    });
  }

  toggleHostAdd(groupKey: string, event: MouseEvent): void {
    event.stopPropagation();
    this.hostAddOpenGroupKey.update((open) => open === groupKey ? null : groupKey);
  }

  onHostAddPicked(groupKey: string, cardId: string): void {
    this.hostAddOpenGroupKey.set(null);
    this.hostCardAdded.emit({ groupKey, cardId });
  }

  /** Select every filtered row, or clear when anything is already selected. */
  toggleSelectAll(event: MouseEvent) {
    event.stopPropagation();
    // Both checkboxes are fully controlled by `bulkSelectedCardIds`, so the browser's own toggle has
    // to be cancelled. Without this, a click that leaves the bound value unchanged — clearing from an
    // indeterminate state, or a parent that declines the change — leaves the DOM ticked while the
    // signal says otherwise, and Angular has no reason to rewrite it.
    event.preventDefault();
    if (this.allRowsSelected() || this.someRowsSelected()) {
      this.bulkSelectionCleared.emit();
      return;
    }
    const rows = this.rows();
    if (!rows.length) return;
    // rows(), not renderedRows(): "select all" must not silently stop at the incremental render cap.
    // Replace mode makes the set exactly the filtered rows rather than a union with a stale one.
    this.bulkListSelectionRequested.emit({ orderedCardIds: rows.map((row) => row.id), mode: "replace" });
  }

  /** Catch-all for the parts of a row that are not a cell trigger: the actions column and the filler
   *  track past the last column. Clicks on a trigger reach `consumedBySelection` directly and stop
   *  there, so this never double-handles them. */
  onRowClick(card: AnyCard, event: MouseEvent) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest(ROW_INTERACTION_STOP_SELECTOR)) return;
    this.consumedBySelection(card, event);
  }

  /**
   * Row-level click gestures that outrank whatever cell was clicked.
   *
   * Shift extends the bulk selection from its anchor, so a range can be swept up anywhere in a row
   * rather than only on the 15px checkbox that appears on hover. Cmd/Ctrl is deliberately not a
   * selection modifier here: on the title it already means "open in a new tab", and one modifier
   * meaning two things depending on which column you are over is worse than not having it.
   *
   * A plain click inside an existing selection clears it instead of editing. Editing one cell of a
   * highlighted range reads as "apply to all of these" and does the opposite, so the ambiguity is
   * removed rather than resolved — bulk changes stay on the right-click menu, which already applies
   * to the whole selection.
   *
   * @returns true when the click has been consumed and the cell must not act on it.
   */
  private consumedBySelection(card: AnyCard, event: MouseEvent): boolean {
    if (event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      this.closePickers();
      this.closeActionsMenu();
      // A shift-click's browser default is to extend the text selection, which would leave rows
      // highlighted as text underneath the row selection we are making.
      window.getSelection()?.removeAllRanges();
      // rows(), not renderedRows(): a range has to be able to span past the incremental render cap.
      this.bulkSelectionRequested.emit({
        cardId: card.id,
        orderedCardIds: this.rows().map((row) => row.id),
        shiftKey: true,
        additive: true,
      });
      return true;
    }
    if (!this.rowIsLocked(card.id)) return false;
    event.preventDefault();
    event.stopPropagation();
    this.bulkSelectionCleared.emit();
    return true;
  }

  // ── Add a task to one run ─────────────────────────────────────────────────
  /**
   * Adding to any status but one meant leaving the table, so each run block ends in its own add row,
   * which appends to that list — the new card lands exactly where the row you clicked was sitting.
   * The bottom row shown when no run has one (ungrouped, or grouped by something other than status)
   * drives the same composer against the view's single target list, so there is one control to learn.
   *
   * Dismissed by an outside pointerdown rather than by blur: the create re-renders the block,
   * tearing this input down and rebuilding it, and a blur handler would fire during that teardown.
   * `submitRunTask` closes it explicitly instead.
   */
  startRunCompose(listId: string, event: MouseEvent) {
    event.stopPropagation();
    if (this.hostOwnsComposer()) {
      this.cancelRunCompose();
      this.composeRequested.emit({ listId });
      return;
    }
    this.runTaskTitle.set("");
    if (this.runComposeListId() === listId) {
      this.cancelRunCompose();
      return;
    }
    this.runComposeListId.set(listId);
    // Safe to arm here: this runs on `click`, which is after the pointerdown that opened the composer.
    this.watchComposeOutsideClicks(true);
  }

  cancelRunCompose() {
    this.runComposeListId.set(null);
    this.runTaskTitle.set("");
    this.watchComposeOutsideClicks(false);
  }

  /**
   * Clicking anywhere outside the composer closes it, and discards whatever was typed. Committing on
   * the way out would turn a misplaced click into a card nobody meant to create, which costs more to
   * undo than retyping a title.
   */
  private readonly onComposeOutsidePointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null;
    // Matched by class, not by a captured element: the composer is torn down and rebuilt whenever
    // its run re-renders, so any reference we held could be to a detached node.
    if (target?.closest(".tv-run-compose")) return;
    this.cancelRunCompose();
  };

  private watchComposeOutsideClicks(active: boolean) {
    window.removeEventListener("pointerdown", this.onComposeOutsidePointerDown, true);
    // Capture phase, so a handler that stops propagation on its own row cannot leave the composer open.
    if (active) window.addEventListener("pointerdown", this.onComposeOutsidePointerDown, true);
  }

  async submitRunTask(listId: string, event: Event) {
    event.preventDefault();
    const title = this.runTaskTitle().trim();
    if (!title || this.creatingTask()) return;
    this.creatingTask.set(true);
    try {
      const clientToken = crypto.randomUUID();
      const card = await this.api.createCard<AnyCard>(`/boards/${this.boardId()}/lists/${listId}/cards`, {
        title,
        clientToken,
      });
      this.notifications.watchCreatedCardLocally(card.id);
      this.cardCreated.emit(card);
      // Closes on success: the new card appears exactly where the composer was, so leaving an empty
      // input sitting on top of it would hide the thing you just made. Press + again to add another.
      this.cancelRunCompose();
    } finally {
      this.creatingTask.set(false);
    }
  }

  exportCsv() {
    this.exportOpen.set(false);
    const columns = [TITLE_COLUMN_ID, ...this.visibleColumns()];
    const rows = [
      columns.map((column) => this.csvCell(this.columnLabel(column))),
      ...this.exportRows().map((card) => columns.map((column) => this.csvCell(this.exportCell(card, column)))),
    ];
    downloadTextFile(rows.map((row) => row.join(",")).join("\n"), "text/csv;charset=utf-8", this.exportFileName("csv"));
  }

  /**
   * The sheet as structured data: the same payload the workbook is built from, before any of it is
   * laid out for Excel. That is the point of offering it — everything the view knows, in the shape a
   * script can read, rather than a grid a script has to parse back out of.
   */
  exportJson() {
    this.exportOpen.set(false);
    const payload = this.buildExportPayload();
    downloadTextFile(JSON.stringify(payload, null, 2), "application/json", this.exportFileName("json"));
  }

  /**
   * The full workbook: a grouped Cards sheet, a tidy Summary sheet in the long form Excel
   * PivotTables and SUMIFS expect, and a Report sheet whose totals are live formulas against Summary
   * rather than baked numbers — laid out by whatever grouping, breakdown and columns the view was
   * showing.
   *
   * Loaded on demand. write-excel-file is ~100kB and most sessions never export.
   */
  async exportExcel() {
    this.exportOpen.set(false);
    const payload = this.buildExportPayload();
    const { default: writeXlsxFile } = await import("write-excel-file/browser");
    const sheets = buildWorkbookExport(payload).sheets;
    await writeXlsxFile(
      sheets.map((sheet) => ({
        data: styledSheetData(sheet),
        sheet: sheet.name,
        columns: sheet.columnWidths.map((width) => ({ width })),
        // Every sheet puts its title block above a header row at row 4.
        stickyRowsCount: 4,
      })),
    ).toFile(this.exportFileName("xlsx"));
  }

  setAggregate(fieldId: string, metric: AggregateMetric | null) {
    const next = { ...this.aggregateConfig() };
    if (metric) next[fieldId] = [metric];
    else delete next[fieldId];
    this.aggregateConfig.set(next);
    if (!this.emitHostedPresentation()) writeAggregateConfig(this.prefScope(), next);
    this.aggregateOpenFieldId.set(null);
  }

  aggregateFor(fieldId: string): AggregateMetric | null {
    return this.aggregateConfig()[fieldId]?.[0] ?? null;
  }

  /** The sticky footer's grand total for one numeric column, over the distinct cards in the view. */
  aggregateValue(fieldId: string): string {
    const metric = this.aggregateFor(fieldId);
    if (!metric) return "";
    const value = this.metricOver(this.rows(), fieldId, metric);
    return value === null ? "—" : formatAggregate(value);
  }

  // ── Summaries ─────────────────────────────────────────────────────────────
  /** Visible numeric columns that are actually summarising something. */
  readonly summarisedColumns = computed(() =>
    this.visibleColumns().filter((id) => {
      const field = this.customFieldForColumn(id);
      return field?.type === "number" && !!this.aggregateFor(field.id);
    }),
  );

  readonly hasSummaries = computed(() => this.summarisedColumns().length > 0);

  /** Breakdown is meaningless until at least one visible number column is being summarised. */
  readonly availableSplitByOptions = computed(() => this.hasSummaries() ? this.splitByOptions() : []);

  readonly splitActive = computed(() => this.aggregateSplitBy() !== "none");

  /**
   * The whole sheet broken down by the split dimension, rendered as rows above the sticky footer.
   *
   * Only the buckets: the footer directly beneath is already the grand total, so repeating it here
   * would print the same number twice in the same column an inch apart.
   */
  readonly grandSummaries = computed<TableSummaryRow[]>(() =>
    this.splitActive() ? this.summaryRowsFor(this.rows(), "grand", false) : [],
  );

  /**
   * A summary block: one row per breakdown bucket, then the total for the whole set.
   *
   * Buckets come from the same `groupCards` the sheet's own grouping uses, so a bucket here is
   * labelled and ordered exactly as it would be if you grouped by that dimension instead — the two
   * controls stay legible against each other. A bucket holding no value in any summarised column is
   * dropped rather than printed as a row of dashes.
   */
  private summaryRowsFor(cards: AnyCard[], keyPrefix: string, withTotal = true): TableSummaryRow[] {
    const columns = this.summarisedColumns();
    if (!columns.length || !cards.length) return [];
    const rows: TableSummaryRow[] = [];
    if (this.splitActive()) {
      // "position" because bucket order comes from the dimension itself; the sort inside a bucket
      // cannot change a sum.
      for (const bucket of groupCards(cards, this.aggregateSplitBy(), "position", this.groupingContext())) {
        const values = this.summaryValues(bucket.cards, columns);
        if (Object.keys(values).length) rows.push({ key: `${keyPrefix}:${bucket.key}`, label: bucket.label, values });
      }
      // A breakdown that produced one bucket has already printed the total, under a more specific
      // name. Sum or average, one bucket over the same cards is the same number either way.
      if (rows.length === 1) return rows;
    }
    if (withTotal) {
      const values = this.summaryValues(cards, columns);
      if (Object.keys(values).length) rows.push({ key: `${keyPrefix}:total`, label: "Total", values });
    }
    return rows;
  }

  private summaryValues(cards: AnyCard[], columns: string[]): Record<string, string> {
    const values: Record<string, string> = {};
    for (const column of columns) {
      const field = this.customFieldForColumn(column);
      const metric = field && this.aggregateFor(field.id);
      if (!field || !metric) continue;
      const value = this.metricOver(cards, field.id, metric);
      if (value !== null) values[column] = formatAggregate(value);
    }
    return values;
  }

  /** Sum or average of a numeric field over the given cards, or null when none hold a value. */
  private metricOver(cards: AnyCard[], fieldId: string, metric: AggregateMetric): number | null {
    let sum = 0;
    let count = 0;
    for (const card of cards) {
      const raw = this.valueFor(card.id, fieldId)?.valueNumber;
      const value = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
      if (!Number.isFinite(value)) continue;
      sum += value;
      count += 1;
    }
    if (!count) return null;
    return metric === "avg" ? sum / count : sum;
  }

  ngOnDestroy() {
    this.endColumnResize();
    this.endBackgroundPan();
    this.closeActionsMenu();
    this.watchComposeOutsideClicks(false);
    this.scrollportObserver?.disconnect();
    this.scrollportObserver = null;
    this.contentObserver?.disconnect();
    this.contentObserver = null;
    if (this.contentMeasurementFrame !== null) cancelAnimationFrame(this.contentMeasurementFrame);
    this.contentMeasurementFrame = null;
  }

  private endBackgroundPan() {
    if (!this.backgroundPan) return;
    this.backgroundPan.el.classList.remove("is-panning");
    this.backgroundPan = null;
    window.removeEventListener("mousemove", this.onPanMove);
    window.removeEventListener("mouseup", this.onPanEnd);
  }

  private widthForColumn(id: string): number {
    const defaults: Record<string, number> = {
      // The title cell also carries the card key as an inline prefix, so it needs more room than the
      // title text alone would suggest before it starts ellipsing.
      title: 340,
      // Wide enough for the icon plus a two-word list name ("Awaiting Feedback", "Planning /
      // Review"): status is a scanning column and an ellipsed status is worth little.
      status: 176,
      // Fits an avatar plus a full name, which is what a single-assignee cell now renders.
      assignees: 170,
      due: 150,
      priority: 112,
      labels: 200,
      checklist: 110,
      created: 120,
      updated: 120,
    };
    return this.clampColumn(id, this.columnWidths()[id] ?? defaults[id] ?? 180);
  }

  private exportCell(card: AnyCard, column: string): string {
    switch (column) {
      case TITLE_COLUMN_ID: return card.title;
      case "priority": return this.priorityOrderForFlatExport(card.id);
      case "status": return this.listName(card);
      case "board": return this.boardFor(card)?.name ?? "";
      case "assignees": return this.assigneesForCard(card.id).map((member) => member.displayName).join(", ");
      case "due": return this.formattedDue(card);
      case "labels": return this.labelsForCard(card.id).map((label) => label.name).join(", ");
      case "checklist": {
        const checklist = this.checklistSummary(card);
        return checklist.total ? `${checklist.done}/${checklist.total}` : "";
      }
      // Absolute rather than the relative "3d ago" the cell renders, which is meaningless the moment
      // the file is saved.
      case "created": return isoTimestamp(card.createdAt);
      case "updated": return isoTimestamp(card.updatedAt);
      default: {
        const field = this.customFieldForColumn(column);
        if (!field) return "";
        const value = this.displayValue(card, field);
        return value === "—" ? "" : value;
      }
    }
  }

  /** Everything the exports share: the view's grouping, breakdown, columns, sort and export scope. */
  private buildExportPayload() {
    const selected = this.bulkSelectedCardIds();
    const groups = selected.size
      ? this.groups()
        .map((group) => ({ ...group, cards: group.cards.filter((card) => selected.has(card.id)) }))
        .filter((group) => group.cards.length > 0)
      : this.groups();
    return buildBoardExportPayload({
      board: { id: this.boardId(), name: this.boardName() },
      exportedAt: new Date().toISOString(),
      groupBy: this.groupByLabel(),
      sortBy: this.sortByLabel(),
      columns: this.visibleColumns().map((id) => ({ id, label: this.columnLabel(id) })),
      aggregateConfig: this.aggregateConfig(),
      aggregateSplitBy: this.aggregateSplitBy(),
      aggregateSplitLabel: this.splitByLabel(),
      groups,
      lists: this.lists(),
      cardLabels: this.cardLabels(),
      labelsByCard: this.labelsByCard(),
      assigneesByCard: this.assigneesByCard(),
      customFields: this.customFields(),
      members: this.members(),
      customFieldValuesByCardAndField: this.customFieldValuesByCardAndField(),
      // Neither is a table column, so nothing in the export reads them.
      commentCounts: new Map(),
      attachmentCountByCard: new Map(),
      // Null on a board, where every card belongs to the one board named in the metadata. A
      // cross-board sheet resolves each row's own source instead, so the Board column exports the
      // board the card is actually in rather than the sheet's name repeated down the sheet.
      boardSummariesById: this.crossBoard()
        ? new Map(this.sourceBoards().map((board) => [board.id, { id: board.id, name: board.name }]))
        : null,
      priorityRanksByCard: this.priorityRanksByCard(),
      priorityRanksByGroup: this.priorityRanksByGroup(),
      currentUserId: this.currentUserId(),
      cardLinkBaseUrl: window.location.origin,
    });
  }

  private exportFileName(extension: "csv" | "xlsx" | "json"): string {
    return `${sanitizeExportFileName(this.boardName())}-table-${timestampForFileName(new Date().toISOString())}.${extension}`;
  }

  private csvCell(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
  }

  /**
   * CSV is flat and has no group column, unlike the structured exports. Preserve a single personal
   * rank directly; if the same card has different ranks in several people's queues, include each
   * distinct order rather than silently choosing one person's value.
   */
  private priorityOrderForFlatExport(cardId: string): string {
    const direct = this.priorityRanksByCard().get(cardId);
    if (direct !== undefined) return String(direct);
    const ranks = new Set<number>();
    for (const byCard of this.priorityRanksByGroup().values()) {
      const rank = byCard.get(cardId);
      if (rank !== undefined) ranks.add(rank);
    }
    return [...ranks].sort((a, b) => a - b).join("; ");
  }

  private clampColumn(id: string, value: number): number {
    return clampWidth(value, id === TITLE_COLUMN_ID ? { min: 180, max: 720 } : { min: 90, max: 520 });
  }

  private endColumnResize() {
    this.resizingColumn?.removeListeners();
    this.resizingColumn = null;
    document.body.classList.remove("is-table-column-resizing");
  }

  private async saveTextField(card: AnyCard, field: AnyCustomField, value: string) {
    const requestKey = `${card.id}:${field.id}`;
    if (value === "") {
      await this.saveCustomFieldOnce(requestKey, "delete", () => this.api.delete(`/cards/${card.id}/custom-fields/${field.id}`));
      return;
    }
    if (field.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      await this.saveCustomFieldOnce(requestKey, `number:${number}`, () =>
        this.api.put(`/cards/${card.id}/custom-fields/${field.id}`, { valueNumber: String(number) }),
      );
      return;
    }
    await this.saveCustomFieldOnce(requestKey, `text:${value}`, () =>
      this.api.put(`/cards/${card.id}/custom-fields/${field.id}`, { valueText: value }),
    );
  }

  private async saveUrlField(card: AnyCard, field: AnyCustomField, value: string) {
    const requestKey = `${card.id}:${field.id}`;
    const trimmed = value.trim();
    if (!trimmed) {
      await this.saveCustomFieldOnce(requestKey, "delete", () => this.api.delete(`/cards/${card.id}/custom-fields/${field.id}`));
      return;
    }
    await this.saveCustomFieldOnce(requestKey, `url:${trimmed}`, () =>
      this.api.put(`/cards/${card.id}/custom-fields/${field.id}`, { valueUrl: trimmed }),
    );
  }

  private async saveCustomFieldOnce(requestKey: string, saveKey: string, save: () => Promise<unknown>) {
    // Enter commits and the same DOM removal can fire blur. Retain the last successful value key so
    // that double-fire produces one request while a rejected request remains retryable.
    if (this.customFieldSaveKeys.get(requestKey) === saveKey) return;
    this.customFieldSaveKeys.set(requestKey, saveKey);
    try {
      await save();
    } catch (error) {
      if (this.customFieldSaveKeys.get(requestKey) === saveKey) this.customFieldSaveKeys.delete(requestKey);
      throw error;
    }
  }

  private async writeIds(
    card: AnyCard,
    field: AnyCustomField,
    key: "valueOptionIds" | "valueUserIds",
    ids: string[],
  ) {
    if (!ids.length) await this.api.delete(`/cards/${card.id}/custom-fields/${field.id}`);
    else await this.api.put(`/cards/${card.id}/custom-fields/${field.id}`, { [key]: ids });
  }
}

/** Absolute local timestamp for CSV, where a relative "3d ago" would rot the moment it is saved. */
function isoTimestamp(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16).replace("T", " ");
}

/** Grouped and capped the same way in the footer, in every subtotal and in every breakdown row, so
 *  a number never reads as a different magnitude depending on which row it is printed in.
 *
 *  The formatter is hoisted because this is called once per aggregate cell per change-detection
 *  pass, and constructing an Intl.NumberFormat is far more expensive than the formatting itself. */
const AGGREGATE_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function formatAggregate(value: number): string {
  return AGGREGATE_FORMAT.format(value);
}
