import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import { cardPath } from "@kanera/shared/card-links";
import type { CardRelationSummary, DependencyGraphBody, DependencyGraphResponse } from "@kanera/shared/dto";
import { expandCardSummary, SERVER_EVENTS, type WireCardSummary, type WireCustomField } from "@kanera/shared/events";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { icu } from "../../core/i18n/icu";
import { SocketService } from "../../core/realtime/socket.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { localDateKey } from "../../shared/day-key.util";
import { formatDate, formatRelativeTime } from "../../shared/date-format";
import { EmptyStateComponent } from "../../shared/empty-state.component";
import { SegmentedComponent, type SegmentedOption } from "../../shared/segmented.component";
import { ToastService } from "../../shared/toast.service";
import { KeyboardShortcutsService } from "../../core/keyboard/keyboard-shortcuts.service";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { CardLabelsComponent, type CardLabelPresentation } from "../board/card-labels.component";
import { isPlainPrimaryClick } from "../board/card-navigation.util";
import { formatDueDate, isOverdue } from "../board/due-date.util";
import {
  chainHeaderHeight,
  chainNeighbourhood,
  layoutDependencyMap,
  MAP_PADDING,
  NO_DUE_DATE,
  nodeMatchesFilter,
  packChains,
  STEP_LABEL_HEIGHT,
  TILE_WIDTH,
  WAVE_GAP,
  weekColumnKey,
  weekColumnStart,
  type DependencyFilter,
  type MapChain,
  type MapEdge,
  type MapNode,
} from "./dependency-map.layout";
import { readDependencyPreference, updateDependencyPreference, type DependencyLayout } from "./dependency-layout";
import { tileContent, tileFields, tileHeight, type TileContent, type TileDensity } from "./dependency-map.tile";

type ScopeMode = "board" | "workspace";

interface StoredPreference {
  scope?: ScopeMode;
  showRelated?: boolean;
  slim?: boolean;
  critical?: boolean;
}

/**
 * A dependency being drawn from a card's handle. `press`: the handle is down and may become a drag
 * or a tap. `drag`: a connector follows the pointer (`line`, in the source chain's canvas). `pick`:
 * a tap or a keypress started it, and the next card chosen becomes the dependent.
 */
interface LinkDraft {
  fromId: string;
  mode: "press" | "drag" | "pick";
  line: { chainId: string; x1: number; y1: number; x2: number; y2: number } | null;
  overId: string | null;
}

/** A connector picked for removal, and where its Remove button sits in its chain's canvas. */
interface EdgeSelection {
  id: string;
  chainId: string;
  x: number;
  y: number;
}

/**
 * One dependency the viewer changed on this map, with what it takes to reverse it: `added` says
 * whether the change created the relation or removed it. `source`/`target` are the blocker and the
 * dependent for `blocks`. `pathId` is the end the write goes through, one on a board the viewer edits.
 */
interface RelationEdit {
  kind: MapEdge["kind"];
  sourceId: string;
  sourceKey: string;
  targetId: string;
  targetKey: string;
  pathId: string;
  added: boolean;
  /** The relation's id while it exists; putting it back creates a new one. */
  relationId: string | null;
}

/** How many changes the history keeps. */
const HISTORY_LIMIT = 50;
/** Pointer travel, in px, that turns a press on a link handle into a drag rather than a tap. */
const DRAG_THRESHOLD = 4;

/** Coalesces a burst of card events (a bulk move, an automation) into one re-read. */
const REFRESH_DEBOUNCE_MS = 400;
/**
 * How long a tile's highlight outlives the pointer leaving it. Crossing the gap to the next tile
 * would otherwise undim the whole chain for a frame and dim it again: a flicker on every move.
 */
const FOCUS_RELEASE_MS = 120;

const EMPTY_TILE: TileContent = { labels: [], fields: [] };

let nextInstanceId = 0;

/**
 * The Dependencies view: every blocking chain in a scope, laid out left to right in steps, with the
 * cards that need attention (blocked, at risk, holding others up) easy to pick out.
 *
 * Modelled on Jira's dependencies view rather than a Gantt chart: monday.com, Asana and ClickUp draw
 * dependencies as arrows between dated bars, which needs start dates Kanera cards don't have. A map
 * of the chains themselves works whether or not anything is dated, and dates still matter where
 * they exist: a blocker due after the card it blocks, or already overdue, marks that link at risk.
 *
 * The component owns its data. Hosts pass a scope — a board (optionally offering its whole
 * workspace) or the card ids a Global Work lens has loaded — and the map reads the graph itself,
 * so off-board cards render without the host holding them. It joins the board rooms of every board
 * on the map and re-reads when a card on it changes or a relation appears on a board it watches.
 */
@Component({
  selector: "k-dependency-map",
  standalone: true,
  imports: [AvatarComponent, CardLabelsComponent, EmptyStateComponent, SegmentedComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./dependency-map.component.html",
  styleUrl: "./dependency-map.component.scss",
  host: { "[class.is-stacked]": "stacked()", "(keydown.escape)": "cancelEditing()" },
})
export class DependencyMapComponent implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly sockets = inject(SocketService);
  private readonly auth = inject(AuthService);
  private readonly offlineCache = inject(OfflineCacheService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly toasts = inject(ToastService);
  private readonly shortcuts = inject(KeyboardShortcutsService);

  /** Board scope. With `workspaceId`, the map also offers the board's whole workspace. */
  readonly boardId = input<string | null>(null);
  readonly workspaceId = input<string | null>(null);
  /** Card scope, for Global Work: the lens's loaded cards. Takes precedence over `boardId`. */
  readonly cardIds = input<readonly string[] | null>(null);
  /** Key for the remembered scope and toggles. */
  readonly preferenceScope = input.required<string>();
  /** Map, Timeline or Steps. The host owns the switch, in its toolbar (see `dependencyLayoutState`). */
  readonly layoutMode = input.required<DependencyLayout>();
  /**
   * The host's search and filter result over its own cards, or null when nothing narrows it.
   * A chain stays on the map while any of its in-scope cards matches; cards from elsewhere in the
   * workspace are context and never filtered out on their own.
   */
  readonly hostCardIds = input<ReadonlySet<string> | null>(null);
  readonly selectedCardId = input<string | null>(null);
  /** Bumped by the host to force a re-read (Global Work's reconciliation after a reconnect). */
  readonly refreshVersion = input(0);
  /** Inside a page that scrolls itself (Global Work) rather than filling a fixed-height view. */
  readonly stacked = input(false);

  readonly cardOpened = output<WireCardSummary>();

  readonly instanceId = `dm${nextInstanceId++}`;
  readonly tileWidth = TILE_WIDTH;
  readonly chainHeadHeight = chainHeaderHeight;
  readonly stepLabelHeight = STEP_LABEL_HEIGHT;

  readonly scopeMode = signal<ScopeMode>("board");
  readonly showRelated = signal(false);
  /** Detailed tiles carry labels and card-face fields like a board card; slim ones only key and title. */
  readonly density = signal<TileDensity>("detailed");
  /** Highlight each chain's critical path and fade the rest. */
  readonly critical = signal(false);
  readonly filter = signal<DependencyFilter>("all");
  readonly linkDraft = signal<LinkDraft | null>(null);
  readonly selectedEdge = signal<EdgeSelection | null>(null);
  readonly hoveredEdgeId = signal<string | null>(null);
  private readonly undoStack = signal<readonly RelationEdit[]>([]);
  private readonly redoStack = signal<readonly RelationEdit[]>([]);
  /** One history step at a time, so a held-down Ctrl+Z cannot interleave two writes. */
  private readonly historyBusy = signal(false);
  private historyToast: number | null = null;
  /** The Monday of this week on the date axis, for the "This week" column. Fixed for the page's life. */
  private readonly thisWeek = weekColumnKey(localDateKey(new Date()));
  readonly focusedId = signal<string | null>(null);
  private focusReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** The map's content width, for packing chain boxes. */
  private readonly hostWidth = signal(0);

  readonly response = signal<DependencyGraphResponse | null>(null);
  /** Set while the map is an offline snapshot; cleared by the next successful read. */
  readonly cachedAt = signal<string | null>(null);
  readonly offlineCopyLabel = computed(() => {
    const cachedAt = this.cachedAt();
    return cachedAt ? $localize`:Dependencies view note; a relative time such as "5 minutes ago" follows:Offline copy from ${formatRelativeTime(cachedAt)}:time:` : "";
  });
  readonly loading = signal(false);
  readonly loadFailed = signal(false);
  private loadSeq = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly roomLeaves = new Map<string, () => void>();

  readonly offersWorkspace = computed(() => !this.cardIds() && Boolean(this.boardId() && this.workspaceId()));

  readonly request = computed<DependencyGraphBody | null>(() => {
    const ids = this.cardIds();
    if (ids) return ids.length ? { cardIds: [...new Set(ids)].slice(0, 2000) } : null;
    const boardId = this.boardId();
    if (!boardId) return null;
    const workspaceId = this.workspaceId();
    return this.scopeMode() === "workspace" && workspaceId ? { workspaceId } : { boardId };
  });
  /** The request as a primitive, so the load effect keys on what is asked rather than on object identity. */
  private readonly requestKey = computed(() => {
    const request = this.request();
    if (!request) return "";
    return "cardIds" in request ? `cards:${[...request.cardIds].sort().join(",")}` : JSON.stringify(request);
  });
  private readonly cardScopeIds = computed(() => new Set(this.cardIds() ?? []));
  /** Which name a tile shows beside its key: the list when the whole map is one board, else the board. */
  readonly multiBoard = computed(() => Boolean(this.cardIds()) || this.scopeMode() === "workspace");

  readonly scopeOptions: SegmentedOption<ScopeMode>[] = [
    { id: "board", icon: "layout-kanban", label: $localize`:Dependencies view scope switch - only chains that touch this board:This board` },
    { id: "workspace", icon: "building", label: $localize`:Dependencies view scope switch - every chain in the board's workspace:Workspace` },
  ];

  readonly boardsById = computed(() => new Map((this.response()?.boards ?? []).map((board) => [board.id, board])));
  readonly listsById = computed(() => new Map((this.response()?.lists ?? []).map((list) => [list.id, list])));
  readonly peopleById = computed(() => new Map((this.response()?.people ?? []).map((person) => [person.userId, person])));
  private readonly labelsById = computed(() => new Map<string, CardLabelPresentation>((this.response()?.labels ?? []).map((label) => [label.id, label])));
  private readonly fieldsByWorkspace = computed(() => {
    const byWorkspace = new Map<string, WireCustomField[]>();
    for (const field of this.response()?.customFields ?? []) {
      const fields = byWorkspace.get(field.workspaceId);
      if (fields) fields.push(field);
      else byWorkspace.set(field.workspaceId, [field]);
    }
    return byWorkspace;
  });
  /** What each tile shows beyond key and title, which also decides how tall it is. */
  readonly tileContents = computed(() => {
    const labels = this.labelsById();
    const fields = this.fieldsByWorkspace();
    return new Map((this.response()?.cards ?? []).map((card) => [card.id, tileContent(expandCardSummary(card), labels, fields)]));
  });

  readonly layout = computed(() => {
    const response = this.response();
    const cards = (response?.cards ?? []).map((card) => ({ ...expandCardSummary(card), inScope: card.inScope }));
    const contents = this.tileContents();
    const density = this.density();
    return layoutDependencyMap(cards, response?.edges ?? [], {
      showRelated: this.showRelated(),
      axis: this.layoutMode() === "timeline" ? "dates" : "steps",
      tileHeight: (card) => tileHeight(contents.get(card.id) ?? EMPTY_TILE, density),
    });
  });

  /** Chains in view: at least one in-scope card passes the host's filter and one card the map filter. */
  readonly visibleChains = computed(() => {
    const host = this.hostCardIds();
    const filter = this.filter();
    return this.layout().chains.filter((chain) =>
      (!host || chain.nodes.some((node) => node.inScope && host.has(node.id)))
      && chain.nodes.some((node) => nodeMatchesFilter(node, filter))
    );
  });

  /** Cards to ring as matches. Only when something narrows the map; otherwise every card would ring. */
  readonly matchedIds = computed<ReadonlySet<string> | null>(() => {
    const host = this.hostCardIds();
    const filter = this.filter();
    if (!host && filter === "all") return null;
    const ids = new Set<string>();
    for (const node of this.layout().nodesById.values()) {
      if ((!host || (node.inScope && host.has(node.id))) && nodeMatchesFilter(node, filter)) ids.add(node.id);
    }
    return ids;
  });

  /** Where each chain box sits in the map layout. */
  readonly packing = computed(() => {
    const chains = this.visibleChains();
    // The observer reports after the next frame; until then, measure, so the first packing of a
    // freshly loaded map is already the right width instead of jumping into place.
    return packChains(chains, this.hostWidth() || contentWidth(this.host.nativeElement));
  });

  /** Boards whose cards the viewer may add and remove dependencies on (editor access). */
  private readonly editableBoardIds = computed(() => new Set((this.response()?.boards ?? []).filter((board) => board.canEdit).map((board) => board.id)));
  readonly canEditAny = computed(() => this.editableBoardIds().size > 0);

  /**
   * Cards the card being linked can block: open, on a board the viewer edits (the relation is
   * written from the dependent's side), not already waiting on it, and not upstream of it, which
   * would close a loop the server refuses anyway.
   */
  readonly linkTargets = computed<ReadonlySet<string> | null>(() => {
    const draft = this.linkDraft();
    if (!draft) return null;
    const nodes = this.layout().nodesById;
    const source = nodes.get(draft.fromId);
    if (!source) return new Set();
    const upstream = new Set<string>();
    const stack = [...source.blockerIds];
    while (stack.length) {
      const id = stack.pop()!;
      if (upstream.has(id)) continue;
      upstream.add(id);
      stack.push(...(nodes.get(id)?.blockerIds ?? []));
    }
    const editable = this.editableBoardIds();
    const targets = new Set<string>();
    for (const node of nodes.values()) {
      if (node.id === source.id || node.status === "done" || !editable.has(node.card.boardId)) continue;
      if (source.dependentIds.includes(node.id) || upstream.has(node.id)) continue;
      targets.add(node.id);
    }
    return targets;
  });

  private readonly criticalNodeIds = computed<ReadonlySet<string> | null>(() =>
    this.critical() ? new Set(this.layout().chains.flatMap((chain) => [...chain.critical.nodeIds])) : null);
  private readonly criticalEdgeIds = computed<ReadonlySet<string> | null>(() =>
    this.critical() ? new Set(this.layout().chains.flatMap((chain) => [...chain.critical.edgeIds])) : null);

  readonly neighbourhood = computed(() => {
    const id = this.focusedId();
    return id ? chainNeighbourhood(this.layout().nodesById, id) : null;
  });

  /**
   * Cards to fade while one is focused: the rest of its own chain. Other chains are left alone, so
   * moving between chains only redraws the two involved instead of fading the whole map in and out.
   */
  private readonly dimmedIds = computed<ReadonlySet<string> | null>(() => {
    const lit = this.neighbourhood();
    const id = this.focusedId();
    // While a dependency is being drawn the tiles show which cards can take it instead.
    if (!lit || !id || this.linkDraft()) return null;
    const chain = this.layout().chains.find((candidate) => candidate.nodes.some((node) => node.id === id));
    return new Set((chain?.nodes ?? []).filter((node) => !lit.has(node.id)).map((node) => node.id));
  });

  readonly stats = computed(() => {
    const totals = this.layout().totals;
    const chains = this.layout().chains.length;
    const stat = (id: DependencyFilter, count: number, icon: string, label: string, tooltip: string) => ({ id, count, icon, label, tooltip });
    return [
      stat("all", chains, "git-merge",
        icu($localize`:Dependencies view summary - number of dependency chains shown:{count, plural, one {chain} other {chains}}`, { count: chains }),
        $localize`:Tooltip on the Dependencies view chain count:Show every chain`),
      stat("blocked", totals.blocked, "lock",
        $localize`:Dependencies view summary - open cards still waiting on an open blocker:Blocked`,
        $localize`:Tooltip on the Dependencies view Blocked count:Cards waiting on a blocker that is still open`),
      stat("atRisk", totals.atRisk, "alert-triangle",
        $localize`:Dependencies view summary - cards whose blocker is overdue or due after them:At risk`,
        $localize`:Tooltip on the Dependencies view At risk count:Cards whose blocker is overdue or due after them`),
      stat("starter", totals.starter, "player-play",
        $localize`:Dependencies view summary - unblocked cards that other open work waits on:Start here`,
        $localize`:Tooltip on the Dependencies view Start here count:Nothing blocks these, and other open work waits on them`),
      stat("ready", totals.ready, "lock-open",
        $localize`:Dependencies view summary - cards whose blockers are all done:Ready`,
        $localize`:Tooltip on the Dependencies view Ready count:Every blocker is done, so these can start`),
    ];
  });

  /** The single card holding up the most open work, the first thing worth unblocking. */
  readonly topBottleneck = computed(() => {
    let best: MapNode | null = null;
    for (const node of this.layout().nodesById.values()) {
      if (node.status === "done" || node.holdsUp < 2) continue;
      if (!best || node.holdsUp > best.holdsUp) best = node;
    }
    return best;
  });

  constructor() {
    // Ctrl+Z while typing, or inside a card or dialog opened over the map, belongs to that, not to
    // the map's history.
    const onMap = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return true;
      if (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return false;
      return !active.closest("k-card-detail, [role='dialog']");
    };
    this.shortcuts.registerAll($localize`:Keyboard shortcut group heading for the Dependencies view:Dependencies`, [
      { keys: "mod+z", label: $localize`:Keyboard shortcut description on the Dependencies view:Undo the last dependency change`, when: () => this.undoStack().length > 0 && onMap(), run: () => void this.undo() },
      { keys: "mod+shift+z", label: $localize`:Keyboard shortcut description on the Dependencies view:Redo the dependency change`, when: () => this.redoStack().length > 0 && onMap(), run: () => void this.redo() },
    ], this.destroyRef);
    effect(() => {
      const scope = this.preferenceScope();
      const stored = readPreference(scope);
      untracked(() => {
        this.scopeMode.set(stored.scope === "workspace" ? "workspace" : "board");
        this.showRelated.set(stored.showRelated === true);
        this.density.set(stored.slim ? "slim" : "detailed");
        this.critical.set(stored.critical === true);
      });
    });
    // A focus or a half-drawn link belongs to the layout it started in; switching drops both.
    let shownLayout: DependencyLayout | null = null;
    effect(() => {
      const layout = this.layoutMode();
      untracked(() => {
        if (shownLayout !== null && shownLayout !== layout) {
          this.focusedId.set(null);
          this.cancelEditing();
        }
        shownLayout = layout;
      });
    });
    effect(() => {
      const key = this.requestKey();
      this.refreshVersion();
      untracked(() => {
        if (!key) {
          this.loadSeq++;
          this.response.set({ cards: [], edges: [], boards: [], lists: [], labels: [], people: [], customFields: [], truncated: false });
          this.loading.set(false);
          this.syncRooms([]);
          return;
        }
        void this.load();
      });
    });
  }

  ngOnInit(): void {
    const element = this.host.nativeElement;
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => this.hostWidth.set(entries[0]?.contentRect.width ?? 0));
      observer.observe(element);
      this.destroyRef.onDestroy(() => observer.disconnect());
    }

    const socket = this.sockets.connect();
    const onMap = (cardId: string) => this.layout().nodesById.has(cardId);
    const cardChanged = ({ cardId }: { cardId: string }) => {
      if (onMap(cardId)) this.scheduleRefresh();
    };
    const updated = ({ card }: { card: { id: string } }) => cardChanged({ cardId: card.id });
    // A relation can appear between two cards that are not on the map yet; the board room that
    // carries it says so. Any board this map watches counts, since a chain may cross into it.
    const linksChanged = ({ boardId, cardId }: { boardId: string; cardId: string }) => {
      if (onMap(cardId) || this.cardScopeIds().has(cardId) || boardId === this.boardId() || this.roomLeaves.has(boardId)) this.scheduleRefresh();
    };
    const reconnected = () => this.scheduleRefresh();
    socket.on(SERVER_EVENTS.CARD_UPDATED, updated);
    socket.on(SERVER_EVENTS.CARD_MOVED, cardChanged);
    socket.on(SERVER_EVENTS.CARD_DELETED, cardChanged);
    socket.on(SERVER_EVENTS.CARD_LABELS_SET, cardChanged);
    socket.on(SERVER_EVENTS.CARD_ASSIGNEES_SET, cardChanged);
    socket.on(SERVER_EVENTS.CARD_LINKS_CHANGED, linksChanged);
    // Tiles show custom fields, and a card shared with or withdrawn from this viewer joins or
    // leaves the map (or turns into an off-map blocker), so both need a fresh read.
    socket.on(SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, cardChanged);
    socket.on(SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED, cardChanged);
    socket.on(SERVER_EVENTS.CARD_VISIBILITY_GRANTED, linksChanged);
    socket.on(SERVER_EVENTS.CARD_VISIBILITY_REVOKED, linksChanged);
    socket.on("connect", reconnected);
    this.destroyRef.onDestroy(() => {
      socket.off(SERVER_EVENTS.CARD_UPDATED, updated);
      socket.off(SERVER_EVENTS.CARD_MOVED, cardChanged);
      socket.off(SERVER_EVENTS.CARD_DELETED, cardChanged);
      socket.off(SERVER_EVENTS.CARD_LABELS_SET, cardChanged);
      socket.off(SERVER_EVENTS.CARD_ASSIGNEES_SET, cardChanged);
      socket.off(SERVER_EVENTS.CARD_LINKS_CHANGED, linksChanged);
      socket.off(SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, cardChanged);
      socket.off(SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED, cardChanged);
      socket.off(SERVER_EVENTS.CARD_VISIBILITY_GRANTED, linksChanged);
      socket.off(SERVER_EVENTS.CARD_VISIBILITY_REVOKED, linksChanged);
      socket.off("connect", reconnected);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      if (this.focusReleaseTimer) clearTimeout(this.focusReleaseTimer);
      this.loadSeq++;
      this.syncRooms([]);
    });
  }

  async load(): Promise<void> {
    const request = this.request();
    if (!request) return;
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.loadFailed.set(false);
    const cacheKey = this.cacheKey();
    try {
      const response = await this.api.post<DependencyGraphResponse>("/cards/dependency-graph", request);
      if (seq !== this.loadSeq) return;
      this.response.set(response);
      this.cachedAt.set(null);
      this.syncRooms(response.boards.map((board) => board.id));
      void cacheKey.then((key) => key ? this.offlineCache.saveDependencyGraph(key, response) : undefined).catch(() => undefined);
    } catch {
      // Offline (or the read failed): fall back to this exact map's last snapshot. Its board rooms
      // are joined so the reconnect refresh replaces it as soon as the socket is back.
      const key = await cacheKey.catch(() => null);
      const cached = key ? await this.offlineCache.loadDependencyGraph(key).catch(() => null) : null;
      if (seq !== this.loadSeq) return;
      if (cached) {
        this.response.set(cached.response);
        this.cachedAt.set(cached.cachedAt);
        this.syncRooms(cached.response.boards.map((board) => board.id));
      } else if (!this.response()) {
        // A re-read keeps the map it has; only a first load with nothing to show reports the failure.
        this.loadFailed.set(true);
      }
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  /**
   * Per user (the graph is filtered to what they may open) and per request. A card-set request can
   * name 2000 cards, so the request part is hashed rather than stored as the key itself.
   */
  private async cacheKey(): Promise<string | null> {
    const user = this.auth.user();
    const requestKey = this.requestKey();
    if (!user || !requestKey || typeof crypto === "undefined" || !crypto.subtle) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestKey));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${user.clientId}:${user.id}:${hash}`;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.load();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Ref-counted joins, so rooms the host already holds are shared rather than left and rejoined. */
  private syncRooms(boardIds: readonly string[]): void {
    const wanted = new Set(boardIds);
    for (const id of wanted) {
      if (!this.roomLeaves.has(id)) this.roomLeaves.set(id, this.sockets.joinBoard(id));
    }
    for (const [id, leave] of [...this.roomLeaves]) {
      if (wanted.has(id)) continue;
      leave();
      this.roomLeaves.delete(id);
    }
  }

  setScope(scope: ScopeMode): void {
    this.scopeMode.set(scope);
    this.focusedId.set(null);
    this.persist();
  }

  toggleCritical(): void {
    this.critical.update((value) => !value);
    this.persist();
  }

  toggleSlim(): void {
    this.density.update((density) => (density === "slim" ? "detailed" : "slim"));
    this.focusedId.set(null);
    this.persist();
  }

  toggleRelated(): void {
    this.showRelated.update((value) => !value);
    this.persist();
  }

  setFilter(filter: DependencyFilter): void {
    // Pressing the active stat again goes back to everything, like the board overview's counts.
    this.filter.set(this.filter() === filter ? "all" : filter);
  }

  private persist(): void {
    writePreference(this.preferenceScope(), {
      scope: this.scopeMode(),
      showRelated: this.showRelated(),
      ...(this.density() === "slim" ? { slim: true } : {}),
      ...(this.critical() ? { critical: true } : {}),
    });
  }

  focus(id: string): void {
    if (this.focusReleaseTimer) clearTimeout(this.focusReleaseTimer);
    this.focusReleaseTimer = null;
    this.focusedId.set(id);
  }

  /** Lets go of the highlight a beat later, so moving straight onto another tile hands it over. */
  releaseFocus(): void {
    if (this.focusReleaseTimer) clearTimeout(this.focusReleaseTimer);
    this.focusReleaseTimer = setTimeout(() => {
      this.focusReleaseTimer = null;
      this.focusedId.set(null);
    }, FOCUS_RELEASE_MS);
  }

  open(event: MouseEvent, node: MapNode): void {
    // While picking the card a new dependency blocks, a click chooses rather than opens.
    const draft = this.linkDraft();
    if (draft) {
      event.preventDefault();
      if (this.linkTargets()?.has(node.id)) {
        this.linkDraft.set(null);
        void this.link(draft.fromId, node.id);
      } else if (node.id === draft.fromId) {
        this.linkDraft.set(null);
      }
      return;
    }
    // Modified clicks keep the browser's own new-tab behaviour on the real href.
    if (!isPlainPrimaryClick(event)) return;
    event.preventDefault();
    this.cardOpened.emit(node.card);
  }

  href(node: MapNode): string {
    return cardPath(node.card.organisationKey, node.card.key);
  }

  isDim(id: string): boolean {
    return this.dimmedIds()?.has(id) ?? false;
  }

  isEdgeLit(edge: MapEdge): boolean {
    const neighbourhood = this.neighbourhood();
    return Boolean(neighbourhood?.has(edge.from) && neighbourhood.has(edge.to));
  }

  edgeTone(edge: MapEdge): "related" | "cleared" | "risk" | "lit" | "critical" | "plain" {
    if (edge.kind === "relates_to") return "related";
    if (edge.id === this.selectedEdge()?.id || edge.id === this.hoveredEdgeId()) return "lit";
    if (this.isEdgeLit(edge)) return edge.atRisk ? "risk" : "lit";
    // With the critical path on, its links read as one run even where one of them is at risk;
    // the at-risk card keeps its own amber ring.
    if (this.criticalEdgeIds()?.has(edge.id)) return "critical";
    if (edge.atRisk) return "risk";
    return edge.cleared ? "cleared" : "plain";
  }

  wireClass(edge: MapEdge): string {
    let name = `dm-wire is-${this.edgeTone(edge)}`;
    if (this.isDim(edge.from) || this.isDim(edge.to)) name += " is-dim";
    else if (this.isOffPath(edge.from) || this.isOffPath(edge.to)) name += " is-offpath";
    return name;
  }

  markerUrl(edge: MapEdge): string | null {
    const tone = this.edgeTone(edge);
    return tone === "related" ? null : `url(#${this.instanceId}-arrow-${tone})`;
  }

  /** On the critical path, with the highlight on. */
  isCritical(id: string): boolean {
    return this.criticalNodeIds()?.has(id) ?? false;
  }

  /** Faded while the critical path is on: a card of a chain that has one, but not on it. */
  isOffPath(id: string): boolean {
    const ids = this.criticalNodeIds();
    if (!ids || ids.has(id)) return false;
    return this.layout().chains.some((chain) => chain.critical.nodeIds.size > 0 && chain.nodes.some((node) => node.id === id));
  }

  criticalLabel(chain: MapChain): string {
    return icu($localize`:Dependencies view chain badge - how many cards are on the chain's critical path:{count, plural, one {1 card on the critical path} other {# cards on the critical path}}`, { count: chain.critical.nodeIds.size });
  }

  /* Adding and removing dependencies on the map. */

  /** A card can block another while it is open; the dependent decides whether the viewer may write. */
  canLinkFrom(node: MapNode): boolean {
    return node.status !== "done" && this.canEditAny();
  }

  /** Either end may remove a relation, so either end on a board the viewer edits will do. */
  canRemove(edge: MapEdge): boolean {
    return Boolean(this.editableEnd(edge));
  }

  private editableEnd(edge: MapEdge): MapNode | undefined {
    const editable = this.editableBoardIds();
    const [blocker, dependent] = this.edgeEnds(edge);
    return [dependent, blocker].find((node) => node && editable.has(node.card.boardId));
  }

  /** `blocks`: blocker then dependent. `relates_to`: the drawn order. */
  private edgeEnds(edge: MapEdge): [MapNode | undefined, MapNode | undefined] {
    const [first, second] = edge.reversed ? [edge.to, edge.from] : [edge.from, edge.to];
    return [this.node(first), this.node(second)];
  }

  linkState(node: MapNode): "source" | "over" | "target" | "muted" | null {
    const draft = this.linkDraft();
    if (!draft) return null;
    if (node.id === draft.fromId) return "source";
    if (node.id === draft.overId) return "over";
    return this.linkTargets()?.has(node.id) ? "target" : "muted";
  }

  /**
   * A press on a card's handle: dragging past a few pixels draws a connector to drop on the card it
   * blocks; a tap instead starts picking that card with the next click, which is also how touch and
   * keyboard users add one. Pressing the handle of the card being picked from cancels.
   */
  startLink(event: PointerEvent, chain: MapChain, node: MapNode): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const canvas = handle.closest<HTMLElement>(".dm-canvas");
    if (!canvas) return;
    const wasPicking = this.linkDraft()?.fromId === node.id;
    this.selectedEdge.set(null);
    this.linkDraft.set({ fromId: node.id, mode: "press", line: null, overId: null });
    handle.setPointerCapture?.(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    const from = { x1: node.x + TILE_WIDTH, y1: node.y + STEP_LABEL_HEIGHT + node.height / 2 };
    let dragging = false;
    const move = (moved: PointerEvent) => {
      if (!dragging && Math.hypot(moved.clientX - start.x, moved.clientY - start.y) < DRAG_THRESHOLD) return;
      dragging = true;
      const rect = canvas.getBoundingClientRect();
      this.linkDraft.set({
        fromId: node.id,
        mode: "drag",
        line: { chainId: chain.id, ...from, x2: moved.clientX - rect.left, y2: moved.clientY - rect.top },
        overId: this.linkTargetAt(moved.clientX, moved.clientY),
      });
    };
    const end = (ended: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (!dragging) {
        this.linkDraft.set(wasPicking ? null : { fromId: node.id, mode: "pick", line: null, overId: null });
        return;
      }
      const target = ended.type === "pointerup" ? this.linkTargetAt(ended.clientX, ended.clientY) : null;
      this.linkDraft.set(null);
      if (target) void this.link(node.id, target);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /** Enter or Space on a handle (a click with no pointer behind it) starts or cancels picking. */
  handleKey(event: MouseEvent, node: MapNode): void {
    if (event.detail !== 0) return;
    this.selectedEdge.set(null);
    this.linkDraft.set(this.linkDraft()?.fromId === node.id ? null : { fromId: node.id, mode: "pick", line: null, overId: null });
  }

  private linkTargetAt(x: number, y: number): string | null {
    const id = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-card-id]")?.dataset["cardId"] ?? null;
    return id && this.linkTargets()?.has(id) ? id : null;
  }

  draftPath(line: { x1: number; y1: number; x2: number; y2: number }): string {
    const dx = Math.max(24, Math.abs(line.x2 - line.x1) / 2);
    return `M ${line.x1} ${line.y1} C ${line.x1 + dx} ${line.y1}, ${line.x2 - dx} ${line.y2}, ${line.x2} ${line.y2}`;
  }

  cancelEditing(): void {
    this.linkDraft.set(null);
    this.selectedEdge.set(null);
  }

  /** Adds the dependency, written from the dependent's side: the card the viewer must be able to edit. */
  private async link(blockerId: string, dependentId: string): Promise<void> {
    const blocker = this.node(blockerId);
    const dependent = this.node(dependentId);
    if (!blocker || !dependent) return;
    const edit: RelationEdit = {
      kind: "blocks", sourceId: blocker.id, sourceKey: blocker.card.key, targetId: dependent.id, targetKey: dependent.card.key,
      pathId: dependent.id, added: true, relationId: null,
    };
    await this.record(edit);
  }


  /** Picks a connector: a click puts its Remove button where the pointer is, a key at its middle. */
  selectEdge(event: Event, chain: MapChain, edge: MapEdge): void {
    event.preventDefault();
    event.stopPropagation();
    const path = event.currentTarget as SVGPathElement;
    let x: number;
    let y: number;
    if (event instanceof MouseEvent && event.detail > 0) {
      const rect = path.closest(".dm-canvas")!.getBoundingClientRect();
      x = event.clientX - rect.left;
      y = event.clientY - rect.top;
    } else {
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      x = point.x;
      y = point.y + STEP_LABEL_HEIGHT;
    }
    this.linkDraft.set(null);
    this.selectedEdge.set({ id: edge.id, chainId: chain.id, x, y });
    if (!(event instanceof MouseEvent && event.detail > 0)) {
      setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>(".dm-wire-remove")?.focus());
    }
  }

  selectedEdgeIn(chain: MapChain): EdgeSelection | null {
    const selected = this.selectedEdge();
    return selected && selected.chainId === chain.id && chain.edges.some((edge) => edge.id === selected.id) ? selected : null;
  }

  async removeSelectedEdge(event: Event, chain: MapChain): Promise<void> {
    event.stopPropagation();
    const selected = this.selectedEdge();
    const edge = chain.edges.find((candidate) => candidate.id === selected?.id);
    this.selectedEdge.set(null);
    const pathCard = edge && this.editableEnd(edge);
    const [source, target] = edge ? this.edgeEnds(edge) : [];
    if (!edge || !pathCard || !source || !target) return;
    await this.record({
      kind: edge.kind, sourceId: source.id, sourceKey: source.card.key, targetId: target.id, targetKey: target.card.key,
      pathId: pathCard.id, added: false, relationId: edge.id,
    });
  }

  /*
   * Undo and redo. Every add or remove made on this map goes on a history, so Ctrl/⌘+Z takes back
   * the last one and Ctrl/⌘+Shift+Z puts it back, as in a drawing tool. The history belongs to this
   * map and this visit: it holds the viewer's own changes, not ones arriving live from others, and
   * an entry another change has made impossible (the card completed, the relation already gone) is
   * reported and dropped rather than retried.
   */

  /** Makes a fresh change, then offers to undo it. A new change clears what could be redone. */
  private async record(edit: RelationEdit): Promise<void> {
    if (!(await this.applyEdit(edit, edit.added))) return;
    this.undoStack.update((stack) => [...stack.slice(-(HISTORY_LIMIT - 1)), edit]);
    this.redoStack.set([]);
    this.announce(edit, edit.added, "undo");
  }

  /** Takes back the latest change, or a given one (its toast's Undo), wherever it sits in the history. */
  async undo(edit = this.undoStack().at(-1)): Promise<void> {
    if (!edit || !this.undoStack().includes(edit) || this.historyBusy()) return;
    this.undoStack.update((stack) => stack.filter((entry) => entry !== edit));
    if (!(await this.applyEdit(edit, !edit.added))) return;
    this.redoStack.update((stack) => [...stack, edit]);
    this.announce(edit, !edit.added, "redo");
  }

  async redo(edit = this.redoStack().at(-1)): Promise<void> {
    if (!edit || !this.redoStack().includes(edit) || this.historyBusy()) return;
    this.redoStack.update((stack) => stack.filter((entry) => entry !== edit));
    if (!(await this.applyEdit(edit, edit.added))) return;
    this.undoStack.update((stack) => [...stack, edit]);
    this.announce(edit, edit.added, "undo");
  }

  /** Brings the relation into being (`exists`) or removes it. False, with an error toast, when refused. */
  private async applyEdit(edit: RelationEdit, exists: boolean): Promise<boolean> {
    this.historyBusy.set(true);
    try {
      if (exists) {
        // `blocks` is written from the dependent's side; `relates_to` from whichever end the viewer edits.
        const created = edit.kind === "blocks"
          ? await this.api.post<CardRelationSummary>(`/cards/${edit.targetId}/relations`, { targetCardId: edit.sourceId, direction: "blocked_by" })
          : await this.api.post<CardRelationSummary>(`/cards/${edit.pathId}/relations`, {
            targetCardId: edit.pathId === edit.sourceId ? edit.targetId : edit.sourceId, direction: "relates_to",
          });
        edit.relationId = created.id;
      } else if (edit.relationId) {
        await this.api.delete(`/cards/${edit.pathId}/relations/${edit.relationId}`);
        edit.relationId = null;
      }
      void this.load();
      return true;
    } catch (error) {
      this.toasts.error(exists
        ? apiMessage(error, $localize`:Error toast when adding a dependency on the Dependencies view fails:Couldn't add the dependency. Try again.`)
        : apiMessage(error, $localize`:Error toast when removing a dependency on the Dependencies view fails:Couldn't remove the dependency. Try again.`));
      return false;
    } finally {
      this.historyBusy.set(false);
    }
  }

  /**
   * Says what just changed, with the button that reverses it. One toast at a time: an older one's
   * button would act on history that has since moved on.
   */
  private announce(edit: RelationEdit, exists: boolean, offer: "undo" | "redo"): void {
    if (this.historyToast !== null) this.toasts.dismiss(this.historyToast);
    const [source, target] = [edit.sourceKey, edit.targetKey];
    const message = edit.kind === "blocks"
      ? exists
        ? $localize`:Toast after adding a dependency on the Dependencies view:${target}:dependent: now waits on ${source}:blocker:`
        : $localize`:Toast after removing a dependency on the Dependencies view:${target}:dependent: no longer waits on ${source}:blocker:`
      : exists
        ? $localize`:Toast after restoring a relates-to link on the Dependencies view:${source}:first: now relates to ${target}:second:`
        : $localize`:Toast after removing a relates-to link on the Dependencies view:${source}:first: and ${target}:second: are no longer related`;
    this.historyToast = this.toasts.undoable({
      message,
      icon: exists ? "link" : "unlink",
      ...(offer === "redo" ? { undoLabel: $localize`:Toast button that applies again the change just undone:Redo` } : {}),
      undo: () => (offer === "undo" ? this.undo(edit) : this.redo(edit)),
    });
  }


  edgeLabel(edge: MapEdge): string {
    const [first, second] = this.edgeEnds(edge);
    const a = first?.card.key ?? "";
    const b = second?.card.key ?? "";
    return edge.kind === "blocks"
      ? $localize`:Screen reader label on a Dependencies view connector, which selects it for removal:${a}:blocker: blocks ${b}:dependent:`
      : $localize`:Screen reader label on a Dependencies view related-cards connector, which selects it for removal:${a}:first: relates to ${b}:second:`;
  }

  linkHandleLabel(node: MapNode): string {
    return $localize`:Label on the handle that adds a dependency from a card on the Dependencies view:Add a card that ${node.card.key}:key: blocks`;
  }

  pickingLabel(draft: LinkDraft): string {
    const key = this.node(draft.fromId)?.card.key ?? "";
    return $localize`:Dependencies view banner while choosing the card a new dependency blocks:Choose the card that ${key}:key: blocks.`;
  }

  /** The visible width of the chains area, for timeline chain titles that stay put while lanes scroll. */
  readonly viewWidth = computed(() => this.hostWidth() || contentWidth(this.host.nativeElement));

  /**
   * Column headings sit above each column, at the same x as its tiles: steps, or weeks on the
   * timeline. `skipsWeeks`: weeks with nothing due were left out between this column and the last.
   */
  stepColumns(chain: MapChain): { index: number; x: number; bandX: number; bandWidth: number; last: boolean; label: string; tone: string; skipsWeeks: boolean }[] {
    const timeline = this.layoutMode() === "timeline";
    return Array.from({ length: chain.waves }, (_, index) => {
      const x = MAP_PADDING + index * (TILE_WIDTH + WAVE_GAP);
      // Bands meet halfway across each gap; the outer ones run to the canvas edges.
      const bandX = index === 0 ? 0 : x - WAVE_GAP / 2;
      const key = chain.columnKeys[index] ?? 0;
      const previous = chain.columnKeys[index - 1];
      const skipsWeeks = timeline && previous !== undefined && previous !== NO_DUE_DATE && key - previous > 7;
      const tone = !timeline ? "" : key === NO_DUE_DATE ? "is-undated" : key === this.thisWeek ? "is-current" : key < this.thisWeek ? "is-past" : "";
      return {
        index, x, bandX, bandWidth: x + TILE_WIDTH + WAVE_GAP / 2 - bandX, last: index === chain.waves - 1,
        label: timeline ? this.weekLabel(key) : this.stepLabel(index), tone, skipsWeeks,
      };
    });
  }

  private weekLabel(key: number): string {
    if (key === NO_DUE_DATE) return $localize`:Dependencies view timeline column for cards without a due date:No due date`;
    if (key === this.thisWeek) return $localize`:Dependencies view timeline column for cards due this week:This week`;
    const date = formatDate(weekColumnStart(key), "short");
    return $localize`:Dependencies view timeline column heading - cards due in the week starting on this date:Week of ${date}:date:`;
  }

  /** The step list: each wave of a chain as one ordered group. */
  steps(chain: MapChain): MapNode[][] {
    const steps: MapNode[][] = Array.from({ length: chain.waves }, () => []);
    for (const node of chain.nodes) steps[node.wave]!.push(node);
    return steps;
  }

  /**
   * A step's marker on the step list's rail: done once every card in it is, active while any open
   * card in it can be worked now, waiting while all of its open cards are still blocked.
   */
  stepState(step: readonly MapNode[]): "done" | "active" | "waiting" {
    if (step.every((node) => node.status === "done")) return "done";
    return step.some((node) => node.status !== "done" && node.status !== "blocked") ? "active" : "waiting";
  }

  node(id: string): MapNode | undefined {
    return this.layout().nodesById.get(id);
  }

  content(node: MapNode): TileContent {
    return this.tileContents().get(node.id) ?? EMPTY_TILE;
  }

  /** A map tile's fields: as many as fit, then a "+N more" line. The step list shows them all. */
  fitFields(node: MapNode) {
    return tileFields(this.content(node));
  }

  moreFieldsLabel(count: number): string {
    return icu($localize`:Dependencies view tile - card-face fields that did not fit on the tile:{count, plural, one {+1 more field} other {+# more fields}}`, { count });
  }

  placeName(node: MapNode): string {
    if (!this.multiBoard() && node.inScope) return this.listsById().get(node.card.listId)?.name ?? "";
    return this.boardsById().get(node.card.boardId)?.name ?? "";
  }

  boardIcon(node: MapNode): string {
    return this.boardsById().get(node.card.boardId)?.icon || "layout-kanban";
  }

  /** Off-board context cards say which board they live on even on a one-board map. */
  showsBoard(node: MapNode): boolean {
    return this.multiBoard() || !node.inScope;
  }

  assignees(node: MapNode) {
    const people = this.peopleById();
    return node.card.assigneeIds.map((id) => people.get(id)).filter((person) => person !== undefined);
  }

  dueLabel(node: MapNode): string {
    return formatDueDate(node.card.dueDateLocalDate, node.card.dueDateSlot, node.card.dueDateTimezone);
  }

  isOverdue(node: MapNode): boolean {
    return node.status !== "done" && isOverdue(node.card.dueDateLocalDate, node.card.dueDateSlot, node.card.dueDateTimezone);
  }

  statusIcon(node: MapNode): string {
    switch (node.status) {
      case "done": return "ti-circle-check";
      case "blocked": return "ti-lock";
      case "ready": return "ti-lock-open";
      case "starter": return "ti-player-play";
      case "open": return "ti-circle-dashed";
    }
  }

  statusLabel(node: MapNode): string {
    switch (node.status) {
      case "done": return $localize`:Dependencies view tile status - the card is completed:Done`;
      case "blocked": return $localize`:Dependencies view tile status - an open blocker still holds the card:Blocked`;
      case "ready": return $localize`:Dependencies view tile status - every blocker is done:Ready`;
      case "starter": return icu($localize`:Dependencies view tile status - how many open cards wait on this unblocked card:{count, plural, one {Unblocks 1} other {Unblocks #}}`, { count: node.holdsUp });
      case "open": return "";
    }
  }

  riskLabel(node: MapNode): string | null {
    if (node.atRisk === "overdue") return $localize`:Dependencies view warning on a card - one of its blockers is past its due date:A blocker is overdue`;
    if (node.atRisk === "dueAfter") return $localize`:Dependencies view warning on a card - one of its blockers is due after it:A blocker is due after this card`;
    return null;
  }

  offMapLabel(count: number): string {
    return icu($localize`:Dependencies view note on a card - open blockers on boards the viewer can't open, or past the map's limit:{count, plural, one {Blocked by 1 card not on this map} other {Blocked by # cards not on this map}}`, { count });
  }

  holdsUpLabel(node: MapNode): string {
    return icu($localize`:Dependencies view - how many open cards wait on this card, directly or further down its chain:{count, plural, one {1 open card waits on this} other {# open cards wait on this}}`, { count: node.holdsUp });
  }

  waitingOn(node: MapNode): MapNode[] {
    return node.blockerIds.map((id) => this.node(id)).filter((blocker): blocker is MapNode => Boolean(blocker && blocker.status !== "done"));
  }

  unblocks(node: MapNode): MapNode[] {
    return node.dependentIds.map((id) => this.node(id)).filter((dependent): dependent is MapNode => Boolean(dependent && dependent.status !== "done"));
  }

  keys(nodes: readonly MapNode[]): string {
    return nodes.map((entry) => entry.card.key).join(", ");
  }

  tileLabel(node: MapNode): string {
    const parts = [`${node.card.key} ${node.card.title}`];
    const status = this.statusLabel(node);
    if (status) parts.push(status);
    const waiting = this.waitingOn(node);
    if (waiting.length) parts.push($localize`:Screen reader text on a Dependencies view card - the cards it waits on:Waiting on ${this.keys(waiting)}:keys:`);
    const unblocks = this.unblocks(node);
    if (unblocks.length) parts.push($localize`:Screen reader text on a Dependencies view card - the cards waiting on it:Blocks ${this.keys(unblocks)}:keys:`);
    const risk = this.riskLabel(node);
    if (risk) parts.push(risk);
    if (node.offMapBlockers) parts.push(this.offMapLabel(node.offMapBlockers));
    if (this.isCritical(node.id)) parts.push($localize`:Screen reader text on a Dependencies view card on its chain's critical path:On the critical path`);
    return parts.join(". ");
  }

  goalTitle(chain: MapChain): string {
    const [first, ...rest] = chain.goals;
    if (!first) return "";
    return rest.length
      ? icu($localize`:Dependencies view chain heading - the card the chain leads to, plus how many other end cards:{title} and {count, plural, one {1 more} other {# more}}`, { title: first.card.title, count: rest.length })
      : first.card.title;
  }

  chainMeta(chain: MapChain): string {
    return icu($localize`:Dependencies view chain subheading:{cards, plural, one {1 card} other {# cards}} · {steps, plural, one {1 step} other {# steps}}`, { cards: chain.nodes.length, steps: chain.steps });
  }

  stepLabel(index: number): string {
    return $localize`:Dependencies view column heading - the order cards can be worked in:Step ${index + 1}:number:`;
  }
}

function contentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return Math.max(0, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
}

function readPreference(scope: string): StoredPreference {
  const parsed = readDependencyPreference(scope);
  return {
    ...(parsed["scope"] === "workspace" || parsed["scope"] === "board" ? { scope: parsed["scope"] } : {}),
    showRelated: parsed["showRelated"] === true,
    slim: parsed["slim"] === true,
    critical: parsed["critical"] === true,
  };
}

function writePreference(scope: string, value: StoredPreference): void {
  // Explicit falses clear a toggle the merge would otherwise keep.
  updateDependencyPreference(scope, { slim: false, critical: false, ...value });
}

/** The API's own message (already in the viewer's language, e.g. the loop rejection), else a fallback. */
function apiMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const message = (error.body as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
