import { Dialog } from "@angular/cdk/dialog";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { DEFAULT_COMPLETION } from "./global-work-preference";
import { GlobalWorkPage } from "./global-work.page";
import { GlobalWorkState } from "./global-work.state";

const card = {
  id: "40000000-0000-4000-8000-000000000001",
  number: 1,
  key: "WORK-1",
  organisationKey: "0123456789ABCDEF",
  boardId: "30000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  listId: "50000000-0000-4000-8000-000000000001",
  title: "Ship it",
  position: "1000.0000000000",
  dueDateLocalDate: null,
  dueDateSlot: null,
  dueDateTimezone: null,
  completedAt: null,
  archivedAt: null,
  coverAttachmentId: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  hasDescription: false,
  commentCount: 0,
  attachmentCount: 0,
  checklistDoneCount: 0,
  checklistTotalCount: 0,
  coverUrl: null,
  coverImageWidth: null,
  coverImageHeight: null,
  coverImageColor: null,
  labelIds: [],
  assigneeIds: [],
  customFieldValues: [],
};

describe("GlobalWorkPage card routing", () => {
  // The gate the table consumes as `editableCardIds`: a cross-board sheet mixes boards the viewer
  // edits with boards they only observe, and every editing affordance in it is per row.
  it("does not treat cards from observer boards as editable", async () => {
    const catalog = signal({
      organisations: [],
      workspaces: [],
      boards: [{
        id: card.boardId,
        workspaceId: card.workspaceId,
        name: "Observed",
        icon: null,
        iconColor: null,
        viewerRole: "observer" as "editor" | "observer",
        assignedItemsOnly: false,
      }],
      lists: [],
      labels: [],
      customFields: [],
      people: [],
    });
    const setCardCompleted = vi.fn();
    const state = {
      cards: signal([card]),
      response: signal({
        cards: [card],
        checklistItems: [],
        totals: { cards: 1, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
        nextCursor: null,
      }),
      catalog,
      interactionReady: signal(true),
      setCardCompleted,
      initialize: vi.fn(() => Promise.resolve()),
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: Dialog, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    })
      .overrideComponent(GlobalWorkPage, {
        set: {
          template: "",
          providers: [{ provide: GlobalWorkState, useValue: state }],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalWorkPage);
    fixture.componentRef.setInput("lens", "team");
    fixture.detectChanges();
    TestBed.tick();

    expect(fixture.componentInstance.roleEditableCardIds().has(card.id)).toBe(false);

    catalog.update((current) => ({
      ...current,
      boards: current.boards.map((board) => ({ ...board, viewerRole: "editor" as const })),
    }));
    TestBed.tick();
    expect(fixture.componentInstance.roleEditableCardIds().has(card.id)).toBe(true);

    fixture.destroy();
  });

  it("adds and removes the card path without leaving My Cards", async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const response = signal({
      cards: [card],
      checklistItems: [],
      totals: { cards: 1, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
      nextCursor: null,
    });
    const state = {
      cards: signal([card]),
      response,
      initialize: vi.fn(() => Promise.resolve()),
      queryFirstPage: vi.fn(() => Promise.resolve()),
      reconcileCardsInBackground: vi.fn(),
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: Dialog, useValue: {} },
        { provide: Router, useValue: { navigate } },
      ],
    })
      .overrideComponent(GlobalWorkPage, {
        set: {
          template: "",
          providers: [{ provide: GlobalWorkState, useValue: state }],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalWorkPage);
    fixture.componentRef.setInput("lens", "my");
    fixture.detectChanges();
    TestBed.tick();
    navigate.mockClear();

    fixture.componentInstance.openCard(card);
    expect(navigate).toHaveBeenCalledWith(["/my-cards", "c", card.id], {
      queryParams: { cardId: null },
      queryParamsHandling: "merge",
      browserUrl: "/o/0123456789ABCDEF/c/WORK-1",
    });
    state.cards.set([{ ...card, title: "Ship it now" }]);
    TestBed.tick();
    expect(fixture.componentInstance.selectedCard()?.id).toBe(card.id);

    fixture.componentRef.setInput("cardId", card.id);
    TestBed.tick();
    expect(fixture.componentInstance.selectedCard()?.id).toBe(card.id);

    fixture.componentInstance.closeCard();
    await Promise.resolve();
    expect(navigate).toHaveBeenLastCalledWith(["/my-cards"], {
      queryParams: { cardId: null },
      queryParamsHandling: "merge",
    });
    expect(state.queryFirstPage).not.toHaveBeenCalled();

    fixture.componentInstance.startInlineAdd({ listId: card.listId, atTop: false });
    fixture.componentInstance.onInlineCardCreated();
    expect(state.reconcileCardsInBackground).toHaveBeenCalledOnce();
    expect(state.queryFirstPage).not.toHaveBeenCalled();
    expect(fixture.componentInstance.addingListId()).toBeNull();

    fixture.destroy();
  });

  it("closes the detail when browser navigation removes the card id", async () => {
    const state = {
      cards: signal([card]),
      response: signal({
        cards: [card],
        checklistItems: [],
        totals: { cards: 1, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
        nextCursor: null,
      }),
      initialize: vi.fn(() => Promise.resolve()),
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: Dialog, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    })
      .overrideComponent(GlobalWorkPage, {
        set: {
          template: "",
          providers: [{ provide: GlobalWorkState, useValue: state }],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalWorkPage);
    fixture.componentRef.setInput("lens", "team");
    fixture.componentRef.setInput("cardId", card.id);
    fixture.detectChanges();
    TestBed.tick();
    expect(fixture.componentInstance.selectedCard()?.id).toBe(card.id);

    fixture.componentRef.setInput("cardId", undefined);
    TestBed.tick();
    expect(fixture.componentInstance.selectedCard()).toBeNull();

    fixture.destroy();
  });

  it("preserves catalog source order for board sections and portfolio hierarchy", async () => {
    const secondWorkspaceId = "20000000-0000-4000-8000-000000000002";
    const secondBoardId = "30000000-0000-4000-8000-000000000002";
    const secondCard = {
      ...card,
      id: "40000000-0000-4000-8000-000000000002",
      workspaceId: secondWorkspaceId,
      boardId: secondBoardId,
    };
    const state = {
      cards: signal([card, secondCard]),
      response: signal({
        cards: [card, secondCard],
        checklistItems: [],
        totals: { cards: 2, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
        nextCursor: null,
      }),
      catalog: signal({
        organisations: [{ id: "10000000-0000-4000-8000-000000000001", name: "Home", external: false }],
        // Alphabetical order is Alpha then Zulu; catalog order deliberately mirrors the sidebar.
        workspaces: [
          {
            id: card.workspaceId,
            organisationId: "10000000-0000-4000-8000-000000000001",
            name: "Zulu",
            icon: null,
            accentColor: null,
            kind: "standard",
            viewerCanAccessWorkspace: true,
          },
          {
            id: secondWorkspaceId,
            organisationId: "10000000-0000-4000-8000-000000000001",
            name: "Alpha",
            icon: null,
            accentColor: null,
            kind: "standard",
            viewerCanAccessWorkspace: true,
          },
        ],
        boards: [],
        // Native positions are intentionally opposite the workspace sequence. The API catalog is
        // already in sidebar order, and the page must not reshuffle unrelated workspace metadata.
        lists: [
          { id: "list-zulu", workspaceId: card.workspaceId, name: "Zulu list", icon: null, color: null, position: "3000.0000000000" },
          { id: "list-alpha", workspaceId: secondWorkspaceId, name: "Alpha list", icon: null, color: null, position: "1000.0000000000" },
        ],
        labels: [
          { id: "label-zulu", workspaceId: card.workspaceId, name: "Zulu label", color: null, position: "3000.0000000000" },
          { id: "label-alpha", workspaceId: secondWorkspaceId, name: "Alpha label", color: null, position: "1000.0000000000" },
        ],
        customFields: [
          { id: "field-zulu", workspaceId: card.workspaceId, name: "Zulu field", archivedAt: null },
          { id: "field-alpha", workspaceId: secondWorkspaceId, name: "Alpha field", archivedAt: null },
        ],
        people: [],
      }),
      // Only the collapse sets are read by the portfolio tree; the rest of the definition is not
      // touched on this path.
      definition: signal({ collapsedOrganisationIds: [], collapsedWorkspaceIds: [] }),
      portfolio: signal({
        days: 30,
        activityDays: 60,
        activity: [],
        totals: { cards: 2, overdue: 0, dueSoon: 0, completed: 0, overdueChecklistItems: 0, unassigned: 0 },
        buckets: [
          {
            organisationId: "10000000-0000-4000-8000-000000000001",
            organisationName: "Home",
            workspaceId: card.workspaceId,
            workspaceName: "Zulu",
            boardId: card.boardId,
            boardName: "Zulu board",
            active: 1,
            overdue: 0,
            dueSoon: 0,
            unassigned: 0,
            completed: 0,
            overdueChecklistItems: 0,
          },
          {
            organisationId: "10000000-0000-4000-8000-000000000001",
            organisationName: "Home",
            workspaceId: secondWorkspaceId,
            workspaceName: "Alpha",
            boardId: secondBoardId,
            boardName: "Alpha board",
            active: 1,
            overdue: 0,
            dueSoon: 0,
            unassigned: 0,
            completed: 0,
            overdueChecklistItems: 0,
          },
        ],
      }),
      initialize: vi.fn(() => Promise.resolve()),
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: Dialog, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    })
      .overrideComponent(GlobalWorkPage, {
        set: {
          template: "",
          providers: [{ provide: GlobalWorkState, useValue: state }],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalWorkPage);
    fixture.componentRef.setInput("lens", "portfolio");
    fixture.detectChanges();
    TestBed.tick();

    expect(fixture.componentInstance.boardWorkspaces().map((workspace) => workspace.name)).toEqual(["Zulu", "Alpha"]);
    expect(
      fixture.componentInstance.portfolioRows()
        .filter((row) => row.level === "workspace")
        .map((row) => row.label),
    ).toEqual(["Zulu", "Alpha"]);
    expect(fixture.componentInstance.filterLists().map((list) => [list.id, list.group]))
      .toEqual([["list-zulu", "Zulu"], ["list-alpha", "Alpha"]]);
    expect(fixture.componentInstance.filterLabels().map((label) => [label.id, label.group]))
      .toEqual([["label-zulu", "Zulu"], ["label-alpha", "Alpha"]]);
    expect(fixture.componentInstance.filterFields().map((field) => field.id))
      .toEqual(["field-zulu", "field-alpha"]);
    expect(fixture.componentInstance.filterFieldGroups()).toEqual({
      "field-zulu": "Zulu",
      "field-alpha": "Alpha",
    });

    fixture.destroy();
  });

  it("buckets assigned checklist items by urgency, soonest first", async () => {
    const localDate = (offsetDays: number) => {
      const date = new Date();
      date.setDate(date.getDate() + offsetDays);
      return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
    };
    const item = (text: string, dueDateLocalDate: string | null) => ({
      itemId: `item-${text}`,
      text,
      cardId: card.id,
      cardTitle: "Ship it",
      checklistId: "checklist-1",
      listId: card.listId,
      boardId: card.boardId,
      boardName: "Board",
      boardIcon: null,
      assigneeId: "60000000-0000-4000-8000-000000000001",
      dueDateLocalDate,
      dueDateSlot: "anyTime" as const,
      dueDateTimezone: "UTC",
    });
    // Deliberately unsorted, and one bucket holds two items so ordering inside a group is covered.
    const checklistItems = [
      item("later", localDate(30)),
      item("undated", null),
      item("soon-second", localDate(5)),
      item("overdue", localDate(-9)),
      item("soon-first", localDate(3)),
    ];
    const state = {
      cards: signal([]),
      response: signal({
        cards: [],
        checklistItems,
        totals: { cards: 0, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 5, overdueChecklistItems: 1 },
        nextCursor: null,
      }),
      initialize: vi.fn(() => Promise.resolve()),
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: Dialog, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    })
      .overrideComponent(GlobalWorkPage, {
        set: {
          template: "",
          providers: [{ provide: GlobalWorkState, useValue: state }],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalWorkPage);
    fixture.componentRef.setInput("lens", "my");
    fixture.detectChanges();
    TestBed.tick();

    const groups = fixture.componentInstance.checklistGroups();
    // Empty buckets are dropped, and the surviving ones stay in urgency order.
    expect(groups.map((group) => group.label)).toEqual(["Overdue", "Next 7 days", "Later", "No due date"]);
    expect(groups.map((group) => group.items.map((entry) => entry.text))).toEqual([
      ["overdue"],
      ["soon-first", "soon-second"],
      ["later"],
      ["undated"],
    ]);
    expect(groups[0]!.overdue).toBe(true);
    expect(fixture.componentInstance.overdueChecklistCount()).toBe(1);

    fixture.destroy();
  });

  it("counts only dated cards for the calendar, which drops undated ones", async () => {
    const dated = { ...card, id: "40000000-0000-4000-8000-00000000000a", dueDateLocalDate: "2026-07-15" };
    const undated = { ...card, id: "40000000-0000-4000-8000-00000000000c", dueDateLocalDate: null };
    const cards = [dated, undated];
    const state = {
      cards: signal(cards),
      response: signal({
        cards,
        checklistItems: [],
        totals: { cards: 2, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
        nextCursor: null,
      }),
      initialize: vi.fn(() => Promise.resolve()),
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: Dialog, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    })
      .overrideComponent(GlobalWorkPage, {
        set: {
          template: "",
          providers: [{ provide: GlobalWorkState, useValue: state }],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalWorkPage);
    fixture.componentRef.setInput("lens", "my");
    fixture.detectChanges();
    TestBed.tick();

    // The empty state hangs off this count, so an undated-only result must still read as empty.
    expect(fixture.componentInstance.datedCardCount()).toBe(1);
    state.cards.set([undated]);
    TestBed.tick();
    expect(fixture.componentInstance.datedCardCount()).toBe(0);

    fixture.destroy();
  });
});

describe("GlobalWorkPage offline display", () => {
  it("falls back from uncached History to the saved card table until reconciliation succeeds", async () => {
    const cachedAt = signal<string | null>("2026-07-24T12:00:00.000Z");
    const state = {
      cards: signal([]),
      response: signal({
        cards: [],
        checklistItems: [],
        totals: { cards: 0, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
        nextCursor: null,
      }),
      definition: signal({ display: "history" }),
      cachedAt,
      initialize: vi.fn(() => Promise.resolve()),
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: Dialog, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    })
      .overrideComponent(GlobalWorkPage, {
        set: {
          template: "",
          providers: [{ provide: GlobalWorkState, useValue: state }],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalWorkPage);
    fixture.componentRef.setInput("lens", "my");
    fixture.detectChanges();

    expect(fixture.componentInstance.effectiveDisplay()).toBe("table");
    expect(fixture.componentInstance.historyOfflineFallback()).toBe(true);

    cachedAt.set(null);
    TestBed.tick();
    expect(fixture.componentInstance.effectiveDisplay()).toBe("history");
    expect(fixture.componentInstance.historyOfflineFallback()).toBe(false);
  });
});

describe("GlobalWorkPage portfolio summary", () => {
  const organisationId = "10000000-0000-4000-8000-000000000001";
  const workspaceOne = "20000000-0000-4000-8000-000000000001";
  const workspaceTwo = "20000000-0000-4000-8000-000000000002";
  // A standalone board: a `kind: "board"` workspace whose only board carries the same name.
  const standaloneWorkspace = "20000000-0000-4000-8000-000000000003";
  const standaloneBoard = "30000000-0000-4000-8000-000000000004";
  const workspaceNames: Record<string, string> = {
    [workspaceOne]: "Delivery",
    [workspaceTwo]: "Product",
    [standaloneWorkspace]: "Roadmap",
  };
  const bucket = (workspaceId: string, boardId: string, active: number, overdue = 0) => ({
    organisationId,
    organisationName: "Home",
    workspaceId,
    workspaceName: workspaceNames[workspaceId] ?? "Workspace",
    boardId,
    boardName: boardId === standaloneBoard ? "Roadmap" : `Board ${boardId.slice(-1)}`,
    active,
    overdue,
    dueSoon: 0,
    unassigned: 0,
    completed: 0,
    overdueChecklistItems: 0,
  });

  async function mount(activity: { date: string; moved: number; completed: number }[] = []) {
    const definition = signal({ collapsedOrganisationIds: [] as string[], collapsedWorkspaceIds: [] as string[] });
    const toggle = (key: "collapsedOrganisationIds" | "collapsedWorkspaceIds") => (id: string) =>
      definition.update((current) => ({
        ...current,
        [key]: current[key].includes(id) ? current[key].filter((entry) => entry !== id) : [...current[key], id],
      }));
    const state = {
      cards: signal([]),
      response: signal({
        cards: [],
        checklistItems: [],
        totals: { cards: 0, overdue: 0, dueSoon: 0, completed: 0, checklistItems: 0, overdueChecklistItems: 0 },
        nextCursor: null,
      }),
      definition,
      catalog: signal({
        organisations: [{ id: organisationId, name: "Home", external: false }],
        workspaces: [
          { id: workspaceOne, organisationId, name: "Delivery", icon: null, accentColor: null, kind: "standard", viewerCanAccessWorkspace: true },
          { id: workspaceTwo, organisationId, name: "Product", icon: null, accentColor: null, kind: "standard", viewerCanAccessWorkspace: true },
          { id: standaloneWorkspace, organisationId, name: "Roadmap", icon: null, accentColor: null, kind: "board", viewerCanAccessWorkspace: true },
        ],
        boards: [{ id: standaloneBoard, workspaceId: standaloneWorkspace, name: "Roadmap", icon: "map", iconColor: null, viewerRole: "editor", assignedItemsOnly: false }],
        lists: [],
        labels: [],
        customFields: [],
        people: [],
      }),
      portfolio: signal({
        days: 30,
        activityDays: 60,
        activity,
        totals: { cards: 6, overdue: 3, dueSoon: 0, completed: 0, overdueChecklistItems: 0, unassigned: 0 },
        buckets: [
          bucket(workspaceOne, "30000000-0000-4000-8000-000000000001", 8, 3),
          bucket(workspaceOne, "30000000-0000-4000-8000-000000000002", 2),
          bucket(workspaceTwo, "30000000-0000-4000-8000-000000000003", 4),
          bucket(standaloneWorkspace, standaloneBoard, 1),
        ],
      }),
      toggleOrganisationCollapsed: vi.fn(toggle("collapsedOrganisationIds")),
      toggleWorkspaceCollapsed: vi.fn(toggle("collapsedWorkspaceIds")),
      initialize: vi.fn(() => Promise.resolve()),
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: Dialog, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    })
      .overrideComponent(GlobalWorkPage, {
        set: {
          template: "",
          providers: [{ provide: GlobalWorkState, useValue: state }],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalWorkPage);
    fixture.componentRef.setInput("lens", "portfolio");
    fixture.detectChanges();
    TestBed.tick();
    return fixture;
  }

  it("hides descendants of collapsed organisations and workspaces", async () => {
    const fixture = await mount();
    const page = fixture.componentInstance;
    const ids = () => page.portfolioRows().map((row) => row.id);
    expect(ids()).toHaveLength(7);

    const workspaceRow = page.portfolioRows().find((row) => row.level === "workspace")!;
    page.togglePortfolioRow(workspaceRow, new Event("click"));
    TestBed.tick();
    // The workspace row itself stays visible; only its boards fold away.
    expect(ids()).toEqual([
      "organisation:" + organisationId,
      "workspace:" + workspaceOne,
      "workspace:" + workspaceTwo,
      "board:30000000-0000-4000-8000-000000000003",
      "workspace:" + standaloneWorkspace,
    ]);

    const organisationRow = page.portfolioRows()[0]!;
    page.togglePortfolioRow(organisationRow, new Event("click"));
    TestBed.tick();
    expect(ids()).toEqual(["organisation:" + organisationId]);

    // The second workspace is still open, so collapse-all folds the rest rather than expanding.
    expect(page.portfolioAllCollapsed()).toBe(false);
    page.togglePortfolioRowsCollapsed();
    TestBed.tick();
    expect(page.portfolioAllCollapsed()).toBe(true);
    expect(ids()).toEqual(["organisation:" + organisationId]);

    // Once everything is folded the same control expands it again.
    page.togglePortfolioRowsCollapsed();
    TestBed.tick();
    expect(ids()).toHaveLength(7);
    expect(page.portfolioAllCollapsed()).toBe(false);

    fixture.destroy();
  });

  it("scales conditional highlighting on one column-wide scale across tree levels", async () => {
    const fixture = await mount();
    const page = fixture.componentInstance;
    const organisationRow = page.portfolioRows()[0]!;
    const boards = page.portfolioRows().filter((row) => row.level === "board");
    const [busiest, quietest, other] = boards;
    // The workspace holding 4 active cards, against boards holding 8 and 2.
    const smallerWorkspace = page.portfolioRows()
      .find((row) => row.level === "workspace" && row.id === "workspace:" + workspaceTwo)!;

    // The column's largest number — here the organisation rollup — anchors the top of the scale, and
    // everything else ranks below it in order.
    expect(page.portfolioHeat(organisationRow, "active")).toBe(1);
    expect(page.portfolioHeat(busiest!, "active")).toBeLessThan(1);
    expect(page.portfolioHeat(other!, "active")).toBeLessThan(page.portfolioHeat(busiest!, "active"));
    expect(page.portfolioHeat(quietest!, "active")).toBeLessThan(page.portfolioHeat(other!, "active"));

    // The point of a single scale: a board with more cards outranks a workspace with fewer, instead of
    // both reading as the leader of their own level.
    expect(page.portfolioHeat(busiest!, "active"))
      .toBeGreaterThan(page.portfolioHeat(smallerWorkspace, "active"));
    // Equal counts tint identically wherever they sit in the tree.
    expect(page.portfolioHeat(smallerWorkspace, "active")).toBe(page.portfolioHeat(other!, "active"));

    // Zero is never tinted; anything above zero always is, however far behind the leader it trails.
    expect(page.portfolioHeat(quietest!, "overdue")).toBe(0);
    expect(page.portfolioHeat(quietest!, "active")).toBeGreaterThan(0.1);

    fixture.destroy();
  });

  it("feeds the activity strip separate movement and completion counts per day", async () => {
    const today = new Date();
    const localDate = (date: Date) =>
      `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const fixture = await mount([
      { date: localDate(today), moved: 8, completed: 1 },
      { date: localDate(yesterday), moved: 2, completed: 4 },
    ]);
    const [movement, completion] = fixture.componentInstance.activitySeries();

    // The two metrics are never blended: a busy-but-undelivering day must read differently in each
    // row. Column layout and level scaling belong to k-activity-strip and are tested there.
    expect(movement!.key).toBe("moved");
    expect(completion!.key).toBe("completed");
    expect(movement!.counts.get(localDate(today))).toBe(8);
    expect(completion!.counts.get(localDate(today))).toBe(1);
    expect(movement!.counts.get(localDate(yesterday))).toBe(2);
    expect(completion!.counts.get(localDate(yesterday))).toBe(4);
    expect(fixture.componentInstance.activityWindowDays()).toBe(60);

    fixture.destroy();
  });

  it("renders a standalone board as one row instead of a wrapper plus its only board", async () => {
    const fixture = await mount();
    const rows = fixture.componentInstance.portfolioRows();
    const standaloneRow = rows.find((row) => row.workspaceId === standaloneWorkspace)!;

    // One row, named after the board, with nothing left to expand under it.
    expect(rows.filter((row) => row.workspaceId === standaloneWorkspace)).toHaveLength(1);
    expect(standaloneRow.label).toBe("Roadmap");
    expect(standaloneRow.collapseId).toBeNull();
    expect(standaloneRow.boardIds).toEqual([standaloneBoard]);
    // It takes the board's icon, not the wrapper workspace's default.
    expect(fixture.componentInstance.portfolioRowIconClass(standaloneRow)).toBe("ti ti-map");

    fixture.destroy();
  });
});

describe("GlobalWorkPage toolbar state", () => {
  /**
   * The collapse/dismiss seam moved to k-page-toolbar and is tested in
   * page-toolbar.component.spec.ts. What is still the page's own is deciding *when* the collapsed
   * trigger should be accented, which depends on the whole query definition.
   */
  async function mount() {
    const definition = signal({
      scope: { allAccessible: true, organisationIds: [], workspaceIds: [], boardIds: [] },
      filters: {
        q: "",
        assigneeIds: [],
        listIds: [],
        labelIds: [],
        customFieldConditions: [],
        completion: DEFAULT_COMPLETION,
        unassignedOnly: false,
        dueFrom: null,
        dueTo: null,
        overdueOnly: false,
        overdueChecklistOnly: false,
        unreadOnly: false,
        archived: false,
        completedFrom: null,
        completedTo: null,
      },
    });
    const updateFilters = vi.fn();
    const state = {
      cards: signal([]),
      definition,
      initialize: vi.fn(() => Promise.resolve()),
      interactionReady: signal(true),
      queryFirstPage: vi.fn(() => Promise.resolve()),
      updateFilters,
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: Dialog, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    })
      .overrideComponent(GlobalWorkPage, {
        set: {
          template: "",
          providers: [{ provide: GlobalWorkState, useValue: state }],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(GlobalWorkPage);
    fixture.componentRef.setInput("lens", "my");
    fixture.detectChanges();
    TestBed.tick();
    return { fixture, definition, updateFilters };
  }

  it("flags the trigger while any query control is away from its default", () => {
    return mount().then(({ fixture, definition }) => {
      expect(fixture.componentInstance.toolbarFilterActive()).toBe(false);

      definition.update((current) => ({ ...current, filters: { ...current.filters, overdueOnly: true } }));
      TestBed.tick();
      expect(fixture.componentInstance.toolbarFilterActive()).toBe(true);

      fixture.destroy();
    });
  });

  /**
   * The filter panel's "Clear all" must stay inside its own menu. On "my"/"team" the assignee is the
   * page's scope, set by the Teammate trigger beside the Filter button and never shown or counted by
   * the panel; `unassignedOnly` belongs to the portfolio drill-down chip.
   */
  it("leaves the Teammate selection and the drill-down alone when clearing filters", () => {
    return mount().then(({ fixture, updateFilters }) => {
      fixture.componentRef.setInput("lens", "team");
      TestBed.tick();

      fixture.componentInstance.clearFilters();

      const patch = updateFilters.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(patch).not.toHaveProperty("assigneeIds");
      expect(patch).not.toHaveProperty("unassignedOnly");
      // What the panel does own still resets.
      expect(patch["labelIds"]).toEqual([]);
      expect(patch["listIds"]).toEqual([]);
      expect(patch["overdueOnly"]).toBe(false);

      fixture.destroy();
    });
  });

  it("still clears the assignee filter on the portfolio lens, where the panel owns it", () => {
    return mount().then(({ fixture, updateFilters }) => {
      fixture.componentRef.setInput("lens", "portfolio");
      TestBed.tick();

      fixture.componentInstance.clearFilters();

      expect((updateFilters.mock.calls.at(-1)![0] as Record<string, unknown>)["assigneeIds"]).toEqual([]);

      fixture.destroy();
    });
  });
});
