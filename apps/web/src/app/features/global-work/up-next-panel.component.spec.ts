import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { CdkDragDrop } from "@angular/cdk/drag-drop";
import type { WorkCard, WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it } from "vitest";
import { UpNextPanelComponent, type PriorityReorder } from "./up-next-panel.component";

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

/** Ranks 1, 2, 3 with #2 redacted — the manager's view of somebody else's cross-workspace queue. */
const queue: WorkPrioritiesResponse = {
  targetUserId: "60000000-0000-4000-8000-000000000002",
  items: [entry("p1", 1, true), entry("p2", 2, false), entry("p3", 3, true)],
  totalCount: 3,
  hiddenCount: 1,
  canReorder: true,
  reorderableWorkspaceIds: ["20000000-0000-4000-8000-000000000001"],
};

/** Only the container ids, indices and release point are read, so a minimal stand-in is honest. */
function drop(
  previousIndex: number,
  currentIndex: number,
  options: { releasedInside?: boolean } = {},
): CdkDragDrop<unknown[]> {
  const container = { id: "up-next", element: { nativeElement: document.createElement("div") } };
  return {
    previousContainer: container,
    container,
    previousIndex,
    currentIndex,
    isPointerOverContainer: options.releasedInside ?? true,
  } as unknown as CdkDragDrop<unknown[]>;
}

function setup(overrides: Partial<WorkPrioritiesResponse> = {}) {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(UpNextPanelComponent);
  fixture.componentRef.setInput("priorities", { ...queue, ...overrides });
  fixture.componentRef.setInput("canDrag", true);
  fixture.detectChanges();
  return fixture;
}

describe("UpNextPanelComponent", () => {
  beforeEach(() => TestBed.resetTestingModule());

  it("reorders a drop with the anchor for where the pointer released it", () => {
    const fixture = setup();
    const emitted: PriorityReorder[] = [];
    fixture.componentInstance.reordered.subscribe((event) => emitted.push(event));

    // Move #3 to the very top: the head needs no anchor row at all.
    fixture.componentInstance.onDrop(drop(2, 0));
    expect(emitted[0]).toEqual({ priorityId: "p3", afterId: null });

    // Move #1 to the end. With #1 lifted out the remaining list is [p2(hidden), p3], so index 2 is
    // past the last row and needs no anchor either.
    fixture.componentInstance.onDrop(drop(0, 2));
    expect(emitted[1]).toEqual({ priorityId: "p1", beforeId: null });
  });

  it("never anchors on a redacted entry, since the server refuses a blind anchor", () => {
    const fixture = setup();
    const emitted: PriorityReorder[] = [];
    fixture.componentInstance.reordered.subscribe((event) => emitted.push(event));

    // Dropping #1 at index 1 lands it directly below the placeholder. Anchoring `after` the
    // placeholder would be rejected, so it anchors `before` the next visible entry instead.
    fixture.componentInstance.onDrop(drop(0, 1));
    expect(emitted[0]).toEqual({ priorityId: "p1", beforeId: "p3" });
  });

  it("steps a row up or down with the same anchor frame a drop uses", () => {
    const fixture = setup();
    const emitted: PriorityReorder[] = [];
    fixture.componentInstance.reordered.subscribe((event) => emitted.push(event));

    // #3 one step up crosses the redacted row's slot; the anchor resolves to the visible #1.
    fixture.componentInstance.moveBy(queue.items[2]!, -1);
    expect(emitted[0]).toEqual({ priorityId: "p3", afterId: "p1" });

    // The first row cannot go higher: clamped, so nothing is emitted.
    fixture.componentInstance.moveBy(queue.items[0]!, -1);
    expect(emitted).toHaveLength(1);

    fixture.componentInstance.moveBy(queue.items[0]!, 1);
    expect(emitted[1]).toEqual({ priorityId: "p1", beforeId: "p3" });
  });

  it("removes via the row tool and via dragging a row out of the panel", () => {
    const fixture = setup();
    const removed: { priorityId: string }[] = [];
    const reordered: PriorityReorder[] = [];
    fixture.componentInstance.removed.subscribe((event) => removed.push(event));
    fixture.componentInstance.reordered.subscribe((event) => reordered.push(event));

    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>(".row-remove")?.click();
    expect(removed).toEqual([{ priorityId: "p1" }]);

    // A row released outside the panel is the same removal, not a reorder — even when CDK reports
    // an in-list index shift from where the pointer last hovered.
    fixture.componentInstance.onDrop(drop(2, 0, { releasedInside: false }));
    expect(removed).toEqual([{ priorityId: "p1" }, { priorityId: "p3" }]);
    expect(reordered).toEqual([]);
  });

  it("marks the preview outside the panel and zeroes its return transition on release", () => {
    const fixture = setup();
    const preview = document.createElement("div");
    preview.className = "panel-row cdk-drag-preview";
    document.body.appendChild(preview);
    try {
      // The fixture's .panel-rows rect is all zeros in the test DOM, so any negative point is out.
      fixture.componentInstance.onDragMoved({ pointerPosition: { x: -50, y: -50 } } as never);
      expect(preview.classList.contains("drag-outside")).toBe(true);
      fixture.componentInstance.onDragMoved({ pointerPosition: { x: 0, y: 0 } } as never);
      expect(preview.classList.contains("drag-outside")).toBe(false);

      // Released outside: without this, CDK animates the preview back into the list and fires the
      // drop — and the removal — only after that snap-back finishes.
      preview.classList.add("drag-outside");
      fixture.componentInstance.onDragReleased();
      expect(preview.style.transition).toBe("none");

      // Released inside: the settle animation stays.
      preview.style.transition = "";
      preview.classList.remove("drag-outside");
      fixture.componentInstance.onDragReleased();
      expect(preview.style.transition).toBe("");
    } finally {
      preview.remove();
    }
  });

  it("renders ranks over the target's set and locks redacted rows", () => {
    const fixture = setup();
    const host = fixture.nativeElement as HTMLElement;
    const badges = [...host.querySelectorAll<HTMLElement>(".row-rank")]
      .map((element) => element.textContent?.trim());
    // 1, 2, 3 — not renumbered to 1, 2 for the two visible entries, so the manager and the
    // assignee quote the same numbers about the same cards.
    expect(badges).toEqual(["1", "2", "3"]);

    const rows = host.querySelectorAll<HTMLElement>(".panel-row");
    expect(rows[1]?.classList.contains("locked")).toBe(true);
    expect(rows[1]?.querySelector(".row-tools")).toBeNull();
    expect(fixture.componentInstance.isDraggable(queue.items[1]!)).toBe(false);
    expect(fixture.componentInstance.isDraggable(queue.items[0]!)).toBe(true);
  });

  it("is read-only when the viewer may not curate this queue", () => {
    const fixture = setup({ canReorder: false });
    expect(fixture.componentInstance.canReorder()).toBe(false);
    expect(fixture.componentInstance.isDraggable(queue.items[0]!)).toBe(false);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".row-tools")).toBeNull();
  });

  it("refuses to drag rows from workspaces the viewer may not curate", () => {
    const fixture = setup({ reorderableWorkspaceIds: [] });
    expect(fixture.componentInstance.isDraggable(queue.items[0]!)).toBe(false);
  });

  it("notes capacity so the missing tile affordance is explained", () => {
    const fixture = setup({ totalCount: 50 });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".panel-note")?.textContent).toContain("Full at 50 cards");
    // The note takes the inline slot the add button normally holds, and the header "+" greys out:
    // a full queue cannot grow.
    expect(host.querySelector(".panel-add")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".panel-head-tool")?.disabled).toBe(true);
    // The drag hint stays: dragging a row out is exactly how a slot gets freed.
    expect(host.querySelector(".panel-drag-hint")?.textContent).toContain("drag a row out");
  });

  it("offers Add card to curators, grouped per board, and emits the pick", () => {
    const fixture = setup();
    fixture.componentRef.setInput("addableCards", [
      { id: "c1", title: "Fix login", boardId: "b1", boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing" },
      { id: "c2", title: "Ship exports", boardId: "b2", boardName: "Delivery", boardIcon: "rocket", boardIconColor: "blue", listName: "Todo" },
      { id: "c3", title: "Fix signup", boardId: "b1", boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Todo" },
    ]);
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".panel-add");
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);

    const groups = fixture.componentInstance.addGroups();
    expect(groups.map((group) => group.label)).toEqual(["Roadmap", "Delivery"]);
    expect(groups[0]?.options.map((option) => option.id)).toEqual(["c1", "c3"]);

    const added: object[] = [];
    fixture.componentInstance.added.subscribe((event) => added.push(event));
    fixture.componentInstance.toggleAdd();
    fixture.componentInstance.onAddPicked("c2");
    // A pick appends; only a drop carries a positional anchor.
    expect(added).toEqual([{ cardId: "c2", beforeId: null }]);
    expect(fixture.componentInstance.addOpen()).toBe(false);
  });

  it("keeps the Add card footer in flow while the drop list is dragging", () => {
    const fixture = setup();
    const host = fixture.nativeElement as HTMLElement;
    const rows = host.querySelector<HTMLElement>(".panel-rows")!;
    const addAnchor = host.querySelector<HTMLElement>(".panel-add-anchor")!;

    // Mobile renders this list in a height-constrained bottom sheet. Removing the footer when CDK
    // adds its dragging class changes the measured row slots mid-gesture and makes the first slot
    // especially difficult to reach.
    rows.classList.add("cdk-drop-list-dragging");
    expect(getComputedStyle(addAnchor).display).toBe("block");
    expect(addAnchor.querySelector(".panel-add")).not.toBeNull();
  });

  it("accepts an eligible board tile dropped in, anchored where it landed", () => {
    const fixture = setup();
    const tile = {
      kind: "card",
      card: card("70000000-0000-4000-8000-000000000001", "Dragged in"),
    };
    fixture.componentRef.setInput("addableCards", [
      { id: tile.card.id, title: tile.card.title, boardId: tile.card.boardId, boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing" },
    ]);
    fixture.detectChanges();

    const added: object[] = [];
    fixture.componentInstance.added.subscribe((event) => added.push(event));

    // Cross-container drop at index 1: directly below rank #1, so it anchors after p1.
    const foreign = { id: "dl-list-1", element: { nativeElement: document.createElement("div") } };
    const container = { id: "up-next-drop", element: { nativeElement: document.createElement("div") } };
    fixture.componentInstance.onDrop({
      previousContainer: foreign,
      container,
      previousIndex: 0,
      currentIndex: 1,
      item: { data: tile },
    } as never);
    expect(added).toEqual([{ cardId: tile.card.id, afterId: "p1" }]);

    // A tile the server would reject (not in the addable set) may not even enter.
    const ineligible = { data: { kind: "card", card: card("70000000-0000-4000-8000-000000000002", "Not yours") } };
    expect(fixture.componentInstance.canEnterFromBoard(ineligible as never)).toBe(false);
    expect(fixture.componentInstance.canEnterFromBoard({ data: tile } as never)).toBe(true);
  });

  it("opens the card actions menu on right-click, but only for rows the viewer may edit", () => {
    const fixture = setup();
    const rows = fixture.componentInstance.rows();
    const editableCard = rows[0]!.card!;
    fixture.componentRef.setInput("editableCardIds", new Set([editableCard.id]));

    const contextEvent = (x: number, y: number) =>
      ({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }) as unknown as MouseEvent;

    // Editable row: the menu anchors at the cursor.
    fixture.componentInstance.onRowContextMenu(rows[0]!, contextEvent(40, 60));
    expect(fixture.componentInstance.actionsCard()?.id).toBe(editableCard.id);
    expect(fixture.componentInstance.actionsPoint()).toEqual({ x: 40, y: 60 });
    fixture.componentInstance.closeActionsMenu();
    expect(fixture.componentInstance.actionsCard()).toBeNull();

    // A redacted row has no card to act on; a visible-but-uneditable row keeps the browser menu
    // rather than opening one whose every action the server would refuse.
    fixture.componentInstance.onRowContextMenu(rows[1]!, contextEvent(0, 0));
    expect(fixture.componentInstance.actionsCard()).toBeNull();
    fixture.componentInstance.onRowContextMenu(rows[2]!, contextEvent(0, 0));
    expect(fixture.componentInstance.actionsCard()).toBeNull();
  });

  it("shows Add card disabled — not hidden — when nothing is eligible, and no affordance to read-only viewers", () => {
    const withNothingEligible = setup();
    const emptyHost = withNothingEligible.nativeElement as HTMLElement;
    // Disabled beats hidden: the affordance must stay discoverable even when every visible card is
    // already queued.
    expect(emptyHost.querySelector<HTMLButtonElement>(".panel-add")?.disabled).toBe(true);
    expect(emptyHost.querySelector<HTMLButtonElement>(".panel-head-tool")?.disabled).toBe(true);

    TestBed.resetTestingModule();
    const readOnly = setup({ canReorder: false });
    const readOnlyHost = readOnly.nativeElement as HTMLElement;
    expect(readOnlyHost.querySelector(".panel-add-anchor")).toBeNull();
    expect(readOnlyHost.querySelector(".panel-head-tool")).toBeNull();
  });
});
