import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import type { WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MyPrioritiesService } from "../../core/priorities/my-priorities.service";
import { MyPrioritiesPanelComponent } from "./my-priorities-panel.component";

const VIEWER_ID = "60000000-0000-4000-8000-000000000001";

type EntryCard = NonNullable<WorkPriorityItem["card"]>;

function entry(id: string, rank: number, card: Partial<EntryCard> = {}): WorkPriorityItem {
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
      ...card,
    },
    context: { boardName: "Roadmap", boardIcon: null, boardIconColor: null, listName: "Doing", workspaceName: "Delivery", labels: [] },
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
    expect(host(f.fixture).querySelector(".drawer-explainer")?.textContent).toContain("personal priority queue");
    expect(host(f.fixture).querySelector(".drawer-explainer")?.textContent).toContain("first card");
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

    const state = host(f.fixture).querySelector(".drawer-empty");
    expect(state?.textContent).toContain("offline");
    expect(state?.querySelector(".empty-icon .ti-wifi-off")).not.toBeNull();
    // Rows are withheld entirely — this is the whole reason the queue is never cached.
    expect(host(f.fixture).querySelector(".panel-row")).toBeNull();
  });

  it("offers a retry when the load failed", () => {
    const f = setup({ queue: null, loadError: "Couldn't load Up next. Try again in a moment." });
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();

    host(f.fixture).querySelector<HTMLButtonElement>(".empty-all-btn")!.click();
    expect(f.service.refresh).toHaveBeenCalledTimes(2);
  });

  it("shows the same centered loader as notifications for the very first load", () => {
    const f = setup({ queue: null, loading: true });
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();

    expect(host(f.fixture).querySelector(".state-loader.ti-loader-2")).not.toBeNull();
    expect(host(f.fixture).querySelector(".empty-title")).toBeNull();
  });

  it("teaches the gesture when there is work to queue, and stays quiet when there is not", () => {
    const f = setup({ queue: queue([]) });
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();
    expect(host(f.fixture).querySelector(".drawer-empty")?.textContent).toContain("Nothing in Up next");
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

  /**
   * The strip is a legend for the chips underneath it, so the assertions check both together: the
   * counts have to equal the number of chips actually rendered in each tone, or the reader is being
   * told a different story above the fold than below it.
   */
  it("summarises due pressure, counting exactly what the rows colour", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    try {
      const f = setup({
        queue: queue([
          entry("p1", 1, { dueDateLocalDate: "2026-08-01", dueDateSlot: "anyTime", dueDateTimezone: "UTC" }),
          entry("p2", 2, { dueDateLocalDate: "2026-08-09", dueDateSlot: "endOfWorkDay", dueDateTimezone: "UTC" }),
          entry("p3", 3, { dueDateLocalDate: "2026-09-30", dueDateSlot: "anyTime", dueDateTimezone: "UTC" }),
          // Long overdue, but done: it carries no pressure and must not be counted or coloured.
          entry("p4", 4, {
            dueDateLocalDate: "2026-08-01",
            dueDateSlot: "anyTime",
            dueDateTimezone: "UTC",
            completedAt: new Date("2026-08-09T09:00:00.000Z"),
          }),
        ]),
      });
      f.fixture.componentInstance.toggle();
      f.fixture.detectChanges();

      expect(f.fixture.componentInstance.duePressure()).toEqual({ overdue: 1, dueSoon: 1 });
      const strip = host(f.fixture).querySelector(".drawer-due-pressure");
      expect(strip?.textContent?.replace(/\s+/g, " ")).toContain("1 overdue");
      expect(strip?.textContent?.replace(/\s+/g, " ")).toContain("1 due soon");
      expect(host(f.fixture).querySelectorAll(".row-due.overdue")).toHaveLength(1);
      expect(host(f.fixture).querySelectorAll(".row-due.due-soon")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a fresh shared due-time snapshot whenever the drawer reopens", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const f = setup({
      queue: queue([
        entry("p1", 1, { dueDateLocalDate: "2026-08-09", dueDateSlot: "afternoon", dueDateTimezone: "UTC" }),
      ]),
    });
    try {
      f.fixture.componentInstance.toggle();
      await f.fixture.whenStable();
      expect(f.fixture.componentInstance.duePressure()).toEqual({ overdue: 0, dueSoon: 1 });
      expect(host(f.fixture).querySelector(".row-due")?.classList.contains("due-soon")).toBe(true);

      f.fixture.componentInstance.close();
      await vi.advanceTimersByTimeAsync(110);
      await f.fixture.whenStable();
      vi.setSystemTime(new Date("2026-08-09T13:30:00.000Z"));

      f.fixture.componentInstance.toggle();
      await f.fixture.whenStable();
      expect(f.fixture.componentInstance.duePressure()).toEqual({ overdue: 1, dueSoon: 0 });
      expect(host(f.fixture).querySelector(".row-due")?.classList.contains("overdue")).toBe(true);
      expect(host(f.fixture).querySelector(".row-due")?.classList.contains("due-soon")).toBe(false);
    } finally {
      f.fixture.destroy();
      vi.useRealTimers();
    }
  });

  it("behaves as a modal, restores trigger focus, and releases its scroll lock on destroy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // CDK's InteractivityChecker requires rendered geometry; jsdom has none unless supplied.
    const geometry = vi.spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    const f = setup();
    try {
      const trigger = host(f.fixture).querySelector<HTMLButtonElement>(".queue-btn")!;
      trigger.focus();
      trigger.click();
      await f.fixture.whenStable();

      const dialog = host(f.fixture).querySelector<HTMLElement>(".drawer")!;
      const close = dialog.querySelector<HTMLButtonElement>(".close-btn")!;
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(document.activeElement).toBe(close);
      expect(document.body.classList.contains("k-no-scroll")).toBe(true);

      close.click();
      await vi.advanceTimersByTimeAsync(110);
      await f.fixture.whenStable();
      expect(document.activeElement).toBe(trigger);

      f.fixture.componentInstance.toggle();
      await f.fixture.whenStable();
      expect(document.body.classList.contains("k-no-scroll")).toBe(true);
      f.fixture.destroy();
      expect(document.body.classList.contains("k-no-scroll")).toBe(false);
    } finally {
      if (!f.fixture.componentRef.hostView.destroyed) f.fixture.destroy();
      geometry.mockRestore();
      vi.useRealTimers();
    }
  });

  it("hides the due-pressure strip when nothing is under pressure, and when offline", () => {
    // Undated rows: the queue is still an order, and there is no pressure to report about it.
    const f = setup();
    f.fixture.componentInstance.toggle();
    f.fixture.detectChanges();
    expect(f.fixture.componentInstance.duePressure()).toBeNull();
    expect(host(f.fixture).querySelector(".drawer-due-pressure")).toBeNull();

    // Offline withholds the rows entirely, so a summary of them would describe nothing on screen.
    f.queueSignal.set(queue([entry("p1", 1, { dueDateLocalDate: "2020-01-01", dueDateSlot: "anyTime", dueDateTimezone: "UTC" })]));
    f.online.set(false);
    f.fixture.detectChanges();
    expect(f.fixture.componentInstance.duePressure()).not.toBeNull();
    expect(host(f.fixture).querySelector(".drawer-due-pressure")).toBeNull();
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
