import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type {
  PortfolioSummary,
  SavedWorkView,
  WorkCatalog,
  WorkPrioritiesResponse,
  WorkPriorityQueuesResponse,
  WorkQueryResponse,
  WorkViewDefinition,
} from "@kanera/shared/dto";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { SocketService } from "../../core/realtime/socket.service";
import { CardDragCoordinator } from "../board/card-drag-coordinator.service";
import { readGlobalWorkPreference, sanitizeGlobalWorkDefinition, writeGlobalWorkPreference } from "./global-work-preference";
import { MyPrioritiesService } from "../../core/priorities/my-priorities.service";
import { GlobalWorkState } from "./global-work.state";

type Handler = (payload?: never) => void;

class SocketStub {
  connected = true;
  readonly handlers = new Map<string, Handler>();
  readonly on = vi.fn((event: string, handler: Handler) => {
    this.handlers.set(event, handler);
    return this;
  });
  readonly off = vi.fn((event: string) => {
    this.handlers.delete(event);
    return this;
  });

  trigger(event: string, payload: unknown): void {
    this.handlers.get(event)?.(payload as never);
  }
}

const catalog: WorkCatalog = {
  organisations: [
    { id: "10000000-0000-4000-8000-000000000001", name: "Home", external: false },
    { id: "10000000-0000-4000-8000-000000000002", name: "Guest", external: true },
  ],
  workspaces: [
    {
      id: "20000000-0000-4000-8000-000000000001",
      organisationId: "10000000-0000-4000-8000-000000000001",
      name: "Delivery",
      icon: null,
      accentColor: null,
      kind: "standard",
      viewerCanAccessWorkspace: true,
    },
    {
      id: "20000000-0000-4000-8000-000000000002",
      organisationId: "10000000-0000-4000-8000-000000000002",
      name: "Guest workspace",
      icon: null,
      accentColor: null,
      kind: "standard",
      viewerCanAccessWorkspace: false,
    },
  ],
  boards: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      workspaceId: "20000000-0000-4000-8000-000000000001",
      name: "Roadmap",
      icon: null,
      iconColor: null,
      viewerRole: "editor",
      assignedItemsOnly: false,
    },
    {
      id: "30000000-0000-4000-8000-000000000002",
      workspaceId: "20000000-0000-4000-8000-000000000002",
      name: "Guest board",
      icon: null,
      iconColor: null,
      viewerRole: "observer",
      assignedItemsOnly: false,
    },
  ],
  lists: [],
  labels: [],
  customFields: [],
  people: [{
    userId: "60000000-0000-4000-8000-000000000002",
    organisationId: "10000000-0000-4000-8000-000000000001",
    displayName: "Teammate",
    avatarUrl: null,
    boardIds: ["30000000-0000-4000-8000-000000000001"],
  }],
};

const response: WorkQueryResponse = {
  cards: [{
    id: "40000000-0000-4000-8000-000000000001",
    number: 42,
    key: "OLD-42",
    organisationKey: "0123456789ABCDEF",
    boardId: "30000000-0000-4000-8000-000000000001",
    workspaceId: "20000000-0000-4000-8000-000000000001",
    listId: "50000000-0000-4000-8000-000000000001",
    title: "Ship it",
    position: "1000.0000000000",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    assigneeIds: ["60000000-0000-4000-8000-000000000001"],
  }],
  separators: [],
  separatorWorkspaceIds: [],
  checklistItems: [],
  totals: { cards: 1, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
  nextCursor: null,
};

const VIEWER_ID = "60000000-0000-4000-8000-000000000001";
const TEAMMATE_ID = "60000000-0000-4000-8000-000000000002";

/**
 * A queue with one visible entry and one redacted placeholder, so ranks are 1 and 2 while only one
 * card is present — the shape that proves rank is numbered over the target's set, not the viewer's.
 */
const priorities: WorkPrioritiesResponse = {
  targetUserId: VIEWER_ID,
  items: [
    {
      id: "80000000-0000-4000-8000-000000000001",
      position: "1000.0000000000",
      rank: 1,
      card: response.cards[0]!,
      context: {
        boardName: "Roadmap",
        boardIcon: null,
        boardIconColor: null,
        listName: "Doing",
        workspaceName: "Delivery",
      },
    },
    {
      id: "80000000-0000-4000-8000-000000000002",
      position: "2000.0000000000",
      rank: 2,
      card: null,
      context: null,
    },
  ],
  totalCount: 2,
  hiddenCount: 1,
  canReorder: true,
  reorderableWorkspaceIds: ["20000000-0000-4000-8000-000000000001"],
};

/** A teammate's queue with two visible entries, so a lane reorder has something to move. */
const teammateQueue: WorkPrioritiesResponse = {
  targetUserId: TEAMMATE_ID,
  items: [
    {
      id: "80000000-0000-4000-8000-000000000011",
      position: "1000.0000000000",
      rank: 1,
      card: response.cards[0]!,
      context: { boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing", workspaceName: "Delivery" },
    },
    {
      id: "80000000-0000-4000-8000-000000000012",
      position: "2000.0000000000",
      rank: 2,
      card: { ...response.cards[0]!, id: "40000000-0000-4000-8000-000000000009", title: "Then this" },
      context: { boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing", workspaceName: "Delivery" },
    },
  ],
  totalCount: 2,
  hiddenCount: 0,
  canReorder: true,
  reorderableWorkspaceIds: ["20000000-0000-4000-8000-000000000001"],
};

/** The Team Cards lanes batch: the viewer's own queue plus the teammate's. */
const teamQueues: WorkPriorityQueuesResponse = {
  queues: [
    {
      target: { userId: VIEWER_ID, displayName: "Viewer", email: "viewer@x.test", self: true, workspaceIds: [], queueSize: 2 },
      queue: priorities,
    },
    {
      target: {
        userId: TEAMMATE_ID,
        displayName: "Teammate",
        email: "teammate@x.test",
        self: false,
        workspaceIds: ["20000000-0000-4000-8000-000000000001"],
        queueSize: 2,
      },
      queue: teammateQueue,
    },
  ],
};

const cachedDefinition: WorkViewDefinition = {
  scope: { allAccessible: true, organisationIds: [], workspaceIds: [], boardIds: [] },
  filters: {
    q: "",
    assigneeIds: [],
    listIds: [],
    labelIds: [],
    customFieldConditions: [],
    completion: "active",
    unassignedOnly: false,
    dueFrom: null,
    dueTo: null,
    overdueOnly: false,
    overdueChecklistOnly: false,
    unreadOnly: false,
    archived: false,
    completedFrom: null,
    completedTo: null,
    lastActivityBefore: null,
    lastMovedBefore: null,
  },
  groupBy: "dueDate",
  sort: "dueAsc",
  display: "table",
  columns: ["source", "list", "assignees", "dueDate", "completion"],
  table: {
    columnVisibility: {},
    columnOrder: [],
    columnWidths: {},
    aggregates: {},
    aggregateSplitBy: "none",
    collapsedGroupKeys: [],
  },
  portfolioDays: 30,
  collapsedOrganisationIds: [],
  collapsedWorkspaceIds: [],
  collapsedSectionIds: [],
};

type CachedGlobalWork = {
  key: string;
  cachedAt: string;
  definition: WorkViewDefinition;
  catalog: WorkCatalog;
  response: WorkQueryResponse;
  portfolio: PortfolioSummary | null;
  savedViews: SavedWorkView[];
};

function setup(options: {
  apiFails?: boolean;
  cached?: CachedGlobalWork | null;
  loadCached?: () => Promise<CachedGlobalWork | null>;
  /** Overrides the /work/cards/query response so a test can drive real cursor paging. */
  cardsQuery?: (payload: { cursor?: string }) => Promise<WorkQueryResponse> | WorkQueryResponse;
  /** Makes the queue endpoint 403, the way it answers a plain member focusing a teammate. */
  prioritiesForbidden?: boolean;
} = {}) {
  let offline = options.apiFails ?? false;
  const socket = new SocketStub();
  const boardLeaves: ReturnType<typeof vi.fn>[] = [];
  const workspaceLeaves: ReturnType<typeof vi.fn>[] = [];
  const joinBoard = vi.fn(() => {
    const leave = vi.fn();
    boardLeaves.push(leave);
    return leave;
  });
  const joinWorkspace = vi.fn(() => {
    const leave = vi.fn();
    workspaceLeaves.push(leave);
    return leave;
  });
  const get = vi.fn(async (path: string) => {
    if (offline) throw new Error("offline");
    if (path === "/work/catalog") return catalog;
    if (path === "/work-views") return [];
    if (path === "/work-views/share-candidates") return [];
    if (path === "/work/priorities") return teamQueues;
    if (path.startsWith("/work/priorities/")) {
      if (options.prioritiesForbidden) throw new ApiError(403, { message: "forbidden" });
      return priorities;
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, payload?: unknown) => {
    if (offline) throw new Error("offline");
    if (path === "/work/cards/query") {
      return options.cardsQuery?.((payload ?? {}) as { cursor?: string }) ?? response;
    }
    if (path === "/work/portfolio/query") {
      return {
        days: 30,
        totals: { cards: 1, overdue: 0, dueSoon: 0, completed: 0, overdueChecklistItems: 0, unassigned: 0 },
        buckets: [],
      };
    }
    if (path === "/work-views") {
      const body = payload as {
        name: string;
        lens: "my" | "team" | "portfolio";
        visibility: "private" | "organisation";
        definition: WorkViewDefinition;
      };
      return {
        id: "70000000-0000-4000-8000-000000000001",
        clientId: "10000000-0000-4000-8000-000000000001",
        ownerId: "60000000-0000-4000-8000-000000000001",
        ownerName: "Viewer",
        name: body.name,
        lens: body.lens,
        visibility: body.visibility,
        definitionVersion: 1,
        definition: body.definition,
        editable: true,
        sharedUserIds: [],
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
      } satisfies SavedWorkView;
    }
    if (path.startsWith("/boards/") && path.endsWith("/cards")) {
      return { id: "40000000-0000-4000-8000-000000000002" };
    }
    if (path.startsWith("/cards/") && path.endsWith("/move")) {
      return {
        id: "40000000-0000-4000-8000-000000000001",
        listId: "50000000-0000-4000-8000-000000000002",
        position: "500.0000000000",
      };
    }
    if (path.startsWith("/work/priorities/") && path.endsWith("/cards")) return priorities;
    if (path.startsWith("/card-priorities/") && path.endsWith("/move")) return priorities;
    if (path.startsWith("/global-work-separators/") && path.endsWith("/move")) {
      return {
        id: "70000000-0000-4000-8000-000000000001",
        listId: (payload as { listId: string }).listId,
        position: "250.0000000000",
      };
    }
    throw new Error(`unexpected POST ${path}`);
  });
  const del = vi.fn(async (path: string) => {
    if (offline) throw new Error("offline");
    if (path.startsWith("/card-priorities/")) return priorities;
    throw new Error(`unexpected DELETE ${path}`);
  });
  const saveGlobalWork = vi.fn(async () => undefined);
  const loadGlobalWork = vi.fn(() =>
    options.loadCached?.() ?? Promise.resolve(options.cached ?? null)
  );
  const createCard = vi.fn((path: string, body: Record<string, unknown> & { clientToken: string }) =>
    post(path, body)
  );
  const user = signal({
    id: "60000000-0000-4000-8000-000000000001",
    clientId: "10000000-0000-4000-8000-000000000001",
    displayName: "Viewer",
  });
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      GlobalWorkState,
      { provide: ApiClient, useValue: { get, post, createCard, delete: del } },
      { provide: AuthService, useValue: { user: user.asReadonly() } },
      { provide: OfflineCacheService, useValue: { saveGlobalWork, loadGlobalWork } },
      {
        provide: SocketService,
        useValue: {
          connect: vi.fn(() => socket),
          joinBoard,
          joinWorkspace,
          displayedOnline: signal(true),
        },
      },
    ],
  });
  return {
    state: TestBed.inject(GlobalWorkState),
    socket,
    get,
    post,
    del,
    createCard,
    joinBoard,
    joinWorkspace,
    boardLeaves,
    workspaceLeaves,
    saveGlobalWork,
    setOffline(value: boolean) {
      offline = value;
    },
  };
}

describe("GlobalWorkState", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("loads a first page and joins board rooms plus only eligible workspace rooms", async () => {
    const { state, joinBoard, joinWorkspace, saveGlobalWork } = setup();
    await state.initialize("my");

    expect(state.cards().map((card) => card.title)).toEqual(["Ship it"]);
    expect(joinBoard).toHaveBeenCalledWith("30000000-0000-4000-8000-000000000001");
    expect(joinBoard).toHaveBeenCalledWith("30000000-0000-4000-8000-000000000002");
    expect(joinWorkspace).toHaveBeenCalledTimes(1);
    expect(joinWorkspace).toHaveBeenCalledWith("20000000-0000-4000-8000-000000000001");
    expect(saveGlobalWork).toHaveBeenCalled();
  });

  it("defaults My Cards and Team Cards to board view", async () => {
    const { state } = setup();

    await state.initialize("my");
    expect(state.definition().display).toBe("board");

    await state.initialize("team");
    expect(state.definition().display).toBe("board");
  });

  it("reports Group and Sort as set only when they differ from the lens default", async () => {
    const { state } = setup();
    await state.initialize("my");

    // Defaults for the `my` lens: dueDate / dueAsc. The toolbar accents its Group and Sort triggers
    // off these, so "grouped by the default" must not read as an engaged control.
    expect(state.groupByIsSet()).toBe(false);
    expect(state.sortIsSet()).toBe(false);

    state.setGrouping("assignee");
    expect(state.groupByIsSet()).toBe(true);

    state.setSort("titleAsc");
    expect(state.sortIsSet()).toBe(true);

    state.resetTablePresentation();
    expect(state.groupByIsSet()).toBe(false);
    expect(state.sortIsSet()).toBe(false);

    // The default is lens-dependent, which is why this comparison lives beside `defaultDefinition`
    // rather than in the page: portfolio groups by board, so `board` is *not* set there.
    state.lens.set("portfolio");
    state.setGrouping("board");
    expect(state.groupByIsSet()).toBe(false);
  });

  it("applies known realtime mutations immediately and converges through a debounced query", async () => {
    vi.useFakeTimers();
    try {
      const { state, socket, post } = setup();
      await state.initialize("my");
      socket.trigger("card:assignees:set", {
        boardId: "30000000-0000-4000-8000-000000000001",
        cardId: "40000000-0000-4000-8000-000000000001",
        assigneeIds: [],
      });
      expect(state.response().cards[0]?.assigneeIds).toEqual([]);
      expect(state.recoveringConnection()).toBe(false);
      await vi.advanceTimersByTimeAsync(180);
      expect(post.mock.calls.filter(([path]) => path === "/work/cards/query")).toHaveLength(2);
      expect(state.recoveringConnection()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recomputes visible card keys immediately after a workspace prefix event", async () => {
    vi.useFakeTimers();
    try {
      const { state, socket } = setup();
      await state.initialize("my");
      socket.trigger(SERVER_EVENTS.WORKSPACE_UPDATED, {
        workspace: { id: "20000000-0000-4000-8000-000000000001", cardKeyPrefix: "NEW" },
      });
      expect(state.response().cards[0]?.key).toBe("NEW-42");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles every row-summary event and advances the separate History query version", async () => {
    vi.useFakeTimers();
    try {
      const { state, socket, post, get } = setup();
      await state.initialize("my");
      const initialVersion = state.reconciliationVersion();
      const initialCatalogQueries = get.mock.calls.filter(([path]) => path === "/work/catalog").length;
      const events: Array<{ event: string; payload: unknown }> = [
        {
          event: SERVER_EVENTS.CARD_REBALANCED,
          payload: {
            boardId: catalog.boards[0]!.id,
            listId: response.cards[0]!.listId,
            positions: [{ id: response.cards[0]!.id, position: "2000.0000000000" }],
          },
        },
        { event: SERVER_EVENTS.CARD_CHECKLIST_MOVED, payload: {} },
        { event: SERVER_EVENTS.CARD_CHECKLIST_REBALANCED, payload: {} },
        { event: SERVER_EVENTS.CARD_CHECKLIST_ITEM_MOVED, payload: {} },
        { event: SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED, payload: {} },
        { event: SERVER_EVENTS.COMMENT_CREATED, payload: {} },
        { event: SERVER_EVENTS.COMMENT_DELETED, payload: {} },
        { event: SERVER_EVENTS.CARD_ATTACHMENT_CREATED, payload: {} },
        { event: SERVER_EVENTS.CARD_ATTACHMENT_DELETED, payload: {} },
      ];

      for (const [index, item] of events.entries()) {
        socket.trigger(item.event, item.payload);
        if (item.event === SERVER_EVENTS.CARD_REBALANCED) {
          expect(state.response().cards[0]?.position).toBe("2000.0000000000");
        }
        await vi.advanceTimersByTimeAsync(180);
        expect(post.mock.calls.filter(([path]) => path === "/work/cards/query")).toHaveLength(index + 2);
        expect(state.reconciliationVersion()).toBe(initialVersion + index + 1);
      }
      expect(get.mock.calls.filter(([path]) => path === "/work/catalog")).toHaveLength(initialCatalogQueries);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the catalog for every ordering, option, profile, and access event", async () => {
    vi.useFakeTimers();
    try {
      const { state, socket, get } = setup();
      await state.initialize("my");
      const initialVersion = state.reconciliationVersion();
      const events = [
        SERVER_EVENTS.LIST_MOVED,
        SERVER_EVENTS.LIST_REBALANCED,
        SERVER_EVENTS.CARD_LABEL_MOVED,
        SERVER_EVENTS.CARD_LABEL_REBALANCED,
        SERVER_EVENTS.CUSTOM_FIELD_MOVED,
        SERVER_EVENTS.CUSTOM_FIELD_REBALANCED,
        SERVER_EVENTS.CUSTOM_FIELD_OPTION_CREATED,
        SERVER_EVENTS.CUSTOM_FIELD_OPTION_UPDATED,
        SERVER_EVENTS.CUSTOM_FIELD_OPTION_MOVED,
        SERVER_EVENTS.CUSTOM_FIELD_OPTION_REBALANCED,
        SERVER_EVENTS.CUSTOM_FIELD_OPTION_DELETED,
        SERVER_EVENTS.BOARD_MOVED,
        SERVER_EVENTS.BOARD_REBALANCED,
        SERVER_EVENTS.CLIENT_UPDATED,
        SERVER_EVENTS.CLIENT_USER_ADDED,
        SERVER_EVENTS.CLIENT_USER_ROLE_CHANGED,
        SERVER_EVENTS.CLIENT_USER_REMOVED,
        SERVER_EVENTS.USER_PROFILE_UPDATED,
      ];

      for (const [index, event] of events.entries()) {
        socket.trigger(event, {});
        await vi.advanceTimersByTimeAsync(180);
        expect(get.mock.calls.filter(([path]) => path === "/work/catalog")).toHaveLength(index + 2);
        expect(state.reconciliationVersion()).toBe(initialVersion + index + 1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains unchanged room refs across reconciliation and only releases rooms removed from scope", async () => {
    vi.useFakeTimers();
    try {
      const { state, socket, joinBoard, joinWorkspace, boardLeaves, workspaceLeaves } = setup();
      await state.initialize("my");

      socket.trigger(SERVER_EVENTS.CARD_CREATED, {});
      await vi.advanceTimersByTimeAsync(180);
      expect(joinBoard).toHaveBeenCalledTimes(2);
      expect(joinWorkspace).toHaveBeenCalledTimes(1);
      expect(boardLeaves.every((leave) => !leave.mock.calls.length)).toBe(true);
      expect(workspaceLeaves.every((leave) => !leave.mock.calls.length)).toBe(true);

      state.setScope([], [catalog.boards[0]!.id]);
      expect(joinBoard).toHaveBeenCalledTimes(2);
      expect(joinWorkspace).toHaveBeenCalledTimes(1);
      expect(boardLeaves[0]).not.toHaveBeenCalled();
      expect(boardLeaves[1]).toHaveBeenCalledTimes(1);
      expect(workspaceLeaves[0]).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the live board interactive while a newly created card reconciles", async () => {
    vi.useFakeTimers();
    try {
      let cardQueryCount = 0;
      const gate: { release: (() => void) | null } = { release: null };
      const { state, createCard } = setup({
        cardsQuery: async () => {
          cardQueryCount += 1;
          if (cardQueryCount > 1) {
            await new Promise<void>((resolve) => (gate.release = resolve));
          }
          return response;
        },
      });
      await state.initialize("my");

      await state.createCard(
        "30000000-0000-4000-8000-000000000001",
        "50000000-0000-4000-8000-000000000001",
        "A new card",
        ["60000000-0000-4000-8000-000000000001"],
      );

      const [createPath, createBody] = createCard.mock.calls[0]!;
      expect(createPath).toBe(
        "/boards/30000000-0000-4000-8000-000000000001/lists/50000000-0000-4000-8000-000000000001/cards",
      );
      expect(createBody).toMatchObject({
        title: "A new card",
        assigneeIds: ["60000000-0000-4000-8000-000000000001"],
      });
      expect(typeof createBody.clientToken).toBe("string");
      expect(state.loading()).toBe(false);
      expect(state.interactionReady()).toBe(true);

      await vi.advanceTimersByTimeAsync(180);
      expect(gate.release).not.toBeNull();
      expect(state.reconciling()).toBe(true);
      expect(state.loading()).toBe(false);
      expect(state.interactionReady()).toBe(true);

      gate.release?.();
      await vi.waitFor(() => expect(state.reconciling()).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a visible card optimistically and settles the source card position from the API", async () => {
    const { state, post } = setup();
    await state.initialize("my");

    await state.moveCard(
      "40000000-0000-4000-8000-000000000001",
      "50000000-0000-4000-8000-000000000002",
      { beforeCardId: null },
    );

    expect(post).toHaveBeenCalledWith(
      "/cards/40000000-0000-4000-8000-000000000001/move",
      {
        listId: "50000000-0000-4000-8000-000000000002",
        beforeItem: null,
        globalWorkUserId: "60000000-0000-4000-8000-000000000001",
      },
    );
    expect(state.response().cards[0]).toMatchObject({
      listId: "50000000-0000-4000-8000-000000000002",
      position: "500.0000000000",
    });
  });

  it("moves a Global Work separator through the mixed card lane", async () => {
    const separator = {
      id: "70000000-0000-4000-8000-000000000001",
      workspaceId: "20000000-0000-4000-8000-000000000001",
      targetUserId: "60000000-0000-4000-8000-000000000001",
      listId: "50000000-0000-4000-8000-000000000001",
      title: "Now",
      color: null,
      position: "1500.0000000000",
      createdById: "60000000-0000-4000-8000-000000000001",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    const { state, post } = setup({
      cardsQuery: () => ({
        ...response,
        separators: [separator],
        separatorWorkspaceIds: [separator.workspaceId],
      }),
    });
    await state.initialize("my");

    await state.moveSeparator(
      separator.id,
      "50000000-0000-4000-8000-000000000002",
      { beforeItem: null },
    );

    expect(post).toHaveBeenCalledWith(
      `/global-work-separators/${separator.id}/move`,
      {
        listId: "50000000-0000-4000-8000-000000000002",
        beforeItem: null,
      },
    );
    expect(state.response().separators[0]).toMatchObject({
      listId: "50000000-0000-4000-8000-000000000002",
      position: "250.0000000000",
    });
  });

  it("loads every remaining bounded page before enabling the board priority order", async () => {
    const { state, post } = setup();
    await state.initialize("my");
    state.response.update((current) => ({ ...current, nextCursor: "cursor-1" }));

    state.setDisplay("board");
    await vi.waitFor(() => expect(state.loadingMore()).toBe(false));

    expect(post.mock.calls.some(([path, payload]) =>
      path === "/work/cards/query"
      && (payload as { cursor?: string }).cursor === "cursor-1"
      && (payload as { includeMetadata?: boolean }).includeMetadata === false
    )).toBe(true);
    expect(state.response().nextCursor).toBeNull();
  });

  it("holds a realtime reconcile until an in-flight card drag has ended", async () => {
    vi.useFakeTimers();
    try {
      let cardQueryCount = 0;
      const gate: { release: (() => void) | null } = { release: null };
      const { state, socket, post } = setup({
        cardsQuery: async () => {
          cardQueryCount += 1;
          if (cardQueryCount > 1) {
            await new Promise<void>((resolve) => (gate.release = resolve));
          }
          return response;
        },
      });
      await state.initialize("my");
      const cardQueries = () => post.mock.calls.filter(([path]) => path === "/work/cards/query").length;
      const drag = TestBed.inject(CardDragCoordinator);
      drag.start("50000000-0000-4000-8000-000000000001");

      // The viewer's own drop is echoed straight back to them. Refetching the board mid-gesture is
      // what re-rendered the lanes and disabled the drop lists under the pointer.
      socket.trigger("card:moved", {
        boardId: "30000000-0000-4000-8000-000000000001",
        cardId: "40000000-0000-4000-8000-000000000001",
        fromListId: "50000000-0000-4000-8000-000000000001",
        toListId: "50000000-0000-4000-8000-000000000002",
        position: "500.0000000000",
        prevPosition: "1000.0000000000",
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(cardQueries()).toBe(1);
      expect(state.recoveringConnection()).toBe(false);
      // The optimistic patch still lands immediately; only the refetch waits.
      expect(state.response().cards[0]?.listId).toBe("50000000-0000-4000-8000-000000000002");

      drag.end();
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(200);
      expect(cardQueries()).toBe(2);
      expect(state.reconciling()).toBe(true);
      // The authoritative refresh is still in flight, but the live projection remains usable.
      expect(state.interactionReady()).toBe(true);
      expect(state.recoveringConnection()).toBe(false);

      gate.release?.();
      await vi.waitFor(() => expect(state.reconciling()).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a paged board in one swap instead of republishing the first page", async () => {
    const secondCard = {
      ...response.cards[0],
      id: "40000000-0000-4000-8000-000000000002",
      title: "Second",
    } as (typeof response.cards)[number];
    const gate: { release: (() => void) | null } = { release: null };
    let holdSecondPage = false;
    const { state, socket } = setup({
      cardsQuery: async (payload) => {
        if (!payload.cursor) return { ...response, nextCursor: "cursor-1" };
        if (holdSecondPage) await new Promise<void>((resolve) => (gate.release = resolve));
        return { ...response, cards: [secondCard], nextCursor: null };
      },
    });
    await state.initialize("my");
    state.setDisplay("board");
    await vi.waitFor(() => expect(state.cards()).toHaveLength(2));

    holdSecondPage = true;
    socket.trigger("card:created", {});
    await vi.waitFor(() => expect(gate.release).not.toBeNull());

    // Mid-reconcile the complete board is still on screen. Publishing the first page here is what
    // collapsed the lanes to 100 cards, raised the "loading all matching cards" notice above them,
    // and then grew the board back a page at a time.
    expect(state.cards()).toHaveLength(2);
    expect(state.loadingMore()).toBe(false);
    expect(state.canLoadMore()).toBe(false);

    gate.release?.();
    await vi.waitFor(() => expect(state.reconciling()).toBe(false));
    expect(state.cards()).toHaveLength(2);
  });

  it("restores the cached catalog, first page, and timestamp when offline", async () => {
    const cachedAt = "2026-07-24T12:00:00.000Z";
    const { state } = setup({
      apiFails: true,
      cached: {
        key: "10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001:my",
        cachedAt,
        definition: cachedDefinition,
        catalog,
        response,
        portfolio: null,
        savedViews: [],
      },
    });
    await state.initialize("my");

    expect(state.cachedAt()).toBe(cachedAt);
    expect(state.cards()[0]?.title).toBe("Ship it");
    expect(state.error()).toBeNull();
    expect(state.interactionReady()).toBe(false);
  });

  it("accepts an empty cached result as a usable offline view", async () => {
    const emptyResponse: WorkQueryResponse = {
      ...response,
      cards: [],
      totals: { cards: 0, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
    };
    const { state } = setup({
      apiFails: true,
      cached: {
        key: "10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001:my",
        cachedAt: "2026-07-24T12:00:00.000Z",
        definition: cachedDefinition,
        catalog,
        response: emptyResponse,
        portfolio: null,
        savedViews: [],
      },
    });

    await state.initialize("my");

    expect(state.cachedAt()).not.toBeNull();
    expect(state.response().cards).toEqual([]);
    expect(state.error()).toBeNull();
  });

  it("keeps the remembered display and folds when an older offline snapshot paints", async () => {
    const userId = "60000000-0000-4000-8000-000000000001";
    const workspaceId = "20000000-0000-4000-8000-000000000001";
    writeGlobalWorkPreference(userId, "my", {
      selectedViewId: null,
      drilldownLabel: null,
      definition: {
        ...cachedDefinition,
        display: "history",
        collapsedWorkspaceIds: [workspaceId],
      },
      collapsedHistoryDayKeys: ["2026-07-24"],
      collapsedChecklistGroupIds: ["checklist:overdue"],
    });
    const { state } = setup({
      apiFails: true,
      cached: {
        key: "10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001:my",
        cachedAt: "2026-07-24T12:00:00.000Z",
        definition: cachedDefinition,
        catalog,
        response,
        portfolio: null,
        savedViews: [],
      },
    });

    await state.initialize("my");

    expect(state.definition()).toMatchObject({
      display: "history",
      collapsedWorkspaceIds: [workspaceId],
    });
    expect(state.collapsedHistoryDayKeys()).toEqual(["2026-07-24"]);
    expect(state.collapsedChecklistGroupIds()).toEqual(["checklist:overdue"]);
  });

  it("keeps the remembered table presentation when an older offline snapshot paints", async () => {
    const userId = "60000000-0000-4000-8000-000000000001";
    const table = {
      columnVisibility: { labels: true, due: false },
      columnOrder: ["labels", "status", "assignees"],
      columnWidths: { title: 420, labels: 260 },
      aggregates: {},
      aggregateSplitBy: "assignee" as const,
      collapsedGroupKeys: ["assignee:60000000-0000-4000-8000-000000000002"],
    };
    writeGlobalWorkPreference(userId, "my", {
      selectedViewId: null,
      drilldownLabel: null,
      definition: { ...cachedDefinition, groupBy: "assignee", sort: "titleDesc", table },
    });
    const { state } = setup({
      apiFails: true,
      cached: {
        key: "10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001:my",
        cachedAt: "2026-07-24T12:00:00.000Z",
        definition: cachedDefinition,
        catalog,
        response,
        portfolio: null,
        savedViews: [],
      },
    });

    await state.initialize("my");

    expect(state.definition()).toMatchObject({ groupBy: "assignee", sort: "titleDesc" });
    expect(state.definition().table).toEqual(table);
    expect(readGlobalWorkPreference(userId, "my")?.definition).toMatchObject({
      groupBy: "assignee",
      sort: "titleDesc",
      table,
    });
  });

  it("keeps an empty cached Portfolio summary visible offline", async () => {
    const portfolio: PortfolioSummary = {
      days: 30,
      totals: { cards: 0, overdue: 0, dueSoon: 0, completed: 0, overdueChecklistItems: 0, unassigned: 0 },
      buckets: [],
      activityDays: 60,
      activity: [],
    };
    const { state } = setup({
      apiFails: true,
      cached: {
        key: "10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001:portfolio",
        cachedAt: "2026-07-24T12:00:00.000Z",
        definition: { ...cachedDefinition, groupBy: "board", display: "summary" },
        catalog,
        response: {
          ...response,
          cards: [],
          totals: { cards: 0, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
        },
        portfolio,
        savedViews: [],
      },
    });

    await state.initialize("portfolio");

    expect(state.portfolio()).toEqual(portfolio);
    expect(state.error()).toBeNull();
    expect(state.interactionReady()).toBe(false);
  });

  it("recovers a cache-only startup when the socket later reconnects", async () => {
    vi.useFakeTimers();
    try {
      const f = setup({
        apiFails: true,
        cached: {
          key: "10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001:my",
          cachedAt: "2026-07-24T12:00:00.000Z",
          definition: cachedDefinition,
          catalog,
          response,
          portfolio: null,
          savedViews: [],
        },
      });
      await f.state.initialize("my");
      expect(f.state.cachedAt()).not.toBeNull();

      f.setOffline(false);
      f.socket.trigger("connect", undefined);
      expect(f.state.recoveringConnection()).toBe(true);
      await vi.advanceTimersByTimeAsync(400);

      expect(f.state.cachedAt()).toBeNull();
      expect(f.state.interactionReady()).toBe(true);
      expect(f.state.recoveringConnection()).toBe(false);
      expect(f.saveGlobalWork).toHaveBeenLastCalledWith(
        "10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001:my",
        expect.any(Object),
        catalog,
        response,
        null,
        [],
        // No queue in the snapshot: priority order is never served from cache, because a stale
        // sequence reads as an instruction the reader cannot date.
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles on foreground resume even without a queued realtime event", async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      await f.state.initialize("my");
      const cardQueryCount = () => f.post.mock.calls.filter(([path]) => path === "/work/cards/query").length;
      expect(cardQueryCount()).toBe(1);

      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(400);

      expect(cardQueryCount()).toBe(2);
      expect(f.state.reconciling()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a delayed cache read overwrite a completed network response", async () => {
    let resolveCache!: (cached: CachedGlobalWork) => void;
    const delayedCache = new Promise<CachedGlobalWork>((resolve) => {
      resolveCache = resolve;
    });
    const f = setup({ loadCached: () => delayedCache });

    await f.state.initialize("my");
    resolveCache({
      key: "10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001:my",
      cachedAt: "2026-07-20T12:00:00.000Z",
      definition: cachedDefinition,
      catalog,
      response: {
        ...response,
        cards: response.cards.map((card) => ({ ...card, title: "Stale cached title" })),
      },
      portfolio: null,
      savedViews: [],
    });
    await Promise.resolve();

    expect(f.state.cards()[0]?.title).toBe("Ship it");
    expect(f.state.cachedAt()).toBeNull();
  });

  it("restores and keeps preferences isolated for My Cards, Team Cards, and Portfolio", async () => {
    const userId = "60000000-0000-4000-8000-000000000001";
    const teammateId = "60000000-0000-4000-8000-000000000002";
    const definition = (patch: Partial<WorkViewDefinition>): WorkViewDefinition => ({
      scope: { allAccessible: true, organisationIds: [], workspaceIds: [], boardIds: [] },
      filters: {
        q: "",
        assigneeIds: [],
        listIds: [],
        labelIds: [],
        customFieldConditions: [],
        completion: "active",
        unassignedOnly: false,
        dueFrom: null,
        dueTo: null,
        overdueOnly: false,
        overdueChecklistOnly: false,
        unreadOnly: false,
        archived: false,
        completedFrom: null,
        completedTo: null,
        lastActivityBefore: null,
        lastMovedBefore: null,
      },
      groupBy: "dueDate",
      sort: "dueAsc",
      display: "table",
      columns: ["source", "list"],
      portfolioDays: 30,
      collapsedOrganisationIds: [],
      collapsedWorkspaceIds: [],
      collapsedSectionIds: [],
      ...patch,
      table: patch.table ?? {
        columnVisibility: {},
        columnOrder: [],
        columnWidths: {},
        aggregates: {},
        aggregateSplitBy: "none",
        collapsedGroupKeys: [],
      },
    });
    writeGlobalWorkPreference(userId, "my", {
      selectedViewId: null,
      drilldownLabel: null,
      definition: definition({
        groupBy: "completion",
        sort: "titleAsc",
        display: "history",
        collapsedWorkspaceIds: ["20000000-0000-4000-8000-000000000001"],
        collapsedSectionIds: ["completed"],
        filters: {
          ...definition({}).filters,
          overdueOnly: true,
        },
      }),
    });
    writeGlobalWorkPreference(userId, "team", {
      selectedViewId: null,
      drilldownLabel: null,
      definition: definition({
        groupBy: "board",
        display: "calendar",
        filters: {
          ...definition({}).filters,
          assigneeIds: [teammateId],
        },
      }),
    });
    writeGlobalWorkPreference(userId, "portfolio", {
      selectedViewId: null,
      drilldownLabel: "All boards · Unassigned",
      definition: definition({
        groupBy: "workspace",
        display: "table",
        portfolioDays: 60,
        filters: {
          ...definition({}).filters,
          unassignedOnly: true,
        },
      }),
    });

    const { state } = setup();
    await state.initialize("my");
    expect(state.definition()).toMatchObject({
      groupBy: "completion",
      sort: "titleAsc",
      display: "history",
      filters: { overdueOnly: true },
      collapsedWorkspaceIds: ["20000000-0000-4000-8000-000000000001"],
      collapsedSectionIds: ["completed"],
    });

    await state.initialize("team");
    expect(state.definition()).toMatchObject({
      groupBy: "board",
      display: "calendar",
      filters: { assigneeIds: [teammateId] },
    });

    await state.initialize("portfolio");
    expect(state.definition()).toMatchObject({
      groupBy: "workspace",
      display: "table",
      portfolioDays: 60,
      filters: { unassignedOnly: true },
    });
    expect(state.drilldownLabel()).toBe("All boards · Unassigned");

    state.setGrouping("organisation");
    state.setSearch("temporary search");
    state.setArchived(true);
    TestBed.tick();
    expect(readGlobalWorkPreference(userId, "portfolio")?.definition).toMatchObject({
      groupBy: "organisation",
      filters: { q: "", archived: false, unassignedOnly: true },
    });
    expect(readGlobalWorkPreference(userId, "my")?.definition.groupBy).toBe("completion");
    expect(readGlobalWorkPreference(userId, "team")?.definition.groupBy).toBe("board");

    state.clearSavedView();
    await vi.waitFor(() => expect(state.loading()).toBe(false));
    TestBed.tick();
    expect(readGlobalWorkPreference(userId, "portfolio")?.definition).toMatchObject({
      groupBy: "board",
      display: "summary",
      portfolioDays: 30,
      filters: { unassignedOnly: false },
    });
  });

  it("persists collapsed layout locally and restores it when applying a saved view", async () => {
    const userId = "60000000-0000-4000-8000-000000000001";
    const workspaceId = "20000000-0000-4000-8000-000000000001";
    const boardId = "30000000-0000-4000-8000-000000000001";
    const { state } = setup();
    await state.initialize("my");

    state.setGrouping("board");
    state.setDisplay("board");
    state.toggleWorkspaceCollapsed(workspaceId);
    state.toggleSectionCollapsed(boardId);
    state.setCollapsedTableGroupKeys([`board:${boardId}`]);
    state.setCollapsedHistoryDayKeys(["2026-07-24"]);
    state.toggleChecklistGroupCollapsed("checklist:overdue");
    TestBed.tick();

    expect(readGlobalWorkPreference(userId, "my")).toMatchObject({
      definition: {
        collapsedWorkspaceIds: [workspaceId],
        collapsedSectionIds: [boardId],
        table: { collapsedGroupKeys: [`board:${boardId}`] },
      },
      collapsedTableGroupKeys: [`board:${boardId}`],
      collapsedHistoryDayKeys: ["2026-07-24"],
      collapsedChecklistGroupIds: ["checklist:overdue"],
    });

    const savedDefinition = state.definition();
    const savedView: SavedWorkView = {
      id: "70000000-0000-4000-8000-000000000001",
      clientId: "10000000-0000-4000-8000-000000000001",
      ownerId: userId,
      ownerName: "Viewer",
      name: "Collapsed priorities",
      lens: "my",
      visibility: "private",
      definitionVersion: 1,
      definition: savedDefinition,
      editable: true,
      sharedUserIds: [],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
    };

    state.toggleWorkspaceCollapsed(workspaceId);
    state.toggleSectionCollapsed(boardId);
    expect(state.definition().collapsedWorkspaceIds).toEqual([]);
    expect(state.definition().collapsedSectionIds).toEqual([]);

    state.applySavedView(savedView);
    await vi.waitFor(() => expect(state.loading()).toBe(false));
    expect(state.definition().collapsedWorkspaceIds).toEqual([workspaceId]);
    expect(state.definition().collapsedSectionIds).toEqual([boardId]);
  });

  it("includes the complete table presentation when creating and applying a saved view", async () => {
    const { state, post } = setup();
    await state.initialize("my");
    const fieldId = "90000000-0000-4000-8000-000000000001";
    const presentation = {
      columnVisibility: { labels: true, [`cf:${fieldId}`]: true },
      columnOrder: ["board", `cf:${fieldId}`, "due"],
      columnWidths: { title: 360, [`cf:${fieldId}`]: 180 },
      aggregates: { [fieldId]: ["sum" as const] },
      aggregateSplitBy: "board",
      collapsedGroupKeys: ["board:30000000-0000-4000-8000-000000000001"],
    };
    state.setGrouping("board");
    state.setSort("titleDesc");
    state.setTablePresentation(presentation);

    await state.createSavedView("Revenue rollup", "private");

    const createCall = post.mock.calls.find(([path]) => path === "/work-views");
    expect(createCall?.[1]).toMatchObject({
      definition: {
        groupBy: "board",
        sort: "titleDesc",
        table: presentation,
      },
    });

    state.resetTablePresentation();
    expect(state.definition().table.aggregates).toEqual({});
    state.applySavedView(state.savedViews()[0]!);
    expect(state.definition().table).toEqual(presentation);
    expect(state.collapsedTableGroupKeys()).toEqual(presentation.collapsedGroupKeys);
  });

  it("drops the portfolio title search when returning to the summary", async () => {
    const { state } = setup();
    await state.initialize("portfolio");

    state.setDisplay("table");
    state.setSearch("migration");
    expect(state.definition().filters.q).toBe("migration");

    // The summary hides the search box, so a leftover query would narrow every metric and heatmap
    // with nothing on screen to explain it.
    state.setDisplay("summary");
    expect(state.definition().filters.q).toBe("");
  });

  it("defers portfolio cards until a row display is opened", async () => {
    const { state, post } = setup();
    await state.initialize("portfolio");
    const cardQueries = () => post.mock.calls.filter(([path]) => path === "/work/cards/query");
    expect(cardQueries()).toHaveLength(0);
    expect(post.mock.calls.filter(([path]) => path === "/work/portfolio/query")).toHaveLength(1);

    state.setDisplay("table");
    await vi.waitFor(() => expect(state.loading()).toBe(false));
    expect(cardQueries()).toHaveLength(1);
  });

  it("keeps the search query when other lenses change display", async () => {
    const { state } = setup();
    await state.initialize("my");

    state.setSearch("migration");
    state.setDisplay("table");
    expect(state.definition().filters.q).toBe("migration");
  });
});

describe("GlobalWorkState priority queue", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  const priorityGets = (get: { mock: { calls: unknown[][] } }) =>
    get.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith("/work/priorities/"));

  it("reads the viewer's own queue from the shell service instead of fetching its own copy", async () => {
    const { state, get } = setup();
    const myPriorities = TestBed.inject(MyPrioritiesService);
    await state.initialize("my");
    // No fetch of its own: a second copy of the viewer's queue is a second thing that can disagree
    // with the drawer and Home. The shell service is the only owner.
    expect(priorityGets(get)).toHaveLength(0);
    expect(state.priorities()).toBeNull();

    myPriorities.initialise();
    await vi.waitFor(() => expect(state.priorities()?.items.map((item) => item.rank)).toEqual([1, 2]));
    expect(state.priorities()).toBe(myPriorities.queue());
  });

  it("issues no request when no single teammate is in focus", async () => {
    const { state, get } = setup();
    await state.initialize("team");
    // Two people selected: a queue belongs to one person, so there is nothing to ask for.
    state.setAssignees([TEAMMATE_ID, "60000000-0000-4000-8000-000000000003"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.focusedTargetUserId()).toBeNull();
    expect(priorityGets(get)).toHaveLength(0);
    expect(state.priorities()).toBeNull();
  });

  it("keeps Team Cards alive when the focused teammate's queue is forbidden", async () => {
    // Any member can focus a teammate, but only admins may read that queue: the server's 403 means
    // "no queue surface for you", and the ride-along fetch must not take the card query down.
    const { state, get } = setup({ prioritiesForbidden: true });
    await state.initialize("team");
    state.setAssignees([TEAMMATE_ID]);
    await state.queryFirstPage();

    expect(state.focusedTargetUserId()).toBe(TEAMMATE_ID);
    expect(priorityGets(get).length).toBeGreaterThan(0);
    expect(state.priorities()).toBeNull();
    expect(state.error()).toBeNull();
    expect(state.cards().length).toBeGreaterThan(0);
  });

  it("loads every readable queue on the team lens and refreshes on any target's invalidation", async () => {
    vi.useFakeTimers();
    try {
      const { state, socket, get } = setup();
      const batchGets = () => get.mock.calls.filter(([path]) => path === "/work/priorities");
      await state.initialize("team");
      await vi.advanceTimersByTimeAsync(0);

      // The lanes display reads this ambiently, so the batch rides initialize — a display switch
      // does not re-query.
      expect(batchGets()).toHaveLength(1);
      expect(state.teamPriorities()?.queues.map((lane) => lane.target.userId)).toEqual([VIEWER_ID, TEAMMATE_ID]);

      // Nobody is focused, but the lanes show every readable queue — a teammate's ping is
      // relevant here, unlike on My Cards (see "ignores other people's" below).
      socket.trigger(SERVER_EVENTS.CARD_PRIORITY_INVALIDATED, { targetUserId: TEAMMATE_ID });
      await vi.advanceTimersByTimeAsync(180);
      expect(batchGets()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads the viewer's own add candidates when Team Cards enters Priority view", async () => {
    const { state, post } = setup();
    await state.initialize("team");
    expect(state.teamPrioritySelfCandidateCards()).toEqual([]);

    state.setDisplay("priorities");
    expect(state.interactionReady()).toBe(false);
    await vi.waitFor(() => expect(state.interactionReady()).toBe(true));

    expect(state.teamPrioritySelfCandidateCards().map((card) => card.id)).toEqual([
      "40000000-0000-4000-8000-000000000001",
    ]);
    expect(post.mock.calls.some(([path, body]) =>
      path === "/work/cards/query" && (body as { lens?: string }).lens === "my"
    )).toBe(true);
  });

  it("never fetches the queue batch outside the team lens", async () => {
    const { state, get } = setup();
    await state.initialize("my");
    expect(get.mock.calls.filter(([path]) => path === "/work/priorities")).toHaveLength(0);
    expect(state.teamPriorities()).toBeNull();
  });

  it("reorders one lane optimistically and folds the server's queue back into the batch", async () => {
    const { state, post } = setup();
    await state.initialize("team");
    const laneOf = () => state.teamPriorities()!.queues.find((lane) => lane.target.userId === TEAMMATE_ID)!.queue;
    const [first, second] = laneOf().items;

    const moved: WorkPrioritiesResponse = {
      ...teammateQueue,
      items: [
        { ...teammateQueue.items[1]!, rank: 1, position: "500.0000000000" },
        { ...teammateQueue.items[0]!, rank: 2, position: "3000.0000000000" },
      ],
    };
    post.mockResolvedValueOnce(moved);
    const pending = state.moveTeamPriority(TEAMMATE_ID, first!.id, { beforeId: null });

    // Applied before the round trip, ranks renumbered — and only in the touched lane.
    expect(laneOf().items.map((item) => item.id)).toEqual([second!.id, first!.id]);
    expect(laneOf().items.map((item) => item.rank)).toEqual([1, 2]);
    expect(state.teamPriorities()!.queues[0]!.queue).toEqual(priorities);

    await pending;
    expect(laneOf()).toEqual(moved);
  });

  it("adds to one team lane optimistically and settles only that lane", async () => {
    const { state, post } = setup();
    await state.initialize("team");
    const candidate = {
      ...response.cards[0]!,
      id: "40000000-0000-4000-8000-000000000019",
      title: "New teammate priority",
      assigneeIds: [TEAMMATE_ID],
    };
    state.response.update((current) => ({ ...current, cards: [...current.cards, candidate] }));
    const created = {
      id: "80000000-0000-4000-8000-000000000019",
      position: "3000.0000000000",
      rank: 3,
      card: candidate,
      context: { boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing", workspaceName: "Delivery" },
    };
    const settled: WorkPrioritiesResponse = {
      ...teammateQueue,
      items: [...teammateQueue.items, created],
      totalCount: 3,
    };
    post.mockResolvedValueOnce(settled);

    const pending = state.addTeamPriority(TEAMMATE_ID, candidate.id, { beforeId: null });
    const laneOf = () => state.teamPriorities()!.queues.find((lane) => lane.target.userId === TEAMMATE_ID)!.queue;
    expect(laneOf().items.at(-1)?.id).toBe(`pending:${candidate.id}`);
    expect(laneOf().totalCount).toBe(3);
    expect(state.teamPriorities()!.queues[0]!.queue).toEqual(priorities);

    await pending;
    expect(post).toHaveBeenCalledWith(`/work/priorities/${TEAMMATE_ID}/cards`, {
      cardId: candidate.id,
      beforeId: null,
    });
    expect(laneOf()).toEqual(settled);
  });

  it("restores the exact lane snapshot when a lane removal is rejected", async () => {
    const { state, setOffline } = setup();
    await state.initialize("team");
    const snapshot = state.teamPriorities();

    setOffline(true);
    const pending = state.removeTeamPriority(TEAMMATE_ID, teammateQueue.items[0]!.id);
    const lane = state.teamPriorities()!.queues.find((candidate) => candidate.target.userId === TEAMMATE_ID)!.queue;
    expect(lane.items.map((item) => item.rank)).toEqual([1]);
    expect(lane.totalCount).toBe(1);

    await expect(pending).rejects.toThrow();
    expect(state.teamPriorities()).toEqual(snapshot);
  });

  it("keeps ranked cards visible in the queue when the filters exclude them", async () => {
    const { state } = setup();
    TestBed.inject(MyPrioritiesService).initialise();
    await state.initialize("my");
    await vi.waitFor(() => expect(state.priorities()).not.toBeNull());

    // The one card in the query result is also #1 in the queue, so nothing else is addable. This
    // is the invariant that stops a card wearing a rank pill and offering "+ Up next" at once.
    const ranked = state.rankedCardIds();
    expect([...ranked]).toEqual(["40000000-0000-4000-8000-000000000001"]);
    expect(state.cards().filter((card) => !ranked.has(card.id))).toEqual([]);

    // The queue is filter-independent: it survives a filter that excludes its card, which is
    // exactly why it is a separate endpoint rather than a sort on the card query.
    state.updateFilters({ q: "nothing matches this" });
    expect(state.priorities()?.items[0]?.card?.id).toBe("40000000-0000-4000-8000-000000000001");
  });

  it("writes an optimistic position synchronously and restores the exact snapshot on reject", async () => {
    const { state, setOffline } = setup();
    // The write is delegated to the shell service, but it must still land — and roll back — through
    // the page's own `priorities` seam, which is what every Global Work surface reads.
    TestBed.inject(MyPrioritiesService).initialise();
    await state.initialize("my");
    await vi.waitFor(() => expect(state.priorities()).not.toBeNull());
    const snapshot = state.priorities();

    setOffline(true);
    const moving = snapshot!.items[0]!.id;
    const pending = state.movePriority(moving, { beforeId: null });
    // Applied before the round trip: the row is under the pointer and must not wait for the server.
    expect(state.priorities()!.items.map((item) => item.id)).toEqual([
      "80000000-0000-4000-8000-000000000002",
      moving,
    ]);
    expect(state.priorities()!.items.map((item) => item.rank)).toEqual([1, 2]);

    await expect(pending).rejects.toThrow();
    expect(state.priorities()).toEqual(snapshot);
  });

  it("ignores priority invalidations entirely on My Cards", async () => {
    vi.useFakeTimers();
    try {
      const { state, socket, get, post } = setup();
      await state.initialize("my");
      await vi.advanceTimersByTimeAsync(0);
      const priorityCallsBefore = priorityGets(get).length;
      const cardCallsBefore = post.mock.calls.filter(([path]) => path === "/work/cards/query").length;

      // The viewer's own queue is service-owned and converges there. Nothing on this page depends
      // on it — there is no priority sort, and rank pills read the queue itself — so a card
      // requery would be pure waste.
      for (let index = 0; index < 3; index += 1) {
        socket.trigger(SERVER_EVENTS.CARD_PRIORITY_INVALIDATED, { targetUserId: VIEWER_ID });
      }
      // Somebody else's queue changed: this page is not showing it either.
      socket.trigger(SERVER_EVENTS.CARD_PRIORITY_INVALIDATED, { targetUserId: TEAMMATE_ID });
      await vi.advanceTimersByTimeAsync(180);

      expect(post.mock.calls.filter(([path]) => path === "/work/cards/query").length).toBe(cardCallsBefore);
      expect(priorityGets(get).length).toBe(priorityCallsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows the Priorities display on the team lens only", () => {
    // "priorities" is the team lanes display. A stored preference naming it — including one left
    // over from the pre-panel display-mode era — is honoured on the team lens and falls back
    // everywhere else: My Cards has the docked panel, and the portfolio has no queues.
    const stored = { ...cachedDefinition, display: "priorities" } as WorkViewDefinition;
    writeGlobalWorkPreference(VIEWER_ID, "team", { definition: stored, selectedViewId: null, drilldownLabel: null });
    expect(readGlobalWorkPreference(VIEWER_ID, "team")?.definition.display).toBe("priorities");

    expect(sanitizeGlobalWorkDefinition(stored, "team", catalog, VIEWER_ID).display).toBe("priorities");
    expect(sanitizeGlobalWorkDefinition({
      ...stored,
      filters: { ...stored.filters, assigneeIds: [TEAMMATE_ID] },
    }, "team", catalog, VIEWER_ID).filters.assigneeIds).toEqual([]);
    for (const lens of ["my", "portfolio"] as const) {
      const display = sanitizeGlobalWorkDefinition(stored, lens, catalog, VIEWER_ID).display;
      expect(["board", "table", "summary"]).toContain(display);
      expect(display).not.toBe("priorities");
    }
  });

  it("opens the Up next panel unless this person explicitly closed it", async () => {
    // No stored preference at all: the panel defaults open — the queue must not hide behind a
    // toggle nobody has pressed yet.
    const first = setup();
    await first.state.initialize("my");
    expect(first.state.upNextPanelOpen()).toBe(true);

    // A preference written before the flag existed reads the same as none: still open. The write
    // happens after the reset because tearing down the previous state persists its own preference.
    TestBed.resetTestingModule();
    writeGlobalWorkPreference(VIEWER_ID, "my", { definition: cachedDefinition, selectedViewId: null, drilldownLabel: null });
    const upgraded = setup();
    await upgraded.state.initialize("my");
    expect(upgraded.state.upNextPanelOpen()).toBe(true);

    // Only a stored explicit close keeps it closed.
    TestBed.resetTestingModule();
    writeGlobalWorkPreference(VIEWER_ID, "my", {
      definition: cachedDefinition,
      selectedViewId: null,
      drilldownLabel: null,
      upNextPanelOpen: false,
    });
    const closed = setup();
    await closed.state.initialize("my");
    expect(closed.state.upNextPanelOpen()).toBe(false);
  });

  it("restores a cached snapshot written before the queue existed", async () => {
    const cached = {
      key: "k",
      cachedAt: "2026-07-25T00:00:00.000Z",
      definition: cachedDefinition,
      catalog,
      response,
      portfolio: null,
      savedViews: [],
    } as unknown as CachedGlobalWork;
    const { state } = setup({ apiFails: true, cached });
    await state.initialize("my");

    expect(state.priorities()).toBeNull();
  });
});
