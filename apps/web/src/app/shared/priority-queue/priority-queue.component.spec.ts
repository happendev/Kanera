import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { CdkDragDrop } from "@angular/cdk/drag-drop";
import type { WorkCard, WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it } from "vitest";
import type { PriorityAddableCard } from "./priority-add-cards";
import { PriorityQueueComponent, type PriorityReorder } from "./priority-queue.component";

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
      ? { boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing", listIcon: null, listColor: null, workspaceName: "Delivery", labels: [] }
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

/** A candidate for the Add card picker. Due date and key are what the rows now render. */
function addable(
  id: string,
  title: string,
  where: { boardId: string; boardName: string; listId: string; listName: string },
  due: { dueDateLocalDate?: string | null; dueDateSlot?: null } = {},
): PriorityAddableCard {
  return {
    id,
    title,
    key: `DEV-${id}`,
    boardIcon: null,
    boardIconColor: null,
    listIcon: null,
    listColor: null,
    dueDateLocalDate: due.dueDateLocalDate ?? null,
    dueDateSlot: null,
    dueDateTimezone: "UTC",
    ...where,
  };
}

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
  const fixture = TestBed.createComponent(PriorityQueueComponent);
  fixture.componentRef.setInput("priorities", { ...queue, ...overrides });
  fixture.componentRef.setInput("canDrag", true);
  fixture.detectChanges();
  return fixture;
}

describe("PriorityQueueComponent", () => {
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

  it("removes via the row tool and via dragging a row out of the surface", () => {
    const fixture = setup();
    const removed: { priorityId: string }[] = [];
    const reordered: PriorityReorder[] = [];
    fixture.componentInstance.removed.subscribe((event) => removed.push(event));
    fixture.componentInstance.reordered.subscribe((event) => reordered.push(event));

    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>(".row-remove")?.click();
    expect(removed).toEqual([{ priorityId: "p1" }]);

    // A row released outside the surface is the same removal, not a reorder — even when CDK reports
    // an in-list index shift from where the pointer last hovered.
    fixture.componentInstance.onDrop(drop(2, 0, { releasedInside: false }));
    expect(removed).toEqual([{ priorityId: "p1" }, { priorityId: "p3" }]);
    expect(reordered).toEqual([]);
  });

  it("marks the preview outside the surface and zeroes its return transition on release", () => {
    const fixture = setup();
    const preview = document.createElement("div");
    preview.className = "panel-row cdk-drag-preview";
    // Scoped per instance: the drawer can be open over the dock, and each must only ever touch its
    // own preview clone.
    preview.dataset["queue"] = "up-next-drop";
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

  it("leaves another mounted surface's drag preview alone", () => {
    const fixture = setup();
    const foreign = document.createElement("div");
    foreign.className = "panel-row cdk-drag-preview";
    foreign.dataset["queue"] = "my-priorities-drawer-drop";
    document.body.appendChild(foreign);
    try {
      fixture.componentInstance.onDragMoved({ pointerPosition: { x: -50, y: -50 } } as never);
      expect(foreign.classList.contains("drag-outside")).toBe(false);
    } finally {
      foreign.remove();
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
    // The note takes the inline slot the add button normally holds: a full queue cannot grow.
    expect(host.querySelector(".panel-add")).toBeNull();
    // The drag hint stays: dragging a row out is exactly how a slot gets freed.
    expect(host.querySelector(".panel-drag-hint")?.textContent).toContain("drag a row out");
  });

  it("offers Add card to curators, sectioned board › list, and emits the pick", () => {
    const fixture = setup();
    fixture.componentRef.setInput("addableCards", [
      addable("c1", "Fix login", { boardId: "b1", boardName: "Roadmap", listId: "l1", listName: "Doing" }),
      addable("c2", "Ship exports", { boardId: "b2", boardName: "Delivery", listId: "l2", listName: "Todo" }),
      addable("c3", "Fix signup", { boardId: "b1", boardName: "Roadmap", listId: "l2", listName: "Todo" }),
    ]);
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".panel-add");
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);

    // The list is the section heading and the board is its parent, stated once per board. Both of
    // Roadmap's lists stay together even though the input interleaves a Delivery card between them.
    const groups = fixture.componentInstance.addGroups();
    expect(groups.map((group) => group.label)).toEqual(["Doing", "Todo", "Todo"]);
    expect(groups.map((group) => group.parent?.label)).toEqual(["Roadmap", "Roadmap", "Delivery"]);
    expect(groups[1]?.options.map((option) => option.id)).toEqual(["c3"]);
    // No per-row list hint any more — that repetition is what the sectioning replaced.
    expect(groups[0]?.options[0]?.hint ?? null).toBeNull();

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
    fixture.componentRef.setInput("acceptExternalCardDrops", true);
    const tile = {
      kind: "card",
      card: card("70000000-0000-4000-8000-000000000001", "Dragged in"),
    };
    fixture.componentRef.setInput("addableCards", [
      addable(tile.card.id, tile.card.title, { boardId: tile.card.boardId, boardName: "Roadmap", listId: "l1", listName: "Doing" }),
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

  it("refuses foreign tiles on surfaces that are not board drop targets", () => {
    const fixture = setup();
    fixture.componentRef.setInput("addableCards", [
      addable("c1", "Fix login", { boardId: "b1", boardName: "Roadmap", listId: "l1", listName: "Doing" }),
    ]);
    fixture.detectChanges();
    // The drawer and Home render the same rows but sit nowhere near a board's lanes; accepting a
    // tile there would mean accepting a drag that has no way to have started.
    expect(fixture.componentInstance.canEnterFromBoard({ data: { kind: "card", card: card("c1", "Fix login") } } as never)).toBe(false);
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
    expect(fixture.componentInstance.actionsMenu()[0]?.card.id).toBe(editableCard.id);
    expect(fixture.componentInstance.actionsMenu()[0]?.point).toEqual({ x: 40, y: 60 });
    fixture.componentInstance.closeActionsMenu();
    expect(fixture.componentInstance.actionsMenu()).toEqual([]);

    // A redacted row has no card to act on; a visible-but-uneditable row keeps the browser menu
    // rather than opening one whose every action the server would refuse.
    fixture.componentInstance.onRowContextMenu(rows[1]!, contextEvent(0, 0));
    expect(fixture.componentInstance.actionsMenu()).toEqual([]);
    fixture.componentInstance.onRowContextMenu(rows[2]!, contextEvent(0, 0));
    expect(fixture.componentInstance.actionsMenu()).toEqual([]);
  });

  // The drawer and Home read a queue response that carries no board role, so they have nothing to
  // gate with. An empty default set used to read as "nothing is editable" and cost them the menu.
  it("offers the actions menu on every visible row when the host has no role information", () => {
    const fixture = setup();
    const rows = fixture.componentInstance.rows();
    const contextEvent = () =>
      ({ clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} }) as unknown as MouseEvent;

    fixture.componentInstance.onRowContextMenu(rows[0]!, contextEvent());
    expect(fixture.componentInstance.actionsMenu()[0]?.card.id).toBe(rows[0]!.card!.id);

    fixture.componentInstance.onRowContextMenu(rows[2]!, contextEvent());
    expect(fixture.componentInstance.actionsMenu()[0]?.card.id).toBe(rows[2]!.card!.id);

    // A redacted row still has nothing to act on.
    fixture.componentInstance.onRowContextMenu(rows[1]!, contextEvent());
    expect(fixture.componentInstance.actionsMenu()[0]?.card.id).toBe(rows[2]!.card!.id);
  });

  // The stack dismisses the open menu from a capture-phase contextmenu listener, before the row
  // handler that opens the next one. Both land in one tick, so the view must be keyed by the
  // opening — a reused instance is left unregistered and `visibility: hidden`.
  it("rebuilds the actions menu view on every right-click, including the same row twice", async () => {
    const fixture = setup();
    const rows = fixture.componentInstance.rows();
    fixture.componentRef.setInput("editableCardIds", new Set(rows.flatMap((row) => (row.card ? [row.card.id] : []))));
    const contextEvent = () =>
      ({ clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} }) as unknown as MouseEvent;

    fixture.componentInstance.onRowContextMenu(rows[0]!, contextEvent());
    const first = fixture.componentInstance.actionsMenu()[0]!.token;

    fixture.componentInstance.onRowContextMenu(rows[2]!, contextEvent());
    expect(fixture.componentInstance.actionsMenu()[0]!.token).not.toBe(first);

    const second = fixture.componentInstance.actionsMenu()[0]!.token;
    fixture.componentInstance.onRowContextMenu(rows[2]!, contextEvent());
    expect(fixture.componentInstance.actionsMenu()[0]!.token).not.toBe(second);
  });

  it("shows Add card disabled — not hidden — when nothing is eligible, and none to read-only viewers", () => {
    const withNothingEligible = setup();
    const emptyHost = withNothingEligible.nativeElement as HTMLElement;
    // Disabled beats hidden: the affordance must stay discoverable even when every visible card is
    // already queued.
    expect(emptyHost.querySelector<HTMLButtonElement>(".panel-add")?.disabled).toBe(true);

    TestBed.resetTestingModule();
    const readOnly = setup({ canReorder: false });
    expect((readOnly.nativeElement as HTMLElement).querySelector(".panel-add-anchor")).toBeNull();
  });

  it("truncates to visibleLimit as a prefix, keeping drop indices and ranks honest", () => {
    const fixture = setup();
    fixture.componentRef.setInput("visibleLimit", 2);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll(".panel-row")).toHaveLength(2);
    // "1 more" — the block must say what it is not showing, or #1–#2 reads as the whole queue.
    expect(host.querySelector(".panel-more")?.textContent).toContain("1 more");

    // Anchors are still computed over the full queue, so a step down off the visible tail lands
    // exactly where the untruncated surface would put it.
    const emitted: PriorityReorder[] = [];
    fixture.componentInstance.reordered.subscribe((event) => emitted.push(event));
    fixture.componentInstance.moveBy(queue.items[0]!, 1);
    expect(emitted[0]).toEqual({ priorityId: "p1", beforeId: "p3" });
  });

  // Also the regression test for the injector: `k-card-labels` injects the *root* display service,
  // not the route-scoped BoardMenuCoordinator, which the shell drawer cannot provide. Every existing
  // case in this file has label-free fixtures, so `@if` never instantiates the chips and none of
  // them would have caught a NullInjectorError here.
  it("renders the server-resolved labels a row carries, capped with an overflow chip", () => {
    const labelled = entry("p1", 1, true);
    labelled.context!.labels = [
      { id: "l1", name: "Bug", color: "rose" },
      { id: "l2", name: "Backend", color: null },
      { id: "l3", name: "Chore", color: "teal" },
      { id: "l4", name: "Spillover", color: "blue" },
    ];
    const fixture = setup({ items: [labelled, entry("p3", 2, true)] });
    const host = fixture.nativeElement as HTMLElement;

    const chips = [...host.querySelectorAll<HTMLElement>(".row-labels .label-chip")];
    expect(chips.slice(0, 3).map((chip) => chip.textContent?.trim())).toEqual(["Bug", "Backend", "Chore"]);
    // Capped at three named chips; the rest are summarised rather than pushing the trail off the row.
    expect(chips.at(-1)?.classList.contains("is-overflow")).toBe(true);
    expect(chips.at(-1)?.textContent?.trim()).toBe("+1");

    // `.row-main` is a <button>, so the chips must stay presentational — an interactive chip renders
    // role="button" and would be interactive content nested inside it.
    expect(host.querySelector(".row-labels .label-chip[role=\"button\"]")).toBeNull();

    // A row without labels renders no bar at all, rather than an empty box under the trail.
    expect(host.querySelectorAll(".row-labels")).toHaveLength(1);
    // Its own row under the board › list line, never inside it: sharing that line is what clipped a
    // chip down to a sliver.
    expect(host.querySelector(".row-context .row-labels")).toBeNull();
    expect(host.querySelector(".row-main > .row-labels")).not.toBeNull();
  });

  // "Which list" is the queued card's state, and the row's whole reason for a second line. It has to
  // arrive from the server's `context` — Home mounts this component with no work catalog to resolve a
  // list id against — and it has to survive a list with no colour of its own.
  it("names the list in its own icon and colour, and stays neutral without one", () => {
    const coloured = entry("p1", 1, true);
    coloured.context!.listName = "Review & Approval";
    coloured.context!.listIcon = "eye-check";
    coloured.context!.listColor = "violet";
    const fixture = setup({ items: [coloured, entry("p3", 2, true)] });
    const host = fixture.nativeElement as HTMLElement;

    const lists = [...host.querySelectorAll<HTMLElement>(".row-list")];
    expect(lists[0]?.textContent?.trim()).toBe("Review & Approval");
    expect(lists[0]?.querySelector("i")?.className).toBe("ti ti-eye-check");
    // Icon and name both take the colour, the way the notifications breadcrumb renders a list.
    expect(lists[0]?.querySelector<HTMLElement>("i")?.style.color).toBe("var(--color-violet)");
    expect(lists[0]?.querySelector<HTMLElement>(".row-context-part")?.style.color).toBe("var(--color-violet)");

    // No colour set: nothing is written, so the line's inherited muted colour applies rather than a
    // literal grey the theme cannot follow.
    expect(lists[1]?.querySelector<HTMLElement>("i")?.style.color).toBe("");
    expect(lists[1]?.querySelector("i")?.className).toBe("ti ti-list");

    // Board › list, so the hierarchy is explicit; the separator only exists between the two.
    expect(host.querySelector(".row-board")?.textContent?.trim()).toBe("Roadmap");
    expect(host.querySelectorAll(".row-sep-chevron")).toHaveLength(2);
  });

  it("shows a completed row as done, and drops its due pressure with it", () => {
    const overdue = entry("p1", 1, true);
    overdue.card!.dueDateLocalDate = "2020-01-01";
    const fixture = setup({ items: [overdue] });
    const host = fixture.nativeElement as HTMLElement;
    // Before completion: an ordinary overdue row.
    expect(host.querySelector(".panel-row")?.classList.contains("is-completed")).toBe(false);
    expect(host.querySelector(".row-due")?.classList.contains("overdue")).toBe(true);

    const completed = entry("p1", 1, true);
    completed.card!.dueDateLocalDate = "2020-01-01";
    completed.card!.completedAt = new Date("2026-08-09T10:00:00.000Z");
    fixture.componentRef.setInput("priorities", { ...queue, items: [completed], totalCount: 1, hiddenCount: 0 });
    fixture.detectChanges();

    // The quick-complete gesture must show *something*: without this the row sat unchanged for the
    // round trip and then abruptly vanished, which reads as a bug.
    expect(host.querySelector(".panel-row")?.classList.contains("is-completed")).toBe(true);
    expect(host.querySelector(".row-title .row-complete-icon")).not.toBeNull();
    // A done card carries no due pressure, so the angry red chip goes with it.
    expect(host.querySelector(".row-due")?.classList.contains("overdue")).toBe(false);
    expect(fixture.componentInstance.dueOverdue(fixture.componentInstance.rows()[0]!.card!)).toBe(false);
  });

  it("offers quick-complete only where the host enables it", () => {
    const fixture = setup();
    expect((fixture.nativeElement as HTMLElement).querySelector(".row-complete")).toBeNull();

    fixture.componentRef.setInput("allowQuickComplete", true);
    fixture.detectChanges();
    const completed: object[] = [];
    fixture.componentInstance.completed.subscribe((event) => completed.push(event));
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".row-complete")?.click();
    expect(completed).toEqual([{ cardId: queue.items[0]!.card!.id, completed: true }]);
  });
});
