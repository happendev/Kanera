import type { OnDestroy, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal } from "@angular/core";
import { Router } from "@angular/router";
import { cardPath } from "@kanera/shared/card-links";
import type {
  PortfolioBucket,
  WorkCard,
  WorkCatalogBoard,
  WorkCatalogList,
  WorkCustomFieldCondition,
  WorkDisplayMode,
  WorkDoneEventType,
  WorkGroupBy,
  WorkSort,
} from "@kanera/shared/dto";
import { expandCardSummary, type WireCardDetail, type WireCardSummary, type WireChecklistAssignment, type WireCustomField } from "@kanera/shared/events";
import type { WorkViewLens } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { viewPreferenceKey } from "../../core/browser/browser-contracts";
import { MyPrioritiesService } from "../../core/priorities/my-priorities.service";
import { AnchoredPickerPopover } from "../../shared/anchored-picker.popover";
import { PageHeaderComponent } from "../../shared/page-header.component";
import { PageToolbarComponent } from "../../shared/page-toolbar.component";
import { PanelStackService } from "../../shared/panel-stack.service";
import { mediaQuerySignal } from "../../shared/media-query.signal";
import type { PickerGroup } from "../../shared/picker-list.component";
import { SearchFieldComponent } from "../../shared/search-field.component";
import { SegmentedComponent, type SegmentedOption } from "../../shared/segmented.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { ActivityStripComponent, type ActivityStripSeries } from "../../shared/activity-strip.component";
import { StatTileComponent } from "../../shared/stat-tile.component";
import { AvatarComponent } from "../../shared/avatar.component";
import { BoardCanvasComponent } from "../board/board-canvas.component";
import { BoardMenuCoordinator } from "../board/board-menu-coordinator.service";
import { CardDragCoordinator } from "../board/card-drag-coordinator.service";
import { BoardCalendarViewComponent } from "../board/calendar-view/board-calendar-view.component";
import { BoardState, type AnySeparator, type BoardLaneItem } from "../board/board-state";
import { formatDueDate, isOverdue } from "../board/due-date.util";
import { FilterBarComponent } from "../board/table-view/filter-bar.component";
import { ListComponent, type CardDropPayload, type SeparatorDropPayload, type StartAddPayload } from "../board/list.component";
import { WorkDoneViewComponent } from "../board/work-done-view/work-done-view.component";
import { readWorkDoneLayout, writeWorkDoneLayout } from "../board/work-done-view/work-done-preferences";
import { NARROW_WORK_DONE_LAYOUT_QUERY, type WorkDoneLayout } from "../board/work-done-view/work-done.types";
import { BoardTableViewComponent, type HostedTableCardReorder } from "../board/table-view/board-table-view.component";
import { TABLE_CARD_STORE, type TableCardStore } from "../board/table-view/table-card-store";
import type {
  AnyCustomField,
  AnyLabel,
  AnyList,
  AnyMember,
  CardGroup,
  GroupBy,
  SortBy,
  SourceBoardRef,
  SourceOrganisationRef,
  SourceWorkspaceRef,
} from "../board/table-view/table-view.types";
import type { FilterValue } from "../board/table-view/filter.types";
import { GlobalCardCreatePopover } from "./global-card-create.popover";
import { DEFAULT_COMPLETION } from "./global-work-preference";
import { GlobalCardDetailHostComponent } from "./global-card-detail-host.component";
import { GlobalWorkState } from "./global-work.state";
import { priorityAnchorAt, type PriorityAnchor } from "./priority-anchor";
import { SaveViewPopover } from "./save-view.popover";
import { TeamPrioritiesViewComponent, type TeamPriorityReorder } from "./team-priorities-view.component";
import { UpNextPanelComponent, type UpNextAddableCard } from "./up-next-panel.component";
import { peoplePickerGroups, savedViewPickerGroups, scopePickerGroups } from "./work-pickers";

type GlobalCard = WireCardSummary & { workspaceId: string };
type ChecklistGroup = {
  id: string;
  label: string;
  icon: string;
  /** Tints the heading red: the whole bucket is late. */
  overdue: boolean;
  items: WireChecklistAssignment[];
};
/** Which toolbar/header popover is open. Only one at a time, so opening one dismisses the rest. */
type WorkMenu = "create" | "save" | "source" | "team" | "view" | "group" | "sort" | "period";
type PortfolioMetric = "active" | "overdue" | "dueSoon" | "unassigned" | "completed" | "overdueChecklistItems";
type PriorityLayout = "grid" | "table";
type PortfolioRow = {
  id: string;
  level: "organisation" | "workspace" | "board";
  label: string;
  context: string;
  /** Collapse key for the row's own subtree; null on rows with no children. */
  collapseId: string | null;
  /** A `kind: "board"` workspace rendered as one row instead of a wrapper plus its only board. */
  standalone: boolean;
  /** Set on workspace/board rows so a collapsed ancestor can hide them without re-walking the tree. */
  organisationId: string;
  workspaceId: string | null;
  workspaceIds: string[];
  boardIds: string[];
  active: number;
  overdue: number;
  dueSoon: number;
  unassigned: number;
  completed: number;
  overdueChecklistItems: number;
};
/** Number columns of the portfolio table, in render order, with the tone their heat tint uses. */
const PORTFOLIO_COLUMNS: { key: PortfolioMetric; label: string; tone: "danger" | "success" | "neutral" }[] = [
  { key: "active", label: "Active", tone: "neutral" },
  { key: "overdue", label: "Overdue", tone: "danger" },
  { key: "dueSoon", label: "Next 7 days", tone: "neutral" },
  { key: "unassigned", label: "Unassigned", tone: "neutral" },
  { key: "completed", label: "Completed", tone: "success" },
  { key: "overdueChecklistItems", label: "Checklist", tone: "danger" },
];
/** Fallback window length until the first portfolio response lands; the server owns the real value. */
const PORTFOLIO_ACTIVITY_DAYS = 60;
/** Smallest tint a non-zero count gets, and the curve that keeps mid-range counts distinguishable. */
const HEAT_FLOOR = 0.16;
const HEAT_GAMMA = 0.6;
/**
 * Collapse key for the checklist section as a whole. Shares the persisted checklist-group set, so it
 * must stay outside the `checklist:<bucket>` ids that `checklistGroups()` assigns.
 */
const CHECKLIST_SECTION_COLLAPSE_ID = "checklist:section";
/**
 * Mirrors MAX_CARD_PRIORITIES_PER_USER in `@kanera/shared/schema` — importing the value would pull
 * the Drizzle schema barrel into the web bundle, the same reason DEFAULT_COMPLETION is duplicated
 * in global-work-preference.ts. The server enforces the real cap; this only hides affordances it
 * would reject anyway.
 */
const MAX_UP_NEXT_ENTRIES = 50;
const PRIORITY_LAYOUT_KEY = viewPreferenceKey("mode", "globalWork:team:priorities");

function storedPriorityLayout(): PriorityLayout {
  if (typeof localStorage === "undefined") return "grid";
  try {
    return localStorage.getItem(PRIORITY_LAYOUT_KEY) === "table" ? "table" : "grid";
  } catch {
    return "grid";
  }
}

function priorityGroupKey(userId: string): string {
  return `priority:${userId}`;
}

function priorityPickerGroups(cards: UpNextAddableCard[]): PickerGroup[] {
  const groups = new Map<string, PickerGroup>();
  for (const card of cards) {
    const group = groups.get(card.boardId) ?? {
      id: card.boardId,
      label: card.boardName,
      icon: card.boardIcon ?? "layout-kanban",
      color: card.boardIconColor,
      options: [],
    };
    group.options.push({ id: card.id, label: card.title, hint: card.listName || null });
    groups.set(card.boardId, group);
  }
  return [...groups.values()];
}

@Component({
  selector: "k-global-work",
  standalone: true,
  imports: [
    DatePipe,
    ActivityStripComponent,
    AnchoredPickerPopover,
    AvatarComponent,
    BoardCalendarViewComponent,
    BoardCanvasComponent,
    BoardTableViewComponent,
    FilterBarComponent,
    ListComponent,
    PageHeaderComponent,
    PageToolbarComponent,
    SearchFieldComponent,
    SegmentedComponent,
    TooltipDirective,
    WorkDoneViewComponent,
    TeamPrioritiesViewComponent,
    UpNextPanelComponent,
    GlobalCardCreatePopover,
    GlobalCardDetailHostComponent,
    SaveViewPopover,
    StatTileComponent,
  ],
  providers: [
    GlobalWorkState,
    BoardState,
    BoardMenuCoordinator,
    // The table's optimistic writes have to land in the query projection that is actually rendering
    // its rows, not in the bare BoardState this page provides for its other shared children.
    {
      provide: TABLE_CARD_STORE,
      useFactory: (state: GlobalWorkState): TableCardStore => ({
        updateCard: (card) => state.applyCardUpdate(card),
        setCardAssignees: (cardId, userIds) => state.applyCardAssignees(cardId, userIds),
        setCardLabels: (cardId, labelIds) => state.applyCardLabels(cardId, labelIds),
        // `beforeCardId: null` appends, matching the board's own status-change behaviour. Routed
        // through GlobalWorkState.moveCard so the merged cross-board lane and its personal
        // separators are accounted for, which the board's per-list position maths cannot do.
        moveCardToList: (cardId, listId) => state.moveCard(cardId, listId, { beforeCardId: null }),
      }),
      deps: [GlobalWorkState],
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./global-work.page.html",
  styleUrl: "./global-work.page.scss",
})
export class GlobalWorkPage implements OnInit, OnDestroy {
  readonly state = inject(GlobalWorkState);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly panelStack = inject(PanelStackService);
  private readonly cardDrag = inject(CardDragCoordinator);
  private readonly myPriorities = inject(MyPrioritiesService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly lens = input.required<WorkViewLens>();
  readonly cardId = input<string | undefined>();

  readonly openMenu = signal<WorkMenu | null>(null);
  readonly selectedCard = signal<WorkCard | null>(null);
  readonly selectedCardHost = computed(() => {
    const card = this.selectedCard();
    return card ? [card] : [];
  });
  readonly drilldownLabel = this.state.drilldownLabel;
  readonly moveError = signal<string | null>(null);
  readonly addingListId = signal<string | null>(null);
  readonly addingAtTop = signal(false);
  readonly workDoneRefreshVersion = signal(0);
  /** History-only event dimension, surfaced through the page's shared Filter panel. */
  readonly workDoneEventType = signal<WorkDoneEventType | null>(null);
  private readonly preferredWorkDoneLayout = signal<WorkDoneLayout>(readWorkDoneLayout("global"));
  private readonly narrowWorkDoneLayout = mediaQuerySignal(NARROW_WORK_DONE_LAYOUT_QUERY);
  /** Keep the wide-screen choice, but render List while the grid cannot form multiple columns. */
  readonly workDoneLayout = computed<WorkDoneLayout>(() =>
    this.narrowWorkDoneLayout() ? "list" : this.preferredWorkDoneLayout()
  );
  readonly workDoneLayoutOptions = computed<readonly SegmentedOption<WorkDoneLayout>[]>(() => [
    { id: "list", icon: "list-details", label: "List layout" },
    { id: "grid", icon: "layout-grid", label: "Grid layout", disabled: this.narrowWorkDoneLayout() },
  ]);

  setWorkDoneLayout(layout: WorkDoneLayout): void {
    if (layout === "grid" && this.narrowWorkDoneLayout()) return;
    this.preferredWorkDoneLayout.set(layout);
    writeWorkDoneLayout("global", layout);
  }
  readonly priorityLayout = signal<PriorityLayout>(storedPriorityLayout());
  readonly priorityLayoutOptions: readonly SegmentedOption<PriorityLayout>[] = [
    { id: "grid", icon: "layout-grid", label: "Grid view" },
    { id: "table", icon: "table", label: "Table view" },
  ];
  readonly collapsedOrganisationIds = computed(() =>
    new Set(this.state.definition().collapsedOrganisationIds)
  );
  readonly collapsedWorkspaceIds = computed(() =>
    new Set(this.state.definition().collapsedWorkspaceIds)
  );
  readonly collapsedCardGroupIds = computed(() =>
    new Set(this.state.collapsedChecklistGroupIds())
  );
  /**
   * Whole-section collapse rides in the same persisted set as the per-bucket collapse below it, under
   * a reserved id that no `checklistGroups()` bucket uses, so both survive a reload the same way.
   */
  readonly checklistSectionCollapsed = computed(() =>
    this.collapsedCardGroupIds().has(CHECKLIST_SECTION_COLLAPSE_ID)
  );
  private readonly cardNavigationTarget = signal<string | null | undefined>(undefined);
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  private routeCardResolution = 0;
  private pendingRouteCardId: string | null = null;
  private resolvedRouteCardId: string | null = null;

  readonly pageTitle = computed(() => ({
    my: "My Cards",
    team: "Team Cards",
    portfolio: "Portfolio",
  })[this.lens()]);

  /**
   * What the 56px chrome bar shows beside the title, replacing the old header's separate eyebrow and
   * full-sentence description. One dense phrase: the bar drops the subtitle entirely when it stacks,
   * and the old header's full sentence would be the first thing to ellipsise away up there. A
   * portfolio metric drill-down keeps its own banner above the table, which also carries the way
   * back, so it deliberately does not also appear here.
   */
  readonly headerSubtitle = "Across all boards";

  /**
   * The display switch, in row 1 with every other page's view switch.
   *
   * Portfolio is a rollup lens: the summary is its home, and the table is only where a metric
   * drill-down lands. It has no calendar — the rollups are counts rather than dated cards, and the
   * drill-down already carries its own date filter, so a month grid added nothing.
   *
   * A display stays enabled while it is the current one even when the page is not interaction-ready,
   * so a reader on a cached copy can still see which display they are on.
   */
  readonly displayOptions = computed<SegmentedOption<WorkDisplayMode>[]>(() => {
    const current = this.effectiveDisplay();
    const busy = !this.state.interactionReady();
    const option = (id: WorkDisplayMode, icon: string, label: string): SegmentedOption<WorkDisplayMode> =>
      ({ id, icon, label, disabled: busy && current !== id });
    if (this.lens() === "portfolio") {
      return [option("summary", "chart-bar", "Summary view"), option("table", "table", "Table view")];
    }
    return [
      option("board", "layout-kanban", "Board view"),
      // Team only: everyone's Up next queues sit immediately beside the board view, since both are
      // lane-based ways of reading the same work. My Cards already has the docked single queue.
      ...(this.lens() === "team" ? [option("priorities", "list-numbers", "Up next view")] : []),
      option("table", "table", "Table view"),
      option("calendar", "calendar", "Calendar view"),
      option("history", "history", "Work done"),
    ];
  });

  selectDisplay(display: WorkDisplayMode): void {
    this.state.setDisplay(display);
    // Leaving a metric drill-down for another display drops the drill-down's scope label with it,
    // since the label describes a table the reader is no longer looking at.
    if (display === "summary") this.drilldownLabel.set(null);
  }
  // History has no offline query, and the lanes' queues are deliberately not cached (a stale
  // sequence reads as an instruction) — both fall back to the table over a cached snapshot.
  readonly effectiveDisplay = computed<WorkDisplayMode>(() =>
    this.state.cachedAt() && ["history", "priorities"].includes(this.state.definition().display)
      ? "table"
      : this.state.definition().display
  );
  readonly historyOfflineFallback = computed(() =>
    this.state.cachedAt() !== null && this.state.definition().display === "history"
  );
  readonly prioritiesOfflineFallback = computed(() =>
    this.state.cachedAt() !== null && this.state.definition().display === "priorities"
  );
  /** Priority is the whole-team overview; teammate focus is only meaningful on card views. */
  readonly showTeammateFilter = computed(() =>
    this.lens() === "team" && this.effectiveDisplay() !== "priorities"
  );

  readonly organisationsById = computed(() =>
    new Map(this.state.catalog().organisations.map((item) => [item.id, item]))
  );
  readonly workspacesById = computed(() =>
    new Map(this.state.catalog().workspaces.map((item) => [item.id, item]))
  );
  readonly boardsById = computed(() =>
    new Map(this.state.catalog().boards.map((item) => [item.id, item]))
  );
  readonly listsById = computed(() =>
    new Map(this.state.catalog().lists.map((item) => [item.id, item]))
  );
  readonly labelsById = computed(() =>
    new Map(this.state.catalog().labels.map((item) => [item.id, item]))
  );
  readonly peopleById = computed(() =>
    new Map(this.state.catalog().people.map((item) => [item.userId, item]))
  );

  readonly lensViews = computed(() =>
    this.state.savedViews().filter((view) => view.lens === this.lens())
  );
  readonly teamPeople = computed(() => {
    const scopedBoardIds = new Set(this.state.scopedBoards().map((board) => board.id));
    return this.state.catalog().people.filter((person) =>
      person.userId !== this.state.auth.user()?.id
      && person.boardIds.some((boardId) => scopedBoardIds.has(boardId))
    );
  });
  readonly portfolioPeople = computed(() => {
    const scopedBoardIds = new Set(this.state.scopedBoards().map((board) => board.id));
    return this.state.catalog().people.filter((person) =>
      person.boardIds.some((boardId) => scopedBoardIds.has(boardId))
    );
  });
  readonly editableBoards = computed(() => {
    const targetUserId = this.creationTargetUserId();
    if (!targetUserId) return [];
    const person = this.peopleById().get(targetUserId);
    return this.state.scopedBoards().filter((board) =>
      board.viewerRole === "editor"
      && (targetUserId === this.state.auth.user()?.id
        ? person?.boardIds.includes(board.id) !== false
        : person?.boardIds.includes(board.id))
    );
  });
  readonly editableBoardsByWorkspace = computed(() => {
    const result = new Map<string, WorkCatalogBoard[]>();
    for (const board of this.editableBoards()) {
      const boards = result.get(board.workspaceId) ?? [];
      boards.push(board);
      result.set(board.workspaceId, boards);
    }
    return result;
  });
  // ── Shared filter bar (k-filter-bar) bridge ─────────────────────────────────────────────
  // Global Work reuses the same drill-down filter popover as board views.
  // Its FilterValue is a client-side shape, so we map it to/from the server-side WorkFilters. This
  // view spans many workspaces, which routinely repeat list/label/field names ("Doing", "Priority"),
  // so every option carries its workspace as a group: the panel then renders one section per
  // workspace instead of a flat list of identical-looking rows.
  private readonly multiWorkspace = computed(() => this.state.catalog().workspaces.length > 1);
  private readonly multiOrganisation = computed(() => this.state.catalog().organisations.length > 1);
  private readonly filterGroupName = (workspaceId: string) => {
    if (!this.multiWorkspace()) return null;
    const workspace = this.workspacesById().get(workspaceId);
    if (!workspace || !this.multiOrganisation()) return workspace?.name ?? "Workspace";
    const organisation = this.organisationsById().get(workspace.organisationId);
    const organisationName = organisation
      ? `${organisation.name}${organisation.external ? " · Guest" : ""}`
      : "Organisation";
    return `${organisationName} · ${workspace.name}`;
  };

  readonly filterLabels = computed(() =>
    this.state.catalog().labels.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      group: this.filterGroupName(label.workspaceId),
    }))
  );
  readonly filterLists = computed(() =>
    this.state.catalog().lists.map((list) => ({
      id: list.id,
      name: list.name,
      icon: list.icon,
      group: this.filterGroupName(list.workspaceId),
    }))
  );
  readonly filterFields = computed(() =>
    this.state.catalog().customFields.filter((field) => !field.archivedAt)
  );
  readonly filterFieldGroups = computed(() =>
    Object.fromEntries(
      this.state.catalog().customFields.map((field) => [field.id, this.filterGroupName(field.workspaceId)])
    )
  );
  readonly filterMembers = computed(() => {
    const organisationOrder = new Map(
      this.state.catalog().organisations.map((organisation, index) => [organisation.id, index])
    );
    return [...this.portfolioPeople()]
      .sort((a, b) =>
        (organisationOrder.get(a.organisationId) ?? Number.MAX_SAFE_INTEGER)
        - (organisationOrder.get(b.organisationId) ?? Number.MAX_SAFE_INTEGER)
        || a.displayName.localeCompare(b.displayName)
      )
      .map((person) => ({
      userId: person.userId,
      displayName: person.displayName,
      avatarUrl: person.avatarUrl,
      group: this.multiOrganisation()
        ? (() => {
            const organisation = this.organisationsById().get(person.organisationId);
            return organisation
              ? `${organisation.name}${organisation.external ? " · Guest" : ""}`
              : "Organisation";
          })()
        : null,
      }));
  });

  readonly filterValue = computed<FilterValue>(() => {
    const filters = this.state.definition().filters;
    return {
      labelIds: filters.labelIds,
      // Assignee filtering only surfaces in the portfolio lens; "my"/"team" scope assignees elsewhere.
      memberIds: this.lens() === "portfolio" ? filters.assigneeIds : [],
      listIds: filters.listIds,
      boardIds: [],
      cfConditions: filters.customFieldConditions.map((condition) => ({
        fieldId: condition.fieldId,
        op: condition.op,
        value: condition.value,
        value2: condition.value2,
        ids: condition.ids,
      })),
      showUnreadOnly: filters.unreadOnly,
      showOverdueOnly: filters.overdueOnly,
      // Board-only quick filter: Global Work's rank pills can belong to a curated teammate's
      // queue, so "your Up next queue" would be ambiguous here. The filter bar never shows the
      // row on this page (showPrioritySet stays off).
      showPrioritySetOnly: false,
    };
  });
  // The completed-date range doubles as the "show completed" switch: an empty range means active
  // cards only, any bound flips completion to "completed" so the query returns finished work.
  readonly completedFromDate = computed(() => this.state.definition().filters.completedFrom?.slice(0, 10) ?? "");
  readonly completedToDate = computed(() => this.state.definition().filters.completedTo?.slice(0, 10) ?? "");
  readonly showCompletedRange = computed(() => Boolean(this.completedFromDate() || this.completedToDate()));
  readonly completedRangeLabel = computed(() => {
    const from = this.completedFromDate();
    const to = this.completedToDate();
    if (from && to) return `${this.localDateLabel(from)} – ${this.localDateLabel(to)}`;
    if (from) return `From ${this.localDateLabel(from)}`;
    if (to) return `Until ${this.localDateLabel(to)}`;
    return "Choose date range";
  });

  /**
   * Drives the calendar's empty state. The stacked calendar itself drops undated cards — a card with
   * no due date has no place on a grid, and the table and board views already cover them.
   */
  readonly datedCardCount = computed(() =>
    this.state.cards().filter((card) => card.dueDateLocalDate).length
  );
  readonly boardCardsByList = computed(() => {
    const result = new Map<string, GlobalCard[]>();
    for (const card of this.state.cards()) {
      const lane = result.get(card.listId) ?? [];
      lane.push(card);
      result.set(card.listId, lane);
    }
    for (const lane of result.values()) {
      // Card positions form one workspace-list lane even when the cards belong to different
      // boards. This is the same order the move API updates, so source navigation rank must not
      // be introduced as a second priority system here.
      lane.sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
    }
    return result;
  });
  readonly boardItemsByList = computed(() => {
    const result = new Map<string, BoardLaneItem[]>();
    for (const [listId, cards] of this.boardCardsByList()) {
      result.set(listId, cards.map((card) => ({ kind: "card", card })));
    }
    for (const separator of this.state.separators()) {
      const items = result.get(separator.listId) ?? [];
      items.push({ kind: "separator", separator });
      result.set(separator.listId, items);
    }
    for (const items of result.values()) {
      items.sort((a, b) => {
        const aPosition = a.kind === "card" ? a.card.position : a.separator.position;
        const bPosition = b.kind === "card" ? b.card.position : b.separator.position;
        return Number(aPosition) - Number(bPosition)
          || a.kind.localeCompare(b.kind)
          || (a.kind === "card" ? a.card.id : a.separator.id)
            .localeCompare(b.kind === "card" ? b.card.id : b.separator.id);
      });
    }
    return result;
  });
  readonly boardListsByWorkspace = computed(() => {
    const result = new Map<string, WorkCatalogList[]>();
    for (const list of this.state.catalog().lists) {
      const lists = result.get(list.workspaceId) ?? [];
      lists.push(list);
      result.set(list.workspaceId, lists);
    }
    for (const lists of result.values()) {
      lists.sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
    }
    return result;
  });
  readonly boardCustomFieldsByWorkspace = computed(() => {
    const result = new Map<string, WireCustomField[]>();
    for (const field of this.state.catalog().customFields) {
      if (field.archivedAt) continue;
      const fields = result.get(field.workspaceId) ?? [];
      fields.push(field);
      result.set(field.workspaceId, fields);
    }
    return result;
  });
  readonly boardCustomFieldValues = computed(() => {
    const result = new Map<string, Map<string, GlobalCard["customFieldValues"][number]>>();
    for (const card of this.state.cards()) {
      result.set(card.id, new Map(card.customFieldValues.map((value) => [value.fieldId, value])));
    }
    return result;
  });
  readonly boardLabelsByCard = computed(() => {
    const labels = this.labelsById();
    return new Map(this.state.cards().map((card) => [
      card.id,
      card.labelIds.flatMap((id) => {
        const label = labels.get(id);
        return label ? [label] : [];
      }),
    ]));
  });
  readonly boardAssigneesByCard = computed(() => {
    const people = this.peopleById();
    return new Map(this.state.cards().map((card) => [
      card.id,
      card.assigneeIds.flatMap((userId) => {
        const person = people.get(userId);
        return person ? [{
          userId: person.userId,
          displayName: person.displayName,
          avatarUrl: person.avatarUrl,
        }] : [];
      }),
    ]));
  });
  readonly boardAttachmentCounts = computed(() =>
    new Map(this.state.cards().map((card) => [card.id, card.attachmentCount]))
  );
  readonly boardCommentCounts = computed(() =>
    new Map(this.state.cards().map((card) => [card.id, card.commentCount]))
  );
  readonly roleEditableCardIds = computed(() => new Set(
    this.state.cards()
      .filter((card) => this.boardsById().get(card.boardId)?.viewerRole === "editor")
      .map((card) => card.id)
  ));
  readonly draggableCardIds = computed(() => new Set(
    this.state.cards()
      .filter((card) =>
        this.boardsById().get(card.boardId)?.viewerRole === "editor"
        && !card.completedAt
        && !card.archivedAt
      )
      .map((card) => card.id)
  ));
  // A partially paged board must stay inert because a lane's order is only meaningful once every
  // matching card in it has arrived. Routine background reconciliation does not affect readiness.
  readonly boardInteractionReady = computed(() =>
    this.state.interactionReady()
    && !this.state.loadingMore()
    && !this.state.canLoadMore()
  );
  readonly boardWorkspaces = computed(() => {
    const workspaceIds = new Set(this.state.cards().map((card) => card.workspaceId));
    return this.state.catalog().workspaces.filter((workspace) => workspaceIds.has(workspace.id));
  });
  // A single-workspace user has nothing to disambiguate between: the collapsible workspace section
  // is pure chrome there, so the lanes render bare and take the page height like a normal board.
  // Collapse state is ignored in that mode because there is no header left to expand it again.
  readonly singleWorkspaceBoard = computed(() => !this.multiWorkspace());
  // ── Table view bridge ──────────────────────────────────────────────────────────────────
  // The board Table view rendered over the cross-board query. Everything below adapts the work
  // catalog to the shapes it takes; nothing here is table-specific logic, and the sheet's own
  // grouping, breakdown, aggregates and export come from the component unchanged.

  /**
   * Catalog lists as board lists, with their bare names.
   *
   * Unlike `historyLists`, which prefixes the workspace: the status column here is a narrow pill, and
   * a prefix left every cell reading "Marketing & Crea…" with the actual status clipped off. The
   * ambiguity a prefix guards against does not arise — the status picker is scoped to the card's own
   * workspace, the Board column names the source, and the table qualifies its own group headers.
   */
  readonly tableLists = computed<AnyList[]>(() => {
    const timestamp = new Date(0);
    return this.state.catalog().lists.map((list) => ({
      ...list,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  });

  readonly tableLabels = computed<AnyLabel[]>(() => {
    const timestamp = new Date(0);
    return this.state.catalog().labels.map((label) => ({
      ...label,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  });

  readonly tableCustomFields = computed<AnyCustomField[]>(() =>
    this.state.catalog().customFields.filter((field) => !field.archivedAt)
  );

  /**
   * Everyone in scope, as board members.
   *
   * The catalog has no per-board roster role, and the table only reads names and avatars for the
   * assignee cells and pickers — `role` and `source` are here to satisfy the shape. Whether an
   * assignment is allowed is decided per row by `roleEditableCardIds`, not by this value.
   */
  readonly tableMembers = computed<AnyMember[]>(() =>
    this.portfolioPeople().map((person) => ({
      userId: person.userId,
      displayName: person.displayName,
      avatarUrl: person.avatarUrl,
      role: "editor" as const,
      source: "board" as const,
      clientId: person.organisationId,
    }))
  );

  readonly tableAssigneesByCard = computed(() => {
    const members = new Map(this.tableMembers().map((member) => [member.userId, member]));
    return new Map(this.state.cards().map((card) => [
      card.id,
      card.assigneeIds.flatMap((userId) => {
        const member = members.get(userId);
        return member ? [member] : [];
      }),
    ]));
  });

  readonly tableLabelsByCard = computed(() => {
    const labels = new Map(this.tableLabels().map((label) => [label.id, label]));
    return new Map(this.state.cards().map((card) => [
      card.id,
      card.labelIds.flatMap((id) => {
        const label = labels.get(id);
        return label ? [label] : [];
      }),
    ]));
  });

  readonly tableSourceBoards = computed<SourceBoardRef[]>(() =>
    this.state.catalog().boards.map((board) => ({
      id: board.id,
      workspaceId: board.workspaceId,
      name: board.name,
      icon: board.icon,
      iconColor: board.iconColor,
    }))
  );
  readonly tableSourceWorkspaces = computed<SourceWorkspaceRef[]>(() =>
    this.state.catalog().workspaces.map((workspace) => ({
      id: workspace.id,
      organisationId: workspace.organisationId,
      name: workspace.name,
      icon: workspace.icon,
      accentColor: workspace.accentColor,
    }))
  );
  readonly tableSourceOrganisations = computed<SourceOrganisationRef[]>(() =>
    this.state.catalog().organisations.map((organisation) => ({
      id: organisation.id,
      name: organisation.external ? `${organisation.name} · Guest` : organisation.name,
    }))
  );

  /**
   * The saved view's group/sort, translated to the table's vocabulary.
   *
   * Global Work persists both server-side as part of the view definition and already renders the
   * controls in its own toolbar, so the table is told what to do rather than offering a second,
   * localStorage-backed pair. `WorkGroupBy` and `GroupBy` now name the same dimensions; only the
   * spelling of the null case differs.
   */
  readonly tableGroupBy = computed<GroupBy>(() => this.state.definition().groupBy);
  readonly tableSortBy = computed<SortBy>(() => ({
    dueAsc: "due-asc",
    dueDesc: "due-desc",
    titleAsc: "title-asc",
    titleDesc: "title-desc",
    createdAsc: "created-asc",
    createdDesc: "created-desc",
    updatedAsc: "updated-asc",
    updatedDesc: "updated-desc",
  } as const)[this.state.definition().sort]);

  readonly historyLists = computed(() =>
    this.state.catalog().lists.map((list) => ({
      ...list,
      name: this.multiWorkspace() ? `${this.workspaceName(list.workspaceId)} · ${list.name}` : list.name,
    }))
  );
  // The work-done rows resolve label chips against this catalog. The page provides a bare BoardState
  // for its shared child components but never hydrates it from a board, so its own cross-workspace
  // catalog is the only label source here.
  readonly historyLabels = computed(() =>
    this.state.catalog().labels.map((label) => ({ id: label.id, name: label.name, color: label.color }))
  );
  readonly historyCfConditions = computed(() =>
    this.state.definition().filters.customFieldConditions.map((condition) => ({
      fieldId: condition.fieldId,
      op: condition.op,
      ...(condition.value !== undefined ? { value: condition.value } : {}),
      ...(condition.value2 !== undefined ? { value2: condition.value2 } : {}),
      ...(condition.ids !== undefined ? { ids: condition.ids } : {}),
    }))
  );
  // ── Toolbar pickers ────────────────────────────────────────────────────────────────────
  // These replace native selects: the scope, teammate and saved-view lists all span organisations
  // and workspaces, so they render the sidebar's icons, indentation and grouping instead of a flat
  // list of names that repeat across workspaces.
  readonly scopeGroups = computed(() => scopePickerGroups(this.state.catalog()));
  readonly teamPeopleGroups = computed(() =>
    peoplePickerGroups(this.teamPeople(), this.state.catalog(), { id: "", label: "All teammates" })
  );
  readonly savedViewGroups = computed(() => savedViewPickerGroups(this.lensViews()));

  readonly groupByOptions: { id: WorkGroupBy; label: string; icon: string }[] = [
    { id: "dueDate", label: "Due date", icon: "calendar-due" },
    { id: "organisation", label: "Organisation", icon: "building" },
    { id: "workspace", label: "Workspace", icon: "rocket" },
    { id: "board", label: "Board", icon: "layout-kanban" },
    { id: "assignee", label: "Assignee", icon: "user" },
    { id: "list", label: "List", icon: "layout-list" },
    { id: "completion", label: "Completion", icon: "circle-check" },
    { id: "none", label: "No grouping", icon: "circle-off" },
  ];
  readonly sortOptions: { id: WorkSort; label: string; icon: string }[] = [
    { id: "dueAsc", label: "Due date, soonest first", icon: "sort-ascending" },
    { id: "dueDesc", label: "Due date, latest first", icon: "sort-descending" },
    { id: "titleAsc", label: "Title A–Z", icon: "sort-a-z" },
    { id: "titleDesc", label: "Title Z–A", icon: "sort-z-a" },
    { id: "updatedDesc", label: "Recently updated", icon: "history" },
    { id: "createdDesc", label: "Recently created", icon: "plus" },
  ];
  readonly groupByGroups = computed(() => [{
    id: "groupBy",
    options: this.groupByOptions.map((option) => ({ id: option.id, label: option.label, icon: option.icon })),
  }]);
  readonly sortGroups = computed(() => [{
    id: "sort",
    options: this.sortOptions.map((option) => ({ id: option.id, label: option.label, icon: option.icon })),
  }]);

  readonly scopeTrigger = computed(() => {
    const scope = this.state.definition().scope;
    const value = this.sourceValue();
    if (!value) {
      return { label: "All boards", icon: "ti ti-world", color: null as string | null };
    }
    if (value.startsWith("o:")) {
      const organisation = this.organisationsById().get(scope.organisationIds[0] ?? "");
      return { label: organisation?.name ?? "Organisation", icon: "ti ti-building", color: null as string | null };
    }
    if (value.startsWith("w:")) {
      const workspaceId = scope.workspaceIds[0] ?? "";
      return {
        label: this.workspaceName(workspaceId),
        icon: this.workspaceIconClass(workspaceId),
        color: this.workspaceIconColor(workspaceId),
      };
    }
    const boardId = scope.boardIds[0] ?? "";
    return {
      label: this.boardsById().get(boardId)?.name ?? "Board",
      icon: this.boardIconClass(boardId),
      color: this.boardIconColor(boardId),
    };
  });
  readonly teamTrigger = computed(() => {
    const userId = this.selectedTeamPerson();
    const person = userId ? this.peopleById().get(userId) : null;
    return { label: person?.displayName ?? "All teammates", person };
  });
  readonly savedViewLabel = computed(() => this.state.selectedView()?.name ?? "No saved view");
  readonly groupByLabel = computed(() =>
    this.groupByOptions.find((option) => option.id === this.state.definition().groupBy)?.label ?? "None"
  );
  readonly sortLabel = computed(() =>
    this.sortOptions.find((option) => option.id === this.state.definition().sort)?.label ?? "Sort"
  );
  readonly creationTargetUserId = computed(() => {
    if (this.lens() === "my") return this.state.auth.user()?.id ?? null;
    if (this.lens() === "team") return this.selectedTeamPerson() || null;
    return null;
  });
  readonly creationTargetName = computed(() => {
    const targetUserId = this.creationTargetUserId();
    if (!targetUserId) return "";
    return this.lens() === "my"
      ? this.state.auth.user()?.displayName ?? "you"
      : this.peopleById().get(targetUserId)?.displayName ?? "this teammate";
  });
  readonly creationAssigneeIds = computed(() => {
    const targetUserId = this.creationTargetUserId();
    return targetUserId ? [targetUserId] : [];
  });

  /** Portfolio headline tiles. Each drills the table down to the matching slice. */
  readonly portfolioMetrics = computed<{
    key: PortfolioMetric;
    label: string;
    icon: string;
    tone: "danger" | "success" | null;
    value: number;
  }[]>(() => {
    const totals = this.state.portfolio()?.totals;
    if (!totals) return [];
    return [
      { key: "active", label: "Active", icon: "player-play", tone: null, value: totals.cards - totals.completed },
      { key: "overdue", label: "Overdue", icon: "alert-triangle", tone: "danger", value: totals.overdue },
      { key: "dueSoon", label: "Due next 7 days", icon: "calendar-due", tone: null, value: totals.dueSoon },
      { key: "unassigned", label: "Unassigned", icon: "user-question", tone: null, value: totals.unassigned },
      { key: "completed", label: "Completed", icon: "circle-check", tone: "success", value: totals.completed },
      { key: "overdueChecklistItems", label: "Overdue checklist", icon: "list-check", tone: "danger", value: totals.overdueChecklistItems },
    ];
  });

  readonly portfolioColumns = PORTFOLIO_COLUMNS;

  /** Full organisation → workspace → board tree. Collapse only affects which rows render. */
  private readonly portfolioTree = computed<PortfolioRow[]>(() => {
    const buckets = this.state.portfolio()?.buckets ?? [];
    const organisations = new Map<string, PortfolioBucket[]>();
    for (const bucket of buckets) {
      const rows = organisations.get(bucket.organisationId) ?? [];
      rows.push(bucket);
      organisations.set(bucket.organisationId, rows);
    }
    const result: PortfolioRow[] = [];
    for (const [organisationId, organisationBuckets] of organisations) {
      result.push(this.rollupPortfolioRow(
        `organisation:${organisationId}`,
        "organisation",
        organisationBuckets[0]?.organisationName ?? "Organisation",
        "Organisation",
        organisationId,
        null,
        organisationBuckets,
      ));
      const workspaces = new Map<string, PortfolioBucket[]>();
      for (const bucket of organisationBuckets) {
        const rows = workspaces.get(bucket.workspaceId) ?? [];
        rows.push(bucket);
        workspaces.set(bucket.workspaceId, rows);
      }
      for (const [workspaceId, workspaceBuckets] of workspaces) {
        // A standalone board is a `kind: "board"` workspace wrapping a single board, and both carry
        // the same name — rendering the wrapper and the board would repeat the row for no
        // information. Collapse the pair into one leaf row, as the sidebar does.
        const standalone = this.workspacesById().get(workspaceId)?.kind === "board"
          && workspaceBuckets.length === 1;
        result.push({
          ...this.rollupPortfolioRow(
            `workspace:${workspaceId}`,
            "workspace",
            standalone
              ? workspaceBuckets[0]?.boardName ?? workspaceBuckets[0]?.workspaceName ?? "Board"
              : workspaceBuckets[0]?.workspaceName ?? "Workspace",
            workspaceBuckets[0]?.organisationName ?? "",
            organisationId,
            workspaceId,
            workspaceBuckets,
          ),
          // No children to fold, and drill-down targets the board itself rather than the wrapper.
          ...(standalone ? { collapseId: null, standalone: true } : {}),
        });
        if (standalone) continue;
        for (const bucket of workspaceBuckets) {
          result.push({
            id: `board:${bucket.boardId}`,
            level: "board",
            label: bucket.boardName,
            context: `${bucket.organisationName} · ${bucket.workspaceName}`,
            collapseId: null,
            standalone: false,
            organisationId,
            workspaceId: bucket.workspaceId,
            workspaceIds: [bucket.workspaceId],
            boardIds: [bucket.boardId],
            active: bucket.active,
            overdue: bucket.overdue,
            dueSoon: bucket.dueSoon,
            unassigned: bucket.unassigned,
            completed: bucket.completed,
            overdueChecklistItems: bucket.overdueChecklistItems,
          });
        }
      }
    }
    return result;
  });

  readonly portfolioRows = computed<PortfolioRow[]>(() => {
    const collapsedOrganisations = this.collapsedOrganisationIds();
    const collapsedWorkspaces = this.collapsedWorkspaceIds();
    return this.portfolioTree().filter((row) => {
      if (row.level === "organisation") return true;
      if (collapsedOrganisations.has(row.organisationId)) return false;
      return row.level === "workspace" || !collapsedWorkspaces.has(row.workspaceId ?? "");
    });
  });

  /**
   * Excel-style conditional highlighting: one scale per column, spanning every row of the tree.
   *
   * Scaling within a tree level instead looked broken — a board holding 11 cards came out as hot as
   * the workspace holding 89, because each was the leader of its own level. Rollups sitting at the
   * top of the scale is the honest reading: they really do hold the largest numbers.
   */
  private readonly portfolioColumnPeaks = computed(() => {
    const peaks = new Map<PortfolioMetric, number>();
    for (const row of this.portfolioTree()) {
      for (const column of PORTFOLIO_COLUMNS) {
        peaks.set(column.key, Math.max(peaks.get(column.key) ?? 0, row[column.key]));
      }
    }
    return peaks;
  });

  /** 0 (no tint) to 1 (largest number in the column). Consumed as the --heat CSS variable. */
  portfolioHeat(row: PortfolioRow, metric: PortfolioMetric): number {
    const value = row[metric];
    if (value <= 0) return 0;
    const peak = this.portfolioColumnPeaks().get(metric) ?? 0;
    if (peak <= 0) return 0;
    // Raw ratios waste the tint range: against a dominant rollup, everything else lands in the first
    // few invisible percent. The gamma lifts the middle of the scale and the floor guarantees any
    // non-zero count is visibly tinted, so the eye can rank rows instead of only spotting the peak.
    const ratio = Math.min(1, value / peak);
    const scaled = HEAT_FLOOR + (1 - HEAT_FLOOR) * ratio ** HEAT_GAMMA;
    return Math.round(scaled * 100) / 100;
  }

  /**
   * Two activity series over the same window: what moved, and what actually shipped. A board can look
   * busy and deliver nothing, so the counts are never blended into one row. Rendering (day columns,
   * level scaling, month labels) belongs to the shared k-activity-strip.
   */
  readonly activitySeries = computed<ActivityStripSeries[]>(() => {
    const activity = this.state.portfolio()?.activity ?? [];
    return [
      { key: "moved", label: "Card movement", noun: "move", tone: "accent" as const },
      { key: "completed", label: "Completed", noun: "completion", tone: "success" as const },
    ].map((series) => ({
      ...series,
      counts: new Map(activity.map((day) => [day.date, day[series.key as "moved" | "completed"]])),
    }));
  });

  readonly activityWindowDays = computed(() => this.state.portfolio()?.activityDays ?? PORTFOLIO_ACTIVITY_DAYS);

  constructor() {
    document.addEventListener("keydown", this.handleDocumentKeydown);
    effect(() => {
      // Keep the modal derived from the route so browser Back/Forward and pasted global-work links
      // behave like the existing board card detail. The visible query is preferred to avoid a
      // second read; a direct link outside the current result set is resolved below with card access.
      const requestedCardId = this.cardId() ?? null;
      const navigationTarget = this.cardNavigationTarget();
      // Component input binding can briefly retain the previous query params during navigation.
      // Keep the existing modal mounted until the requested cardId reaches the route input.
      if (navigationTarget !== undefined && requestedCardId !== navigationTarget) return;
      if (navigationTarget !== undefined) this.cardNavigationTarget.set(undefined);
      const visibleCard = requestedCardId
        ? this.state.cards().find((card) => card.id === requestedCardId) ?? null
        : null;
      this.syncCardFromRoute(requestedCardId, visibleCard);
    });
  }

  ngOnInit(): void {
    void this.state.initialize(this.lens());
  }

  ngOnDestroy(): void {
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    if (this.queryTimer !== null) clearTimeout(this.queryTimer);
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => this.onDocumentKeydown(event);

  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() !== "f" || (!event.ctrlKey && !event.metaKey)) return;
    // Card detail owns its own focused surface; matching the board page, leave browser shortcuts
    // alone while that modal is open instead of pulling focus back into the page behind it.
    if (this.selectedCard()) return;
    event.preventDefault();
    // Search stays outside the toolbar's collapsing controls, so it is focusable at every width.
    // Portfolio summary intentionally has no card query; in that display this remains a no-op while
    // still keeping the browser find UI from obscuring the app-level workspace.
    const input = this.el.nativeElement.querySelector<HTMLInputElement>('k-search-field .sf-input');
    input?.focus();
  }

  /**
   * Any query control away from its default. Drives the compact trigger's accent state, which is the
   * only signal a phone user gets that filters are hiding rows behind a collapsed panel.
   */
  readonly toolbarFilterActive = computed(() => {
    const definition = this.state.definition();
    const filters = definition.filters;
    return (
      filters.q.trim().length > 0
      || filters.labelIds.length > 0
      || filters.listIds.length > 0
      || filters.assigneeIds.length > 0
      || filters.customFieldConditions.length > 0
      || filters.unassignedOnly
      || filters.overdueOnly
      || filters.overdueChecklistOnly
      || filters.unreadOnly
      || filters.archived
      || filters.completion !== DEFAULT_COMPLETION
      || filters.dueFrom !== null
      || filters.dueTo !== null
      || filters.completedFrom !== null
      || filters.completedTo !== null
      || (this.effectiveDisplay() === "history" && this.workDoneEventType() !== null)
      || !definition.scope.allAccessible
    );
  });

  queueQuery(): void {
    if (!this.state.interactionReady()) return;
    if (this.queryTimer !== null) clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(() => {
      this.queryTimer = null;
      void this.state.queryFirstPage();
    }, 260);
  }

  applyQuery(): void {
    if (!this.state.interactionReady()) return;
    if (this.queryTimer !== null) clearTimeout(this.queryTimer);
    this.queryTimer = null;
    void this.state.queryFirstPage();
  }

  /**
   * Toolbar popovers are mutually exclusive, enforced by this single signal.
   *
   * No `stopPropagation` here: `AnchoredPanelDirective` registers the panel as a stack layer only
   * after the opening click has finished propagating, so the panel can no longer see the click that
   * opened it. Letting the click through is what allows other document listeners (drag coordinators,
   * other panels' dismissal) to react to it normally.
   */
  toggleMenu(menu: WorkMenu): void {
    if (!this.state.interactionReady() && menu !== "group") return;
    this.openMenu.update((current) => (current === menu ? null : menu));
  }

  /**
   * Close `menu`, but only if it is still the one that is open.
   *
   * The identity check is load-bearing, not defensiveness. Clicking toolbar trigger B while A is open
   * runs B's `toggleMenu` at the target first, and then the *same* click carries on to
   * PanelStackService, which dismisses A — still mounted at that point. An unconditional
   * `openMenu.set(null)` there would wipe the value B just wrote, so the old menu closed, the new one
   * never appeared, and the user had to click twice. Anything that multiplexes several popovers
   * through one signal needs this guard.
   */
  closeMenu(menu: WorkMenu): void {
    this.openMenu.update((current) => (current === menu ? null : current));
  }

  /** Reporting windows the portfolio summary supports; the server caps completed work at 60 days. */
  readonly portfolioDayOptions = [7, 30, 60];

  // The period lives in the toolbar next to the other query controls rather than in a card above the
  // metrics: it narrows the same result set the filters do, so it belongs with them.
  readonly periodGroups = computed(() => [{
    id: "period",
    options: this.portfolioDayOptions.map((days) => ({
      id: String(days),
      label: `Last ${days} days`,
      icon: "calendar-stats",
      hint: days === 60 ? "Longest window we report on" : null,
    })),
  }]);
  readonly periodValue = computed(() => String(this.state.definition().portfolioDays));
  readonly periodLabel = computed(() => `Last ${this.state.definition().portfolioDays} days`);

  selectPortfolioDays(days: number): void {
    this.closeMenu("period");
    this.state.setPortfolioDays(days);
    this.applyQuery();
  }

  /**
   * Toolbar inline clears. Each mirrors the `select…` path above for the same control, minus the
   * menu close (the × sits outside the panel, so the anchored panel dismisses itself), so a control
   * reset from the toolbar reloads exactly as it would when reset from inside its picker.
   */
  clearPortfolioDays(): void {
    this.state.resetPortfolioDays();
    this.applyQuery();
  }

  clearGrouping(): void {
    this.state.resetGrouping();
  }

  clearSort(): void {
    this.state.resetSort();
    this.applyQuery();
  }

  onCardCreated(): void {
    // GlobalWorkState.createCard already re-queries, so the new card lands in the list on its own.
    this.closeMenu("create");
  }

  startInlineAdd(payload: StartAddPayload): void {
    this.addingListId.set(payload.listId);
    this.addingAtTop.set(payload.atTop);
  }

  cancelInlineAdd(): void {
    this.addingListId.set(null);
    this.addingAtTop.set(false);
  }

  onInlineCardCreated(): void {
    this.cancelInlineAdd();
    // The shared list composer writes directly to the source board. Reconcile in the background so
    // its cross-board summary settles without disabling every other list while the query runs.
    this.state.reconcileCardsInBackground();
  }

  selectView(id: string): void {
    this.closeMenu("view");
    if (!id) {
      this.state.clearSavedView();
      return;
    }
    const view = this.state.savedViews().find((candidate) => candidate.id === id);
    if (view) this.state.applySavedView(view);
  }

  selectGrouping(groupBy: WorkGroupBy): void {
    this.closeMenu("group");
    this.state.setGrouping(groupBy);
  }

  selectSort(sort: WorkSort): void {
    this.closeMenu("sort");
    this.state.setSort(sort);
    this.applyQuery();
  }

  resetTableView(): void {
    this.state.resetTablePresentation();
    this.applyQuery();
  }

  selectSource(value: string): void {
    this.closeMenu("source");
    if (!value) this.state.setScope([], []);
    else if (value.startsWith("o:")) this.state.setScope([], [], [value.slice(2)]);
    else if (value.startsWith("w:")) this.state.setScope([value.slice(2)], []);
    else this.state.setScope([], [value.slice(2)]);
    if (this.lens() === "team" && this.selectedTeamPerson() && !this.teamPeople().some((person) => person.userId === this.selectedTeamPerson())) {
      this.state.setAssignees([]);
    }
    this.applyQuery();
  }

  sourceValue(): string {
    const scope = this.state.definition().scope;
    if (scope.allAccessible) return "";
    if (scope.organisationIds.length === 1 && scope.workspaceIds.length === 0 && scope.boardIds.length === 0) return `o:${scope.organisationIds[0]}`;
    if (scope.boardIds.length === 1 && scope.workspaceIds.length === 0) return `b:${scope.boardIds[0]}`;
    if (scope.workspaceIds.length === 1 && scope.boardIds.length === 0) return `w:${scope.workspaceIds[0]}`;
    return "";
  }

  selectTeamPerson(userId: string): void {
    this.closeMenu("team");
    this.state.setAssignees(userId ? [userId] : []);
    this.applyQuery();
  }

  selectedTeamPerson(): string {
    return this.state.definition().filters.assigneeIds.length === 1
      ? this.state.definition().filters.assigneeIds[0]!
      : "";
  }

  onFilterValueChange(value: FilterValue): void {
    // Custom-field conditions are workspace-scoped in the query; recover each field's workspace
    // from the catalog (fieldId is globally unique) and drop any whose field is no longer visible.
    const customFieldConditions: WorkCustomFieldCondition[] = value.cfConditions.flatMap((condition) => {
      const workspaceId = this.state.catalog().customFields.find((field) => field.id === condition.fieldId)?.workspaceId;
      if (!workspaceId) return [];
      return [{
        workspaceId,
        fieldId: condition.fieldId,
        op: condition.op,
        ...(condition.value !== undefined ? { value: condition.value } : {}),
        ...(condition.value2 !== undefined ? { value2: condition.value2 } : {}),
        ...(condition.ids !== undefined ? { ids: condition.ids } : {}),
      }];
    });
    this.state.updateFilters({
      labelIds: value.labelIds,
      listIds: value.listIds,
      unreadOnly: value.showUnreadOnly,
      overdueOnly: value.showOverdueOnly,
      customFieldConditions,
      ...(this.lens() === "portfolio" ? { assigneeIds: value.memberIds } : {}),
    });
    this.applyQuery();
  }

  applyCompletedRange(range: { from: string; to: string }): void {
    // Bound the day range as full-day ISO instants and switch completion to "completed" so the
    // server returns finished cards within the window rather than the active default.
    this.state.updateFilters({
      completion: "completed",
      completedFrom: range.from ? new Date(`${range.from}T00:00:00`).toISOString() : null,
      completedTo: range.to ? new Date(`${range.to}T23:59:59.999`).toISOString() : null,
    });
    this.applyQuery();
  }

  clearCompletedRange(): void {
    this.state.updateFilters({ completion: DEFAULT_COMPLETION, completedFrom: null, completedTo: null });
    this.applyQuery();
  }

  /**
   * "Hide completed" is on only for the strict `active` filter. A completed-date range is a
   * completed-only query, so hiding completed work also drops that range instead of contradicting it.
   */
  readonly hideCompleted = computed(() => this.state.definition().filters.completion === "active");

  onHideCompletedChange(hide: boolean): void {
    this.state.updateFilters({
      completion: hide ? "active" : DEFAULT_COMPLETION,
      completedFrom: null,
      completedTo: null,
    });
    this.applyQuery();
  }

  onArchivedChange(archived: boolean): void {
    this.state.setArchived(archived);
    this.applyQuery();
  }

  /**
   * "Clear all" from the filter panel. Scoped to what that panel actually offers, which is narrower
   * than "every filter in the definition":
   *
   * - `assigneeIds` is only the panel's on the portfolio lens (see `filterValue` and
   *   `onFilterValueChange`, which gate it the same way). On "my"/"team" it is the scope of the page
   *   itself, driven by the Teammate trigger next door — clearing it from in here silently reset a
   *   control the panel never showed and whose badge never counted it.
   * - `unassignedOnly` has no panel row at all; it belongs to the portfolio drill-down, which owns
   *   its own chip and close button.
   */
  clearFilters(): void {
    this.workDoneEventType.set(null);
    this.state.updateFilters({
      listIds: [],
      labelIds: [],
      customFieldConditions: [],
      completion: DEFAULT_COMPLETION,
      overdueOnly: false,
      unreadOnly: false,
      archived: false,
      completedFrom: null,
      completedTo: null,
      ...(this.lens() === "portfolio" ? { assigneeIds: [] } : {}),
    });
    this.applyQuery();
  }

  openCard(card: GlobalCard): void {
    const compact = this.state.response().cards.find((candidate) => candidate.id === card.id);
    if (compact) this.showCard(compact);
  }

  openCardById(cardId: string): void {
    const card = this.state.cards().find((candidate) => candidate.id === cardId);
    if (card) this.openCard(card);
  }

  /* ── Up next ─────────────────────────────────────────────────────────────────
   *
   * The queue is a property of the focused person, not a display of its own: rank pills ride the
   * card tiles, curation happens in a docked panel, and the display underneath — with all its
   * filters, grouping and search — is the candidate pool. Everything here reads
   * `currentPriorities`, which binds the response to the person currently in focus so a teammate
   * switch can never relabel the previous person's order while the next request is in flight.
   */

  /** Errors from panel gestures render inside the panel, next to the row that failed. */
  readonly priorityError = signal<string | null>(null);

  /** The queue response is usable only for the person currently named by the Team/My Cards lens. */
  readonly currentPriorities = computed(() => {
    const targetUserId = this.state.focusedTargetUserId();
    if (!targetUserId) return null;
    const queue = this.state.priorities();
    return queue?.targetUserId === targetUserId ? queue : null;
  });

  /**
   * The whole feature is withheld on an offline snapshot: a stale sequence reads as an instruction,
   * and someone following "do this first" from a cached queue can be reading last week's order with
   * no way to tell. Rank pills and the panel disappear together, from this one gate.
   */
  readonly upNextAvailable = computed(() =>
    this.currentPriorities() !== null
    && this.state.cachedAt() === null
    && this.effectiveDisplay() !== "history"
    && this.effectiveDisplay() !== "summary"
    // The lanes display *is* every queue; a docked copy of one of them beside it is noise.
    && this.effectiveDisplay() !== "priorities"
  );
  /** The dock is a board curation tool; every other display keeps its own full-width reading mode. */
  readonly showUpNextControl = computed(() =>
    this.lens() !== "portfolio" && this.effectiveDisplay() === "board"
  );
  readonly upNextUnavailableTooltip = computed(() => {
    if (this.effectiveDisplay() === "priorities") {
      return "The Up next view already shows everyone";
    }
    if (this.effectiveDisplay() === "history" || this.effectiveDisplay() === "summary") {
      return "Up next is unavailable on this view";
    }
    if (!this.state.focusedTargetUserId()) {
      return this.lens() === "team"
        ? "Pick one teammate to curate their Up next, or switch to the Up next view to see everyone"
        : "Up next is unavailable on this view";
    }
    if (!this.state.interactionReady()) return "Loading Up next…";
    return "You don’t have permission to view this teammate’s Up next";
  });
  readonly upNextOpen = computed(() =>
    this.upNextAvailable() && this.showUpNextControl() && this.state.upNextPanelOpen()
  );
  /** Names the queue's owner in the panel header when curating somebody else. */
  readonly upNextTargetName = computed(() => {
    if (this.lens() !== "team") return null;
    const targetUserId = this.state.focusedTargetUserId();
    return targetUserId ? this.peopleById().get(targetUserId)?.displayName ?? null : null;
  });
  readonly upNextCount = computed(() => this.upNextAvailable() ? this.currentPriorities()?.totalCount ?? 0 : 0);
  readonly priorityRanksByCard = computed<Map<string, number>>(() => {
    if (!this.upNextAvailable()) return new Map();
    return new Map(
      (this.currentPriorities()?.items ?? []).flatMap((item) => item.card ? [[item.card.id, item.rank] as const] : []),
    );
  });
  /**
   * Which tiles may offer "+ Up next". Everything the server would reject offers nothing: cards
   * already ranked (they wear a pill instead), completed cards, cards in workspaces this viewer may
   * not curate for the target, and any card while the queue is at capacity.
   */
  readonly priorityAddableCardIds = computed<Set<string>>(() => {
    const queue = this.upNextAvailable() ? this.currentPriorities() : null;
    if (!queue || !queue.canReorder || !this.state.interactionReady()) return new Set();
    if (queue.totalCount >= MAX_UP_NEXT_ENTRIES) return new Set();
    const ranked = new Set(queue.items.flatMap((item) => item.card ? [item.card.id] : []));
    const curatable = new Set(queue.reorderableWorkspaceIds);
    return new Set(
      this.state.cards()
        .filter((card) => !ranked.has(card.id) && !card.completedAt && curatable.has(card.workspaceId))
        .map((card) => card.id),
    );
  });

  /**
   * Board ids in the order the navigation sidebar presents them — organisations, each one's
   * workspaces, each workspace's boards, all in catalog order. The scope and create-card pickers
   * walk the catalog the same way, so every board list on this page reads in one order.
   */
  private readonly navBoardOrder = computed<Map<string, number>>(() => {
    const catalog = this.state.catalog();
    const order = new Map<string, number>();
    for (const organisation of catalog.organisations) {
      for (const workspace of catalog.workspaces) {
        if (workspace.organisationId !== organisation.id) continue;
        for (const board of catalog.boards) {
          if (board.workspaceId === workspace.id) order.set(board.id, order.size);
        }
      }
    }
    return order;
  });

  /**
   * The panel's "Add card" picker: the same eligible set as the tiles' hover "+", with board/list
   * context resolved for display. This is the affordance a touch screen can actually find — the
   * tile button needs a hover. Sorted into sidebar order (boards as the nav lists them, then each
   * board's own list/card order) rather than query order, so the picker's sections sit where the
   * reader expects them from every other board list in the app.
   */
  readonly upNextAddableCards = computed<UpNextAddableCard[]>(() => {
    const addable = this.priorityAddableCardIds();
    if (addable.size === 0) return [];
    return this.presentPriorityCandidates(this.state.cards().filter((card) => addable.has(card.id)));
  });

  /** Eligible assigned cards for each whole-team lane's two Add card pickers. */
  readonly teamPriorityAddableCards = computed<ReadonlyMap<string, UpNextAddableCard[]>>(() => {
    const result = new Map<string, UpNextAddableCard[]>();
    if (!this.state.interactionReady()) return result;
    for (const lane of this.priorityLanes()) {
      if (!lane.queue.canReorder || lane.queue.totalCount >= MAX_UP_NEXT_ENTRIES) continue;
      const ranked = new Set(lane.queue.items.flatMap((item) => item.card ? [item.card.id] : []));
      const workspaces = new Set(lane.queue.reorderableWorkspaceIds);
      // Team Cards excludes the viewer's assignments, while the priorities batch intentionally
      // includes a self lane. That lane alone receives the parallel My Cards candidate projection.
      const sourceCards = lane.target.self
        ? [...new Map(
            [...this.state.cards(), ...this.state.teamPrioritySelfCandidateCards()]
              .map((card) => [card.id, card]),
          ).values()]
        : this.state.cards();
      const candidates = sourceCards.filter((card) =>
        card.assigneeIds.includes(lane.target.userId)
        && !ranked.has(card.id)
        && !card.completedAt
        && !card.archivedAt
        && workspaces.has(card.workspaceId)
      );
      result.set(lane.target.userId, this.presentPriorityCandidates(candidates));
    }
    return result;
  });

  private presentPriorityCandidates(cards: GlobalCard[]): UpNextAddableCard[] {
    const boards = this.boardsById();
    const lists = this.listsById();
    const boardOrder = this.navBoardOrder();
    return cards
      .map((card) => {
        const board = boards.get(card.boardId);
        const list = lists.get(card.listId);
        return {
          entry: {
            id: card.id,
            title: card.title,
            boardId: card.boardId,
            boardName: board?.name ?? "Board",
            boardIcon: board?.icon ?? null,
            boardIconColor: board?.iconColor ?? null,
            listName: list?.name ?? "",
          },
          boardRank: boardOrder.get(card.boardId) ?? Number.MAX_SAFE_INTEGER,
          listRank: Number(list?.position ?? 0),
          cardRank: Number(card.position),
        };
      })
      .sort((a, b) =>
        a.boardRank - b.boardRank
        || a.listRank - b.listRank
        || a.cardRank - b.cardRank
        || a.entry.id.localeCompare(b.entry.id)
      )
      .map((row) => row.entry);
  }

  /**
   * The unread pulse on the toggle: "this queue changed since you last had the panel open."
   *
   * The signature is the ordered entry ids, so a reorder pulses but an unrelated card edit does
   * not. Stored per (viewer, target) in localStorage rather than on the server — a read receipt is
   * viewer-local chrome, and losing it costs one spurious pulse.
   */
  private readonly upNextSeenSignature = signal<string | null>(null);
  private readonly upNextSignature = computed(() =>
    (this.currentPriorities()?.items ?? []).map((item) => item.id).join("|")
  );
  /** The viewer's own read receipt lives with the shell service, which the drawer also marks. */
  readonly isSelfUpNextTarget = computed(
    () => this.state.focusedTargetUserId() === this.state.auth.user()?.id
  );
  private readonly upNextSeenKey = computed(() => {
    const viewerId = this.state.auth.user()?.id;
    const targetUserId = this.state.focusedTargetUserId();
    return viewerId && targetUserId && !this.isSelfUpNextTarget()
      ? viewPreferenceKey("upNextSeen", `${viewerId}:${targetUserId}`)
      : null;
  });
  readonly upNextPulse = computed(() =>
    this.upNextAvailable()
    && !this.upNextOpen()
    && (this.isSelfUpNextTarget()
      ? this.myPriorities.changedSinceSeen()
      : this.upNextSignature() !== "" && this.upNextSeenSignature() !== this.upNextSignature())
  );
  private readonly loadUpNextSeen = effect(() => {
    const key = this.upNextSeenKey();
    try {
      this.upNextSeenSignature.set(key && typeof localStorage !== "undefined" ? localStorage.getItem(key) : null);
    } catch {
      this.upNextSeenSignature.set(null);
    }
  });
  // Continuously while open, not just on toggle: a change that lands while the panel is showing has
  // been seen, and must not pulse after the panel closes.
  private readonly markUpNextSeen = effect(() => {
    if (!this.upNextOpen()) return;
    if (this.isSelfUpNextTarget()) {
      // Read the signature so this effect re-runs as the queue changes under an open panel.
      this.upNextSignature();
      this.myPriorities.markSeen();
      return;
    }
    const key = this.upNextSeenKey();
    const signature = this.upNextSignature();
    if (!key) return;
    this.upNextSeenSignature.set(signature);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, signature);
    } catch {
      // Storage can be unavailable in privacy mode; the pulse just resets next visit.
    }
  });

  toggleUpNextPanel(): void {
    if (!this.showUpNextControl() || !this.upNextAvailable()) return;
    this.priorityError.set(null);
    this.state.setUpNextPanelOpen(!this.state.upNextPanelOpen());
  }

  /** From a tile's "+ Up next": joins at the end, and the panel is where it gets dragged higher. */
  onUpNextAdd(cardId: string): void {
    this.moveError.set(null);
    void this.state.addPriority(cardId, { beforeId: null }).catch(() => {
      // moveError, not priorityError: the gesture happened on the board, where this banner renders,
      // and the panel showing the queue may not even be open.
      this.moveError.set("We couldn’t add that card to Up next. Nothing has changed.");
    });
  }

  /**
   * From the panel itself — its "Add card" picker (appends) or a board tile dropped onto it (joins
   * where the pointer released it). Failures render inside the panel, where the gesture ended.
   */
  onUpNextAddFromPanel(event: { cardId: string; afterId?: string | null; beforeId?: string | null }): void {
    this.priorityError.set(null);
    const { cardId, ...anchor } = event;
    void this.state.addPriority(cardId, anchor).catch(() => {
      this.priorityError.set("We couldn’t add that card to Up next. Nothing has changed.");
    });
  }

  /**
   * The panel's drop-list id, handed to every lane's `cdkDropListConnectedTo` while the panel is
   * open, so a tile can be dragged straight onto the queue. Cleared when the panel is closed —
   * CDK warns on connections it cannot resolve, and the target only exists while rendered.
   */
  readonly upNextDropTargets = computed<string[]>(() => this.upNextOpen() ? ["up-next-drop"] : []);

  onPriorityReordered(event: { priorityId: string; afterId?: string | null; beforeId?: string | null }): void {
    this.priorityError.set(null);
    const { priorityId, ...anchor } = event;
    void this.state.movePriority(priorityId, anchor).catch(() => {
      this.priorityError.set("We couldn’t reorder that Up next card. Its previous position has been restored.");
    });
  }

  onPriorityRemoved(event: { priorityId: string }): void {
    this.priorityError.set(null);
    void this.state.removePriority(event.priorityId).catch(() => {
      this.priorityError.set("We couldn’t remove that card from Up next. It has been put back.");
    });
  }

  /**
   * The dock's row-level "mark complete", offered only on the viewer's own queue. Completing drops
   * the card out of the live queue server-side, so the row leaves via the ordinary snapshot rather
   * than by anything patched here.
   */
  onPriorityCompleted(event: { cardId: string; completed: boolean }): void {
    this.priorityError.set(null);
    void this.myPriorities.setCardCompleted(event.cardId, event.completed).catch(() => {
      this.priorityError.set("We couldn’t update that card. Nothing has changed.");
    });
  }

  /** Priority view is the whole readable team at once; person drill-down belongs to Board view. */
  readonly priorityLanes = computed(() => this.state.teamPriorities()?.queues ?? []);
  readonly hiddenPriorityLaneIds = signal<ReadonlySet<string>>(new Set());
  readonly visiblePriorityLanes = computed(() => {
    const hidden = this.hiddenPriorityLaneIds();
    return this.priorityLanes().filter((lane) => !hidden.has(lane.target.userId));
  });

  setPriorityLayout(layout: PriorityLayout): void {
    this.priorityLayout.set(layout);
    // Presentation-only and browser-local, matching the board table's layout preferences. The
    // priority relation and its ordering remain server-owned regardless of the chosen projection.
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(PRIORITY_LAYOUT_KEY, layout);
    } catch {
      // The in-memory switch still works when storage is unavailable in a hardened browser context.
    }
  }

  /**
   * Priority queues are relation-backed groups, not a grouping inferred from card fields. Supplying
   * them to the shared table preserves a shared card in each person's queue and keeps each queue's
   * exact rank order while gaining the board table's inline editors and column tooling.
   */
  readonly priorityTableGroups = computed<CardGroup[]>(() => {
    const query = this.state.definition().filters.q.trim().toLowerCase();
    const liveCards = new Map(this.state.cards().map((card) => [card.id, card]));
    const people = this.peopleById();
    return this.visiblePriorityLanes().map((lane) => ({
      key: priorityGroupKey(lane.target.userId),
      label: lane.target.self ? `${lane.target.displayName} · You` : lane.target.displayName,
      icon: null,
      color: null,
      avatarUrl: people.get(lane.target.userId)?.avatarUrl ?? null,
      acceptsDrop: false,
      meta: {},
      cards: lane.queue.items.flatMap((entry) => {
        if (!entry.card) return [];
        const card = liveCards.get(entry.card.id) ?? expandCardSummary(entry.card);
        return query && !card.title.toLowerCase().includes(query) ? [] : [card];
      }),
    }));
  });

  readonly priorityTableCards = computed<GlobalCard[]>(() =>
    // Every hosted row above is resolved through expandCardSummary or the live Global Work
    // projection, so the broader AnyCard type exposed by CardGroup can be narrowed back here.
    this.priorityTableGroups().flatMap((group) => group.cards) as GlobalCard[]
  );
  readonly priorityTableRanksByGroup = computed<ReadonlyMap<string, ReadonlyMap<string, number>>>(() => {
    const result = new Map<string, ReadonlyMap<string, number>>();
    for (const lane of this.visiblePriorityLanes()) {
      result.set(priorityGroupKey(lane.target.userId), new Map(
        lane.queue.items.flatMap((entry) => entry.card ? [[entry.card.id, entry.rank] as const] : []),
      ));
    }
    return result;
  });
  readonly priorityTableReorderableCardIdsByGroup = computed<ReadonlyMap<string, ReadonlySet<string>>>(() => {
    const result = new Map<string, ReadonlySet<string>>();
    for (const lane of this.visiblePriorityLanes()) {
      const workspaces = new Set(lane.queue.reorderableWorkspaceIds);
      result.set(priorityGroupKey(lane.target.userId), new Set(
        this.state.interactionReady() && lane.queue.canReorder
          ? lane.queue.items.flatMap((entry) =>
              entry.card && workspaces.has(entry.card.workspaceId) ? [entry.card.id] : []
            )
          : [],
      ));
    }
    return result;
  });
  readonly priorityTableAddGroupsByGroup = computed<ReadonlyMap<string, PickerGroup[]>>(() => {
    const result = new Map<string, PickerGroup[]>();
    const candidates = this.teamPriorityAddableCards();
    for (const lane of this.visiblePriorityLanes()) {
      // Match the grid: read-only queues have no add affordance; curatable queues retain a disabled
      // + when full or when every eligible assigned card is already queued.
      if (!lane.queue.canReorder) continue;
      result.set(
        priorityGroupKey(lane.target.userId),
        priorityPickerGroups(candidates.get(lane.target.userId) ?? []),
      );
    }
    return result;
  });
  readonly priorityTableHiddenCount = computed(() =>
    this.visiblePriorityLanes().reduce((count, lane) => count + lane.queue.hiddenCount, 0)
  );
  readonly priorityTableEditableCardIds = computed(() => new Set(
    this.priorityTableCards()
      .filter((card) => this.boardsById().get(card.boardId)?.viewerRole === "editor")
      .map((card) => card.id),
  ));
  readonly priorityTableAssigneesByCard = computed(() => {
    const members = new Map(this.tableMembers().map((member) => [member.userId, member]));
    return new Map(this.priorityTableCards().map((card) => [
      card.id,
      card.assigneeIds.flatMap((userId) => {
        const member = members.get(userId);
        return member ? [member] : [];
      }),
    ]));
  });
  readonly priorityTableLabelsByCard = computed(() => {
    const labels = new Map(this.tableLabels().map((label) => [label.id, label]));
    return new Map(this.priorityTableCards().map((card) => [
      card.id,
      card.labelIds.flatMap((id) => {
        const label = labels.get(id);
        return label ? [label] : [];
      }),
    ]));
  });
  readonly priorityTableCustomFieldValues = computed(() => new Map(
    this.priorityTableCards().map((card) => [
      card.id,
      new Map(card.customFieldValues.map((value) => [value.fieldId, value])),
    ]),
  ));

  isPriorityLaneHidden(targetUserId: string): boolean {
    return this.hiddenPriorityLaneIds().has(targetUserId);
  }

  togglePriorityLane(targetUserId: string): void {
    const hidden = new Set(this.hiddenPriorityLaneIds());
    if (hidden.has(targetUserId)) {
      hidden.delete(targetUserId);
    } else {
      hidden.add(targetUserId);
    }
    this.hiddenPriorityLaneIds.set(hidden);
  }

  /** A lane's gestures reuse the panel's error surface; both render beside the row that failed. */
  onLaneReordered(event: TeamPriorityReorder): void {
    this.priorityError.set(null);
    const { targetUserId, priorityId, ...anchor } = event;
    void this.state.moveTeamPriority(targetUserId, priorityId, anchor).catch(() => {
      this.priorityError.set("We couldn’t reorder that Up next card. Its previous position has been restored.");
    });
  }

  onPriorityTableReordered(event: HostedTableCardReorder): void {
    const lane = this.visiblePriorityLanes().find(
      (candidate) => priorityGroupKey(candidate.target.userId) === event.groupKey,
    );
    const moved = lane?.queue.items.find((entry) => entry.card?.id === event.cardId);
    if (!lane || !moved) return;

    const fullRest = lane.queue.items.filter((entry) => entry.id !== moved.id);
    let anchor: PriorityAnchor | null;
    if (!this.state.definition().filters.q.trim() && lane.queue.hiddenCount === 0) {
      anchor = priorityAnchorAt(fullRest, event.currentIndex);
    } else {
      // A filtered or partly redacted table only has visible row coordinates. Anchor against the
      // nearest rendered neighbour, never an invisible entry the server deliberately rejects.
      const group = this.priorityTableGroups().find((candidate) => candidate.key === event.groupKey);
      const visibleRest = (group?.cards ?? []).filter((card) => card.id !== event.cardId);
      if (visibleRest.length === 0) return;
      const below = visibleRest[event.currentIndex];
      const neighbour = below ?? visibleRest.at(-1)!;
      const neighbourEntry = fullRest.find((entry) => entry.card?.id === neighbour.id);
      anchor = neighbourEntry
        ? below ? { beforeId: neighbourEntry.id } : { afterId: neighbourEntry.id }
        : null;
    }
    if (!anchor) return;
    this.onLaneReordered({
      targetUserId: lane.target.userId,
      priorityId: moved.id,
      ...anchor,
    });
  }

  onPriorityTableDragStarted(): void {
    // Keep realtime reconciliation from replacing a queue while its table row is in flight, matching
    // the grid lanes' drag lifecycle.
    this.cardDrag.start("team-priority-table");
  }

  onPriorityTableDragEnded(): void {
    this.cardDrag.end();
  }

  onLaneRemoved(event: { targetUserId: string; priorityId: string }): void {
    this.priorityError.set(null);
    void this.state.removeTeamPriority(event.targetUserId, event.priorityId).catch(() => {
      this.priorityError.set("We couldn’t remove that card from Up next. It has been put back.");
    });
  }

  onLaneAdded(event: { targetUserId: string; cardId: string }): void {
    this.priorityError.set(null);
    void this.state.addTeamPriority(event.targetUserId, event.cardId, { beforeId: null }).catch(() => {
      this.priorityError.set("We couldn’t add that card to Up next. Nothing has changed.");
    });
  }

  onPriorityTableAdded(event: { groupKey: string; cardId: string }): void {
    const lane = this.visiblePriorityLanes().find(
      (candidate) => priorityGroupKey(candidate.target.userId) === event.groupKey,
    );
    if (lane) this.onLaneAdded({ targetUserId: lane.target.userId, cardId: event.cardId });
  }

  openChecklistItem(item: WireChecklistAssignment): void {
    const board = this.boardsById().get(item.boardId);
    this.showCard({
      id: item.cardId,
      boardId: item.boardId,
      workspaceId: item.cardWorkspaceId || board?.workspaceId || "",
      organisationKey: item.organisationKey,
      number: item.cardNumber,
      key: item.cardKey,
      listId: item.listId,
      title: item.cardTitle,
      position: "0",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  closeCard(): void {
    void this.navigateToCard(null).then(() => {
      // cardId is modal-only route state. GlobalWorkState already patches card summaries from
      // realtime events and schedules reconciliation after detail mutations, so re-querying here
      // would turn a simple modal close into a page-level loading state and layout shift.
      this.workDoneRefreshVersion.update((version) => version + 1);
    });
  }

  listsForWorkspace(workspaceId: string) {
    return this.boardListsByWorkspace().get(workspaceId) ?? [];
  }

  customFieldsForWorkspace(workspaceId: string): WireCustomField[] {
    return this.boardCustomFieldsByWorkspace().get(workspaceId) ?? [];
  }

  isWorkspaceCollapsed(workspaceId: string): boolean {
    return this.collapsedWorkspaceIds().has(workspaceId);
  }

  isPortfolioRowCollapsed(row: PortfolioRow): boolean {
    if (!row.collapseId) return false;
    return row.level === "organisation"
      ? this.collapsedOrganisationIds().has(row.collapseId)
      : this.collapsedWorkspaceIds().has(row.collapseId);
  }

  /**
   * Collapse persists through the view definition, so the shape survives a reload and travels with a
   * saved view — the same contract the board and card-group collapses use.
   */
  togglePortfolioRow(row: PortfolioRow, event: Event): void {
    event.stopPropagation();
    this.setPortfolioRowCollapsed(row, !this.isPortfolioRowCollapsed(row));
  }

  /** One control for both directions: collapse everything still open, otherwise expand everything. */
  togglePortfolioRowsCollapsed(): void {
    const collapse = !this.portfolioAllCollapsed();
    for (const row of this.portfolioTree()) this.setPortfolioRowCollapsed(row, collapse);
  }

  readonly portfolioGroupCount = computed(() =>
    this.portfolioTree().filter((row) => row.collapseId).length
  );
  readonly portfolioAllCollapsed = computed(() =>
    this.portfolioTree().every((row) => !row.collapseId || this.isPortfolioRowCollapsed(row))
  );

  private setPortfolioRowCollapsed(row: PortfolioRow, collapsed: boolean): void {
    if (!row.collapseId || this.isPortfolioRowCollapsed(row) === collapsed) return;
    if (row.level === "organisation") this.state.toggleOrganisationCollapsed(row.collapseId);
    else this.state.toggleWorkspaceCollapsed(row.collapseId);
  }

  toggleWorkspaceCollapsed(workspaceId: string): void {
    this.state.toggleWorkspaceCollapsed(workspaceId);
  }

  isCardGroupCollapsed(groupId: string): boolean {
    return this.collapsedCardGroupIds().has(groupId);
  }

  toggleCardGroupCollapsed(groupId: string): void {
    this.state.toggleChecklistGroupCollapsed(groupId);
  }

  toggleChecklistSectionCollapsed(): void {
    this.state.toggleChecklistGroupCollapsed(CHECKLIST_SECTION_COLLAPSE_ID);
  }

  canDragCard(card: GlobalCard): boolean {
    return Boolean(
      this.boardInteractionReady()
      && this.draggableCardIds().has(card.id)
    );
  }

  onCardDrop(payload: CardDropPayload, workspaceId: string): void {
    const card = this.state.cards().find((candidate) => candidate.id === payload.cardId);
    const targetList = this.listsById().get(payload.toListId);
    if (
      !card
      || !this.canDragCard(card)
      || card.workspaceId !== workspaceId
      || targetList?.workspaceId !== workspaceId
    ) return;

    const anchor = payload.beforeItem !== undefined
      ? { beforeItem: payload.beforeItem }
      : payload.afterItem !== undefined
        ? { afterItem: payload.afterItem }
        : payload.beforeCardId !== undefined
          ? { beforeItem: payload.beforeCardId ? { type: "card" as const, id: payload.beforeCardId } : null }
          : { afterItem: payload.afterCardId ? { type: "card" as const, id: payload.afterCardId } : null };
    this.moveError.set(null);
    void this.state.moveCard(card.id, payload.toListId, anchor).catch(() => {
      this.moveError.set("We couldn’t move that card. Its previous position has been restored.");
    });
  }

  separatorCreateBaseUrl(workspaceId: string): string | null {
    const targetUserId = this.state.focusedTargetUserId();
    if (!targetUserId || !this.state.separatorWorkspaceIds().has(workspaceId)) return null;
    return `/work/workspaces/${workspaceId}/users/${targetUserId}`;
  }

  onSeparatorCreated(separator: AnySeparator): void {
    if ("workspaceId" in separator && "targetUserId" in separator) this.state.addSeparator(separator);
  }

  onSeparatorUpdated(separator: AnySeparator): void {
    if ("workspaceId" in separator && "targetUserId" in separator) this.state.updateSeparator(separator);
  }

  onSeparatorDrop(payload: SeparatorDropPayload, workspaceId: string): void {
    const targetList = this.listsById().get(payload.toListId);
    if (!this.state.separatorWorkspaceIds().has(workspaceId) || targetList?.workspaceId !== workspaceId) return;
    this.moveError.set(null);
    void this.state.moveSeparator(payload.separatorId, payload.toListId, {
      ...(payload.beforeItem !== undefined ? { beforeItem: payload.beforeItem } : {}),
      ...(payload.afterItem !== undefined ? { afterItem: payload.afterItem } : {}),
    }).catch(() => {
      this.moveError.set("We couldn’t move that separator. Its previous position has been restored.");
    });
  }

  openBoard(boardId: string): void {
    void this.router.navigate(["/b", boardId]);
  }

  openHistoryCard(card: WireCardSummary): void {
    const board = this.boardsById().get(card.boardId);
    if (!board) return;
    this.showCard({
      ...card,
      workspaceId: board.workspaceId,
    });
  }

  private showCard(card: WorkCard): void {
    // The card opens as a drawer over this page, not as a stack layer, and the card click that gets here
    // is stopped at the card (it has to be, or the canvas reads it as a background click). So close the
    // open popovers here rather than leaving one stranded behind the drawer. Every entry point into card
    // detail funnels through this method.
    // `closeAll()` dismisses k-page-toolbar's collapsed body too, since that registers as a layer.
    this.panelStack.closeAll();
    this.routeCardResolution += 1;
    this.pendingRouteCardId = null;
    this.resolvedRouteCardId = card.id;
    this.selectedCard.set(card);
    void this.navigateToCard(card.id, card.organisationKey, card.key);
  }

  private syncCardFromRoute(cardId: string | null, visibleCard: WorkCard | null): void {
    if (!cardId) {
      this.routeCardResolution += 1;
      this.pendingRouteCardId = null;
      this.resolvedRouteCardId = null;
      this.selectedCard.set(null);
      return;
    }
    if (this.resolvedRouteCardId === cardId) return;
    if (visibleCard) {
      this.routeCardResolution += 1;
      this.pendingRouteCardId = null;
      this.resolvedRouteCardId = cardId;
      this.selectedCard.set(visibleCard);
      return;
    }
    if (this.pendingRouteCardId === cardId) return;

    const resolution = ++this.routeCardResolution;
    this.pendingRouteCardId = cardId;
    // The card may not belong to the current lens anymore (or may be beyond its loaded page).
    // Resolve it through the access-checked detail route rather than weakening the work query.
    void this.api.get<WireCardDetail>(`/cards/${cardId}/detail`).then((detail) => {
      if (resolution !== this.routeCardResolution || this.cardId() !== cardId) return;
      const workspaceId = this.state.catalog().boards.find((board) => board.id === detail.card.boardId)?.workspaceId ?? "";
      this.resolvedRouteCardId = cardId;
      this.selectedCard.set({
        id: detail.card.id,
        boardId: detail.card.boardId,
        workspaceId: detail.card.workspaceId || workspaceId,
        organisationKey: detail.card.organisationKey,
        number: detail.card.number,
        key: detail.card.key,
        listId: detail.card.listId,
        title: detail.card.title,
        position: detail.card.position,
        createdAt: detail.card.createdAt,
        updatedAt: detail.card.updatedAt,
        dueDateLocalDate: detail.card.dueDateLocalDate,
        dueDateSlot: detail.card.dueDateSlot,
        dueDateTimezone: detail.card.dueDateTimezone,
        completedAt: detail.card.completedAt,
        archivedAt: detail.card.archivedAt,
        coverAttachmentId: detail.card.coverAttachmentId,
        hasDescription: Boolean(detail.card.description),
        attachmentCount: detail.attachments.length,
        labelIds: detail.labelIds,
        assigneeIds: detail.assigneeIds,
        customFieldValues: detail.customFieldValues,
      });
    }).catch(() => {
      if (resolution === this.routeCardResolution && this.cardId() === cardId) {
        void this.navigateToCard(null);
      }
    }).finally(() => {
      if (resolution === this.routeCardResolution) this.pendingRouteCardId = null;
    });
  }

  private navigateToCard(cardId: string | null, organisationKey?: string, cardKey?: string): Promise<boolean> {
    const route = ({
      my: "/my-cards",
      team: "/team-cards",
      portfolio: "/portfolio",
    } as const)[this.lens()];
    this.cardNavigationTarget.set(cardId);
    return this.router.navigate(cardId ? [route, "c", cardId] : [route], {
      // Strip a legacy query-form id while preserving filters owned by the Global Work URL.
      queryParams: { cardId: null },
      queryParamsHandling: "merge",
      ...(organisationKey && cardKey ? { browserUrl: cardPath(organisationKey, cardKey) } : {}),
    }).then((navigated) => {
      if (!navigated && this.cardNavigationTarget() === cardId) {
        this.cardNavigationTarget.set(undefined);
      }
      return navigated;
    }).catch((error: unknown) => {
      if (this.cardNavigationTarget() === cardId) this.cardNavigationTarget.set(undefined);
      throw error;
    });
  }

  drillDown(source: PortfolioRow | null, metric: PortfolioMetric): void {
    if (!this.state.interactionReady()) return;
    const now = new Date();
    const today = this.localDate(now);
    const nextSeven = new Date(now);
    nextSeven.setDate(nextSeven.getDate() + 7);
    const completedFrom = new Date(now.getTime() - this.state.definition().portfolioDays * 86_400_000).toISOString();
    if (!source) this.state.setScope([], []);
    else if (source.level === "organisation") this.state.setScope(source.workspaceIds, []);
    else if (source.level === "workspace") this.state.setScope([source.workspaceIds[0]!], []);
    else this.state.setScope([], [source.boardIds[0]!]);
    this.state.updateFilters({
      completion: metric === "completed" ? "completed" : "active",
      overdueOnly: metric === "overdue",
      unassignedOnly: metric === "unassigned",
      overdueChecklistOnly: metric === "overdueChecklistItems",
      dueFrom: metric === "dueSoon" ? today : null,
      dueTo: metric === "dueSoon" ? this.localDate(nextSeven) : null,
      completedFrom: metric === "completed" ? completedFrom : null,
      completedTo: metric === "completed" ? now.toISOString() : null,
    });
    this.state.setDisplay("table");
    this.drilldownLabel.set(`${source?.label ?? "All boards"} · ${this.metricLabel(metric)}`);
    this.applyQuery();
  }

  closeDrilldown(): void {
    if (!this.state.interactionReady()) return;
    this.drilldownLabel.set(null);
    this.state.setScope([], []);
    this.state.updateFilters({
      completion: DEFAULT_COMPLETION,
      overdueOnly: false,
      unassignedOnly: false,
      overdueChecklistOnly: false,
      dueFrom: null,
      dueTo: null,
      completedFrom: null,
      completedTo: null,
    });
    this.state.setDisplay("summary");
    this.applyQuery();
  }

  metricLabel(metric: string): string {
    return ({
      active: "Active",
      overdue: "Overdue",
      dueSoon: "Due next 7 days",
      unassigned: "Unassigned",
      completed: `Completed (${this.state.definition().portfolioDays}d)`,
      overdueChecklistItems: "Overdue checklist items",
    } as Record<string, string>)[metric] ?? metric;
  }

  // Board and workspace icons/colours mirror the sidebar rendering so a card's source reads the
  // same everywhere. Colours resolve to the shared --color-* tokens; a null colour inherits.
  boardIconClass(boardId: string): string {
    return `ti ti-${this.boardsById().get(boardId)?.icon || "layout-kanban"}`;
  }

  boardIconColor(boardId: string): string | null {
    const color = this.boardsById().get(boardId)?.iconColor;
    return color ? `var(--color-${color})` : null;
  }

  workspaceIconClass(workspaceId: string): string {
    return `ti ti-${this.workspacesById().get(workspaceId)?.icon || "rocket"}`;
  }

  workspaceIconColor(workspaceId: string): string | null {
    const color = this.workspacesById().get(workspaceId)?.accentColor;
    return color ? `var(--color-${color})` : null;
  }

  listIconClass(listId: string): string {
    return `ti ti-${this.listsById().get(listId)?.icon || "list"}`;
  }

  listIconColor(listId: string): string | null {
    const color = this.listsById().get(listId)?.color;
    return color ? `var(--color-${color})` : null;
  }

  portfolioRowIconClass(row: PortfolioRow): string {
    // A standalone row *is* its board, so it takes the board's icon rather than the wrapper's.
    if (row.level === "board" || row.standalone) return this.boardIconClass(row.boardIds[0] ?? "");
    if (row.level === "workspace") return this.workspaceIconClass(row.workspaceIds[0] ?? "");
    return "ti ti-building";
  }

  portfolioRowIconColor(row: PortfolioRow): string | null {
    if (row.level === "board" || row.standalone) return this.boardIconColor(row.boardIds[0] ?? "");
    if (row.level === "workspace") return this.workspaceIconColor(row.workspaceIds[0] ?? "");
    return null;
  }

  localDateLabel(value: string, style: "full" | "medium" = "medium"): string {
    const date = new Date(`${value}T12:00:00`);
    return date.toLocaleDateString(undefined, style === "full"
      ? { weekday: "long", year: "numeric", month: "long", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" });
  }

  isChecklistOverdue(item: WireChecklistAssignment): boolean {
    return isOverdue(item.dueDateLocalDate, item.dueDateSlot, item.dueDateTimezone);
  }

  checklistDueText(item: WireChecklistAssignment): string {
    return formatDueDate(item.dueDateLocalDate, item.dueDateSlot, item.dueDateTimezone) || "No due date";
  }

  listNameById(listId: string): string {
    return this.listsById().get(listId)?.name ?? "Unknown list";
  }

  /**
   * Assigned checklist items bucketed by urgency, using the same vocabulary as the cards' due-date
   * grouping ("Overdue", "Due today", "Next 7 days", "Later", "No due date").
   *
   * The section is a work queue, so it groups by *when* regardless of how the cards above are
   * grouped: a flat list of items gives no sense of what to pick up next, and grouping by source
   * would scatter the overdue ones across boards.
   */
  readonly checklistGroups = computed<ChecklistGroup[]>(() => {
    const items = this.state.response().checklistItems;
    if (items.length === 0) return [];
    const today = this.localDate(new Date());
    const nextSeven = new Date();
    nextSeven.setDate(nextSeven.getDate() + 7);
    const weekEnd = this.localDate(nextSeven);
    const groups: ChecklistGroup[] = [
      { id: "checklist:overdue", label: "Overdue", icon: "alert-circle", overdue: true, items: [] },
      { id: "checklist:today", label: "Due today", icon: "calendar-event", overdue: false, items: [] },
      { id: "checklist:upcoming", label: "Next 7 days", icon: "calendar-week", overdue: false, items: [] },
      { id: "checklist:later", label: "Later", icon: "calendar", overdue: false, items: [] },
      { id: "checklist:undated", label: "No due date", icon: "calendar-off", overdue: false, items: [] },
    ];
    for (const item of items) {
      const due = item.dueDateLocalDate;
      // Overdue is checked first: an item due today with a morning slot is already late by the
      // afternoon, so the date alone cannot decide the bucket.
      const index = this.isChecklistOverdue(item) ? 0
        : !due ? 4
        : due <= today ? 1
        : due <= weekEnd ? 2
        : 3;
      groups[index]!.items.push(item);
    }
    for (const group of groups) {
      group.items.sort((a, b) =>
        (a.dueDateLocalDate ?? "9999-12-31").localeCompare(b.dueDateLocalDate ?? "9999-12-31")
        || a.text.localeCompare(b.text)
      );
    }
    return groups.filter((group) => group.items.length > 0);
  });

  readonly overdueChecklistCount = computed(() =>
    this.state.response().checklistItems.filter((item) => this.isChecklistOverdue(item)).length
  );

  workspaceName(workspaceId: string): string {
    return this.workspacesById().get(workspaceId)?.name ?? "Workspace";
  }

  private localDate(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private rollupPortfolioRow(
    id: string,
    level: "organisation" | "workspace",
    label: string,
    context: string,
    organisationId: string,
    workspaceId: string | null,
    buckets: PortfolioBucket[],
  ): PortfolioRow {
    return buckets.reduce<PortfolioRow>((row, bucket) => ({
      ...row,
      workspaceIds: row.workspaceIds.includes(bucket.workspaceId)
        ? row.workspaceIds
        : [...row.workspaceIds, bucket.workspaceId],
      boardIds: [...row.boardIds, bucket.boardId],
      active: row.active + bucket.active,
      overdue: row.overdue + bucket.overdue,
      dueSoon: row.dueSoon + bucket.dueSoon,
      unassigned: row.unassigned + bucket.unassigned,
      completed: row.completed + bucket.completed,
      overdueChecklistItems: row.overdueChecklistItems + bucket.overdueChecklistItems,
    }), {
      id,
      level,
      label,
      context,
      collapseId: workspaceId ?? organisationId,
      standalone: false,
      organisationId,
      workspaceId,
      workspaceIds: [],
      boardIds: [],
      active: 0,
      overdue: 0,
      dueSoon: 0,
      unassigned: 0,
      completed: 0,
      overdueChecklistItems: 0,
    });
  }
}
