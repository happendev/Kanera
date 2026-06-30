import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireBoardMemberUser, WireCardSummary } from "@kanera/shared/events";
import { describe, expect, it, vi } from "vitest";
import { BoardCalendarViewComponent } from "./board-calendar-view.component";

function card(overrides: Partial<WireCardSummary> = {}): WireCardSummary {
  return {
    id: "card-1",
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
    labelIds: [],
    assigneeIds: [],
    customFieldValues: [],
    ...overrides,
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
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(BoardCalendarViewComponent);
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
    expect(days[0].key).toBe("2026-04-26");
    expect(days.at(-1)?.key).toBe("2026-06-06");
  });

  it("uses a one-week range in week mode", async () => {
    const fixture = await create([
      card({ id: "in-week", dueDateLocalDate: "2026-05-20" }),
      card({ id: "out-week", dueDateLocalDate: "2026-05-28" }),
    ]);

    fixture.componentInstance.setMode("week");
    fixture.componentInstance.anchorDate.set(new Date(2026, 4, 20));

    expect(fixture.componentInstance.days().map((day) => day.key)).toEqual([
      "2026-05-17",
      "2026-05-18",
      "2026-05-19",
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
      "2026-05-23",
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

  it("shows icon-only board context when board summaries are provided", async () => {
    const fixture = await create();
    fixture.componentRef.setInput("boardSummariesById", new Map([
      ["board-1", { id: "board-1", name: "Launch board", icon: "rocket", iconColor: "blue" }],
    ]));
    fixture.detectChanges();

    const boardBadge = fixture.nativeElement.querySelector(".cal-board-icon") as HTMLElement | null;
    expect(boardBadge?.querySelector("i")?.className).toContain("ti-rocket");
    expect(boardBadge?.getAttribute("aria-label")).toBe("Launch board");
    expect(boardBadge?.textContent?.trim()).toBe("");
    expect(fixture.nativeElement.querySelector(".cal-card")?.textContent).not.toContain("Launch board");
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

  it("keeps the title on its own row below time and board context", async () => {
    const fixture = await create([
      card({ dueDateSlot: "morning" }),
    ]);
    fixture.componentRef.setInput("boardSummariesById", new Map([
      ["board-1", { id: "board-1", name: "Launch board", icon: "rocket", iconColor: "blue" }],
    ]));
    fixture.detectChanges();

    const primary = fixture.nativeElement.querySelector(".cal-primary-row") as HTMLElement | null;
    expect(primary?.children[0]?.classList.contains("cal-context-row")).toBe(true);
    expect(primary?.children[1]?.classList.contains("cal-card-title")).toBe(true);
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

  it("renders optional metadata and assignees in the same secondary row", async () => {
    const fixture = await create([
      card({ hasDescription: true, attachmentCount: 1 }),
    ]);
    fixture.componentRef.setInput("assigneesByCard", new Map([
      ["card-1", [member({ userId: "user-1" })]],
    ]));
    fixture.detectChanges();

    const secondary = fixture.nativeElement.querySelector(".cal-secondary-row") as HTMLElement | null;
    expect(secondary?.querySelector(".cal-meta-row .ti-align-left")).toBeTruthy();
    expect(secondary?.querySelector(".cal-assignees k-avatar")).toBeTruthy();
  });

  it("emits card opens", async () => {
    const fixture = await create();
    const opened = vi.fn();
    fixture.componentInstance.cardOpened.subscribe(opened);

    fixture.componentInstance.openCard("card-1");

    expect(opened).toHaveBeenCalledWith("card-1");
  });
});
