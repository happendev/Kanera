import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { CardCustomFieldValue, CustomField } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../core/api/api.client";
import { STORAGE_KEYS, viewPreferenceKey } from "../../../core/browser/browser-contracts";
import { NotificationsService } from "../../../core/notifications/notifications.service";
import { BoardMenuCoordinator } from "../board-menu-coordinator.service";
import { BoardState } from "../board-state";
import type { AnyCard, AnyList } from "./table-view.types";
import { BoardTableViewComponent } from "./board-table-view.component";

function card(id: string, position = "1000.0000000000", listId = "list-1"): AnyCard {
  return {
    id,
    boardId: "board-1",
    listId,
    title: `Card ${id}`,
    position,
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: null,
    createdById: "user-1",
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AnyCard;
}

function list(id = "list-1", position = "1000.0000000000"): AnyList {
  return {
    id,
    workspaceId: "workspace-1",
    name: "Todo",
    icon: null,
    color: null,
    position,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AnyList;
}

function field(overrides: Partial<CustomField> = {}): CustomField {
  return {
    id: "field-1",
    workspaceId: "workspace-1",
    name: "Client",
    icon: "forms",
    type: "text",
    allowMultiple: false,
    position: "1000.0000000000",
    showOnCard: false,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function value(cardId: string, fieldId: string, valueText: string | null): CardCustomFieldValue {
  return {
    cardId,
    fieldId,
    valueText,
    valueNumber: null,
    valueCheckbox: null,
    valueDate: null,
    valueUrl: null,
    valueOptionIds: null,
    valueUserIds: null,
    updatedAt: new Date(),
  };
}

/** Rows actually mounted, across every group the incremental render cap has reached. */
function renderedCount(component: BoardTableViewComponent): number {
  return component.runGroups().reduce((count, group) => count + group.cards.length, 0);
}

describe("BoardTableViewComponent", () => {
  const api = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    createCard: vi.fn(),
  };
  const state = {
    updateCard: vi.fn(),
    cardById: vi.fn((id: string) => card(id)),
    positionForCardDrop: vi.fn(() => "2000.0000000000"),
    moveCard: vi.fn(),
    setCardAssignees: vi.fn(),
    setCardLabels: vi.fn(),
  };

  /** Per-card unread counts the stubbed NotificationsService reports; reset before each test. */
  let unreadCounts: Record<string, number> = {};

  beforeEach(() => {
    localStorage.clear();
    unreadCounts = {};
    vi.clearAllMocks();
    api.post.mockResolvedValue({});
    api.put.mockResolvedValue({});
    api.patch.mockResolvedValue(card("card-1"));
    api.delete.mockResolvedValue({});
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        BoardMenuCoordinator,
        { provide: ApiClient, useValue: api },
        {
          provide: NotificationsService,
          useValue: { watchCreatedCardLocally: vi.fn(), cardUnreadCount: (id: string) => unreadCounts[id] ?? 0 },
        },
        { provide: BoardState, useValue: state },
      ],
    }).overrideComponent(BoardTableViewComponent, { set: { template: "" } });
  });

  function fixture(cards: AnyCard[] = [card("card-1")], fields: CustomField[] = [field()], lists: AnyList[] = [list()]) {
    const fixture = TestBed.createComponent(BoardTableViewComponent);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("lists", lists);
    fixture.componentRef.setInput("customFields", fields);
    fixture.detectChanges();
    return fixture;
  }

  it("shows title, status, assignees, due date, and every custom field by default, including showOnCard=false", () => {
    const component = fixture().componentInstance;

    expect(["title", ...component.visibleColumns()]).toEqual(["title", "status", "assignees", "due", "cf:field-1"]);
  });

  it("isolates table preferences from the generic board preference scope", () => {
    localStorage.setItem(viewPreferenceKey("columns", "board:board-1"), JSON.stringify({ labels: true }));
    const component = fixture().componentInstance;
    component.toggleColumn("labels");

    expect(localStorage.getItem(viewPreferenceKey("columns", "board:board-1"))).toBe(JSON.stringify({ labels: true }));
    expect(localStorage.getItem(viewPreferenceKey("columns", "board:board-1:table"))).toContain('"labels":true');
  });

  it("restores column visibility and order, grouping, and sorting when the board table is reopened", () => {
    const firstVisit = fixture();
    const first = firstVisit.componentInstance;
    first.toggleColumn("labels");
    first.onColumnDrop({ previousIndex: 3, currentIndex: 0 } as never);
    first.setGroupBy("completion");
    first.setSort("title-desc");
    firstVisit.destroy();

    const reopened = fixture().componentInstance;

    expect(reopened.visibleColumns()).toEqual(["labels", "status", "assignees", "due", "cf:field-1"]);
    expect(reopened.groupBy()).toBe("completion");
    expect(reopened.sortBy()).toBe("title-desc");
  });

  it("keeps a remembered custom-field grouping while the board payload loads", () => {
    localStorage.setItem(viewPreferenceKey("groupBy", "board:board-1:table"), "cf:field-1");
    const view = TestBed.createComponent(BoardTableViewComponent);
    view.componentRef.setInput("boardId", "board-1");
    view.componentRef.setInput("cards", []);
    view.componentRef.setInput("lists", []);
    view.componentRef.setInput("loading", true);
    view.detectChanges();

    expect(view.componentInstance.groupBy()).toBe("cf:field-1");

    view.componentRef.setInput("customFields", [field()]);
    view.componentRef.setInput("loading", false);
    view.detectChanges();

    expect(view.componentInstance.groupBy()).toBe("cf:field-1");
  });

  it("auto-fits Title from the full title text rather than only its card-key child", () => {
    const view = fixture();
    const cell = document.createElement("div");
    cell.dataset["col"] = "title";
    cell.style.display = "flex";
    cell.style.paddingLeft = "28px";
    cell.style.paddingRight = "10px";
    const trigger = document.createElement("button");
    trigger.style.display = "flex";
    trigger.style.paddingRight = "10px";
    const title = document.createElement("span");
    title.style.display = "block";
    const key = document.createElement("span");
    title.append(key, "A title much wider than its card key");
    trigger.append(title);
    cell.append(trigger);
    (view.nativeElement as HTMLElement).append(cell);

    Object.defineProperty(cell, "scrollWidth", { configurable: true, value: 240 });
    Object.defineProperty(trigger, "scrollWidth", { configurable: true, value: 180 });
    Object.defineProperty(title, "scrollWidth", { configurable: true, value: 310 });
    Object.defineProperty(key, "scrollWidth", { configurable: true, value: 45 });

    view.componentInstance.autoFitColumn("title", new MouseEvent("dblclick"));

    // 358px measured content plus the component's 4px auto-fit slack.
    expect(view.componentInstance.columnWidths()["title"]).toBe(362);
    expect(localStorage.getItem(viewPreferenceKey("columnWidths", "board:board-1:table")))
      .toBe(JSON.stringify({ title: 362 }));
  });

  it("keeps a table label press as both the shared compression gesture and the cell edit trigger", () => {
    const component = fixture().componentInstance;
    const labelHost = document.createElement("k-card-labels");
    const labelText = document.createElement("span");
    labelHost.append(labelText);
    const event = {
      target: labelText,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent;

    component.openLabelsCellPicker(card("card-1"), "labels", event);

    expect(localStorage.getItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED)).toBe("1");
    expect(component.pickerIsOpen("card-1", "labels")).toBe(true);
  });

  // `cards.position` is per-list, so manual sort has to order by list before position or the flat
  // grid interleaves lists by a number that only means something inside one.
  it("orders manual sort by list, then by position within the list", () => {
    const lists = [list("list-1", "2000.0000000000"), list("list-2", "1000.0000000000")];
    const cards = [
      card("a-second", "2000.0000000000", "list-1"),
      card("b-first", "1000.0000000000", "list-2"),
      card("a-first", "1000.0000000000", "list-1"),
      card("b-second", "3000.0000000000", "list-2"),
    ];
    const component = fixture(cards, [field()], lists).componentInstance;

    // list-2 sorts first because its own position is lower, even though its cards share the same
    // numeric range as list-1's.
    expect(component.rows().map((row) => row.id)).toEqual(["b-first", "b-second", "a-first", "a-second"]);
  });

  it("sorts a card whose list is missing to the end of manual sort", () => {
    const cards = [card("orphan", "0500.0000000000", "list-gone"), card("known", "9000.0000000000", "list-1")];
    const component = fixture(cards).componentInstance;

    expect(component.rows().map((row) => row.id)).toEqual(["known", "orphan"]);
  });

  it("leaves non-manual sorts totally ordered across lists once grouping is off", () => {
    const lists = [list("list-1", "2000.0000000000"), list("list-2", "1000.0000000000")];
    const cards = [
      { ...card("zulu", "1000.0000000000", "list-2"), title: "Zulu" },
      { ...card("alpha", "1000.0000000000", "list-1"), title: "Alpha" },
    ];
    const component = fixture(cards, [field()], lists).componentInstance;
    component.setGroupBy("none");
    component.setSort("title-asc");

    expect(component.rows().map((row) => row.id)).toEqual(["alpha", "zulu"]);
    // Grouped, the same sort orders within each list and the lists themselves stay in board order.
    component.setGroupBy("list");
    expect(component.rows().map((row) => row.id)).toEqual(["zulu", "alpha"]);
  });

  // A shift-click anywhere in a row is a selection gesture, not a cell edit — the checkbox is a 15px
  // hover-only target and sweeping a range off it is the point.
  it("shift-clicking a cell selects a row range instead of editing it", () => {
    const cards = [card("card-1", "1000.0000000000"), card("card-2", "2000.0000000000")];
    const component = fixture(cards).componentInstance;
    const requests: unknown[] = [];
    component.bulkSelectionRequested.subscribe((payload) => requests.push(payload));

    component.beginEdit(cards[1]!, "cf:field-1", "Old", new MouseEvent("click", { shiftKey: true }));

    expect(requests).toEqual([
      { cardId: "card-2", orderedCardIds: ["card-1", "card-2"], shiftKey: true, additive: true },
    ]);
    expect(component.isEditing("card-2", "cf:field-1")).toBe(false);
  });

  it("clears the bulk selection instead of editing a row inside it", () => {
    const view = fixture();
    view.componentRef.setInput("bulkSelectedCardIds", new Set(["card-1"]));
    view.detectChanges();
    const component = view.componentInstance;
    let cleared = 0;
    component.bulkSelectionCleared.subscribe(() => (cleared += 1));

    component.beginEdit(card("card-1"), "cf:field-1", "Old", new MouseEvent("click"));

    expect(cleared).toBe(1);
    expect(component.isEditing("card-1", "cf:field-1")).toBe(false);
  });

  it("keeps cells editable on rows outside the bulk selection", () => {
    const view = fixture([card("card-1"), card("card-2", "2000.0000000000")]);
    view.componentRef.setInput("bulkSelectedCardIds", new Set(["card-1"]));
    view.detectChanges();
    const component = view.componentInstance;

    component.beginEdit(card("card-2", "2000.0000000000"), "cf:field-1", "Old", new MouseEvent("click"));

    expect(component.isEditing("card-2", "cf:field-1")).toBe(true);
  });

  it("selects every filtered row from the header checkbox, past the render cap", () => {
    const cards = Array.from({ length: 200 }, (_, index) => card(`card-${index}`, String(index).padStart(4, "0")));
    const view = fixture(cards);
    const component = view.componentInstance;
    const requests: unknown[] = [];
    component.bulkListSelectionRequested.subscribe((payload) => requests.push(payload));

    expect(renderedCount(component)).toBe(80);
    component.toggleSelectAll(new MouseEvent("click"));

    expect(requests).toEqual([{ orderedCardIds: cards.map((item) => item.id), mode: "replace" }]);
  });

  it("selects every card in a group, including rows past the render cap", () => {
    const cards = Array.from({ length: 120 }, (_, index) => card(`card-${index}`, String(index).padStart(4, "0")));
    const component = fixture(cards).componentInstance;
    const group = component.runGroups()[0]!;
    const requests: unknown[] = [];
    component.bulkListSelectionRequested.subscribe((payload) => requests.push(payload));

    expect(group.cards).toHaveLength(80);
    expect(group.cardIds).toHaveLength(120);
    component.toggleGroupSelection(group, new MouseEvent("click"));

    expect(requests).toEqual([{ orderedCardIds: cards.map((item) => item.id), mode: "add" }]);
  });

  it("reports partial and complete group selection and removes a fully selected group", () => {
    const cards = [card("card-1"), card("card-2", "2000.0000000000")];
    const view = fixture(cards);
    const component = view.componentInstance;
    const group = component.runGroups()[0]!;
    const requests: unknown[] = [];
    component.bulkListSelectionRequested.subscribe((payload) => requests.push(payload));

    view.componentRef.setInput("bulkSelectedCardIds", new Set(["card-1"]));
    view.detectChanges();
    expect(component.groupSomeRowsSelected(group)).toBe(true);
    expect(component.groupAllRowsSelected(group)).toBe(false);

    view.componentRef.setInput("bulkSelectedCardIds", new Set(["card-1", "card-2"]));
    view.detectChanges();
    expect(component.groupSomeRowsSelected(group)).toBe(false);
    expect(component.groupAllRowsSelected(group)).toBe(true);
    component.toggleGroupSelection(group, new MouseEvent("click"));

    expect(requests).toEqual([{ orderedCardIds: ["card-1", "card-2"], mode: "remove" }]);
  });

  it("exports only selected cards to grid and structured formats", async () => {
    const cards = [
      { ...card("card-1"), key: "DEV-1", organisationKey: "ABCDEF0123456789" },
      { ...card("card-2", "2000.0000000000"), key: "DEV-2", organisationKey: "ABCDEF0123456789" },
    ];
    const view = fixture(cards);
    view.componentRef.setInput("bulkSelectedCardIds", new Set(["card-2"]));
    view.detectChanges();

    const blobs: Blob[] = [];
    const anchor = { click: vi.fn(), setAttribute: vi.fn(), style: {} } as unknown as HTMLAnchorElement;
    vi.spyOn(document, "createElement").mockReturnValue(anchor);
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:x";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    try {
      view.componentInstance.exportCsv();
      view.componentInstance.exportJson();
      const csv = await blobs[0]!.text();
      const json = JSON.parse(await blobs[1]!.text()) as { groups: Array<{ cards: unknown[] }> };

      expect(csv).toContain('"Card card-2"');
      expect(csv).not.toContain('"Card card-1"');
      expect(json.groups.flatMap((group) => group.cards)).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("clears from the header checkbox once anything is selected", () => {
    const view = fixture([card("card-1"), card("card-2", "2000.0000000000")]);
    view.componentRef.setInput("bulkSelectedCardIds", new Set(["card-1"]));
    view.detectChanges();
    const component = view.componentInstance;
    let cleared = 0;
    component.bulkSelectionCleared.subscribe(() => (cleared += 1));

    expect(component.allRowsSelected()).toBe(false);
    expect(component.someRowsSelected()).toBe(true);
    component.toggleSelectAll(new MouseEvent("click"));

    expect(cleared).toBe(1);
  });

  // Both boxes are controlled by `bulkSelectedCardIds`. If the native toggle is allowed through, a
  // click that leaves the bound value unchanged (clearing from indeterminate) leaves the DOM ticked
  // while nothing is selected, and Angular never rewrites it.
  it("cancels the native toggle on both checkboxes so they cannot desync from the selection", () => {
    const view = fixture();
    view.componentRef.setInput("bulkSelectedCardIds", new Set(["card-1"]));
    view.detectChanges();
    const component = view.componentInstance;

    const headerClick = new MouseEvent("click", { cancelable: true });
    component.toggleSelectAll(headerClick);
    const rowClick = new MouseEvent("click", { cancelable: true });
    component.toggleRowSelection(card("card-1"), rowClick);

    expect(headerClick.defaultPrevented).toBe(true);
    expect(rowClick.defaultPrevented).toBe(true);
  });

  it("reports the header checkbox as fully checked only when every filtered row is selected", () => {
    const cards = [card("card-1"), card("card-2", "2000.0000000000"), card("card-3", "3000.0000000000")];
    const view = fixture(cards);
    view.componentRef.setInput("filteredCardIds", new Set(["card-1", "card-2"]));
    view.componentRef.setInput("bulkSelectedCardIds", new Set(["card-1", "card-2"]));
    view.detectChanges();

    // Filtered out of view, so it does not count against "all".
    expect(view.componentInstance.allRowsSelected()).toBe(true);
    expect(view.componentInstance.someRowsSelected()).toBe(false);
  });

  describe("row drag", () => {
    const lists = [list("list-1", "1000.0000000000"), list("list-2", "2000.0000000000")];
    // Two contiguous runs, exactly how manual sort renders them: list-1 then list-2.
    const rows = () => [
      card("a1", "1000.0000000000", "list-1"),
      card("a2", "2000.0000000000", "list-1"),
      card("b1", "1000.0000000000", "list-2"),
      card("b2", "2000.0000000000", "list-2"),
    ];

    function view() {
      const component = fixture(rows(), [field()], lists).componentInstance;
      const dropped: unknown[] = [];
      component.cardDropped.subscribe((payload) => dropped.push(payload));
      return { component, dropped };
    }

    /** CDK compares containers by identity, so a same-block move must pass the very same object. */
    function drop(
      component: BoardTableViewComponent,
      cardId: string,
      to: number,
      opts: { from?: number; toGroup?: number; fromGroup?: number } = {},
    ) {
      const groups = component.runGroups();
      const container = { data: groups[opts.toGroup ?? 0]! };
      const previousContainer = opts.fromGroup === undefined ? container : { data: groups[opts.fromGroup]! };
      component.onRowDrop({
        previousIndex: opts.from ?? 0,
        currentIndex: to,
        item: { data: rows().find((row) => row.id === cardId)! },
        container,
        previousContainer,
      } as never);
    }

    it("splits the rendered rows into one block per list run", () => {
      const groups = view().component.runGroups();

      expect(groups.map((group) => [group.listId, group.cards.map((c) => c.id)])).toEqual([
        ["list-1", ["a1", "a2"]],
        ["list-2", ["b1", "b2"]],
      ]);
    });

    // Grouping is its own axis now: a sort that interleaves lists no longer dissolves the blocks.
    it("keeps one block per list under a sort that interleaves lists", () => {
      const { component } = view();

      component.setSort("title-asc");

      expect(component.runGroups().map((group) => group.listId)).toEqual(["list-1", "list-2"]);
    });

    it("collapses to a single unlabelled block when grouping is off", () => {
      const { component } = view();

      component.setGroupBy("none");

      expect(component.runGroups().map((group) => [group.listId, group.name])).toEqual([[null, ""]]);
    });

    it("reorders within a block without changing its list", () => {
      const { component, dropped } = view();

      drop(component, "a2", 0, { from: 1 });

      expect(dropped).toEqual([{ cardId: "a2", toListId: "list-1", beforeCardId: "a1" }]);
    });

    it("moves the card to the target list when dropped into another block", () => {
      const { component, dropped } = view();

      // Released over list-2's block, between b1 and b2.
      drop(component, "a1", 1, { fromGroup: 0, toGroup: 1 });

      expect(dropped).toEqual([{ cardId: "a1", toListId: "list-2", beforeCardId: "b2" }]);
    });

    it("appends when dropped past the last row of a block", () => {
      const { component, dropped } = view();

      drop(component, "a1", 2, { fromGroup: 0, toGroup: 1 });

      expect(dropped).toEqual([{ cardId: "a1", toListId: "list-2", afterCardId: "b2" }]);
    });

    it("ignores a drop that did not move the row", () => {
      const { component, dropped } = view();

      drop(component, "a2", 1, { from: 1 });

      expect(dropped).toEqual([]);
    });

    it("only allows dragging under manual sort", () => {
      const { component, dropped } = view();
      expect(component.dragEnabled()).toBe(true);

      component.setSort("title-asc");
      drop(component, "a2", 0, { from: 1 });

      expect(component.dragEnabled()).toBe(false);
      expect(dropped).toEqual([]);
    });

    // A list is the only bucket a dropped row can be written into; an assignee bucket would have to
    // mean an assignment, which is not what dragging a row promises.
    it("refuses to drag when grouped by anything but list", () => {
      const { component, dropped } = view();

      component.setGroupBy("completion");
      drop(component, "a2", 0, { from: 1 });

      expect(component.dragEnabled()).toBe(false);
      expect(component.dragDisabledHint()).toBe("Drag to reorder works when grouped by status");
      expect(dropped).toEqual([]);
    });

    it("reports the full group size, not the rendered slice", () => {
      const { component } = view();

      expect(component.runGroups().map((group) => group.total)).toEqual([2, 2]);
    });
  });

  describe("run composer", () => {
    function open() {
      const view = fixture();
      view.componentInstance.startRunCompose("list-1", new MouseEvent("click"));
      return view;
    }

    function pointerDownOn(el: Element) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    }

    it("closes on a pointerdown outside it, discarding the draft", () => {
      const view = open();
      view.componentInstance.runTaskTitle.set("Half-typed");

      pointerDownOn(document.body);

      expect(view.componentInstance.runComposeListId()).toBeNull();
      expect(view.componentInstance.runTaskTitle()).toBe("");
      expect(api.createCard).not.toHaveBeenCalled();
    });

    it("stays open for a pointerdown inside the composer", () => {
      const view = open();
      const form = document.createElement("form");
      form.className = "tv-run-compose";
      document.body.append(form);

      try {
        pointerDownOn(form);
        expect(view.componentInstance.runComposeListId()).toBe("list-1");
      } finally {
        form.remove();
      }
    });

    it("stops listening once the composer is closed", () => {
      const view = open();
      view.componentInstance.cancelRunCompose();
      view.componentInstance.runComposeListId.set("list-2");

      // A stale listener would close the block that a later + click just opened.
      pointerDownOn(document.body);

      expect(view.componentInstance.runComposeListId()).toBe("list-2");
    });
  });

  it("shows one assignee in full and several by first name", () => {
    const view = fixture();
    const member = (userId: string, displayName: string) => ({ userId, displayName, avatarUrl: null, role: "member" });
    view.componentRef.setInput(
      "assigneesByCard",
      new Map([
        ["card-1", [member("user-1", "Amelia Okonkwo")]],
        ["card-2", [member("user-1", "Amelia Okonkwo"), member("user-2", "Ben Shah")]],
      ]),
    );
    view.detectChanges();

    expect(view.componentInstance.assigneeNames("card-1")).toBe("Amelia Okonkwo");
    expect(view.componentInstance.assigneeNames("card-2")).toBe("Amelia, Ben");
  });

  describe("grouping", () => {
    const hours = field({ id: "hours", name: "Hours", type: "number" });

    function numberValue(cardId: string, valueNumber: string): CardCustomFieldValue {
      return { ...value(cardId, "hours", null), valueNumber } as CardCustomFieldValue;
    }

    /** list-1 holds a completed 10h card and an open 4h card; list-2 holds an open 5h card. */
    function billableBoard() {
      const cards = [
        { ...card("card-1", "1000.0000000000", "list-1"), completedAt: new Date() } as AnyCard,
        card("card-2", "2000.0000000000", "list-1"),
        card("card-3", "1000.0000000000", "list-2"),
      ];
      const view = fixture(cards, [hours], [list("list-1", "1000.0000000000"), list("list-2", "2000.0000000000")]);
      view.componentRef.setInput("customFieldValuesByCardAndField", new Map([
        ["card-1", new Map([["hours", numberValue("card-1", "10")]])],
        ["card-2", new Map([["hours", numberValue("card-2", "4")]])],
        ["card-3", new Map([["hours", numberValue("card-3", "5")]])],
      ]));
      view.detectChanges();
      return view;
    }

    it("groups by a dimension other than list and persists it to the table scope", () => {
      const component = fixture().componentInstance;

      component.setGroupBy("completion");

      expect(component.groupBy()).toBe("completion");
      expect(localStorage.getItem(viewPreferenceKey("groupBy", "board:board-1:table"))).toBe("completion");
    });

    // The dimension a group is already split on would put every one of its cards in a single bucket.
    it("clears a breakdown that the new grouping has made a no-op", () => {
      const component = fixture().componentInstance;
      component.setSplitBy("completion");

      component.setGroupBy("completion");

      expect(component.aggregateSplitBy()).toBe("none");
    });

    it("falls back to list when the stored grouping names a field that no longer exists", () => {
      localStorage.setItem(viewPreferenceKey("groupBy", "board:board-1:table"), "cf:deleted-field");

      expect(fixture().componentInstance.groupBy()).toBe("list");
    });

    // groupByList only enumerates live lists, so this card belongs to no bucket. Dropping rows out
    // of a table silently is worse than showing an extra block.
    it("collects a card whose list is gone instead of losing it", () => {
      const cards = [card("known", "1000.0000000000", "list-1"), card("orphan", "1000.0000000000", "list-gone")];
      const component = fixture(cards).componentInstance;

      expect(component.runGroups().map((group) => [group.name, group.cards.map((c) => c.id)]))
        .toEqual([["Todo", ["known"]], ["Ungrouped", ["orphan"]]]);
      expect(component.footerCount()).toBe(2);
    });

    it("keeps empty lists as add targets, but not while a filter is narrowing the view", () => {
      const lists = [list("list-1", "1000.0000000000"), list("list-2", "2000.0000000000")];
      const view = fixture([card("card-1", "1000.0000000000", "list-1")], [field()], lists);
      const component = view.componentInstance;
      expect(component.runGroups().map((group) => group.listId)).toEqual(["list-1", "list-2"]);

      view.componentRef.setInput("filteredCardIds", new Set(["card-1"]));
      view.detectChanges();

      expect(component.runGroups().map((group) => group.listId)).toEqual(["list-1"]);
    });

    // A multi-value dimension draws a card in every bucket it belongs to; every count and every
    // total still has to treat it as one card.
    it("repeats a card across buckets but counts and sums it once", () => {
      const view = billableBoard();
      const component = view.componentInstance;
      const member = (userId: string, displayName: string) => ({ userId, displayName, avatarUrl: null, role: "member" });
      view.componentRef.setInput("members", [member("user-1", "Amelia"), member("user-2", "Ben")]);
      view.componentRef.setInput("assigneesByCard", new Map([
        ["card-1", [member("user-1", "Amelia"), member("user-2", "Ben")]],
      ]));
      view.detectChanges();
      component.setGroupBy("assignee");
      component.setAggregate("hours", "sum");

      expect(component.runGroups().map((group) => [group.name, group.total]))
        .toEqual([["Amelia", 1], ["Ben", 1], ["Unassigned", 2]]);
      expect(component.footerCount()).toBe(3);
      expect(component.aggregateValue("hours")).toBe("19");
    });

    it("gives every group its own subtotal", () => {
      const component = billableBoard().componentInstance;

      component.setAggregate("hours", "sum");

      expect(component.runGroups().map((group) => group.summaries)).toEqual([
        [{ key: "list:list-1:total", label: "Total", values: { "cf:hours": "14" } }],
        [{ key: "list:list-2:total", label: "Total", values: { "cf:hours": "5" } }],
      ]);
    });

    it("breaks each group's subtotal down by the split dimension, and the sheet's below it", () => {
      const component = billableBoard().componentInstance;
      component.setAggregate("hours", "sum");

      component.setSplitBy("completion");

      expect(component.aggregateFor("hours")).toBe("sum");
      expect(component.runGroups()[0]!.summaries.map((row) => [row.label, row.values["cf:hours"]]))
        .toEqual([["Open", "4"], ["Completed", "10"], ["Total", "14"]]);
      // Buckets only: the sticky footer directly beneath is already the grand total.
      expect(component.grandSummaries().map((row) => [row.label, row.values["cf:hours"]]))
        .toEqual([["Open", "9"], ["Completed", "10"]]);
      expect(component.aggregateValue("hours")).toBe("19");
    });

    // list-2 holds only open cards, so its breakdown is one bucket — and a Total row beneath it
    // would print the same number under a vaguer name.
    it("drops the total from a group whose breakdown produced a single bucket", () => {
      const component = billableBoard().componentInstance;
      component.setAggregate("hours", "sum");

      component.setSplitBy("completion");

      expect(component.runGroups()[1]!.summaries.map((row) => [row.label, row.values["cf:hours"]]))
        .toEqual([["Open", "5"]]);
    });

    // With one block there is nothing for a per-group subtotal to distinguish, and it would print
    // the footer's own number an inch above it.
    it("leaves the subtotals to the footer when grouping is off", () => {
      const component = billableBoard().componentInstance;
      component.setAggregate("hours", "sum");

      component.setGroupBy("none");

      expect(component.runGroups().map((group) => group.summaries)).toEqual([[]]);
      expect(component.grandSummaries()).toEqual([]);
    });

    it("folds a group away, keeping its header and its subtotal", () => {
      const component = billableBoard().componentInstance;
      component.setAggregate("hours", "sum");

      component.toggleGroupCollapsed("list:list-1");

      const [first, second] = component.runGroups();
      expect([first!.collapsed, first!.cards.length, first!.total]).toEqual([true, 0, 2]);
      // The subtotal survives the fold, which is what makes "collapse all" a summary of the board.
      expect(first!.summaries.map((row) => row.values["cf:hours"])).toEqual(["14"]);
      expect(second!.cards.map((c) => c.id)).toEqual(["card-3"]);
    });

    // Collapsed cards are withheld on purpose. Counting them as "hidden" would leave the scroll
    // handler raising the cap forever without a row ever appearing.
    it("does not treat a collapsed group as rows waiting on the render cap", () => {
      const component = billableBoard().componentInstance;

      component.toggleGroupCollapsed("list:list-1");

      expect(component.hasHiddenRows()).toBe(false);
    });

    it("collapses and expands every group from one control", () => {
      const component = billableBoard().componentInstance;
      expect(component.allGroupsCollapsed()).toBe(false);

      component.toggleAllGroups();
      expect(component.allGroupsCollapsed()).toBe(true);
      expect(component.runGroups().flatMap((group) => group.cards)).toEqual([]);

      component.toggleAllGroups();
      expect(component.allGroupsCollapsed()).toBe(false);
      expect(component.runGroups().flatMap((group) => group.cards)).toHaveLength(3);
    });

    it("uses host-owned collapse state and reports fold changes", () => {
      const view = billableBoard();
      const emitted: string[][] = [];
      view.componentRef.setInput("hostCollapsedGroupKeys", ["list:list-1"]);
      view.componentInstance.hostCollapsedGroupKeysChange.subscribe((keys) => emitted.push(keys));
      view.detectChanges();

      expect(view.componentInstance.runGroups()[0]?.collapsed).toBe(true);

      view.componentInstance.toggleGroupCollapsed("list:list-1");
      expect(emitted).toEqual([[]]);
    });

    // Group keys are dimension-scoped, so a key kept across a change of axis folds an unrelated block.
    it("forgets what was collapsed when the grouping changes", () => {
      const component = billableBoard().componentInstance;
      component.toggleGroupCollapsed("list:list-1");

      component.setGroupBy("completion");
      // The reset is an effect on the effective axis, so that a host-supplied change clears the same
      // state a menu change does. It lands on the next tick rather than inside the setter.
      TestBed.tick();

      expect(component.collapsedGroups().size).toBe(0);
    });

    // Global Work drives grouping from its saved-view definition rather than the table's menu.
    it("groups by the host's dimension and hides its own group control", () => {
      const fixture = billableBoard();
      const component = fixture.componentInstance;
      expect(component.effectiveGroupBy()).toBe("list");

      fixture.componentRef.setInput("hostGroupBy", "completion");
      TestBed.tick();

      expect(component.effectiveGroupBy()).toBe("completion");
      expect(component.groups().map((group) => group.label)).toEqual(["Open", "Completed"]);
      // The stored table preference is untouched, so removing the host control restores it.
      expect(component.groupBy()).toBe("list");
    });

    it("clears collapse state when the host changes the grouping", () => {
      const fixture = billableBoard();
      const component = fixture.componentInstance;
      component.toggleGroupCollapsed("list:list-1");

      fixture.componentRef.setInput("hostGroupBy", "completion");
      TestBed.tick();

      expect(component.collapsedGroups().size).toBe(0);
    });

    it("offers nothing to collapse when there is a single block", () => {
      const component = billableBoard().componentInstance;

      component.setGroupBy("none");

      expect(component.canCollapseGroups()).toBe(false);
    });

    it("keeps breakdown unavailable until a calculation is selected", () => {
      const component = billableBoard().componentInstance;

      component.setSplitBy("completion");

      expect(component.aggregateFor("hours")).toBeNull();
      expect(component.availableSplitByOptions()).toEqual([]);
      expect(component.aggregateSplitBy()).toBe("none");
      expect(component.hasSummaries()).toBe(false);
      expect(component.runGroups().flatMap((group) => group.summaries)).toEqual([]);
      expect(component.grandSummaries()).toEqual([]);
    });

    it("resets table presentation preferences and clears number calculations", () => {
      const component = billableBoard().componentInstance;
      let resetRequests = 0;
      component.resetRequested.subscribe(() => (resetRequests += 1));
      component.setGroupBy("completion");
      component.setSort("title-desc");
      component.toggleColumn("labels");
      component.setAggregate("hours", "avg");
      component.setSplitBy("assignee");

      component.resetTable();

      expect(component.groupBy()).toBe("list");
      expect(component.sortBy()).toBe("position");
      expect(component.columnVisibility()).toEqual({});
      expect(component.columnOrder()).toEqual([]);
      expect(component.columnWidths()).toEqual({});
      expect(component.aggregateFor("hours")).toBeNull();
      expect(component.aggregateSplitBy()).toBe("none");
      expect(resetRequests).toBe(1);
      expect(localStorage.getItem(viewPreferenceKey("aggregates", "board:board-1:table")))
        .toBe(JSON.stringify({}));
    });

    it("reports table presentation to a saved-view host instead of writing lens-wide preferences", () => {
      const view = billableBoard();
      const component = view.componentInstance;
      const presentations: Array<Parameters<typeof component.hostPresentationChange.emit>[0]> = [];
      view.componentRef.setInput("hostPresentation", {
        columnVisibility: { labels: true },
        columnOrder: ["labels", "due"],
        columnWidths: { title: 340 },
        aggregates: { hours: ["sum"] },
        aggregateSplitBy: "completion",
        collapsedGroupKeys: [],
      });
      component.hostPresentationChange.subscribe((presentation) => presentations.push(presentation));
      TestBed.tick();

      expect(component.aggregateFor("hours")).toBe("sum");
      expect(component.aggregateSplitBy()).toBe("completion");
      component.toggleColumn("labels");

      expect(presentations.at(-1)).toMatchObject({
        columnVisibility: { labels: false },
        columnOrder: ["labels", "due"],
        columnWidths: { title: 340 },
        aggregates: { hours: ["sum"] },
        aggregateSplitBy: "completion",
      });
      expect(localStorage.getItem(viewPreferenceKey("columns", "board:board-1:table"))).toBeNull();
    });
  });

  it("deletes a blank text value instead of writing an empty string", async () => {
    const component = fixture().componentInstance;
    component.beginEdit(card("card-1"), "cf:field-1", "Old");
    component.editDraft.set("");
    await component.commitEdit();

    expect(api.delete).toHaveBeenCalledWith("/cards/card-1/custom-fields/field-1");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("rejects non-numeric number drafts without an API request", async () => {
    const numberField = field({ id: "number-1", type: "number" });
    const component = fixture([card("card-1")], [numberField]).componentInstance;
    component.beginEdit(card("card-1"), "cf:number-1", "");
    component.editDraft.set("not-a-number");
    await component.commitEdit();

    expect(api.put).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("deduplicates the Enter-then-blur custom-field commit", async () => {
    const component = fixture().componentInstance;
    component.beginEdit(card("card-1"), "cf:field-1", "");
    component.editDraft.set("Acme");

    await Promise.all([component.commitEdit(), component.commitEdit()]);

    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith("/cards/card-1/custom-fields/field-1", { valueText: "Acme" });
  });

  it("moves a card optimistically before awaiting the API", async () => {
    let resolveRequest!: (value: { id: string; listId: string; position: string }) => void;
    api.post.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const component = fixture().componentInstance;
    const source = card("card-1");

    const pending = component.setListForCard(source, "list-2");
    expect(state.moveCard).toHaveBeenCalledWith("card-1", "list-2", "2000.0000000000");
    expect(api.post).toHaveBeenCalled();
    resolveRequest({ id: "card-1", listId: "list-2", position: "3000.0000000000" });
    await pending;
    expect(state.moveCard).toHaveBeenLastCalledWith("card-1", "list-2", "3000.0000000000");
  });

  it("restores the original status and position when the optimistic status request fails", async () => {
    api.post.mockRejectedValueOnce(new Error("no access"));
    const component = fixture().componentInstance;

    await expect(component.setListForCard(card("card-1"), "list-2")).rejects.toThrow("no access");
    expect(state.moveCard).toHaveBeenNthCalledWith(1, "card-1", "list-2", "2000.0000000000");
    expect(state.moveCard).toHaveBeenNthCalledWith(2, "card-1", "list-1", "1000.0000000000");
  });

  it("rolls an optimistic assignee change back when the request fails", async () => {
    api.put.mockRejectedValueOnce(new Error("no access"));
    const view = fixture();
    const member = {
      userId: "user-1",
      displayName: "Dylan",
      avatarUrl: null,
      role: "member",
    };
    view.componentRef.setInput("assigneesByCard", new Map([["card-1", [member]]]));
    view.detectChanges();

    await expect(view.componentInstance.toggleAssignee(card("card-1"), "user-1")).rejects.toThrow("no access");
    expect(state.setCardAssignees).toHaveBeenNthCalledWith(1, "card-1", []);
    expect(state.setCardAssignees).toHaveBeenNthCalledWith(2, "card-1", ["user-1"]);
  });

  it("uses realtime-provided custom-field inputs without writing them back", () => {
    const view = fixture();
    const next = new Map([["card-1", new Map([["field-1", value("card-1", "field-1", "Acme")]])]]);
    view.componentRef.setInput("customFieldValuesByCardAndField", next);
    view.detectChanges();

    expect(view.componentInstance.displayValue(card("card-1"), field())).toBe("Acme");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("counts filtered rows and grows the render cap in pages of 80", () => {
    const cards = Array.from({ length: 200 }, (_, index) => card(`card-${index}`, String(index).padStart(4, "0")));
    const view = fixture(cards);
    const component = view.componentInstance;
    view.componentRef.setInput("filteredCardIds", new Set(cards.slice(0, 170).map((item) => item.id)));
    view.detectChanges();

    expect(component.footerCount()).toBe(170);
    expect(renderedCount(component)).toBe(80);
    component.onTableScroll({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 } as HTMLElement);
    expect(renderedCount(component)).toBe(160);
  });

  // The sheet reads unread counts live off NotificationsService, so a socket-delivered notification
  // marks the row without a reload. The shape of the mark is shared with k-card (unread-mark.ts).
  it("marks rows with unread notifications, showing a count only past the first", () => {
    unreadCounts = { "card-2": 1, "card-3": 4, "card-4": 250 };
    const component = fixture([card("card-1"), card("card-2"), card("card-3"), card("card-4")]).componentInstance;

    expect(component.unreadCount("card-1")).toBe(0);
    expect(component.unreadHasCount("card-2")).toBe(false);
    expect(component.unreadText("card-2")).toBe("");
    expect(component.unreadText("card-3")).toBe("4");
    expect(component.unreadText("card-4")).toBe("9+");
    expect(component.unreadLabel("card-2")).toBe("1 unread notification");
    expect(component.unreadLabel("card-4")).toBe("250 unread notifications");
  });

  // Everything the sheet gains when a host renders it over rows from more than one board.
  describe("cross-board embedding", () => {
    const boards = [
      { id: "board-1", workspaceId: "workspace-1", name: "Delivery", icon: "rocket", iconColor: "blue" },
      { id: "board-2", workspaceId: "workspace-2", name: "Support", icon: null, iconColor: null },
    ];
    const workspaces = [
      { id: "workspace-1", organisationId: "org-1", name: "Acme", icon: null, accentColor: null },
      { id: "workspace-2", organisationId: "org-1", name: "Beta", icon: null, accentColor: null },
    ];

    function crossBoard() {
      const lists = [
        list("list-1", "1000.0000000000"),
        { ...list("list-2", "2000.0000000000"), workspaceId: "workspace-2", name: "Doing" } as AnyList,
      ];
      const cards = [
        card("a", "1000.0000000000", "list-1"),
        { ...card("b", "1000.0000000000", "list-2"), boardId: "board-2" } as AnyCard,
      ];
      const view = fixture(cards, [field(), field({ id: "field-2", workspaceId: "workspace-2" })], lists);
      view.componentRef.setInput("sourceBoards", boards);
      view.componentRef.setInput("sourceWorkspaces", workspaces);
      view.componentRef.setInput("sourceOrganisations", [{ id: "org-1", name: "Acme Group" }]);
      view.detectChanges();
      return view;
    }

    it("offers a Board column and the source group-by axes only when rows span boards", () => {
      const single = fixture().componentInstance;
      expect(single.availableColumns()).not.toContain("board");
      expect(single.groupByOptions().map((option) => option.value)).not.toContain("board");

      const component = crossBoard().componentInstance;
      expect(component.availableColumns()).toContain("board");
      expect(component.visibleColumns()).toContain("board");
      expect(component.groupByOptions().map((option) => option.value))
        .toEqual(expect.arrayContaining(["organisation", "workspace", "board"]));
      expect(component.boardFor(card("a"))?.name).toBe("Delivery");
    });

    /**
     * Two workspaces means two vocabularies. Every workspace's fields on by default is a wall of
     * columns blank on most rows, and two fields called "Client" would share one heading.
     */
    it("defaults custom-field columns off across workspaces and qualifies their labels", () => {
      const component = crossBoard().componentInstance;

      expect(component.visibleColumns()).not.toContain("cf:field-1");
      expect(component.columnLabel("cf:field-1")).toBe("Acme · Client");
      expect(component.columnLabel("cf:field-2")).toBe("Beta · Client");
      // A single workspace behaves exactly as a board does.
      expect(fixture().componentInstance.columnLabel("cf:field-1")).toBe("Client");
    });

    // The status cell stays a bare pill — a prefix there clips the status off — so the run headers
    // carry the workspace instead.
    it("qualifies list group headers but not list names", () => {
      const view = crossBoard();
      view.componentInstance.setGroupBy("list");
      view.detectChanges();

      expect(view.componentInstance.groups().map((group) => group.label)).toEqual(["Acme · Todo", "Beta · Doing"]);
      expect(view.componentInstance.listName(card("a"))).toBe("Todo");
    });

    // Lists are workspace-scoped, so the other workspace's statuses are not legal targets.
    it("scopes the status picker to the card's own workspace", () => {
      const component = crossBoard().componentInstance;

      expect(component.listsForCard(card("a")).map((item) => item.id)).toEqual(["list-1"]);
      expect(component.listsForCard({ ...card("b"), boardId: "board-2" } as AnyCard).map((item) => item.id))
        .toEqual(["list-2"]);
    });

    it("withholds editing from rows the host did not mark editable", () => {
      const view = crossBoard();
      view.componentRef.setInput("editableCardIds", new Set(["a"]));
      view.detectChanges();

      expect(view.componentInstance.canEditCard(card("a"))).toBe(true);
      expect(view.componentInstance.canEditCard(card("b"))).toBe(false);
      // The page-wide gate still wins over a per-row grant.
      view.componentRef.setInput("canEdit", false);
      view.detectChanges();
      expect(view.componentInstance.canEditCard(card("a"))).toBe(false);
    });

    it("exports each row's own board rather than the sheet's name", async () => {
      const view = crossBoard();
      view.componentRef.setInput("boardName", "My Cards");
      view.detectChanges();

      const blobs: Blob[] = [];
      const anchor = { click: vi.fn(), setAttribute: vi.fn(), style: {} } as unknown as HTMLAnchorElement;
      vi.spyOn(document, "createElement").mockReturnValue(anchor);
      vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
        blobs.push(blob as Blob);
        return "blob:x";
      });
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

      view.componentInstance.exportCsv();
      const csv = await blobs[0]!.text();
      vi.restoreAllMocks();

      expect(csv).toContain('"Board"');
      expect(csv).toContain('"Delivery"');
      expect(csv).toContain('"Support"');
      expect(csv).not.toContain('"My Cards"');
    });
  });
});
