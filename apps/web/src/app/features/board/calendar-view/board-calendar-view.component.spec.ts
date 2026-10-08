import { createComponentFixture } from "../../../../test/component-fixture";
import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireBoardMemberUser, WireCardSummary } from "@kanera/shared/events";
import { describe, expect, it, vi } from "vitest";
import type { CdkDragDrop } from "@angular/cdk/drag-drop";
import { ApiClient } from "../../../core/api/api.client";
import { TABLE_CARD_STORE, type TableCardStore } from "../table-view/table-card-store";
import { BoardMenuCoordinator } from "../board-menu-coordinator.service";
import { BoardCalendarViewComponent, calendarLayoutForWidth } from "./board-calendar-view.component";

function card(overrides: Partial<WireCardSummary> = {}): WireCardSummary {
  return {
    id: "card-1",
    workspaceId: "workspace-1",
    number: 1,
    key: "WORK-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Ship calendar",
    position: "1000.0000000000",
    dueDateLocalDate: "2026-05-20",
    dueDateSlot: "anyTime",
    dueDateTimezone: "UTC",
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
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
    ...overrides,
    organisationKey: overrides.organisationKey ?? "0123456789ABCDEF",
  };
}

function member(overrides: Partial<WireBoardMemberUser> = {}): WireBoardMemberUser {
  return {
    userId: "user-1",
    displayName: "Ada Lovelace",
    avatarUrl: null,
    role: "editor",
    source: "workspace",
    ...overrides,
  };
}

describe("BoardCalendarViewComponent", () => {
  async function create(cards = [card()]) {
    await TestBed.configureTestingModule({
      imports: [BoardCalendarViewComponent],
      providers: [provideZonelessChangeDetection(), BoardMenuCoordinator],
    }).compileComponents();
    const fixture = createComponentFixture(BoardCalendarViewComponent);
    fixture.componentRef.setInput("cards", cards);
    fixture.componentInstance.anchorDate.set(new Date(2026, 4, 15));
    fixture.detectChanges();
    return fixture;
  }

  it("groups dated cards into month cells and hides undated cards", async () => {
    const fixture = await create([
      card({ id: "dated", dueDateLocalDate: "2026-05-20" }),
      card({ id: "undated", dueDateLocalDate: null }),
    ]);

    const days = fixture.componentInstance.days();
    expect(days.find((day) => day.key === "2026-05-20")?.cards.map((c) => c.id)).toEqual(["dated"]);
    expect(days.flatMap((day) => day.cards).map((c) => c.id)).not.toContain("undated");
    // Monday-first: May 2026 opens on Friday, so the grid starts on Mon 27 Apr and, because 31 May
    // is itself a Sunday, needs no trailing week.
    expect(days[0].key).toBe("2026-04-27");
    expect(days.at(-1)?.key).toBe("2026-05-31");
  });

  it("boxes the weekday header and grid in a month panel inside the scroll viewport", async () => {
    const fixture = await create();

    const host = fixture.nativeElement as HTMLElement;
    const viewport = host.querySelector(".calendar-scroll");
    expect(viewport).toBeTruthy();
    const panel = viewport?.querySelector(":scope > .calendar-month");
    expect(panel).toBeTruthy();
    expect(panel?.querySelector(".calendar-month-body > .calendar-weekdays")).toBeTruthy();
    expect(panel?.querySelector(".calendar-month-body > .calendar-grid")).toBeTruthy();
    // The paged view is named by its toolbar, so the panel does not repeat the month.
    expect(panel?.querySelector(".calendar-month-header")).toBeNull();

    fixture.componentRef.setInput("loading", true);
    fixture.detectChanges();
    expect(viewport?.querySelector(".calendar-grid .skeleton-day")).toBeTruthy();
  });

  it("picks the layout from the calendar's own width", () => {
    // Unmeasured (0) keeps the full grid rather than guessing a phone layout.
    expect(calendarLayoutForWidth(0)).toBe("full");
    expect(calendarLayoutForWidth(390)).toBe("phone");
    expect(calendarLayoutForWidth(559)).toBe("phone");
    expect(calendarLayoutForWidth(560)).toBe("compact");
    expect(calendarLayoutForWidth(768)).toBe("compact");
    expect(calendarLayoutForWidth(1200)).toBe("full");
  });

  it("caps a compact month cell behind +N more and opens it in place", async () => {
    const fixture = await create(Array.from({ length: 5 }, (_, i) => card({ id: `c${i}`, title: `Card ${i}`, position: `${i + 1}` })));
    fixture.componentInstance.layout.set("compact");
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    // Two tiles plus the "+3 more" row fill the three-slot cap.
    expect(host.querySelectorAll(".calendar-day .cal-card").length).toBe(2);
    const more = host.querySelector<HTMLButtonElement>(".calendar-day .cal-more");
    expect(more?.textContent?.trim()).toBe("+3 more");
    // A compact column shows the bare number, not "20 May".
    expect(host.querySelector(".calendar-day .calendar-day-number")?.textContent?.trim()).toBe("20");

    more?.click();
    fixture.detectChanges();
    expect(host.querySelectorAll(".calendar-day .cal-card").length).toBe(5);
    expect(host.querySelector(".calendar-day .cal-more")?.textContent?.trim()).toBe("Show less");

    // A week row has the pane's height to grow into, so it never caps.
    fixture.componentInstance.toggleDayExpanded("2026-05-20");
    fixture.componentInstance.setMode("week");
    fixture.componentInstance.anchorDate.set(new Date(2026, 4, 20));
    fixture.detectChanges();
    expect(host.querySelectorAll(".calendar-day .cal-card").length).toBe(5);
    expect(host.querySelector(".cal-more")).toBeNull();
  });

  it("lists the chosen day's cards under a month of day numbers on a phone", async () => {
    const fixture = await create([
      card({ id: "a", title: "First", dueDateLocalDate: "2026-05-20" }),
      card({ id: "b", title: "Second", dueDateLocalDate: "2026-05-22" }),
    ]);
    fixture.componentInstance.layout.set("phone");
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".calendar-grid")).toBeNull();
    expect(host.querySelectorAll(".cal-mini-day").length).toBe(35);
    // Today is outside May 2026, so the month opens on its first day with something due.
    expect(host.querySelector(".cal-mini-day.is-selected .cal-mini-number")?.textContent?.trim()).toBe("20");
    expect([...host.querySelectorAll(".cal-agenda .cal-card-title")].map((el) => el.textContent?.trim())).toEqual(["First"]);

    // Accessible dates follow the viewer's locale; choose the day by its visible number instead
    // of requiring day-before-month wording from the machine running the tests.
    const may22 = [...host.querySelectorAll<HTMLButtonElement>(".cal-mini-day")]
      .find((el) => el.querySelector(".cal-mini-number")?.textContent?.trim() === "22" && !el.classList.contains("is-muted"));
    expect(may22?.querySelectorAll(".cal-mini-dot").length).toBe(1);
    may22?.click();
    fixture.detectChanges();
    expect([...host.querySelectorAll(".cal-agenda .cal-card-title")].map((el) => el.textContent?.trim())).toEqual(["Second"]);
  });

  it("stacks a phone week as seven days with empty days reduced to their heading", async () => {
    const fixture = await create([card({ id: "a", dueDateLocalDate: "2026-05-20" })]);
    fixture.componentInstance.layout.set("phone");
    fixture.componentInstance.setMode("week");
    fixture.componentInstance.anchorDate.set(new Date(2026, 4, 20));
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const days = [...host.querySelectorAll(".cal-agenda-day")];
    expect(days.length).toBe(7);
    expect(days.filter((day) => day.classList.contains("is-empty")).length).toBe(6);
    expect(days[2]?.querySelectorAll(".cal-card").length).toBe(1);
  });

  it("lists only days with cards in the stacked phone agenda", async () => {
    const fixture = await create([
      card({ id: "july", dueDateLocalDate: "2026-07-15" }),
      card({ id: "september", dueDateLocalDate: "2026-09-02" }),
    ]);
    fixture.componentRef.setInput("navigation", "stacked");
    fixture.componentInstance.layout.set("phone");
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll(".calendar-month-header h3").length).toBe(2);
    expect(host.querySelectorAll(".cal-agenda-day").length).toBe(2);
    expect(host.querySelector(".cal-agenda-day.is-empty")).toBeNull();
  });

  it("renders empty days as slots and keeps neighbouring-month cards in the paged view", async () => {
    const fixture = await create([
      card({ id: "in-month", dueDateLocalDate: "2026-05-20" }),
      card({ id: "last-month", dueDateLocalDate: "2026-04-28" }),
    ]);

    const days = fixture.componentInstance.days();
    // Cards outside the anchor month stay visible but dimmed: no other grid on screen shows them.
    const neighbour = days.find((day) => day.key === "2026-04-28");
    expect(neighbour?.inMonth).toBe(false);
    expect(neighbour?.cards.map((c) => c.id)).toEqual(["last-month"]);
    expect(days.every((day) => !day.isPadding)).toBe(true);

    const host = fixture.nativeElement as HTMLElement;
    // Every cell of the month is rendered; two hold cards, the rest are empty slots holding columns.
    expect(host.querySelectorAll(".calendar-grid > .calendar-day").length).toBe(2);
    expect(host.querySelectorAll(".calendar-grid > .calendar-slot-empty").length).toBe(days.length - 2);
    // Headings are short because a column is a seventh of the grid; the full date is the tooltip.
    const headings = [...host.querySelectorAll(".calendar-day > header > span")].map((el) => el.textContent?.trim());
    expect(headings).toEqual([
      fixture.componentInstance.dayLabel("2026-04-28"),
      fixture.componentInstance.dayLabel("2026-05-20"),
    ]);
  });

  it("stacks one padded month per due date in stacked navigation", async () => {
    const fixture = await create([
      card({ id: "july", dueDateLocalDate: "2026-07-15" }),
      card({ id: "september", dueDateLocalDate: "2026-09-02" }),
      card({ id: "undated", dueDateLocalDate: null }),
    ]);
    fixture.componentRef.setInput("navigation", "stacked");
    fixture.detectChanges();

    const months = fixture.componentInstance.months();
    // August holds nothing, so it is skipped rather than rendered as an empty grid.
    expect(months.map((month) => month.key)).toEqual(["2026-07", "2026-09"]);

    const july = months[0]!;
    expect(july.label).toBe("July 2026");
    expect(july.cardCount).toBe(1);
    // Whole weeks, with the leading blanks that put the 1st under its real weekday.
    expect(july.days.length % 7).toBe(0);
    // 1 July 2026 is a Wednesday, so two Monday-first padding cells precede it.
    expect(july.days.findIndex((day) => !day.isPadding)).toBe(2);
    expect(july.days.filter((day) => !day.isPadding).length).toBe(31);
    expect(july.days.find((day) => day.key === "2026-07-15")?.cards.map((c) => c.id)).toEqual(["july"]);
    expect(july.days.find((day) => day.key === "2026-07-16")?.cards).toEqual([]);
    // Padding cells never repeat the neighbouring month's cards: that month has its own grid below.
    expect(july.days.filter((day) => day.isPadding).every((day) => day.cards.length === 0)).toBe(true);

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(".calendar-toolbar")).toBeNull();
    expect(host.querySelectorAll(".calendar-month-header h3").length).toBe(2);
    expect([...host.querySelectorAll(".cal-card-title")].map((el) => el.textContent?.trim())).toEqual([
      "Ship calendar",
      "Ship calendar",
    ]);
  });

  it("uses a one-week range in week mode", async () => {
    const fixture = await create([
      card({ id: "in-week", dueDateLocalDate: "2026-05-20" }),
      card({ id: "out-week", dueDateLocalDate: "2026-05-28" }),
    ]);

    fixture.componentInstance.setMode("week");
    fixture.componentInstance.anchorDate.set(new Date(2026, 4, 20));

    expect(fixture.componentInstance.days().map((day) => day.key)).toEqual([
      "2026-05-18",
      "2026-05-19",
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
      "2026-05-23",
      "2026-05-24",
    ]);
    expect(fixture.componentInstance.days().flatMap((day) => day.cards).map((c) => c.id)).toEqual(["in-week"]);
  });

  it("respects filtered card ids", async () => {
    const fixture = await create([
      card({ id: "shown", dueDateLocalDate: "2026-05-20" }),
      card({ id: "hidden", dueDateLocalDate: "2026-05-20" }),
    ]);
    fixture.componentRef.setInput("filteredCardIds", new Set(["shown"]));

    expect(fixture.componentInstance.days().find((day) => day.key === "2026-05-20")?.cards.map((c) => c.id)).toEqual(["shown"]);
  });

  it("names the board when board summaries are provided", async () => {
    const fixture = await create();
    fixture.componentRef.setInput("boardSummariesById", new Map([
      ["board-1", { id: "board-1", name: "Launch board", icon: "rocket", iconColor: "blue" }],
    ]));
    fixture.detectChanges();

    const boardBadge = fixture.nativeElement.querySelector(".cal-board") as HTMLElement | null;
    expect(boardBadge?.querySelector("i")?.className).toContain("ti-rocket");
    expect(boardBadge?.querySelector(".cal-board-name")?.textContent?.trim()).toBe("Launch board");
  });

  it("renders labels as named chips with an overflow chip", async () => {
    const fixture = await create();
    fixture.componentRef.setInput("labelsByCard", new Map([
      ["card-1", [
        { id: "l1", name: "Bug", color: "red" },
        { id: "l2", name: "Infra", color: null },
        { id: "l3", name: "Support", color: "blue" },
        { id: "l4", name: "Later", color: "green" },
      ]],
    ]));
    fixture.detectChanges();

    const chips = [...fixture.nativeElement.querySelectorAll(".cal-label-row .label-chip")] as HTMLElement[];
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual(["Bug", "Infra", "Support", "+1"]);
    // An unset colour falls back to the neutral chip rather than rendering var(--color-null).
    expect(chips[1]?.style.getPropertyValue("--label-color")).toBe("var(--border-strong)");
    expect(chips.at(-1)?.getAttribute("aria-label")).toBe("More labels: Later");
  });

  it("hides all-day due times and shows slotted due times", async () => {
    const fixture = await create([
      card({ id: "all-day", title: "All day card", dueDateSlot: "anyTime" }),
      card({ id: "morning", title: "Morning card", dueDateSlot: "morning" }),
    ]);

    const cards = Array.from(fixture.nativeElement.querySelectorAll(".cal-card")) as HTMLElement[];
    expect(cards.find((el) => el.textContent?.includes("All day card"))?.querySelector(".cal-time")).toBeNull();
    expect(cards.find((el) => el.textContent?.includes("Morning card"))?.querySelector(".cal-time")?.textContent?.trim()).toBe("09:00");
  });

  it("leads with the title, then the key inside the shared context row", async () => {
    const fixture = await create([
      card({ dueDateSlot: "morning" }),
    ]);
    fixture.componentRef.setInput("boardSummariesById", new Map([
      ["board-1", { id: "board-1", name: "Launch board", icon: "rocket", iconColor: "blue" }],
    ]));
    fixture.detectChanges();

    const text = fixture.nativeElement.querySelector(".cal-card-text") as HTMLElement | null;
    expect(text?.children[0]?.classList.contains("cal-card-title")).toBe(true);
    // The key shares the context row with time and board rather than owning a row of its own.
    const context = text?.children[1] as HTMLElement | undefined;
    expect(context?.classList.contains("cal-context-row")).toBe(true);
    expect(context?.children[0]?.classList.contains("cal-card-key")).toBe(true);
    expect(context?.children[0]?.textContent?.trim()).toBe("WORK-1");
  });

  it("renders assignees with overflow", async () => {
    const fixture = await create();
    fixture.componentRef.setInput("assigneesByCard", new Map([
      ["card-1", [
        member({ userId: "user-1", displayName: "Ada" }),
        member({ userId: "user-2", displayName: "Grace" }),
        member({ userId: "user-3", displayName: "Katherine" }),
        member({ userId: "user-4", displayName: "Margaret" }),
      ]],
    ]));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll(".cal-avatar k-avatar").length).toBe(2);
    expect(fixture.nativeElement.querySelector(".cal-avatar-more")?.textContent?.trim()).toBe("+2");
  });

  it("renders optional metadata without comments", async () => {
    const fixture = await create([
      card({ hasDescription: true, checklistDoneCount: 1, checklistTotalCount: 3, attachmentCount: 2, commentCount: 4 }),
    ]);

    const meta = fixture.nativeElement.querySelector(".cal-meta-row") as HTMLElement | null;
    expect(meta?.querySelector(".ti-align-left")).toBeTruthy();
    expect(meta?.querySelector(".ti-checkbox")).toBeTruthy();
    expect(meta?.querySelector(".ti-paperclip")).toBeTruthy();
    expect(meta?.querySelector(".ti-message-circle")).toBeNull();
  });

  it("keeps metadata in the text column with the assignees pinned beside it", async () => {
    const fixture = await create([
      card({ hasDescription: true, attachmentCount: 1 }),
    ]);
    fixture.componentRef.setInput("assigneesByCard", new Map([
      ["card-1", [member({ userId: "user-1" })]],
    ]));
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(".cal-card-body") as HTMLElement | null;
    expect(body?.querySelector(".cal-card-text .cal-meta-row .ti-align-left")).toBeTruthy();
    expect(body?.querySelector(":scope > .cal-assignees k-avatar")).toBeTruthy();
  });

  it("emits card opens", async () => {
    const fixture = await create();
    const opened = vi.fn();
    fixture.componentInstance.cardOpened.subscribe(opened);

    fixture.componentInstance.openCard("card-1");

    expect(opened).toHaveBeenCalledWith("card-1");
  });

  describe("rescheduling by drag", () => {
    function drop(card: WireCardSummary, dayKey: string): CdkDragDrop<string, string, WireCardSummary> {
      return { item: { data: card }, container: { data: dayKey } } as unknown as CdkDragDrop<string, string, WireCardSummary>;
    }

    async function createWithStore(patch: ReturnType<typeof vi.fn>, cards = [card()]) {
      const store: TableCardStore = {
        updateCard: vi.fn(),
        setCardAssignees: vi.fn(),
        setCardLabels: vi.fn(),
        captureCustomFieldWrite: vi.fn(() => vi.fn()),
        moveCardToList: vi.fn(),
      };
      await TestBed.configureTestingModule({
        imports: [BoardCalendarViewComponent],
        providers: [
          provideZonelessChangeDetection(),
          BoardMenuCoordinator,
          { provide: ApiClient, useValue: { patch } },
          { provide: TABLE_CARD_STORE, useValue: store },
        ],
      }).compileComponents();
      const fixture = createComponentFixture(BoardCalendarViewComponent);
      fixture.componentRef.setInput("cards", cards);
      fixture.componentInstance.anchorDate.set(new Date(2026, 4, 15));
      fixture.detectChanges();
      return { fixture, store };
    }

    it("moves the card to the released day optimistically, keeps its slot, and settles on the response", async () => {
      const dragged = card({ dueDateSlot: "morning" });
      const settled = { ...dragged, dueDateLocalDate: "2026-05-22" };
      const patch = vi.fn().mockResolvedValue(settled);
      const { fixture, store } = await createWithStore(patch, [dragged]);

      await fixture.componentInstance.onCardDropped(drop(dragged, "2026-05-22"));

      expect(store.updateCard).toHaveBeenNthCalledWith(1, { ...dragged, dueDateLocalDate: "2026-05-22" });
      expect(patch).toHaveBeenCalledWith("/cards/card-1", { dueDateLocalDate: "2026-05-22", dueDateSlot: "morning" });
      expect(store.updateCard).toHaveBeenLastCalledWith(settled);
      expect(fixture.componentInstance.reschedulingCardIds().has("card-1")).toBe(false);
    });

    it("reverts the optimistic move when the request fails", async () => {
      const dragged = card();
      const patch = vi.fn().mockRejectedValue(new Error("offline"));
      const { fixture, store } = await createWithStore(patch, [dragged]);

      await expect(fixture.componentInstance.onCardDropped(drop(dragged, "2026-05-22"))).rejects.toThrow("offline");

      expect(store.updateCard).toHaveBeenLastCalledWith(dragged);
      expect(fixture.componentInstance.reschedulingCardIds().has("card-1")).toBe(false);
    });

    it("ignores a release on the card's own day and cards the viewer cannot edit", async () => {
      const dragged = card();
      const patch = vi.fn();
      const { fixture, store } = await createWithStore(patch, [dragged]);

      await fixture.componentInstance.onCardDropped(drop(dragged, "2026-05-20"));
      fixture.componentRef.setInput("editableCardIds", new Set<string>());
      fixture.detectChanges();
      await fixture.componentInstance.onCardDropped(drop(dragged, "2026-05-22"));

      expect(patch).not.toHaveBeenCalled();
      expect(store.updateCard).not.toHaveBeenCalled();
      // The tile is rendered but not liftable, so the month can still be drag-scrolled from it.
      const tile = (fixture.nativeElement as HTMLElement).querySelector(".cal-card");
      expect(tile?.classList.contains("cdk-drag-disabled")).toBe(true);
    });
  });
});
