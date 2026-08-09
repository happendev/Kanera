import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { CdkDrag, type CdkDragDrop } from "@angular/cdk/drag-drop";
import type { WorkCard, WorkPriorityItem, WorkPriorityQueue } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { By } from "@angular/platform-browser";
import { CARD_DRAG_START_DELAY } from "../board/card-drag-scroll";
import { TeamPrioritiesViewComponent, type TeamPriorityReorder } from "./team-priorities-view.component";

function card(id: string, title: string): WorkCard {
  return {
    id,
    number: 1,
    key: `DEV-${id.slice(-1)}`,
    organisationKey: "0123456789ABCDEF",
    boardId: "30000000-0000-4000-8000-000000000001",
    workspaceId: "20000000-0000-4000-8000-000000000001",
    listId: "50000000-0000-4000-8000-000000000001",
    title,
    position: "1000.0000000000",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  };
}

function entry(id: string, rank: number, visible: boolean): WorkPriorityItem {
  return {
    id,
    position: `${rank * 1000}.0000000000`,
    rank,
    card: visible ? card(`40000000-0000-4000-8000-00000000000${rank}`, `Ranked ${rank}`) : null,
    context: visible
      ? { boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing", workspaceName: "Delivery" }
      : null,
  };
}

function lane(
  userId: string,
  displayName: string,
  self: boolean,
  items: WorkPriorityItem[],
  overrides: Partial<WorkPriorityQueue["queue"]> = {},
): WorkPriorityQueue {
  return {
    target: { userId, displayName, email: `${userId.slice(-1)}@x.test`, self, workspaceIds: [], queueSize: items.length },
    queue: {
      targetUserId: userId,
      items,
      totalCount: items.length,
      hiddenCount: items.filter((item) => item.card === null).length,
      canReorder: true,
      reorderableWorkspaceIds: ["20000000-0000-4000-8000-000000000001"],
      ...overrides,
    },
  };
}

const SELF_ID = "60000000-0000-4000-8000-000000000001";
const TEAMMATE_ID = "60000000-0000-4000-8000-000000000002";

/** The manager's overview: their own short queue, and a teammate's queue with a redacted #2. */
const queues: WorkPriorityQueue[] = [
  lane(SELF_ID, "Viewer", true, [entry("s1", 1, true)]),
  lane(TEAMMATE_ID, "Teammate", false, [entry("p1", 1, true), entry("p2", 2, false), entry("p3", 3, true)]),
];

/** Only the container ids, indices and release point are read, so a minimal stand-in is honest. */
function drop(
  previousIndex: number,
  currentIndex: number,
  options: { releasedInside?: boolean } = {},
): CdkDragDrop<unknown[]> {
  const container = { id: "lane", element: { nativeElement: document.createElement("div") } };
  return {
    previousContainer: container,
    container,
    previousIndex,
    currentIndex,
    isPointerOverContainer: options.releasedInside ?? true,
  } as unknown as CdkDragDrop<unknown[]>;
}

function setup(input: WorkPriorityQueue[] = queues) {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(TeamPrioritiesViewComponent);
  fixture.componentRef.setInput("queues", input);
  fixture.componentRef.setInput("canDrag", true);
  fixture.detectChanges();
  return fixture;
}

describe("TeamPrioritiesViewComponent", () => {
  beforeEach(() => TestBed.resetTestingModule());

  it("renders one lane per readable queue, ranks numbered over each target's whole set", () => {
    const fixture = setup();
    const host = fixture.nativeElement as HTMLElement;

    const names = [...host.querySelectorAll<HTMLElement>(".lane-name")].map((el) => el.textContent?.replace(/\s+/g, " ").trim());
    expect(names).toEqual(["Viewer you", "Teammate"]);
    const counts = [...host.querySelectorAll<HTMLElement>(".lane-count")].map((el) => el.textContent?.trim());
    expect(counts).toEqual(["1", "3"]);

    const lanes = host.querySelectorAll<HTMLElement>(".lane");
    const badges = [...lanes[1]!.querySelectorAll<HTMLElement>(".row-rank")].map((el) => el.textContent?.trim());
    // 1, 2, 3 — not renumbered to 1, 2 for the two visible entries, so the manager and the
    // assignee quote the same numbers about the same cards.
    expect(badges).toEqual(["1", "2", "3"]);
    expect(lanes[1]!.querySelectorAll(".lane-row")[1]?.classList.contains("locked")).toBe(true);

    const hidden: string[] = [];
    fixture.componentInstance.laneHidden.subscribe((userId) => hidden.push(userId));
    lanes[1]!.querySelector<HTMLButtonElement>(".lane-head-hide")!.click();
    expect(hidden).toEqual([TEAMMATE_ID]);
  });

  it("keeps every lane visible while search filters matching card titles", () => {
    const fixture = setup();
    fixture.componentRef.setInput("searchQuery", "ranked 3");
    fixture.detectChanges();

    const lanes = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".lane");
    expect(lanes).toHaveLength(2);
    expect(lanes[0]!.querySelector(".lane-empty")?.textContent).toContain("No cards match this search");
    expect(lanes[1]!.querySelectorAll(".lane-row")).toHaveLength(1);
    expect(lanes[1]!.querySelector(".row-title")?.textContent).toContain("Ranked 3");
    // Search never renumbers the underlying queue.
    expect(lanes[1]!.querySelector(".row-rank")?.textContent?.trim()).toBe("3");
    expect((fixture.nativeElement as HTMLElement).querySelector(".lane-focus")).toBeNull();
  });

  it("uses the board's touch hold delay before a row starts dragging", () => {
    const fixture = setup();
    const drag = fixture.debugElement.query(By.directive(CdkDrag)).injector.get(CdkDrag);
    expect(drag.dragStartDelay).toEqual(CARD_DRAG_START_DELAY);
    expect(drag.lockAxis).toBe("y");
  });

  it("renders the queues as a wrapped grid with no layout switch", () => {
    const fixture = setup();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".lanes")).not.toBeNull();
    expect(host.querySelector("k-segmented")).toBeNull();
  });

  it("leaves lane visibility to the profile controls in the page toolbar", () => {
    const fixture = setup();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll(".lane")).toHaveLength(2);
    expect(host.querySelector(".lane-collapse")).toBeNull();
  });

  it("opens the Up Next card actions menu on right-click only for editable rows", () => {
    const fixture = setup();
    const editable = fixture.componentInstance.lanes()[0]!.rows[0]!.card!;
    fixture.componentRef.setInput("editableCardIds", new Set([editable.id]));
    fixture.detectChanges();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    fixture.componentInstance.onRowContextMenu(fixture.componentInstance.lanes()[0]!.rows[0]!, {
      clientX: 40,
      clientY: 60,
      preventDefault,
      stopPropagation,
    } as unknown as MouseEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.actionsMenu()[0]?.card.id).toBe(editable.id);
    expect(fixture.componentInstance.actionsMenu()[0]?.point).toEqual({ x: 40, y: 60 });

    fixture.componentInstance.closeActionsMenu();
    fixture.componentInstance.onRowContextMenu(fixture.componentInstance.lanes()[1]!.rows[2]!, {
      preventDefault,
      stopPropagation,
    } as unknown as MouseEvent);
    expect(fixture.componentInstance.actionsMenu()).toEqual([]);
  });

  it("offers Add card in the lane header and footer, grouped by board, and emits the lane owner", () => {
    const fixture = setup();
    fixture.componentRef.setInput("addableCardsByUserId", new Map([[TEAMMATE_ID, [
      { id: "c1", title: "Fix login", boardId: "b1", boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing" },
      { id: "c2", title: "Ship exports", boardId: "b2", boardName: "Delivery", boardIcon: "rocket", boardIconColor: "blue", listName: "Todo" },
      { id: "c3", title: "Fix signup", boardId: "b1", boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Todo" },
    ]]]));
    fixture.detectChanges();

    const teammateLane = fixture.componentInstance.lanes()[1]!;
    expect(teammateLane.addGroups.map((group) => group.label)).toEqual(["Roadmap", "Delivery"]);
    expect(teammateLane.addGroups[0]?.options.map((option) => option.id)).toEqual(["c1", "c3"]);

    const laneElements = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".lane");
    expect(laneElements[1]!.querySelector<HTMLButtonElement>(".lane-head-add")?.disabled).toBe(false);
    expect(laneElements[1]!.querySelector<HTMLButtonElement>(".lane-add")?.disabled).toBe(false);

    const added: object[] = [];
    fixture.componentInstance.added.subscribe((event) => added.push(event));
    fixture.componentInstance.toggleAdd(TEAMMATE_ID, "list");
    expect(fixture.componentInstance.isAddOpen(TEAMMATE_ID, "list")).toBe(true);
    fixture.componentInstance.onAddPicked(TEAMMATE_ID, "c2");
    expect(added).toEqual([{ targetUserId: TEAMMATE_ID, cardId: "c2" }]);
    expect(fixture.componentInstance.addOpenAt()).toBeNull();
  });

  it("reorders within a lane with the target attached and never anchors on a redacted entry", () => {
    const fixture = setup();
    const emitted: TeamPriorityReorder[] = [];
    fixture.componentInstance.reordered.subscribe((event) => emitted.push(event));
    const teammateLane = fixture.componentInstance.lanes()[1]!;

    // Move #3 to the very top: the head needs no anchor row at all.
    fixture.componentInstance.onDrop(drop(2, 0), teammateLane);
    expect(emitted[0]).toEqual({ targetUserId: TEAMMATE_ID, priorityId: "p3", afterId: null });

    // Dropping #1 directly below the placeholder anchors before the next visible entry instead,
    // since the server refuses a blind anchor.
    fixture.componentInstance.onDrop(drop(0, 1), teammateLane);
    expect(emitted[1]).toEqual({ targetUserId: TEAMMATE_ID, priorityId: "p1", beforeId: "p3" });

    // One step down resolves in the same rest-coordinate anchor frame a drop uses.
    fixture.componentInstance.moveBy(teammateLane, teammateLane.queue.items[0]!, 1);
    expect(emitted[2]).toEqual({ targetUserId: TEAMMATE_ID, priorityId: "p1", beforeId: "p3" });
    // The first row cannot go higher: clamped, so nothing is emitted.
    fixture.componentInstance.moveBy(teammateLane, teammateLane.queue.items[0]!, -1);
    expect(emitted).toHaveLength(3);
  });

  it("treats a release outside the lane as a snap-back, never a removal", () => {
    // The deliberate divergence from the docked panel's drag-out removal: with lanes side by side,
    // "outside" is one misdrop from a neighbour's queue.
    const fixture = setup();
    const removed: unknown[] = [];
    const reordered: unknown[] = [];
    fixture.componentInstance.removed.subscribe((event) => removed.push(event));
    fixture.componentInstance.reordered.subscribe((event) => reordered.push(event));

    fixture.componentInstance.onDrop(drop(2, 0, { releasedInside: false }), fixture.componentInstance.lanes()[1]!);
    expect(removed).toEqual([]);
    expect(reordered).toEqual([]);
  });

  it("reorders filtered results relative to one another without jumping past hidden matches", () => {
    const fixture = setup();
    fixture.componentRef.setInput("searchQuery", "ranked");
    fixture.detectChanges();
    const emitted: TeamPriorityReorder[] = [];
    fixture.componentInstance.reordered.subscribe((event) => emitted.push(event));
    const teammateLane = fixture.componentInstance.lanes()[1]!;

    // The redacted #2 is absent from search results. Moving #3 above #1 anchors directly before
    // #1 rather than treating the filtered top as the absolute head of the full queue.
    fixture.componentInstance.onDrop(drop(1, 0), teammateLane);
    expect(emitted).toEqual([{ targetUserId: TEAMMATE_ID, priorityId: "p3", beforeId: "p1" }]);
  });

  it("removes via the row tool with the lane's target attached", () => {
    const fixture = setup();
    const removed: { targetUserId: string; priorityId: string }[] = [];
    fixture.componentInstance.removed.subscribe((event) => removed.push(event));

    const lanes = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(".lane");
    lanes[1]!.querySelector<HTMLButtonElement>(".row-remove")!.click();
    expect(removed).toEqual([{ targetUserId: TEAMMATE_ID, priorityId: "p1" }]);
  });

  it("locks redacted rows and whole lanes the viewer may not curate", () => {
    const readOnly = lane(TEAMMATE_ID, "Teammate", false, [entry("p1", 1, true)], {
      canReorder: false,
      reorderableWorkspaceIds: [],
    });
    const fixture = setup([readOnly]);
    const componentLane = fixture.componentInstance.lanes()[0]!;
    expect(fixture.componentInstance.isDraggable(componentLane, componentLane.queue.items[0]!)).toBe(false);
    expect((fixture.nativeElement as HTMLElement).querySelector(".row-tools")).toBeNull();

    // And even in a curatable lane, a redacted entry is never draggable: its anchor would be blind
    // and the viewer has no rights over that card's workspace anyway.
    TestBed.resetTestingModule();
    const withHidden = setup(queues).componentInstance;
    const teammateLane = withHidden.lanes()[1]!;
    expect(withHidden.isDraggable(teammateLane, teammateLane.queue.items[1]!)).toBe(false);
    expect(withHidden.isDraggable(teammateLane, teammateLane.queue.items[0]!)).toBe(true);
  });

  it("shows the quiet empty state for a teammate with nothing in Up next", () => {
    const fixture = setup([lane(TEAMMATE_ID, "Teammate", false, [])]);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".lane-empty")?.textContent).toContain("Nothing in Up next yet");
    expect(host.querySelector(".lane-count")?.textContent?.trim()).toBe("0");
  });
});
