import type { CdkDragDrop, CdkDragMove, CdkDragStart} from "@angular/cdk/drag-drop";
import { CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup, moveItemInArray } from "@angular/cdk/drag-drop";
import { CdkScrollable } from "@angular/cdk/scrolling";
import type {
  OnDestroy} from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type { Card, CardCustomFieldValue } from "@kanera/shared/schema";
import type { Cell, SheetData } from "write-excel-file/browser";
import { ApiClient } from "../../../core/api/api.client";
import { APP_DOM_EVENTS } from "../../../core/browser/browser-contracts";
import { downloadTextFile } from "../../../core/browser/download";
import { vibrateCardDragEnd, vibrateCardDragStart } from "../../../core/browser/haptics";
import { NotificationsService } from "../../../core/notifications/notifications.service";
import { WorkspaceService } from "../../../core/workspace/workspace.service";
import { AvatarComponent } from "../../../shared/avatar.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { BoardState, committedItemOrderForDrop, laneItemAnchor, laneItemKey, sameItemOrder, separatorBordersVisibleCard, type BoardLaneItem } from "../board-state";
import { SeparatorComponent } from "../separator.component";
import { CARD_DRAG_START_DELAY, cardDragEdgeScrollStep } from "../card-drag-scroll";
import { CardActionsMenuPopover } from "../card-actions-menu.popover";
import { suppressDropCommitTransitions } from "../drop-commit-transition";
import { openCardDetailInNewTab } from "../card-navigation.util";
import { formatDueDate, isDueSoon, isOverdue } from "../due-date.util";
import type { AddCardBoardOption, BulkCardMenuPayload, BulkCardSelectionPayload, CardDropPayload, SeparatorDropPayload, StartAddPayload } from "../list.component";
import { groupCards } from "./group-by.util";
import {
  buildBoardExportPayload,
  buildWorkbookExport,
  sanitizeExportFileName,
  timestampForFileName,
  type BoardExportPayload,
} from "./export.util";
import {
  type AnyCard,
  type AnyCustomField,
  type AnyLabel,
  type AnyList,
  type AnyMember,
  type AnySeparator,
  type AggregateConfig,
  type AggregateMetric,
  BUILTIN_COLUMN_IDS,
  type CardGroup,
  type ColumnVisibility,
  GROUP_BY_OPTIONS,
  type GroupBy,
  SORT_BY_OPTIONS,
  type SortBy,
} from "./list-view.types";
import {
  readAggregateConfig,
  type ColumnWidths,
  readColumnOrder,
  readColumnVisibility,
  readColumnWidths,
  readGroupBy,
  readShowSeparators,
  readSortBy,
  writeAggregateConfig,
  writeColumnOrder,
  writeColumnVisibility,
  writeColumnWidths,
  writeGroupBy,
  writeShowSeparators,
  writeSortBy,
} from "./view-preference";

const TITLE_COLUMN_ID = "title";
const ACTIONS_COLUMN_WIDTH = 44;
const TITLE_MIN_WIDTH = 240;
const TITLE_MAX_WIDTH = 900;
const COLUMN_MIN_WIDTH = 80;
const COLUMN_MAX_WIDTH = 720;

// Large boards (3000+ cards) would otherwise mount a table row per card on open. Render a
// leading budget of rows spread across the expanded groups and grow it as the user scrolls
// toward the bottom. The budget only ever grows, so rows already in the
// DOM (including one mid-drag) are never unmounted, keeping CDK drag indices aligned.
const INITIAL_ROW_CAP = 80;
const ROW_CAP_PAGE = 80;
const GROW_NEAR_BOTTOM_PX = 600;
const COMMITTED_DROP_FALLBACK_MS = 2000;

interface BoardSummary {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
}

interface ColumnMeta {
  label: string;
  icon: string;
  visibleByDefault: boolean;
}

interface GroupByOption {
  value: GroupBy;
  label: string;
  icon: string;
}

interface AggregateOption {
  field: AnyCustomField;
  sum: boolean;
  avg: boolean;
}

interface GroupAggregatePill {
  key: string;
  label: string;
}

@Component({
  selector: "k-board-list-view",
  standalone: true,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, CdkDragHandle, CdkScrollable, CardActionsMenuPopover, AvatarComponent, TooltipDirective, SeparatorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./board-list-view.component.html",
  styleUrl: "./board-list-view.component.scss",
})
export class BoardListViewComponent implements OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly state = inject(BoardState);
  private readonly notifications = inject(NotificationsService);
  private readonly workspaces = inject(WorkspaceService);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>("scrollEl");
  // Touch requires a long-press before a row drag starts so swipes scroll the list; mouse is immediate.
  protected readonly dragStartDelay = CARD_DRAG_START_DELAY;

  // ── Inputs ────────────────────────────────────────────────────────────────
  readonly viewKey = input.required<string>();
  readonly boardId = input<string>("");
  readonly boardName = input<string>("Board");
  readonly separatorItemBaseUrl = input<string>("/separators");
  readonly cards = input.required<AnyCard[]>();
  readonly separators = input<AnySeparator[]>([]);
  readonly lists = input.required<AnyList[]>();
  readonly customFields = input<AnyCustomField[]>([]);
  readonly cardLabels = input<AnyLabel[]>([]);
  readonly members = input<AnyMember[]>([]);
  readonly labelsByCard = input<Map<string, AnyLabel[]>>(new Map());
  readonly assigneesByCard = input<Map<string, AnyMember[]>>(new Map());
  readonly customFieldValuesByCardAndField = input<Map<string, Map<string, CardCustomFieldValue>>>(new Map());
  readonly commentCounts = input<Map<string, number>>(new Map());
  readonly attachmentCountByCard = input<Map<string, number>>(new Map());
  readonly boardSummariesById = input<Map<string, BoardSummary> | null>(null);
  readonly filteredCardIds = input<Set<string> | null>(null);
  readonly selectedCardId = input<string | null>(null);
  readonly bulkSelectedCardIds = input<Set<string>>(new Set());
  readonly canEdit = input<boolean>(true);
  readonly canCreateCards = input<boolean>(true);
  readonly addCardBoards = input<AddCardBoardOption[]>([]);
  readonly defaultAddCardBoardId = input<string | null>(null);
  readonly defaultAddCardAssigneeIds = input<string[]>([]);
  readonly allowCardDuplicate = input<boolean>(true);
  readonly allowCardCopyToBoard = input<boolean>(true);
  readonly defaultGroupBy = input<GroupBy>("list");
  readonly currentUserId = input<string | null>(null);
  readonly addingListId = input<string | null>(null);
  readonly addAtTop = input<boolean>(false);
  readonly loading = input<boolean>(false);
  readonly canManageSeparators = computed(() => Boolean(this.boardId() || this.separatorItemBaseUrl() !== "/separators"));

  // ── Outputs ───────────────────────────────────────────────────────────────
  readonly cardOpened = output<string>();
  readonly bulkSelectionRequested = output<BulkCardSelectionPayload>();
  readonly bulkMenuRequested = output<BulkCardMenuPayload>();
  readonly cardCreated = output<AnyCard>();
  readonly cardDropped = output<CardDropPayload>();
  readonly separatorDropped = output<SeparatorDropPayload>();
  readonly separatorUpdated = output<AnySeparator>();
  readonly separatorDeleted = output<string>();
  readonly startAdd = output<StartAddPayload>();
  readonly cancelAdd = output<void>();

  // ── Local UI state ────────────────────────────────────────────────────────
  readonly groupBy = signal<GroupBy>("list");
  readonly sortBy = signal<SortBy>("position");
  readonly columnVisibility = signal<ColumnVisibility>({});
  readonly columnOrder = signal<string[]>([]);
  readonly columnWidths = signal<ColumnWidths>({});
  readonly aggregateConfig = signal<AggregateConfig>({});
  readonly autoColumnWidths = signal<ColumnWidths>({});
  readonly collapsedGroups = signal<Set<string>>(new Set());
  readonly groupByMenuOpen = signal(false);
  readonly sortMenuOpen = signal(false);
  readonly aggregatesMenuOpen = signal(false);
  readonly columnsMenuOpen = signal(false);
  readonly exportMenuOpen = signal(false);
  readonly activeActionsCardId = signal<string | null>(null);
  readonly actionsMenuPoint = signal<{ x: number; y: number } | null>(null);
  readonly addPopoverPoint = signal<{ x: number; y: number } | null>(null);
  readonly showSeparators = signal(false);
  readonly newTitle = signal("");
  readonly boardPickerOpen = signal(false);
  readonly boardPickerOpenAbove = signal(false);
  readonly boardPickerQuery = signal("");
  readonly selectedAddCardBoardId = signal<string | null>(null);
  readonly cardDragging = signal(false);
  readonly scrollViewportWidth = signal<number | null>(null);

  readonly sortByOptions = SORT_BY_OPTIONS;
  readonly skeletonGroups = [0, 1, 2];
  readonly skeletonRows = [0, 1, 2, 3];
  readonly skeletonColumns = [0, 1, 2, 3, 4];
  readonly canEnterColumnList = (drag: CdkDrag<unknown>) => typeof drag.data === "string";
  readonly canEnterCardList = (drag: CdkDrag<unknown>) => typeof drag.data !== "string";
  private scrollDrag: { startX: number; startScrollLeft: number } | null = null;
  private cleanupScrollDrag?: () => void;
  private resizeObserver: ResizeObserver | null = null;
  private measureFrame: number | null = null;
  private cardDragPointer: { x: number; y: number } | null = null;
  private edgeScrollFrame: number | null = null;
  // Committed drop order is held at the lane-item level (cards + separators interleaved) so the
  // CDK placeholder order survives until parent optimistic state catches up, for either kind.
  private readonly committedDropItems = signal<Map<string, BoardLaneItem[]>>(new Map());
  private clearCommittedDropTimeout: number | null = null;
  private resizingColumn:
    | {
      id: string;
      startX: number;
      startWidth: number;
      removeListeners: () => void;
    }
    | null = null;

  constructor() {
    // Restore persisted preferences whenever the scope changes.
    effect(() => {
      const scope = this.viewKey();
      const fallbackGroupBy = untracked(() => this.defaultGroupBy());
      this.groupBy.set(this.validGroupByOrFallback(readGroupBy(scope), fallbackGroupBy));
      this.sortBy.set(readSortBy(scope) ?? "position");
      this.columnVisibility.set(readColumnVisibility(scope) ?? {});
      this.columnOrder.set(readColumnOrder(scope) ?? []);
      this.columnWidths.set(readColumnWidths(scope) ?? {});
      this.aggregateConfig.set(this.validAggregateConfig(readAggregateConfig(scope) ?? {}));
      this.showSeparators.set(readShowSeparators(scope) ?? false);
      this.collapsedGroups.set(new Set());
    });

    effect((onCleanup) => {
      const el = this.scrollEl()?.nativeElement;
      if (!el) return;
      const detach = this.attachScrollDragHandlers(el);
      this.cleanupScrollDrag = detach;
      onCleanup(() => {
        detach();
        this.cleanupScrollDrag = undefined;
      });
    });

    effect((onCleanup) => {
      const el = this.scrollEl()?.nativeElement;
      if (!el) return;
      this.scrollViewportWidth.set(el.clientWidth);
      const observer = new ResizeObserver(() => this.scrollViewportWidth.set(el.clientWidth));
      observer.observe(el);
      this.resizeObserver = observer;
      onCleanup(() => {
        observer.disconnect();
        if (this.resizeObserver === observer) this.resizeObserver = null;
      });
    });

    effect((onCleanup) => {
      this.visibleColumns();
      // Collapsing groups only changes mounted rows; it must not re-feed current
      // grid widths into auto sizing. Still track data and row budget changes so
      // newly revealed rows can contribute their intrinsic content widths.
      this.groups();
      this.rowRenderCap();
      this.filteredCardIds();
      this.customFieldValuesByCardAndField();
      this.labelsByCard();
      this.scheduleColumnMeasure();
      onCleanup(() => this.clearPendingColumnMeasure());
    });

    effect(() => {
      this.renderedGroups();
      if (!this.hasHiddenRows()) return;
      const el = this.scrollEl()?.nativeElement;
      if (!el) return;
      // Keep filling the scroll container while the mounted rows leave the user near the end.
      // Normal scrolling uses the same threshold, so rows appear before a manual control is needed.
      untracked(() => requestAnimationFrame(() => {
        if (this.hasHiddenRows() && this.shouldGrowRows(el)) this.growRows();
      }));
    });

    effect(() => {
      const committed = this.committedDropItems();
      if (!committed.size) return;
      // Drop the placeholder once parent state has reproduced the committed lane order for every
      // affected group (compared by item identity across cards + separators).
      const baseByKey = new Map(this.baseGroups().map((group) => [group.key, this.rowsForGroup(group, group.cards)]));
      const caughtUp = [...committed].every(([key, items]) => sameItemOrder(baseByKey.get(key) ?? EMPTY_ITEMS, items));
      if (caughtUp) this.clearCommittedDropOrder();
    });

    effect(() => {
      const boards = this.addCardBoards();
      const fallback = this.defaultAddCardBoardId() ?? boards[0]?.id ?? this.boardId();
      const selected = this.selectedAddCardBoardId();
      if (!selected || (boards.length > 0 && !boards.some((board) => board.id === selected))) {
        this.selectedAddCardBoardId.set(fallback || null);
      }
    });
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  readonly visibleCards = computed(() => {
    const filter = this.filteredCardIds();
    if (!filter) return this.cards();
    return this.cards().filter((card) => filter.has(card.id));
  });

  readonly sortedCustomFields = computed(() =>
    [...this.customFields()].sort((a, b) => Number(a.position) - Number(b.position)),
  );

  readonly listById = computed(() => new Map(this.lists().map((list) => [list.id, list])));

  readonly customFieldById = computed(() => new Map(this.customFields().map((field) => [field.id, field])));
  // Member display names keyed by id. Hoisted out of customFieldDisplay so a user-type custom
  // field column doesn't rebuild this map for every rendered row on every change detection pass.
  private readonly memberNameById = computed(() => new Map(this.members().map((m) => [m.userId, m.displayName])));

  readonly numericCustomFields = computed(() => this.sortedCustomFields().filter((field) => field.type === "number"));

  readonly selectedAddCardBoard = computed(() => {
    const id = this.selectedAddCardBoardId() ?? this.defaultAddCardBoardId() ?? this.boardId();
    return this.addCardBoards().find((board) => board.id === id) ?? null;
  });

  readonly filteredAddCardBoards = computed(() => {
    const q = this.boardPickerQuery().trim().toLowerCase();
    const boards = [...this.addCardBoards()].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return boards;
    return boards.filter((board) => board.name.toLowerCase().includes(q));
  });

  readonly groupByOptions = computed<GroupByOption[]>(() => [
    ...GROUP_BY_OPTIONS,
    ...this.sortedCustomFields().map((field) => ({
      value: `cf:${field.id}` as GroupBy,
      label: field.name,
      icon: field.icon || "forms",
    })),
  ]);

  /** Shared column metadata keeps template helpers as map lookups, not array scans. */
  readonly columnMetaById = computed(() => {
    const map = new Map<string, ColumnMeta>();
    for (const id of BUILTIN_COLUMN_IDS) {
      map.set(id, {
        label: builtinColumnLabel(id),
        icon: builtinColumnIcon(id),
        visibleByDefault: id === "status" || id === "board" || id === "assignees" || id === "due" || id === "labels" || id === "checklist",
      });
    }
    for (const field of this.sortedCustomFields()) {
      map.set(`cf:${field.id}`, {
        label: field.name,
        icon: field.icon || "forms",
        visibleByDefault: !!field.showOnCard,
      });
    }
    return map;
  });

  private readonly baseGroups = computed<CardGroup[]>(() =>
    groupCards(this.visibleCards(), this.groupBy(), this.sortBy(), {
      lists: this.lists(),
      labels: this.cardLabels(),
      members: this.members(),
      labelsByCard: this.labelsByCard(),
      assigneesByCard: this.assigneesByCard(),
      customFields: this.customFields(),
      customFieldValuesByCardAndField: this.customFieldValuesByCardAndField(),
      currentUserId: this.currentUserId(),
    }),
  );

  // Drop ordering is reconciled at the rendered-item level (see renderedGroups), so groups stay the
  // plain grouped cards used for aggregates, export, and selection.
  readonly groups = computed<CardGroup[]>(() => this.baseGroups());
  readonly activeAddGroup = computed(() => {
    const listId = this.addingListId();
    return listId ? this.groups().find((group) => group.meta.listId === listId) ?? null : null;
  });
  readonly canShowSeparators = computed(() => this.groupBy() === "list" && this.sortBy() === "position");
  readonly visibleRowCardIds = computed(() => this.groups().flatMap((group) => group.cards.map((card) => card.id)));

  // How many card rows to actually render across all expanded groups; grows on scroll.
  readonly rowRenderCap = signal(INITIAL_ROW_CAP);

  /**
   * Groups with their rendered card slice, the interleaved lane items actually rendered, and a
   * hidden-row count, computed against a single budget walked top-to-bottom. Collapsed groups
   * render nothing and don't consume budget. Slices are prefixes, so CDK drop indices line up with
   * the rendered rows. While a drop is being handed to parent state, the committed lane order for a
   * group overrides its derived item order so the placeholder stays put.
   */
  readonly renderedGroups = computed<{ group: CardGroup; cards: AnyCard[]; items: BoardLaneItem[]; hidden: number }[]>(() => {
    const collapsed = this.collapsedGroups();
    const committed = this.committedDropItems();
    const withRows = (group: CardGroup, cards: AnyCard[], hidden: number) => ({
      group,
      cards,
      items: committed.get(group.key) ?? this.rowsForGroup(group, cards),
      hidden,
    });
    if (this.filteredCardIds()) {
      return this.groups().map((group) => withRows(group, collapsed.has(group.key) ? EMPTY_CARDS : group.cards, 0));
    }
    let budget = this.rowRenderCap();
    return this.groups().map((group) => {
      if (collapsed.has(group.key)) return withRows(group, EMPTY_CARDS, 0);
      const total = group.cards.length;
      if (budget >= total) {
        budget -= total;
        return withRows(group, group.cards, 0);
      }
      const cards = budget > 0 ? group.cards.slice(0, budget) : EMPTY_CARDS;
      budget = 0;
      return withRows(group, cards, total - cards.length);
    });
  });

  readonly hasHiddenRows = computed(() => this.renderedGroups().some((entry) => entry.hidden > 0));

  onTableScroll(el: HTMLElement) {
    if (!this.hasHiddenRows()) return;
    if (this.shouldGrowRows(el)) this.growRows();
  }

  private growRows() {
    if (!this.hasHiddenRows()) return;
    this.rowRenderCap.update((cap) => cap + ROW_CAP_PAGE);
  }

  private shouldGrowRows(el: HTMLElement): boolean {
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    return remaining <= GROW_NEAR_BOTTOM_PX;
  }

  readonly aggregateOptions = computed<AggregateOption[]>(() => {
    const config = this.aggregateConfig();
    return this.numericCustomFields().map((field) => {
      const metrics = config[field.id] ?? [];
      return {
        field,
        sum: metrics.includes("sum"),
        avg: metrics.includes("avg"),
      };
    });
  });

  readonly hasActiveAggregates = computed(() =>
    Object.values(this.aggregateConfig()).some((metrics) => metrics.length > 0),
  );

  /** Total card count (deduplicated) across all groups — for the toolbar caption. */
  readonly totalCardCount = computed(() => this.visibleCards().length);
  readonly allGroupsCollapsed = computed(() => {
    const groups = this.groups();
    if (groups.length === 0) return false;
    const collapsed = this.collapsedGroups();
    return groups.every((group) => collapsed.has(group.key));
  });
  readonly toggleAllGroupsLabel = computed(() => this.allGroupsCollapsed() ? "Expand all groups" : "Collapse all groups");

  /** Drag is only meaningful when the natural board ordering is shown. */
  readonly dragEnabled = computed(() =>
    this.canEdit() && this.groupBy() === "list" && this.sortBy() === "position",
  );

  /** A short hint when drag is disabled in list view — surfaces in headers. */
  readonly dragDisabledHint = computed(() => {
    if (this.dragEnabled() || !this.canEdit()) return null;
    if (this.groupBy() !== "list") return "Card drag to reorder works when grouped by list";
    if (this.sortBy() !== "position") return "Card drag to reorder works with manual sort";
    return null;
  });

  readonly availableColumns = computed<string[]>(() => {
    const groupBy = this.groupBy();
    const hasBoardColumn = !!this.boardSummariesById();
    const fieldIds = this.sortedCustomFields().map((field) => `cf:${field.id}`);
    const ordered: string[] = [];

    for (const id of BUILTIN_COLUMN_IDS) {
      if (id === "status" && groupBy === "list") continue;
      if (id === "board" && !hasBoardColumn) continue;
      ordered.push(id);
    }
    ordered.push(...fieldIds);
    return ordered;
  });

  /** Columns currently shown — title is always present and sits first. */
  readonly visibleColumns = computed<string[]>(() => {
    const visibility = this.columnVisibility();
    const visible = this.availableColumns().filter((id) => this.columnDefault(id, visibility));
    return applySavedColumnOrder(visible, this.columnOrder());
  });

  /** All toggleable columns, in display order, for the picker menu. */
  readonly pickableColumns = computed(() => {
    const groupBy = this.groupBy();
    const hasBoardColumn = !!this.boardSummariesById();
    const items: { id: string; label: string; icon: string; visible: boolean; disabled?: boolean }[] = [];
    const visibility = this.columnVisibility();

    for (const id of BUILTIN_COLUMN_IDS) {
      if (id === "status" && groupBy === "list") continue;
      if (id === "board" && !hasBoardColumn) continue;
      items.push({
        id,
        label: builtinColumnLabel(id),
        icon: builtinColumnIcon(id),
        visible: this.columnDefault(id, visibility),
      });
    }
    for (const field of this.sortedCustomFields()) {
      const id = `cf:${field.id}`;
      items.push({
        id,
        label: field.name,
        icon: field.icon || "forms",
        visible: this.columnDefault(id, visibility),
      });
    }
    return items;
  });

  private columnDefault(id: string, visibility: ColumnVisibility): boolean {
    if (id in visibility) return visibility[id];
    const meta = this.columnMetaById().get(id);
    if (meta) return meta.visibleByDefault;
    return true;
  }

  aggregatePillsFor(group: CardGroup): GroupAggregatePill[] {
    const config = this.aggregateConfig();
    const values = this.customFieldValuesByCardAndField();
    const fields = this.numericCustomFields();
    const pills: GroupAggregatePill[] = [];

    for (const field of fields) {
      const metrics = config[field.id] ?? [];
      if (!metrics.length) continue;
      let sum = 0;
      let count = 0;
      for (const card of group.cards) {
        const value = values.get(card.id)?.get(field.id)?.valueNumber;
        const n = typeof value === "number" ? value : value === null || value === undefined || value === "" ? Number.NaN : Number(value);
        if (!Number.isFinite(n)) continue;
        sum += n;
        count += 1;
      }
      if (count === 0) continue;
      for (const metric of metrics) {
        const number = metric === "sum" ? sum : sum / count;
        pills.push({
          key: `${field.id}:${metric}`,
          label: `${field.name} ${metric} ${this.formatAggregateNumber(number)}`,
        });
      }
    }

    return pills;
  }

  readonly groupByLabel = computed(() => this.groupByOptions().find((option) => option.value === this.groupBy())?.label ?? "List");
  readonly sortByLabel = computed(() => SORT_BY_OPTIONS.find((option) => option.value === this.sortBy())?.label ?? "Manual");

  readonly gridTemplate = computed(() => {
    const cols = this.visibleColumns();
    const widths = this.columnWidths();
    const parts: string[] = [`${this.widthForColumn(TITLE_COLUMN_ID, widths)}px`];
    for (const col of cols) parts.push(`${this.widthForColumn(col, widths)}px`);
    parts.push(`${ACTIONS_COLUMN_WIDTH}px`);
    return parts.join(" ");
  });

  columnLabel(col: string): string {
    return this.columnMetaById().get(col)?.label ?? col;
  }

  columnIcon(col: string): string {
    return this.columnMetaById().get(col)?.icon ?? "minus";
  }

  customFieldIdFromCol(col: string): string {
    return col.startsWith("cf:") ? col.slice(3) : "";
  }

  private validGroupByOrFallback(value: GroupBy | null, fallback: GroupBy): GroupBy {
    const candidate = value ?? fallback;
    if (!candidate.startsWith("cf:")) return candidate;
    const fieldId = candidate.slice(3);
    return this.customFieldById().has(fieldId) ? candidate : fallback;
  }

  private validAggregateConfig(config: AggregateConfig): AggregateConfig {
    const numericIds = new Set(this.numericCustomFields().map((field) => field.id));
    const next: AggregateConfig = {};
    for (const [fieldId, metrics] of Object.entries(config)) {
      if (!numericIds.has(fieldId)) continue;
      const validMetrics = metrics.filter((metric): metric is AggregateMetric => metric === "sum" || metric === "avg");
      if (validMetrics.length) next[fieldId] = [...new Set(validMetrics)];
    }
    return next;
  }

  private widthForColumn(id: string, widths: ColumnWidths = this.columnWidths()): number {
    return clampColumnWidth(id, widths[id] ?? this.autoColumnWidths()[id] ?? defaultWidthForColumn(id));
  }

  isGroupCollapsed(key: string): boolean {
    return this.collapsedGroups().has(key);
  }

  toggleGroup(key: string) {
    this.collapsedGroups.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  toggleAllGroups() {
    if (this.loading()) return;
    const groups = this.groups();
    if (groups.length === 0) return;

    if (this.allGroupsCollapsed()) {
      this.collapsedGroups.set(new Set());
      return;
    }

    this.collapsedGroups.set(new Set(groups.map((group) => group.key)));
  }

  // ── Per-card helpers ──────────────────────────────────────────────────────
  labelsForCard(cardId: string): AnyLabel[] {
    return this.labelsByCard().get(cardId) ?? EMPTY_LABELS;
  }

  assigneesForCard(cardId: string): AnyMember[] {
    return this.assigneesByCard().get(cardId) ?? EMPTY_MEMBERS;
  }

  fieldValueFor(cardId: string, fieldId: string): CardCustomFieldValue | null {
    return this.customFieldValuesByCardAndField().get(cardId)?.get(fieldId) ?? null;
  }

  /**
   * Display text for a select/user/date/url custom field cell, resolving option
   * labels and member names. Returns null when there is nothing to show.
   */
  customFieldDisplay(cardId: string, fieldId: string): string | null {
    const value = this.fieldValueFor(cardId, fieldId);
    const field = this.customFieldById().get(fieldId);
    if (!value || !field) return null;
    switch (field.type) {
      case "select": {
        const options = "options" in field ? field.options : [];
        const labels = (value.valueOptionIds ?? [])
          .map((id) => options.find((o) => o.id === id)?.label)
          .filter((label): label is string => Boolean(label));
        return labels.length ? labels.join(", ") : null;
      }
      case "user": {
        const namesById = this.memberNameById();
        const names = (value.valueUserIds ?? [])
          .map((id) => namesById.get(id))
          .filter((name): name is string => Boolean(name));
        return names.length ? names.join(", ") : null;
      }
      case "date":
        return value.valueDate?.trim() || null;
      case "url":
        return value.valueUrl?.trim() || null;
      default:
        return null;
    }
  }

  customFieldTypeForCol(col: string): string | null {
    return this.customFieldById().get(this.customFieldIdFromCol(col))?.type ?? null;
  }

  commentCountFor(cardId: string): number {
    return this.commentCounts().get(cardId) ?? 0;
  }

  attachmentCountFor(cardId: string): number {
    return this.attachmentCountByCard().get(cardId) ?? 0;
  }

  boardSummaryFor(card: AnyCard): BoardSummary | null {
    const map = this.boardSummariesById();
    return map ? map.get(card.boardId) ?? null : null;
  }

  hasDescription(card: AnyCard): boolean {
    return "hasDescription" in card ? card.hasDescription : Boolean(card.description);
  }

  checklistTotalCount(card: AnyCard): number {
    return "checklistTotalCount" in card ? card.checklistTotalCount : 0;
  }

  checklistDoneCount(card: AnyCard): number {
    return "checklistDoneCount" in card ? card.checklistDoneCount : 0;
  }

  checklistProgress(card: AnyCard): number {
    const total = this.checklistTotalCount(card);
    if (total <= 0) return 0;
    return Math.round((this.checklistDoneCount(card) / total) * 100);
  }

  checklistSummary(card: AnyCard): { done: number; total: number; progress: number } {
    const total = this.checklistTotalCount(card);
    const done = this.checklistDoneCount(card);
    return { done, total, progress: total <= 0 ? 0 : Math.round((done / total) * 100) };
  }

  hasDueDate(card: AnyCard): boolean {
    return Boolean(card.dueDateLocalDate);
  }

  isCardOverdue(card: AnyCard): boolean {
    return !card.archivedAt && !card.completedAt && isOverdue(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  isCardDueSoon(card: AnyCard): boolean {
    return !card.archivedAt && !card.completedAt && isDueSoon(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  formattedDue(card: AnyCard): string {
    return formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
  }

  formatAggregateNumber(value: number): string {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(value);
  }

  workspaceIdFor(card: AnyCard): string | null {
    return this.workspaces.workspaceIdForBoard(card.boardId);
  }

  listNameFor(card: AnyCard): { name: string; icon: string | null; color: string | null } | null {
    const list = this.listById().get(card.listId);
    if (!list) return null;
    return { name: list.name, icon: list.icon, color: list.color };
  }

  formatRelative(value: string | Date | null | undefined): string {
    if (!value) return "";
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (Number.isNaN(time)) return "";
    const diffMs = Date.now() - time;
    const mins = Math.round(diffMs / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.round(months / 12)}y ago`;
  }

  truncateDescription(card: AnyCard): string {
    const raw = (card as Card).description;
    if (!raw) return "";
    const stripped = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return stripped.length > 80 ? `${stripped.slice(0, 77)}…` : stripped;
  }

  // ── Toolbar actions ───────────────────────────────────────────────────────
  selectGroupBy(value: GroupBy) {
    if (this.loading()) return;
    this.groupBy.set(value);
    writeGroupBy(this.viewKey(), value);
    this.groupByMenuOpen.set(false);
  }

  selectSortBy(value: SortBy) {
    if (this.loading()) return;
    this.sortBy.set(value);
    writeSortBy(this.viewKey(), value);
    this.sortMenuOpen.set(false);
  }

  toggleSeparators() {
    if (this.loading() || !this.canShowSeparators()) return;
    this.showSeparators.update((value) => {
      const next = !value;
      writeShowSeparators(this.viewKey(), next);
      return next;
    });
  }

  toggleAggregate(fieldId: string, metric: AggregateMetric) {
    if (this.loading()) return;
    const current = this.aggregateConfig();
    const metrics = current[fieldId] ?? [];
    const nextMetrics = metrics.includes(metric)
      ? metrics.filter((m) => m !== metric)
      : [...metrics, metric];
    const next = { ...current };
    if (nextMetrics.length) next[fieldId] = nextMetrics;
    else delete next[fieldId];
    const valid = this.validAggregateConfig(next);
    this.aggregateConfig.set(valid);
    writeAggregateConfig(this.viewKey(), valid);
  }

  resetViewControls() {
    if (this.loading()) return;
    const groupBy = this.validGroupByOrFallback(null, this.defaultGroupBy());
    this.groupBy.set(groupBy);
    this.sortBy.set("position");
    this.aggregateConfig.set({});
    this.collapsedGroups.set(new Set());
    writeGroupBy(this.viewKey(), groupBy);
    writeSortBy(this.viewKey(), "position");
    writeAggregateConfig(this.viewKey(), {});
    this.closeMenus();
  }

  toggleColumnVisible(id: string) {
    if (this.loading()) return;
    const visibility = { ...this.columnVisibility() };
    const current = this.columnDefault(id, visibility);
    visibility[id] = !current;
    this.columnVisibility.set(visibility);
    writeColumnVisibility(this.viewKey(), visibility);
  }

  resetColumns() {
    if (this.loading()) return;
    this.columnVisibility.set({});
    this.columnOrder.set([]);
    this.columnWidths.set({});
    writeColumnVisibility(this.viewKey(), {});
    writeColumnOrder(this.viewKey(), []);
    writeColumnWidths(this.viewKey(), {});
  }

  openMenu(name: "group" | "sort" | "aggregates" | "columns" | "export", event: MouseEvent) {
    event.stopPropagation();
    if (this.loading()) {
      this.closeMenus();
      return;
    }
    this.groupByMenuOpen.set(name === "group" ? !this.groupByMenuOpen() : false);
    this.sortMenuOpen.set(name === "sort" ? !this.sortMenuOpen() : false);
    this.aggregatesMenuOpen.set(name === "aggregates" ? !this.aggregatesMenuOpen() : false);
    this.columnsMenuOpen.set(name === "columns" ? !this.columnsMenuOpen() : false);
    this.exportMenuOpen.set(name === "export" ? !this.exportMenuOpen() : false);
  }

  closeMenus() {
    this.groupByMenuOpen.set(false);
    this.sortMenuOpen.set(false);
    this.aggregatesMenuOpen.set(false);
    this.columnsMenuOpen.set(false);
    this.exportMenuOpen.set(false);
  }

  exportJson() {
    if (this.loading()) return;
    const payload = this.buildExportPayload();
    downloadTextFile(JSON.stringify(payload, null, 2), "application/json", this.exportFileName(payload, "json"));
    this.exportMenuOpen.set(false);
  }

  async exportExcel() {
    if (this.loading()) return;
    const payload = this.buildExportPayload();
    const { default: writeXlsxFile } = await import("write-excel-file/browser");
    const sheet = buildWorkbookExport(payload).sheets[0]!;
    await writeXlsxFile(styledSheetData(sheet), {
      sheet: sheet.name,
      columns: sheet.columnWidths.map((width) => ({ width })),
      stickyRowsCount: 4,
    }).toFile(this.exportFileName(payload, "xlsx"));
    this.exportMenuOpen.set(false);
  }

  private buildExportPayload(): BoardExportPayload {
    const columns = this.visibleColumns().map((id) => ({ id, label: this.columnLabel(id) }));
    const boardSummaries = this.boardSummariesById();
    return buildBoardExportPayload({
      board: {
        id: this.boardId(),
        name: this.boardName(),
      },
      exportedAt: new Date().toISOString(),
      groupBy: this.groupByLabel(),
      sortBy: this.sortByLabel(),
      columns,
      aggregateConfig: this.aggregateConfig(),
      groups: this.groups(),
      lists: this.lists(),
      labelsByCard: this.labelsByCard(),
      assigneesByCard: this.assigneesByCard(),
      customFields: this.customFields(),
      members: this.members(),
      customFieldValuesByCardAndField: this.customFieldValuesByCardAndField(),
      commentCounts: this.commentCounts(),
      attachmentCountByCard: this.attachmentCountByCard(),
      boardSummariesById: boardSummaries,
    });
  }

  private exportFileName(payload: BoardExportPayload, extension: "json" | "xlsx"): string {
    const boardName = sanitizeExportFileName(payload.metadata.boardName);
    return `${boardName}-${timestampForFileName(payload.metadata.exportedAt)}.${extension}`;
  }

  // ── Row interactions ──────────────────────────────────────────────────────
  onRowClick(card: AnyCard, event: MouseEvent) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".lv-row-stop, k-card-actions-menu, k-card-quick-edit, .cam-panel, .cqe-panel, .bp-panel, .dp-panel, .lp-panel, .qe-panel, .qe-popover")) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      this.closeActionsMenu();
      this.bulkSelectionRequested.emit({
        cardId: card.id,
        orderedCardIds: this.visibleRowCardIds(),
        // List view behaves like a manual row picker: modifier clicks toggle the
        // exact row only, instead of anchoring a Shift range like Kanban cards.
        shiftKey: false,
        additive: event.metaKey || event.ctrlKey,
      });
      return;
    }
    if (event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    this.cardOpened.emit(card.id);
  }

  onRowAuxClick(card: AnyCard, event: MouseEvent) {
    if (event.button !== 1) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".lv-row-stop, k-card-actions-menu, k-card-quick-edit, .cam-panel, .cqe-panel, .bp-panel, .dp-panel, .lp-panel, .qe-panel, .qe-popover")) return;
    event.preventDefault();
    event.stopPropagation();
    openCardDetailInNewTab(card.boardId, card.id);
  }

  onRowContextMenu(card: AnyCard, event: MouseEvent) {
    if (!this.canEdit()) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.bulkSelectedCardIds().has(card.id)) {
      this.closeActionsMenu();
      this.bulkMenuRequested.emit({ cardId: card.id, point: { x: event.clientX, y: event.clientY } });
      return;
    }
    document.dispatchEvent(new CustomEvent<string>(APP_DOM_EVENTS.CARD_ACTIONS_MENU_OPEN, { detail: card.id }));
    this.actionsMenuPoint.set({ x: event.clientX, y: event.clientY });
    this.activeActionsCardId.set(card.id);
  }

  toggleActionsMenu(card: AnyCard, event: MouseEvent) {
    event.stopPropagation();
    if (this.bulkSelectedCardIds().has(card.id)) {
      this.closeActionsMenu();
      this.bulkMenuRequested.emit({ cardId: card.id, point: this.menuPointFromEvent(event) });
      return;
    }
    this.actionsMenuPoint.set(null);
    const next = this.activeActionsCardId() === card.id ? null : card.id;
    if (next) document.dispatchEvent(new CustomEvent<string>(APP_DOM_EVENTS.CARD_ACTIONS_MENU_OPEN, { detail: card.id }));
    this.activeActionsCardId.set(next);
  }

  closeActionsMenu() {
    this.actionsMenuPoint.set(null);
    this.activeActionsCardId.set(null);
  }

  private menuPointFromEvent(event: MouseEvent): { x: number; y: number } {
    const target = event.currentTarget;
    if (target instanceof HTMLElement) {
      const rect = target.getBoundingClientRect();
      return { x: rect.right, y: rect.bottom };
    }
    return { x: event.clientX, y: event.clientY };
  }

  async toggleCompletion(card: AnyCard, event: MouseEvent) {
    event.stopPropagation();
    event.preventDefault();
    if (!this.canEdit()) return;
    try {
      const updated = await this.api.patch(`/cards/${card.id}/completion`, { completed: !card.completedAt });
      this.state.updateCard(updated as AnyCard);
    } catch {
      // Errors surface as toast via the api client; no extra UI here.
    }
  }

  // ── Add card affordance (only visible on list-grouped sections) ──────────
  isAddingHere(group: CardGroup): boolean {
    return group.meta.listId !== undefined && this.addingListId() === group.meta.listId;
  }

  onStartAdd(group: CardGroup, event?: MouseEvent) {
    if (!group.meta.listId || !this.canCreateCards()) return;
    if (event) this.addPopoverPoint.set(addPopoverPointFor(event));
    this.startAdd.emit({ listId: group.meta.listId, atTop: false });
  }

  async submitAdd(group: CardGroup, event: Event) {
    event.preventDefault();
    const title = this.newTitle().trim();
    const listId = group.meta.listId;
    if (!title || !listId) return;
    const boardId = this.selectedAddCardBoardId() ?? this.defaultAddCardBoardId() ?? this.boardId();
    if (!boardId) return;
    const assigneeIds = this.defaultAddCardAssigneeIds();
    const card = await this.api.post<AnyCard>(`/boards/${boardId}/lists/${listId}/cards`, {
      title,
      ...(assigneeIds.length ? { assigneeIds } : {}),
    });
    this.notifications.watchCreatedCardLocally(card.id);
    this.cardCreated.emit(card);
    this.newTitle.set("");
    this.boardPickerOpen.set(false);
    this.boardPickerOpenAbove.set(false);
    this.boardPickerQuery.set("");
    this.addPopoverPoint.set(null);
    this.cancelAdd.emit();
  }

  cancelAddMode() {
    this.newTitle.set("");
    this.boardPickerOpen.set(false);
    this.boardPickerOpenAbove.set(false);
    this.boardPickerQuery.set("");
    this.addPopoverPoint.set(null);
    this.cancelAdd.emit();
  }

  toggleAddCardBoardPicker(event: MouseEvent) {
    event.stopPropagation();
    if (this.cardDragging()) return;
    const opening = !this.boardPickerOpen();
    if (opening && event.currentTarget instanceof HTMLElement) {
      const rect = event.currentTarget.getBoundingClientRect();
      const expectedMenuHeight = 260;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      this.boardPickerOpenAbove.set(spaceBelow < expectedMenuHeight && spaceAbove > spaceBelow);
    }
    this.boardPickerOpen.set(opening);
  }

  selectAddCardBoard(boardId: string) {
    this.selectedAddCardBoardId.set(boardId);
    this.boardPickerOpen.set(false);
    this.boardPickerOpenAbove.set(false);
    this.boardPickerQuery.set("");
  }

  // ── Table layout ─────────────────────────────────────────────────────────
  onColumnDrop(event: CdkDragDrop<string[]>) {
    const visible = this.visibleColumns();
    if (event.previousIndex === event.currentIndex) return;
    const nextVisible = [...visible];
    moveItemInArray(nextVisible, event.previousIndex, event.currentIndex);

    const available = this.availableColumns();
    const hidden = applySavedColumnOrder(
      available.filter((id) => !nextVisible.includes(id)),
      this.columnOrder(),
    );
    const nextOrder = [...nextVisible, ...hidden];
    this.columnOrder.set(nextOrder);
    writeColumnOrder(this.viewKey(), nextOrder);
  }

  startColumnResize(id: string, event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endColumnResize();

    const onPointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const active = this.resizingColumn;
      if (!active) return;
      const width = clampColumnWidth(active.id, active.startWidth + moveEvent.clientX - active.startX);
      const next = { ...this.columnWidths(), [active.id]: width };
      this.columnWidths.set(next);
    };

    const onPointerUp = () => {
      const active = this.resizingColumn;
      if (active) writeColumnWidths(this.viewKey(), this.columnWidths());
      this.endColumnResize();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });
    const removeListeners = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
    this.resizingColumn = {
      id,
      startX: event.clientX,
      startWidth: this.widthForColumn(id),
      removeListeners,
    };
    document.body.classList.add("is-list-column-resizing");
  }

  private endColumnResize() {
    if (!this.resizingColumn) return;
    this.resizingColumn.removeListeners();
    this.resizingColumn = null;
    document.body.classList.remove("is-list-column-resizing");
  }

  private attachScrollDragHandlers(el: HTMLElement) {
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || this.resizingColumn) return;
      const target = event.target as Element | null;
      if (!target || target.closest(".lv-row, .lv-group-header, .lv-toolbar, .lv-menu, button, input, a, .lv-col-resize, .lv-col-drag-handle, .cdk-drag")) return;
      this.scrollDrag = { startX: event.clientX, startScrollLeft: el.scrollLeft };
      el.classList.add("is-dragging");
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!this.scrollDrag) return;
      event.preventDefault();
      el.scrollLeft = this.scrollDrag.startScrollLeft - (event.clientX - this.scrollDrag.startX);
    };

    const onMouseUp = () => {
      if (!this.scrollDrag) return;
      this.scrollDrag = null;
      el.classList.remove("is-dragging");
    };

    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      onMouseUp();
    };
  }

  private scheduleColumnMeasure() {
    this.clearPendingColumnMeasure();
    // Measure after Angular has flushed the latest rows/columns, and collapse
    // bursts of card/filter/column changes into a single DOM read pass.
    this.measureFrame = window.requestAnimationFrame(() => {
      this.measureFrame = null;
      this.measureColumns();
    });
  }

  private clearPendingColumnMeasure() {
    if (this.measureFrame === null) return;
    window.cancelAnimationFrame(this.measureFrame);
    this.measureFrame = null;
  }

  private measureColumns() {
    const root = this.scrollEl()?.nativeElement;
    if (!root) return;
    const next: ColumnWidths = {};
    for (const id of [TITLE_COLUMN_ID, ...this.visibleColumns()]) {
      const selector = `[data-col="${cssEscape(id)}"]`;
      const defaultWidth = defaultWidthForColumn(id);
      let width = defaultWidth;
      root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
        const measuredWidth = measuredColumnContentWidth(el);
        const isConstrained = measuredWidth > el.clientWidth + 1;
        const isAtDefaultWidth = el.clientWidth <= defaultWidth + 1;
        if (isConstrained || isAtDefaultWidth) width = Math.max(width, measuredWidth);
      });
      next[id] = clampColumnWidth(id, width);
    }
    // Avoid invalidating the grid template when the measured widths did not move.
    if (columnWidthsEqual(this.autoColumnWidths(), next)) return;
    this.autoColumnWidths.set(next);
  }

  // ── Drag-drop ─────────────────────────────────────────────────────────────
  onDragStarted(_event: CdkDragStart<BoardLaneItem>) {
    vibrateCardDragStart();
    this.cardDragging.set(true);
    this.startEdgeScrollLoop();
    document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
    document.body.classList.add("is-card-dragging");
  }

  onDragMoved(event: CdkDragMove<BoardLaneItem>) {
    this.cardDragPointer = event.pointerPosition;
    document.dispatchEvent(new CustomEvent<{ x: number; y: number }>(APP_DOM_EVENTS.CARD_DRAG_MOVE, { detail: event.pointerPosition }));
  }

  onDragEnded() {
    vibrateCardDragEnd();
    this.cardDragging.set(false);
    this.stopEdgeScrollLoop();
    document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
    document.body.classList.remove("is-card-dragging");
  }

  private startEdgeScrollLoop() {
    if (this.edgeScrollFrame !== null) return;

    const tick = () => {
      this.edgeScrollFrame = window.requestAnimationFrame(tick);
      const pointer = this.cardDragPointer;
      const el = this.scrollEl()?.nativeElement;
      if (!pointer || !el) return;
      const rect = el.getBoundingClientRect();

      const xStep = cardDragEdgeScrollStep(pointer.x - rect.left, rect.width);
      if (xStep !== 0) el.scrollLeft += xStep;

      const yStep = cardDragEdgeScrollStep(pointer.y - rect.top, rect.height);
      if (yStep !== 0) {
        el.scrollTop += yStep;
        if (yStep > 0 && this.shouldGrowRows(el)) this.growRows();
      }
    };

    this.edgeScrollFrame = window.requestAnimationFrame(tick);
  }

  private stopEdgeScrollLoop() {
    this.cardDragPointer = null;
    if (this.edgeScrollFrame === null) return;
    window.cancelAnimationFrame(this.edgeScrollFrame);
    this.edgeScrollFrame = null;
  }

  onDrop(event: CdkDragDrop<CardGroup>, group: CardGroup) {
    if (!this.dragEnabled() || !group.meta.listId) return;
    // Cards and separators are both cdkDrag rows, so CDK indices are item-space. Resolve the drop
    // against the rendered lane items (not the card-only group.cards) so a dropped card or separator
    // lands exactly between its rendered neighbours.
    const sourceGroup = event.previousContainer.data;
    const targetItems = this.renderedItemsForGroup(group.key);
    const droppedItem = (event.item.data as BoardLaneItem | undefined)
      ?? this.renderedItemsForGroup(sourceGroup.key)[event.previousIndex];
    if (!droppedItem) return;
    const droppedKey = laneItemKey(droppedItem);

    const committedTargetItems = committedItemOrderForDrop(targetItems, droppedItem, event.currentIndex);
    if (sourceGroup.key === group.key && sameItemOrder(targetItems, committedTargetItems)) return;
    const committedItems = new Map<string, BoardLaneItem[]>([[group.key, committedTargetItems]]);
    if (sourceGroup.key !== group.key) {
      committedItems.set(sourceGroup.key, this.renderedItemsForGroup(sourceGroup.key).filter((item) => laneItemKey(item) !== droppedKey));
    }
    suppressDropCommitTransitions(
      event.previousContainer.element?.nativeElement,
      event.container.element?.nativeElement,
    );
    this.commitDropOrder(committedItems);

    const droppedIndex = committedTargetItems.findIndex((item) => laneItemKey(item) === droppedKey);
    const beforeItem = droppedIndex >= 0 ? committedTargetItems[droppedIndex + 1] ?? null : null;
    const afterItem = beforeItem === null ? committedTargetItems[droppedIndex - 1] ?? null : undefined;
    const anchorPayload = beforeItem !== null
      ? { beforeItem: beforeItem ? laneItemAnchor(beforeItem) : null }
      : { afterItem: afterItem ? laneItemAnchor(afterItem) : null };

    if (droppedItem.kind === "card") {
      this.cardDropped.emit({ cardId: droppedItem.card.id, toListId: group.meta.listId, ...anchorPayload });
    } else {
      this.separatorDropped.emit({ separatorId: droppedItem.separator.id, toListId: group.meta.listId, ...anchorPayload });
    }
  }

  private renderedItemsForGroup(key: string): BoardLaneItem[] {
    return this.renderedGroups().find((entry) => entry.group.key === key)?.items ?? EMPTY_ITEMS;
  }

  async updateSeparator(payload: { id: string; title: string; color: string | null }) {
    const separator = await this.api.patch<AnySeparator>(`${this.separatorItemBaseUrl()}/${payload.id}`, {
      title: payload.title,
      color: payload.color,
    });
    this.separatorUpdated.emit(separator);
  }

  async deleteSeparator(separatorId: string) {
    await this.api.delete(`${this.separatorItemBaseUrl()}/${separatorId}`);
    this.separatorDeleted.emit(separatorId);
  }

  // ── Document listeners ───────────────────────────────────────────────────
  @HostListener("document:click", ["$event"])
  onDocumentClick(event: MouseEvent) {
    const target = event.target;
    if (this.groupByMenuOpen() || this.sortMenuOpen() || this.aggregatesMenuOpen() || this.columnsMenuOpen() || this.exportMenuOpen()) {
      const within = target instanceof Node && this.hostEl.nativeElement.querySelector(".lv-toolbar")?.contains(target);
      if (!within) this.closeMenus();
    }
    if (this.activeActionsCardId()) {
      const insideWrap = target instanceof Node && (target as HTMLElement).closest?.(".lv-row-actions, .cam-panel, .bp-panel, .dp-panel, .lp-panel, .qe-panel, .qe-popover");
      if (!insideWrap) this.closeActionsMenu();
    }
  }

  @HostListener("document:kanera:card-actions-menu-open", ["$event"])
  onActionsMenuOpenElsewhere(event: Event) {
    const opened = event instanceof CustomEvent ? (event as CustomEvent<string>).detail : null;
    if (opened !== this.activeActionsCardId()) {
      // Different card or another component opened a menu — close ours.
      // Only act if a menu is currently open here, to avoid clobbering point.
      if (opened !== this.activeActionsCardId()) this.closeActionsMenu();
    }
  }

  trackByCard = (_: number, card: AnyCard): string => card.id;
  trackByRow = (_: number, row: BoardLaneItem): string => row.kind === "card" ? `card:${row.card.id}` : `separator:${row.separator.id}`;
  trackByColumn = (_: number, id: string): string => id;

  ngOnDestroy() {
    this.cleanupScrollDrag?.();
    this.resizeObserver?.disconnect();
    this.clearPendingColumnMeasure();
    if (this.clearCommittedDropTimeout !== null) window.clearTimeout(this.clearCommittedDropTimeout);
    this.stopEdgeScrollLoop();
    this.endColumnResize();
  }

  private commitDropOrder(items: Map<string, BoardLaneItem[]>) {
    this.committedDropItems.set(items);
    if (this.clearCommittedDropTimeout !== null) window.clearTimeout(this.clearCommittedDropTimeout);
    // Mirrors the Kanban handoff: keep CDK's final placeholder order visible until parent
    // optimistic state catches up, including while the temporary repro delay is active.
    this.clearCommittedDropTimeout = window.setTimeout(() => this.clearCommittedDropOrder(), COMMITTED_DROP_FALLBACK_MS);
  }

  private clearCommittedDropOrder() {
    if (this.clearCommittedDropTimeout !== null) {
      window.clearTimeout(this.clearCommittedDropTimeout);
      this.clearCommittedDropTimeout = null;
    }
    this.committedDropItems.set(new Map());
  }

  private rowsForGroup(group: CardGroup, cards: AnyCard[]): BoardLaneItem[] {
    if (!this.showSeparators() || !this.canShowSeparators() || !group.meta.listId) {
      return cards.map((card) => ({ kind: "card", card }));
    }
    const listId = group.meta.listId;
    const separators = this.separators().filter((separator) => separator.listId === listId);
    // Unfiltered tables show every separator; filtered tables keep only separators that still
    // border a surviving card, judged against the full pre-filter lane.
    const kept = this.filteredCardIds()
      ? separators.filter((separator) =>
          separatorBordersVisibleCard(this.laneFor(listId), separator.id, new Set(cards.map((card) => card.id))),
        )
      : separators;
    return [
      ...cards.map((card): BoardLaneItem => ({ kind: "card", card })),
      ...kept.map((separator): BoardLaneItem => ({ kind: "separator", separator })),
    ].sort((a, b) => Number(rowPosition(a)) - Number(rowPosition(b)));
  }

  /** Full, position-sorted lane for a list (every card + separator, ignoring the active filter). */
  private laneFor(listId: string): BoardLaneItem[] {
    return [
      ...this.cards().filter((card) => card.listId === listId).map((card): BoardLaneItem => ({ kind: "card", card })),
      ...this.separators().filter((separator) => separator.listId === listId).map((separator): BoardLaneItem => ({ kind: "separator", separator })),
    ].sort((a, b) => Number(rowPosition(a)) - Number(rowPosition(b)));
  }
}

function rowPosition(row: BoardLaneItem): string {
  return row.kind === "card" ? row.card.position : row.separator.position;
}

function styledSheetData(sheet: ReturnType<typeof buildWorkbookExport>["sheets"][number]): SheetData {
  const boldRows = new Set(sheet.boldRows);
  return sheet.rows.map((row, rowIndex) =>
    row.map((value): Cell => {
      if (value === null) return null;
      return boldRows.has(rowIndex) ? { value, fontWeight: "bold" } : value;
    }),
  );
}

const EMPTY_LABELS: AnyLabel[] = [];
const EMPTY_MEMBERS: AnyMember[] = [];
const EMPTY_CARDS: AnyCard[] = [];
const EMPTY_ITEMS: BoardLaneItem[] = [];

function builtinColumnLabel(id: string): string {
  switch (id) {
    case "status": return "List";
    case "board": return "Board";
    case "assignees": return "Assignees";
    case "due": return "Due date";
    case "labels": return "Labels";
    case "checklist": return "Checklist";
    case "updated": return "Updated";
    case "created": return "Created";
    case "description": return "Description";
    default: return id;
  }
}

function defaultWidthForColumn(col: string): number {
  switch (col) {
    case TITLE_COLUMN_ID:
      return 320;
    case "status":
    case "board":
      return 180;
    case "assignees":
      return 116;
    case "due":
      return 160;
    case "labels":
      return 260;
    case "checklist":
      return 90;
    case "updated":
    case "created":
      return 120;
    case "description":
      return 220;
    default:
      return 220;
  }
}

function clampColumnWidth(id: string, width: number): number {
  const min = id === TITLE_COLUMN_ID ? TITLE_MIN_WIDTH : COLUMN_MIN_WIDTH;
  const max = id === TITLE_COLUMN_ID ? TITLE_MAX_WIDTH : COLUMN_MAX_WIDTH;
  return Math.min(max, Math.max(min, Math.round(width)));
}

function measuredColumnContentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const padding =
    parseFloat(style.paddingLeft || "0") +
    parseFloat(style.paddingRight || "0");
  const gap = parseFloat(style.columnGap || style.gap || "0") || 0;
  const children = [...el.children].filter((child): child is HTMLElement => child instanceof HTMLElement);

  if (children.length === 0) return el.scrollWidth + 2;

  // Measure intrinsic child demand instead of the grid cell itself. The cell's
  // scrollWidth includes its current assigned column width, which otherwise
  // feeds auto widths back into themselves on collapse/expand re-renders.
  const visibleChildren = children.filter((child) => getComputedStyle(child).position !== "absolute");
  const content = visibleChildren.reduce((sum, child) => sum + child.scrollWidth, 0);
  const gaps = Math.max(0, visibleChildren.length - 1) * gap;
  return padding + content + gaps + 2;
}

function applySavedColumnOrder(columns: string[], savedOrder: string[]): string[] {
  if (savedOrder.length === 0) return columns;
  const columnSet = new Set(columns);
  const ordered = savedOrder.filter((id) => columnSet.has(id));
  const missing = columns.filter((id) => !savedOrder.includes(id));
  return [...ordered, ...missing];
}

function columnWidthsEqual(a: ColumnWidths, b: ColumnWidths): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function addPopoverPointFor(event: MouseEvent): { x: number; y: number } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const popoverWidth = Math.min(360, viewportWidth - 24);
  const popoverHeight = 120;
  const x = Math.min(Math.max(12, event.clientX), viewportWidth - popoverWidth - 12);
  const y = Math.min(Math.max(12, event.clientY), viewportHeight - popoverHeight - 12);
  return { x, y };
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function builtinColumnIcon(id: string): string {
  switch (id) {
    case "status": return "list-details";
    case "board": return "layout-kanban";
    case "assignees": return "users";
    case "due": return "calendar-event";
    case "labels": return "tag";
    case "checklist": return "checkbox";
    case "updated": return "history";
    case "created": return "plus";
    case "description": return "align-left";
    default: return "minus";
  }
}
