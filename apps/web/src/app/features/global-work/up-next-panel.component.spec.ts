import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WorkCard, WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it } from "vitest";
import { UpNextPanelComponent } from "./up-next-panel.component";

/**
 * Row behaviour — anchors, drags, removal, the inline Add card — belongs to the shared
 * `k-priority-queue` and is covered in `shared/priority-queue/priority-queue.component.spec.ts`.
 * What is left here is this dock's own chrome: the header, its "+" picker, and the error banner.
 */

function card(id: string, title: string): WorkCard {
  return {
    id,
    number: 1,
    key: "DEV-1",
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

function entry(id: string, rank: number): WorkPriorityItem {
  return {
    id,
    position: `${rank * 1000}.0000000000`,
    rank,
    card: card(`40000000-0000-4000-8000-00000000000${rank}`, `Ranked ${rank}`),
    context: { boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing", workspaceName: "Delivery" },
  };
}

const queue: WorkPrioritiesResponse = {
  targetUserId: "60000000-0000-4000-8000-000000000002",
  items: [entry("p1", 1), entry("p2", 2)],
  totalCount: 2,
  hiddenCount: 0,
  canReorder: true,
  reorderableWorkspaceIds: ["20000000-0000-4000-8000-000000000001"],
};

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

  it("renders the shared queue inside its own chrome", () => {
    const fixture = setup();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".panel-head h3")?.textContent).toContain("Up next");
    expect(host.querySelectorAll("k-priority-queue")).toHaveLength(1);
    expect(host.querySelectorAll(".panel-row")).toHaveLength(2);
  });

  it("names the queue's owner when curating somebody else", () => {
    const fixture = setup();
    expect((fixture.nativeElement as HTMLElement).querySelector(".panel-target")).toBeNull();
    fixture.componentRef.setInput("targetName", "Sam Okafor");
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector(".panel-target")?.textContent).toContain("Sam Okafor");
  });

  it("offers the header + to curators, disabled when nothing is eligible or the queue is full", () => {
    const fixture = setup();
    const host = fixture.nativeElement as HTMLElement;
    // Disabled beats hidden: the affordance stays discoverable when every visible card is queued.
    expect(host.querySelector<HTMLButtonElement>(".panel-head-tool")?.disabled).toBe(true);

    fixture.componentRef.setInput("addableCards", [
      { id: "c1", title: "Fix login", boardId: "b1", boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing" },
    ]);
    fixture.detectChanges();
    expect(host.querySelector<HTMLButtonElement>(".panel-head-tool")?.disabled).toBe(false);

    fixture.componentRef.setInput("priorities", { ...queue, totalCount: 50 });
    fixture.detectChanges();
    expect(host.querySelector<HTMLButtonElement>(".panel-head-tool")?.disabled).toBe(true);
  });

  it("appends the card picked from the header +, and closes the picker", () => {
    const fixture = setup();
    const added: object[] = [];
    fixture.componentInstance.added.subscribe((event) => added.push(event));
    fixture.componentInstance.headAddOpen.set(true);
    fixture.componentInstance.onHeadAddPicked("c2");
    // A pick appends; only a drop carries a positional anchor.
    expect(added).toEqual([{ cardId: "c2", beforeId: null }]);
    expect(fixture.componentInstance.headAddOpen()).toBe(false);
  });

  it("hides every curation affordance from a read-only viewer", () => {
    const fixture = setup({ canReorder: false });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".panel-head-tool")).toBeNull();
    expect(host.querySelector(".panel-add-anchor")).toBeNull();
  });

  it("shows the host's error banner and can be closed", () => {
    const fixture = setup();
    fixture.componentRef.setInput("error", "We couldn’t reorder that Up next card.");
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".panel-error")?.textContent).toContain("couldn’t reorder");

    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => (closed += 1));
    host.querySelector<HTMLButtonElement>(".panel-close")?.click();
    expect(closed).toBe(1);
  });
});
