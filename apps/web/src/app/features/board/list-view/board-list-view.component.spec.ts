import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import type { BoardSeparator, CardCustomFieldValue, CustomField } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../core/api/api.client";
import { viewPreferenceKey } from "../../../core/browser/browser-contracts";
import { NotificationsService } from "../../../core/notifications/notifications.service";
import { WorkspaceService } from "../../../core/workspace/workspace.service";
import { BoardState } from "../board-state";
import { BoardListViewComponent } from "./board-list-view.component";
import type { AnyCard, AnyList, AnySeparator, BoardLaneItem } from "./list-view.types";
import {
  readAggregateConfig,
  readColumnOrder,
  readColumnWidths,
  readGroupBy,
  readShowSeparators,
  readSortBy,
  writeAggregateConfig,
  writeColumnOrder,
  writeColumnWidths,
  writeGroupBy,
  writeSortBy,
} from "./view-preference";

function rowIds(items: BoardLaneItem[]): string[] {
  return items.map((item) => (item.kind === "card" ? item.card.id : item.separator.id));
}

function customField(overrides: Partial<CustomField> = {}): CustomField {
  return {
    id: "field-1",
    workspaceId: "workspace-1",
    name: "Priority",
    icon: "flag",
    type: "text",
    allowMultiple: false,
    position: "1000.0000000000",
    showOnCard: true,
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function card(overrides: Partial<AnyCard>): AnyCard {
  return {
    id: overrides.id ?? "card-1",
    listId: overrides.listId ?? "list-1",
    boardId: overrides.boardId ?? "board-1",
    title: overrides.title ?? "Card",
    position: overrides.position ?? "1000.0000000000",
    dueDateLocalDate: overrides.dueDateLocalDate ?? null,
    dueDateSlot: overrides.dueDateSlot ?? null,
    dueDateTimezone: overrides.dueDateTimezone ?? null,
    completedAt: overrides.completedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    coverAttachmentId: overrides.coverAttachmentId ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-05-21T00:00:00.000Z"),
    description: (overrides as { description?: string | null }).description ?? null,
    createdById: (overrides as { createdById?: string }).createdById ?? "user-1",
  } as unknown as AnyCard;
}

function list(id: string, name: string, position = "1000.0000000000"): AnyList {
  return {
    id,
    workspaceId: "workspace-1",
    name,
    icon: null,
    color: null,
    position,
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
  } as unknown as AnyList;
}

function separator(overrides: Partial<BoardSeparator> = {}): AnySeparator {
  return {
    id: overrides.id ?? "separator-1",
    boardId: overrides.boardId ?? "board-1",
    listId: overrides.listId ?? "list-1",
    title: overrides.title ?? "Separator",
    color: overrides.color ?? null,
    position: overrides.position ?? "1500.0000000000",
    createdById: overrides.createdById ?? "user-1",
    createdAt: overrides.createdAt ?? new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-05-21T00:00:00.000Z"),
  } as unknown as AnySeparator;
}

function fieldValue(cardId: string, fieldId: string, valueNumber: string | null): CardCustomFieldValue {
  return {
    cardId,
    fieldId,
    valueText: null,
    valueNumber,
    valueCheckbox: null,
    valueDate: null,
    valueUrl: null,
    valueOptionIds: null,
    valueUserIds: null,
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
  };
}

function valuesByCard(values: CardCustomFieldValue[]): Map<string, Map<string, CardCustomFieldValue>> {
  const map = new Map<string, Map<string, CardCustomFieldValue>>();
  for (const value of values) {
    let byField = map.get(value.cardId);
    if (!byField) {
      byField = new Map();
      map.set(value.cardId, byField);
    }
    byField.set(value.fieldId, value);
  }
  return map;
}

function configureComponentTest() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiClient, useValue: {} },
      { provide: NotificationsService, useValue: { watchCreatedCardLocally: vi.fn() } },
      { provide: BoardState, useValue: { canEdit: signal(false), isCardChecklistExpanded: () => false, checklistsForCard: () => [] } },
      { provide: WorkspaceService, useValue: { workspaceIdForBoard: () => "workspace-1" } },
    ],
  }).overrideComponent(BoardListViewComponent, { set: { template: "" } });
}

function configureComponentRenderTest() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiClient, useValue: {} },
      { provide: BoardState, useValue: { canEdit: signal(false), updateCard: vi.fn(), isCardChecklistExpanded: () => false, checklistsForCard: () => [] } },
      { provide: WorkspaceService, useValue: { workspaceIdForBoard: () => "workspace-1" } },
    ],
  });
}

describe("board list view preferences", () => {
  const scope = "board:test";

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it("persists column order by view scope", () => {
    writeColumnOrder(scope, ["labels", "due", "cf:priority"]);

    expect(readColumnOrder(scope)).toEqual(["labels", "due", "cf:priority"]);
    expect(readColumnOrder("board:other")).toBeNull();
  });

  it("persists numeric column widths and discards invalid entries", () => {
    writeColumnWidths(scope, { title: 360, labels: 180 });
    localStorage.setItem(
      viewPreferenceKey("columnWidths", "board:invalid"),
      JSON.stringify({ title: 320, labels: "wide", due: Number.NaN }),
    );

    expect(readColumnWidths(scope)).toEqual({ title: 360, labels: 180 });
    expect(readColumnWidths("board:invalid")).toEqual({ title: 320 });
  });

  it("persists custom field group-by values by view scope", () => {
    writeGroupBy(scope, "cf:priority");

    expect(readGroupBy(scope)).toBe("cf:priority");
    expect(readGroupBy("board:other")).toBeNull();
  });

  it("persists aggregate config by view scope and discards invalid entries", () => {
    writeAggregateConfig(scope, { "hours": ["sum", "avg"], "bad": ["sum", "median" as never] });
    localStorage.setItem(
      viewPreferenceKey("aggregates", "board:invalid"),
      JSON.stringify({ hours: "sum", empty: [], other: ["avg", "nope"] }),
    );

    expect(readAggregateConfig(scope)).toEqual({ hours: ["sum", "avg"], bad: ["sum"] });
    expect(readAggregateConfig("board:invalid")).toEqual({ other: ["avg"] });
    expect(readAggregateConfig("board:other")).toBeNull();
  });

  it("falls back when a saved custom field group references a missing field", () => {
    writeGroupBy(scope, "cf:missing");
    configureComponentTest();

    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("cards", []);
    fixture.componentRef.setInput("lists", []);
    fixture.componentRef.setInput("customFields", [customField()]);
    fixture.detectChanges();

    expect(fixture.componentInstance.groupBy()).toBe("list");
  });

  it("selects every card in a group from group data rather than rendered rows", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    const cards = Array.from({ length: 140 }, (_, index) => card({
      id: `card-${index}`,
      listId: "list-1",
      position: `${index + 1}.0000000000`,
    }));
    const emitted: unknown[] = [];
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
    fixture.componentRef.setInput("canEdit", true);
    fixture.componentInstance.bulkListSelectionRequested.subscribe((event) => emitted.push(event));
    fixture.detectChanges();

    fixture.componentInstance.selectGroupCards(
      fixture.componentInstance.groups()[0]!,
      new MouseEvent("click", { shiftKey: true }),
    );

    expect(emitted).toEqual([{
      orderedCardIds: cards.map((item) => item.id),
      additive: true,
    }]);
  });

  it("exposes only numeric custom fields as aggregate options", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("cards", []);
    fixture.componentRef.setInput("lists", []);
    fixture.componentRef.setInput("customFields", [
      customField({ id: "hours", name: "Billing Hours", type: "number" }),
      customField({ id: "month", name: "Billing Month", type: "text" }),
      customField({ id: "billable", name: "Billable", type: "checkbox" }),
    ]);
    fixture.detectChanges();

    expect(fixture.componentInstance.aggregateOptions().map((option) => option.field.id)).toEqual(["hours"]);
  });

  it("toggles and persists aggregate metrics", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("cards", []);
    fixture.componentRef.setInput("lists", []);
    fixture.componentRef.setInput("customFields", [customField({ id: "hours", type: "number" })]);
    fixture.detectChanges();

    fixture.componentInstance.toggleAggregate("hours", "sum");
    fixture.componentInstance.toggleAggregate("hours", "avg");

    expect(fixture.componentInstance.aggregateConfig()).toEqual({ hours: ["sum", "avg"] });
    expect(readAggregateConfig(scope)).toEqual({ hours: ["sum", "avg"] });
  });

  it("resets group, sort, and aggregate preferences to defaults", () => {
    configureComponentTest();
    writeGroupBy(scope, "assignee");
    writeSortBy(scope, "title-asc");
    writeAggregateConfig(scope, { hours: ["sum"] });
    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("defaultGroupBy", "board");
    fixture.componentRef.setInput("cards", []);
    fixture.componentRef.setInput("lists", []);
    fixture.componentRef.setInput("customFields", [customField({ id: "hours", type: "number" })]);
    fixture.detectChanges();

    let clearCount = 0;
    fixture.componentInstance.filterClearAll.subscribe(() => clearCount += 1);
    fixture.componentInstance.resetViewControls();

    expect(fixture.componentInstance.groupBy()).toBe("board");
    expect(fixture.componentInstance.sortBy()).toBe("position");
    expect(fixture.componentInstance.aggregateConfig()).toEqual({});
    expect(clearCount).toBe(1);
    expect(readGroupBy(scope)).toBe("board");
    expect(readSortBy(scope)).toBe("position");
    expect(readAggregateConfig(scope)).toEqual({});
  });

  it("computes group aggregate pills from valid values in that group", () => {
    configureComponentTest();
    writeAggregateConfig(scope, { hours: ["sum", "avg"] });
    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("lists", [list("list-1", "January"), list("list-2", "February", "2000.0000000000")]);
    fixture.componentRef.setInput("cards", [
      card({ id: "a", listId: "list-1", position: "1000.0000000000" }),
      card({ id: "b", listId: "list-1", position: "2000.0000000000" }),
      card({ id: "c", listId: "list-1", position: "3000.0000000000" }),
      card({ id: "d", listId: "list-2", position: "1000.0000000000" }),
    ]);
    fixture.componentRef.setInput("customFields", [customField({ id: "hours", name: "Billing Hours", type: "number" })]);
    fixture.componentRef.setInput("customFieldValuesByCardAndField", valuesByCard([
      fieldValue("a", "hours", "2"),
      fieldValue("b", "hours", "3.5"),
      fieldValue("c", "hours", null),
      fieldValue("d", "hours", "10"),
    ]));
    fixture.detectChanges();

    const january = fixture.componentInstance.groups()[0]!;
    const february = fixture.componentInstance.groups()[1]!;

    expect(fixture.componentInstance.aggregatePillsFor(january).map((pill) => `${pill.fieldName} ${pill.metric} ${pill.total}`)).toEqual([
      "Billing Hours sum 5.5",
      "Billing Hours avg 2.75",
    ]);
    expect(fixture.componentInstance.aggregatePillsFor(february).map((pill) => `${pill.fieldName} ${pill.metric} ${pill.total}`)).toEqual([
      "Billing Hours sum 10",
      "Billing Hours avg 10",
    ]);
    expect(fixture.componentInstance.aggregateGridFor(fixture.componentInstance.aggregatePillsFor(january))).toEqual({
      buckets: [],
      columnCount: 0,
      rows: [
        { key: "hours:sum", label: "Billing Hours sum", total: "5.5", values: [] },
        { key: "hours:avg", label: "Billing Hours avg", total: "2.75", values: [] },
      ],
    });
  });

  it("toggles all current groups between collapsed and expanded", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo"), list("list-2", "Done", "2000.0000000000")]);
    fixture.componentRef.setInput("cards", [
      card({ id: "a", listId: "list-1", position: "1000.0000000000" }),
      card({ id: "b", listId: "list-2", position: "1000.0000000000" }),
    ]);
    fixture.componentRef.setInput("customFields", []);
    fixture.detectChanges();

    fixture.componentInstance.toggleAllGroups();

    expect(fixture.componentInstance.allGroupsCollapsed()).toBe(true);
    expect(fixture.componentInstance.groups().every((group) => fixture.componentInstance.isGroupCollapsed(group.key))).toBe(true);

    fixture.componentInstance.toggleAllGroups();

    expect(fixture.componentInstance.allGroupsCollapsed()).toBe(false);
    expect(fixture.componentInstance.groups().some((group) => fixture.componentInstance.isGroupCollapsed(group.key))).toBe(false);
  });

  it("hides separators by default and shows them with the toolbar toggle", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
    fixture.componentRef.setInput("cards", [
      card({ id: "card-a", position: "1000.0000000000" }),
      card({ id: "card-b", position: "2000.0000000000" }),
    ]);
    fixture.componentRef.setInput("separators", [separator({ id: "separator-a", position: "1500.0000000000" })]);
    fixture.componentRef.setInput("customFields", []);
    fixture.detectChanges();

    expect(rowIds(fixture.componentInstance.renderedGroups()[0]!.items)).toEqual(["card-a", "card-b"]);

    fixture.componentInstance.toggleSeparators();

    expect(rowIds(fixture.componentInstance.renderedGroups()[0]!.items)).toEqual(["card-a", "separator-a", "card-b"]);
    expect(readShowSeparators(scope)).toBe(true);

    const restored = TestBed.createComponent(BoardListViewComponent);
    restored.componentRef.setInput("viewKey", scope);
    restored.componentRef.setInput("lists", [list("list-1", "Todo")]);
    restored.componentRef.setInput("cards", [
      card({ id: "card-a", position: "1000.0000000000" }),
      card({ id: "card-b", position: "2000.0000000000" }),
    ]);
    restored.componentRef.setInput("separators", [separator({ id: "separator-a", position: "1500.0000000000" })]);
    restored.componentRef.setInput("customFields", []);
    restored.detectChanges();

    expect(restored.componentInstance.showSeparators()).toBe(true);
    expect(rowIds(restored.componentInstance.renderedGroups()[0]!.items)).toEqual(["card-a", "separator-a", "card-b"]);
  });

  it("only renders the separator toggle for list manual sort", () => {
    class TestResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    configureComponentRenderTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
    fixture.componentRef.setInput("cards", [card({ id: "card-a" })]);
    fixture.componentRef.setInput("customFields", []);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector(".lv-separator-toggle")).not.toBeNull();

    fixture.componentInstance.selectSortBy("title-asc");
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector(".lv-separator-toggle")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("renders export controls and invokes JSON and Excel exports", () => {
    class TestResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    configureComponentRenderTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", scope);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("boardName", "Roadmap");
    fixture.componentRef.setInput("cards", [card({ id: "a", title: "Alpha" })]);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
    fixture.componentRef.setInput("customFields", []);
    const jsonSpy = vi.spyOn(fixture.componentInstance, "exportJson").mockImplementation(() => undefined);
    const excelSpy = vi.spyOn(fixture.componentInstance, "exportExcel").mockResolvedValue(undefined);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>(".lv-toolbar-export")?.click();
    fixture.detectChanges();

    expect(host.textContent).toContain("JSON");
    expect(host.textContent).toContain("Excel");
    expect(host.textContent).not.toContain("All JSON");
    expect(host.textContent).not.toContain("All Excel");
    expect(host.querySelectorAll<HTMLButtonElement>(".lv-menu-item")).toHaveLength(2);
    expect([...host.querySelectorAll<HTMLElement>(".lv-menu-item span")].map((item) => item.textContent?.trim())).toEqual(["Excel", "JSON"]);

    host.querySelectorAll<HTMLButtonElement>(".lv-menu-item")[1]?.click();
    fixture.componentInstance.closeMenus();
    host.querySelector<HTMLButtonElement>(".lv-toolbar-export")?.click();
    fixture.detectChanges();
    host.querySelectorAll<HTMLButtonElement>(".lv-menu-item")[0]?.click();

    expect(jsonSpy).toHaveBeenCalledOnce();
    expect(excelSpy).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("hides and blocks list-view export when export permission is false", () => {
    class TestResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    configureComponentRenderTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    fixture.componentRef.setInput("viewKey", "board:board-1");
    fixture.componentRef.setInput("cards", [card({})]);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("canExport", false);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector(".lv-toolbar-export")).toBeNull();
    fixture.componentInstance.exportJson();
    expect(fixture.componentInstance.exportMenuOpen()).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("board list view row cap", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("caps rendered rows across groups and grows near the scroll boundary", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    const cards = Array.from({ length: 90 }, (_, i) =>
      card({ id: `card-${i}`, position: `${1000 + i}.0000000000` }),
    );
    fixture.componentRef.setInput("viewKey", "board:rowcap");
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
    fixture.componentRef.setInput("customFields", []);
    fixture.detectChanges();

    const instance = fixture.componentInstance;
    const renderedCount = () => instance.renderedGroups().reduce((sum, entry) => sum + entry.cards.length, 0);

    // Initial budget (80) renders fewer than the 90 cards; the rest are hidden.
    expect(renderedCount()).toBe(80);
    expect(instance.hasHiddenRows()).toBe(true);
    expect(instance.renderedGroups()[0]?.hidden).toBe(10);

    instance.onTableScroll({
      scrollHeight: 3000,
      scrollTop: 2200,
      clientHeight: 300,
    } as HTMLElement);
    fixture.detectChanges();

    expect(renderedCount()).toBe(90);
    expect(instance.hasHiddenRows()).toBe(false);
  });

  it("renders every filtered row so narrowed results are not hidden behind the cap", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    const cards = Array.from({ length: 90 }, (_, i) =>
      card({ id: `card-${i}`, position: `${1000 + i}.0000000000` }),
    );
    fixture.componentRef.setInput("viewKey", "board:rowcap-filtered");
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
    fixture.componentRef.setInput("customFields", []);
    fixture.componentRef.setInput("filteredCardIds", new Set(cards.map((item) => item.id)));
    fixture.detectChanges();

    const instance = fixture.componentInstance;
    const renderedCount = () => instance.renderedGroups().reduce((sum, entry) => sum + entry.cards.length, 0);

    expect(renderedCount()).toBe(90);
    expect(instance.hasHiddenRows()).toBe(false);
  });

  it("auto-scrolls and grows rows while dragging near the bottom edge", () => {
    configureComponentRenderTest();
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frameCallbacks.push(cb);
      return frameCallbacks.length;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const fixture = TestBed.createComponent(BoardListViewComponent);
      const cards = Array.from({ length: 90 }, (_, i) =>
        card({ id: `card-${i}`, position: `${1000 + i}.0000000000` }),
      );
      fixture.componentRef.setInput("viewKey", "board:rowcap-drag");
      fixture.componentRef.setInput("cards", cards);
      fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
      fixture.componentRef.setInput("customFields", []);
      fixture.detectChanges();

      const instance = fixture.componentInstance;
      const scrollEl = fixture.nativeElement.querySelector(".lv-scroll") as HTMLElement;
      Object.defineProperty(scrollEl, "scrollHeight", { value: 3000, configurable: true });
      Object.defineProperty(scrollEl, "clientHeight", { value: 300, configurable: true });
      scrollEl.getBoundingClientRect = () => ({
        left: 100,
        top: 100,
        right: 700,
        bottom: 400,
        width: 600,
        height: 300,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect);
      scrollEl.scrollTop = 2200;

      instance.onDragStarted({} as never);
      instance.onDragMoved({ pointerPosition: { x: 500, y: 399 } } as never);
      for (let i = 0; i < 5 && scrollEl.scrollTop === 2200; i += 1) {
        frameCallbacks.shift()?.(i);
      }
      fixture.detectChanges();

      const renderedCount = () => instance.renderedGroups().reduce((sum, entry) => sum + entry.cards.length, 0);
      expect(scrollEl.scrollTop).toBeGreaterThan(2200);
      expect(renderedCount()).toBe(90);

      instance.onDragEnded();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });
});

describe("board list view drop handoff", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps same-group committed order while parent state catches up", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    const cards = [
      card({ id: "card-a", position: "1000.0000000000" }),
      card({ id: "card-b", position: "2000.0000000000" }),
      card({ id: "card-c", position: "3000.0000000000" }),
      card({ id: "card-d", position: "4000.0000000000" }),
    ];
    const emitted: unknown[] = [];
    fixture.componentRef.setInput("viewKey", "board:drop-handoff");
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
    fixture.componentRef.setInput("customFields", []);
    fixture.componentInstance.cardDropped.subscribe((event) => emitted.push(event));
    fixture.detectChanges();

    const group = fixture.componentInstance.groups()[0]!;
    const container = { data: group };
    fixture.componentInstance.onDrop({
      item: { data: { kind: "card", card: cards[0] } },
      previousContainer: container,
      container,
      previousIndex: 0,
      currentIndex: 2,
    } as never, group);
    fixture.detectChanges();

    // Committed lane order is held on rendered items (cards + separators), not the card-only groups().
    expect(rowIds(fixture.componentInstance.renderedGroups()[0]!.items)).toEqual(["card-b", "card-c", "card-a", "card-d"]);
    expect(emitted).toEqual([{
      cardId: "card-a",
      toListId: "list-1",
      beforeItem: { type: "card", id: "card-d" },
    }]);
  });

  it("does not emit unchanged card or separator drops", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    const cards = [
      card({ id: "card-a", position: "1000.0000000000" }),
      card({ id: "card-b", position: "2000.0000000000" }),
    ];
    const cardEvents: unknown[] = [];
    const separatorEvents: unknown[] = [];
    fixture.componentRef.setInput("viewKey", "board:noop-drop");
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("separators", [separator({ id: "separator-a", position: "1500.0000000000" })]);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo")]);
    fixture.componentRef.setInput("customFields", []);
    fixture.componentInstance.cardDropped.subscribe((event) => cardEvents.push(event));
    fixture.componentInstance.separatorDropped.subscribe((event) => separatorEvents.push(event));
    fixture.detectChanges();

    const group = fixture.componentInstance.groups()[0]!;
    const items = fixture.componentInstance.renderedGroups()[0]!.items;
    const container = { data: group };
    for (const [item, index] of items.map((entry, index) => [entry, index] as const)) {
      fixture.componentInstance.onDrop({
        item: { data: item }, previousContainer: container, container,
        previousIndex: index, currentIndex: index,
      } as never, group);
    }

    expect(cardEvents).toEqual([]);
    expect(separatorEvents).toEqual([]);
  });

  it("keeps cross-group source and target committed order during handoff", () => {
    configureComponentTest();
    const fixture = TestBed.createComponent(BoardListViewComponent);
    const cards = [
      card({ id: "card-a", listId: "list-1", position: "1000.0000000000" }),
      card({ id: "card-b", listId: "list-1", position: "2000.0000000000" }),
      card({ id: "card-c", listId: "list-2", position: "1000.0000000000" }),
    ];
    fixture.componentRef.setInput("viewKey", "board:drop-handoff-cross");
    fixture.componentRef.setInput("cards", cards);
    fixture.componentRef.setInput("lists", [list("list-1", "Todo"), list("list-2", "Done", "2000.0000000000")]);
    fixture.componentRef.setInput("customFields", []);
    fixture.detectChanges();

    const sourceGroup = fixture.componentInstance.groups()[0]!;
    const targetGroup = fixture.componentInstance.groups()[1]!;
    fixture.componentInstance.onDrop({
      item: { data: { kind: "card", card: cards[0] } },
      previousContainer: { data: sourceGroup },
      container: { data: targetGroup },
      previousIndex: 0,
      currentIndex: 1,
    } as never, targetGroup);
    fixture.detectChanges();

    expect(rowIds(fixture.componentInstance.renderedGroups()[0]!.items)).toEqual(["card-b"]);
    expect(rowIds(fixture.componentInstance.renderedGroups()[1]!.items)).toEqual(["card-c", "card-a"]);
  });
});
