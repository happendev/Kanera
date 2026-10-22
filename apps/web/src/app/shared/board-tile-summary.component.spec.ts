import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { BoardTileSummary } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it } from "vitest";
import { BoardTileSummaryComponent } from "./board-tile-summary.component";

function summary(overrides: Partial<BoardTileSummary> = {}): BoardTileSummary {
  return {
    boardId: "board-1",
    open: 4,
    completed: 1,
    overdue: 1,
    checklistDone: 1,
    checklistTotal: 2,
    nextDueDate: "2026-10-24",
    lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    members: [
      { userId: "u1", displayName: "Priya", avatarUrl: null },
      { userId: "u2", displayName: "Marco", avatarUrl: null },
    ],
    memberCount: 6,
    ...overrides,
  };
}

describe("BoardTileSummaryComponent", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BoardTileSummaryComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  function render(value: BoardTileSummary | null) {
    const fixture = TestBed.createComponent(BoardTileSummaryComponent);
    fixture.componentRef.setInput("summary", value);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it("renders nothing until a summary arrives, so the tile keeps its height", () => {
    const host = render(null);
    expect(host.textContent?.trim()).toBe("");
    expect(host.querySelector(".bts-row")).toBeNull();
  });

  it("shows counts, next due date, last activity and member stack without a completion bar", () => {
    const host = render(summary());
    const text = host.textContent?.replace(/\s+/g, " ") ?? "";
    expect(host.querySelector(".bts-progress")).toBeNull();
    expect(text).toContain("4 open");
    expect(text).toContain("1 overdue");
    expect(text).toContain("1/2");
    expect(text).toContain("Updated 2h ago");
    expect(host.querySelectorAll("k-avatar")).toHaveLength(2);
    expect(host.querySelector(".bts-more")?.textContent?.trim()).toBe("+4");
  });

  it("leaves out facts a board does not have, so an empty board reads as one short line", () => {
    const host = render(summary({ open: 0, completed: 0, overdue: 0, checklistDone: 0, checklistTotal: 0, nextDueDate: null, lastActivityAt: null, members: [], memberCount: 0 }));
    const text = host.textContent?.replace(/\s+/g, " ").trim() ?? "";
    expect(text).toBe("No open cards");
    expect(host.querySelector(".bts-progress")).toBeNull();
    expect(host.querySelector(".is-danger")).toBeNull();
    expect(host.querySelector(".bts-avatars")).toBeNull();
  });
});
