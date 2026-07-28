import type { ElementRef, OnDestroy, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, viewChild } from "@angular/core";
import { Router } from "@angular/router";
import type {
  PortfolioBucket,
  WorkCard,
  WorkCatalogBoard,
  WorkCatalogList,
  WorkCustomFieldCondition,
  WorkDisplayMode,
  WorkGroupBy,
  WorkSort,
} from "@kanera/shared/dto";
import type { WireCardDetail, WireCardSummary, WireChecklistAssignment, WireCustomField } from "@kanera/shared/events";
import type { WorkViewLens } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { AnchoredPickerPopover } from "../../shared/anchored-picker.popover";
import { PageHeaderComponent } from "../../shared/page-header.component";
import { PageToolbarComponent } from "../../shared/page-toolbar.component";
import { PanelStackService } from "../../shared/panel-stack.service";
import { SearchFieldComponent } from "../../shared/search-field.component";
import { SegmentedComponent, type SegmentedOption } from "../../shared/segmented.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { ActivityStripComponent, type ActivityStripSeries } from "../../shared/activity-strip.component";
import { StatTileComponent } from "../../shared/stat-tile.component";
import { AvatarComponent } from "../../shared/avatar.component";
import { BoardCanvasComponent } from "../board/board-canvas.component";
import { BoardMenuCoordinator } from "../board/board-menu-coordinator.service";
import { BoardCalendarViewComponent } from "../board/calendar-view/board-calendar-view.component";
import { BoardState, type AnySeparator, type BoardLaneItem } from "../board/board-state";
import { formatDueDate, isOverdue } from "../board/due-date.util";
import { FilterBarComponent } from "../board/table-view/filter-bar.component";
import { ListComponent, type CardDropPayload, type SeparatorDropPayload, type StartAddPayload } from "../board/list.component";
import { WorkDoneViewComponent } from "../board/work-done-view/work-done-view.component";
import { BoardTableViewComponent } from "../board/table-view/board-table-view.component";
import { TABLE_CARD_STORE, type TableCardStore } from "../board/table-view/table-card-store";
import type {
  AnyCustomField,
  AnyLabel,
  AnyList,
  AnyMember,
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
import { SaveViewPopover } from "./save-view.popover";
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
  readonly effectiveDisplay = computed<WorkDisplayMode>(() =>
    this.state.cachedAt() && this.state.definition().display === "history"
      ? "table"
      : this.state.definition().display
  );
  readonly historyOfflineFallback = computed(() =>
    this.state.cachedAt() !== null && this.state.definition().display === "history"
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
    if (this.queryTimer !== null) clearTimeout(this.queryTimer);
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

  clearFilters(): void {
    this.state.updateFilters({
      assigneeIds: [],
      listIds: [],
      labelIds: [],
      customFieldConditions: [],
      completion: DEFAULT_COMPLETION,
      unassignedOnly: false,
      overdueOnly: false,
      unreadOnly: false,
      archived: false,
      completedFrom: null,
      completedTo: null,
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

  openChecklistItem(item: WireChecklistAssignment): void {
    const board = this.boardsById().get(item.boardId);
    this.showCard({
      id: item.cardId,
      boardId: item.boardId,
      workspaceId: board?.workspaceId ?? "",
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
    const targetUserId = this.state.separatorTargetUserId();
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
    void this.navigateToCard(card.id);
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
        workspaceId,
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

  private navigateToCard(cardId: string | null): Promise<boolean> {
    const route = ({
      my: "/my-cards",
      team: "/team-cards",
      portfolio: "/portfolio",
    } as const)[this.lens()];
    this.cardNavigationTarget.set(cardId);
    return this.router.navigate([route], {
      queryParams: { cardId },
      queryParamsHandling: "merge",
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
