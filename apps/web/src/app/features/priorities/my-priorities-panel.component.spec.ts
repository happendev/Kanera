import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import type { WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MyPrioritiesService } from "../../core/priorities/my-priorities.service";
import { MyPrioritiesPanelComponent } from "./my-priorities-panel.component";

const VIEWER_ID = "60000000-0000-4000-8000-000000000001";

function entry(id: string, rank: number): WorkPriorityItem {
  return {
    id,
    position: `${rank * 1000}.0000000000`,
    rank,
    card: {
      id: `card-${rank}`,
      number: rank,
      key: `WORK-${rank}`,
      organisationKey: "0123456789ABCDEF",
      boardId: `board-${rank}`,
      workspaceId: "20000000-0000-4000-8000-000000000001",
      listId: "list-1",
      title: `Ranked ${rank}`,
      position: "1000.0000000000",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    context: { boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing", workspaceName: "Delivery" },
  };
}

function queue(items = [entry("p1", 1), entry("p2", 2)]): WorkPrioritiesResponse {
  return {
    targetUserId: VIEWER_ID,
    items,
    totalCount: items.length,
    hiddenCount: 0,
    canReorder: true,
    reorderableWorkspaceIds: ["20000000-0000-4000-8000-000000000001"],
  };
}

/**
 * A hand-rolled service stub rather than the real one: this spec is about the drawer's chrome —
 * when it opens, what it shows in each state, and what it asks the service to do — not about the
 * queue mechanics, which `my-priorities.service.spec.ts` covers.
 */
function setup(options: { queue?: WorkPrioritiesResponse | null; online?: boolean; loading?: boolean; loadError?: string | null } = {}) {
  const queueSignal = signal<WorkPrioritiesResponse | null>(options.queue === undefined ? queue() : options.queue);
  const online = signal(options.online ?? true);
  const navigate = vi.fn(async () => true);
  const service = {
    queue: queueSignal,
    items: () => queueSignal()?.items ?? [],
    totalCount: () => queueSignal()?.totalCount ?? 0,
    loading: signal(options.loading ?? false),
    loadError: signal<string | null>(options.loadError ?? null),
    online,
    addableCards: signal<{ id: string }[]>([]),
    changedSinceSeen: signal(false),
    initialise: vi.fn(),
    refresh: vi.fn(async () => undefined),
    loadAddCandidates: vi.fn(async () => undefined),
    markSeen: vi.fn(),
    movePriority: vi.fn(async () => undefined),
    removePriority: vi.fn(async () => undefined),
    addPriority: vi.fn(async () => undefined),
    setCardCompleted: vi.fn(async () => undefined),
    cardBrowserUrl: (cardId: string) => `/o/0123456789ABCDEF/c/WORK-${cardId.slice(-1)}`,
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: MyPrioritiesService, useValue: service },
      // RouterLink only needs enough Router/ActivatedRoute to build the hrefs in the empty states.
      { provide: Router, useValue: { navigate, createUrlTree: () => ({}), serializeUrl: () => "/my-cards", events: { subscribe: () => ({ unsubscribe() {} }) } } },
      { provide: ActivatedRoute, useValue: {} },
    ],
  });
  const fixture = TestBed.createComponent(MyPrioritiesPanelComponent);
  fixture.detectChanges();
  return { fixture, service, navigate, online, queueSignal };
}

const host = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;

describe("MyPrioritiesPanelComponent", () => {
  beforeEach(() => TestBed.resetTestingModule());

  it("initialises the shell-wide queue once, from the trigger's own mount", () => {
    const f = setup();
    // The drawer is the shell's single mount point for the queue, so this is where it starts
    // listening — not on a page that may never be opened.
    expect(f.service.initialise).toHaveBeenCalledTimes(1);
  });

  it("shows the count on the trigger and hides the badge at zero", () => {
    const f = setup();
    expect(host(f.fixture).querySelector(".queue-badge")?.textContent?.trim()).toBe("2");

    f.queueSignal.set(queue([]));
    f.fixture.detectChanges();
    expect(host(f.fixture).querySelector(".queue-badge")).toBeNull();
  });

  it("accents the trigger only while the queue has changed unseen", () => {
    const f = setup();
    const button = () => host(f.fixture).querySelector<HTMLButtonElement>(".queue-btn")!;
    expect(button().classList.contains("has-changes")).toBe(false);

    f.service.changedSinceSeen.set(true);
    f.fixture.detectChanges();
    expect(button().classList.contains("has-changes")).toBe(true);
  });

  it("opens on the trigger, loads the queue and its candidate pool, and marks it seen", async () => {
    const f = setup();
    host(f.fixture).querySelector<HTMLButtonElement>(".queue-btn")!.click();
    f.fixture.detectChanges();

    expect(f.fixture.componentInstance.open()).toBe(true);
    expect(f.service.refresh).toHaveBeenCalled();
    // Two requests nobody who never opens the drawer should pay for.
    expect(f.service.loadAddCandidates).toHaveBeenCalled();
    await f.fixture.whenStable();
    expect(f.service.markSeen).toHaveBeenCalled();
    expect(host(f.fixture).querySelectorAll(".panel-row")).toHaveLength(2);
  });

  it("closes on escape and on the backdrop", () => {
    const f = setup();
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();

    f.fixture.componentInstance.onEscape();
    expect(f.fixture.componentInstance.closing()).toBe(true);
  });

  it("shows an offline state instead of a stale order", () => {
    const f = setup({ online: false });
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();

    const state = host(f.fixture).querySelector(".drawer-state");
    expect(state?.textContent).toContain("offline");
    // Rows are withheld entirely — this is the whole reason the queue is never cached.
    expect(host(f.fixture).querySelector(".panel-row")).toBeNull();
  });

  it("offers a retry when the load failed", () => {
    const f = setup({ queue: null, loadError: "Couldn't load Up next. Try again in a moment." });
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();

    host(f.fixture).querySelector<HTMLButtonElement>(".state-action")!.click();
    expect(f.service.refresh).toHaveBeenCalledTimes(2);
  });

  it("shows a skeleton for the very first load, not an empty state", () => {
    const f = setup({ queue: null, loading: true });
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();

    expect(host(f.fixture).querySelectorAll(".skeleton-row").length).toBeGreaterThan(0);
    expect(host(f.fixture).querySelector(".drawer-state")).toBeNull();
  });

  it("teaches the gesture when there is work to queue, and stays quiet when there is not", () => {
    const f = setup({ queue: queue([]) });
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();
    expect(host(f.fixture).querySelector(".drawer-state")?.textContent).toContain("Nothing in Up next");
    expect(host(f.fixture).querySelector(".state-actions")).toBeNull();

    f.service.addableCards.set([{ id: "card-9" }]);
    f.fixture.detectChanges();
    expect(host(f.fixture).querySelector(".state-actions")).not.toBeNull();
  });

  it("opens a card with its shareable URL and closes the drawer", () => {
    const f = setup();
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();

    f.fixture.componentInstance.openCard({ cardId: "card-1", boardId: "board-1", event: new MouseEvent("click") });
    expect(f.navigate).toHaveBeenCalledWith(["/b", "board-1", "c", "card-1"], {
      browserUrl: "/o/0123456789ABCDEF/c/WORK-1",
    });
    expect(f.fixture.componentInstance.closing()).toBe(true);
  });

  it("keeps middle-click meaning new tab, without leaving the drawer", () => {
    const f = setup();
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      f.fixture.componentInstance.openCard({
        cardId: "card-1",
        boardId: "board-1",
        event: new MouseEvent("auxclick", { button: 1 }),
      });
      expect(open).toHaveBeenCalledWith("/o/0123456789ABCDEF/c/WORK-1", "_blank", "noopener");
      expect(f.navigate).not.toHaveBeenCalled();
      expect(f.fixture.componentInstance.closing()).toBe(false);
    } finally {
      open.mockRestore();
    }
  });

  it("surfaces a failed gesture in the drawer rather than silently reverting", async () => {
    const f = setup();
    f.service.movePriority.mockRejectedValueOnce(new Error("offline"));
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();

    f.fixture.componentInstance.onReordered({ priorityId: "p1", beforeId: null });
    await vi.waitFor(() => expect(f.fixture.componentInstance.actionError()).toContain("couldn’t reorder"));
  });
});
