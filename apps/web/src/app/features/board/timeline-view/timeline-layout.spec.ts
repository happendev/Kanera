import { describe, expect, it } from "vitest";
import type { AnyCard, AnyList } from "../table-view/table-view.types";
import { buildTimelineRows, dayAt, dependencyPath, mondayOf, timelineHeader, timelineRange, timelineScale, weekendBands, xOf } from "./timeline-layout";

/** Zooms at each header scale, in pixels per day. */
const DAY_PX = 40;
const WEEK_PX = 16;
const MONTH_PX = 6;
import { dayNumber } from "@kanera/shared/schedule";

/**
 * Failure modes, each a pure arithmetic edge the E2E test cannot enumerate:
 * - the scale starts mid-week, so week header cells never line up with the Monday grid;
 * - the scale leaves out today or a bar, so a card has no place to draw;
 * - a pixel maps back to a different day than the one it was drawn at (a drop lands a day off);
 * - weekend bands split Saturday from Sunday or leak into month zoom;
 * - cards with no dates mix into a list group instead of the trailing Unscheduled group, or that
 *   group appears when every card is dated;
 * - a group's summary span stops short of its last bar;
 * - a collapsed group still emits its rows, or a card in two assignee groups is drawn once;
 * - a forward wire is drawn as a loop, or a conflict wire enters from the right.
 */

const TODAY = "2026-10-21"; // A Wednesday.

function card(id: string, overrides: Partial<AnyCard> = {}): AnyCard {
  return {
    id,
    workspaceId: "ws",
    organisationKey: "ORG",
    number: 1,
    key: `ORG-${id}`,
    listId: "list-a",
    boardId: "board",
    title: id,
    position: "1",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    startDateLocalDate: null,
    completedAt: null,
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    coverAttachmentId: null,
    ...overrides,
  } as AnyCard;
}

const lists: AnyList[] = [
  { id: "list-a", name: "Backlog", icon: "list", color: "blue", position: "1" } as AnyList,
  { id: "list-b", name: "Doing", icon: "run", color: "green", position: "2" } as AnyList,
];

function context(overrides: Partial<Parameters<typeof buildTimelineRows>[4]> = {}): Parameters<typeof buildTimelineRows>[4] {
  return {
    lists,
    labelsByCard: new Map(),
    assigneesByCard: new Map(),
    collapsedGroupKeys: new Set(),
    labels: { unassigned: "Unassigned", noLabel: "No label", allCards: "All cards", unscheduled: "Unscheduled" },
    ...overrides,
  };
}

describe("timelineRange", () => {
  it("starts on a Monday and covers today and every bar", () => {
    const range = timelineRange([{ start: "2026-12-01", end: "2026-12-10" }], TODAY);
    expect(range.startDay).toBe(mondayOf(range.startDay));
    expect((range.endDay - range.startDay + 1) % 7).toBe(0);
    expect(range.startDay).toBeLessThanOrEqual(dayNumber(TODAY));
    expect(range.endDay).toBeGreaterThanOrEqual(dayNumber("2026-12-10"));
  });

  // Zooming holds the day under the pointer still by assuming the scale's origin does not move; if
  // the start drifted with the zoom, every zoom step would jump sideways.
  it("keeps its start when only the minimum span changes, and stretches the end to fill", () => {
    const bars = [{ start: "2026-12-01", end: "2026-12-10" }];
    const narrow = timelineRange(bars, TODAY, 42);
    const wide = timelineRange(bars, TODAY, 600);
    expect(wide.startDay).toBe(narrow.startDay);
    expect(wide.endDay - wide.startDay).toBeGreaterThanOrEqual(600);
  });

  it("maps a pixel back to the day it was drawn at", () => {
    const range = timelineRange([], TODAY);
    const day = dayNumber("2026-10-28");
    const x = xOf(day, range, DAY_PX);
    expect(dayAt(x, range, DAY_PX)).toBe(day);
    expect(dayAt(x + DAY_PX - 1, range, DAY_PX)).toBe(day);
    expect(dayAt(x + DAY_PX, range, DAY_PX)).toBe(day + 1);
    expect(dayAt(-500, range, DAY_PX)).toBe(range.startDay);
  });
});

describe("timelineHeader and weekendBands", () => {
  it("switches header granularity where the labels stop fitting", () => {
    expect(timelineScale(80)).toBe("day");
    expect(timelineScale(22)).toBe("day");
    expect(timelineScale(21.9)).toBe("week");
    expect(timelineScale(7)).toBe("week");
    expect(timelineScale(6.9)).toBe("month");
    expect(timelineHeader(timelineRange([], TODAY), 30, TODAY).minor[0]?.width).toBe(30);
  });

  it("labels week cells by Monday and marks today's week", () => {
    const range = timelineRange([], TODAY);
    const header = timelineHeader(range, WEEK_PX, TODAY);
    expect(header.minor.every((cell) => cell.width === WEEK_PX * 7)).toBe(true);
    expect(header.minor.filter((cell) => cell.tone === "today")).toHaveLength(1);
    expect(header.minor.find((cell) => cell.tone === "today")?.key).toBe("2026-10-19");
    expect(header.major.every((cell) => cell.label.includes("2026") || cell.label.includes("2027"))).toBe(true);
  });

  it("joins Saturday and Sunday into one band and draws none at the month scale", () => {
    const range = timelineRange([], TODAY);
    const bands = weekendBands(range, DAY_PX);
    expect(bands.every((band) => band.width === DAY_PX * 2)).toBe(true);
    expect(bands).toHaveLength((range.endDay - range.startDay + 1) / 7);
    expect(weekendBands(range, MONTH_PX)).toEqual([]);
  });
});

describe("buildTimelineRows", () => {
  const dated = card("a", { startDateLocalDate: "2026-10-19", dueDateLocalDate: "2026-10-23" });
  const later = card("b", { listId: "list-b", startDateLocalDate: "2026-10-26", dueDateLocalDate: "2026-10-30", position: "2" });
  const undated = card("c", { position: "3" });
  const range = timelineRange([{ start: "2026-10-19", end: "2026-10-30" }], TODAY);

  it("groups dated cards by list and sends undated ones to a trailing Unscheduled group", () => {
    const rows = buildTimelineRows([undated, later, dated], "list", range, WEEK_PX, context());
    expect(rows.map((row) => row.id)).toEqual(["group:list:list-a", "list:list-a/a", "group:list:list-b", "list:list-b/b", "group:unscheduled", "unscheduled/c"]);
    const unscheduled = rows.find((row) => row.kind === "card" && row.card.id === "c");
    expect(unscheduled?.kind === "card" && unscheduled.bar).toBeNull();
  });

  it("omits the Unscheduled group when every card is dated and the flat grouping needs no header", () => {
    const rows = buildTimelineRows([later, dated], "none", range, WEEK_PX, context());
    expect(rows.map((row) => row.kind)).toEqual(["card", "card"]);
    expect(rows[0]?.kind === "card" && rows[0].card.id).toBe("a");
  });

  it("spans a group over all its bars and hides rows of a collapsed group", () => {
    const sameList = card("d", { startDateLocalDate: "2026-11-02", dueDateLocalDate: "2026-11-06" });
    const rows = buildTimelineRows([dated, sameList], "list", range, WEEK_PX, context({ collapsedGroupKeys: new Set(["list:list-a"]) }));
    expect(rows).toHaveLength(1);
    const group = rows[0];
    expect(group?.kind === "group" && group.span).toEqual({ start: "2026-10-19", end: "2026-11-06" });
    expect(group?.kind === "group" && group.collapsed).toBe(true);
  });

  it("draws a card with two assignees in both of their groups", () => {
    const assignees = new Map([["a", [
      { userId: "u1", displayName: "Ada", avatarUrl: null },
      { userId: "u2", displayName: "Ben", avatarUrl: null },
    ]]]);
    const rows = buildTimelineRows([dated], "assignee", range, WEEK_PX, context({ assigneesByCard: assignees as never }));
    expect(rows.filter((row) => row.kind === "card")).toHaveLength(2);
    expect(rows.filter((row) => row.kind === "group").map((row) => row.kind === "group" && row.label)).toEqual(["Ada", "Ben"]);
  });
});

describe("dependencyPath", () => {
  it("runs forward when the dependent starts after the blocker ends", () => {
    const path = dependencyPath({ x: 100, y: 18 }, { x: 160, y: 54 }, 36);
    expect(path.startsWith("M 100 18")).toBe(true);
    expect(path.endsWith("H 160")).toBe(true);
    expect(path).not.toContain("V 34");
  });

  it("loops back under the row when the dependent starts before the blocker ends", () => {
    const path = dependencyPath({ x: 200, y: 18 }, { x: 150, y: 54 }, 36);
    expect(path).toBe("M 200 18 H 210 V 34 H 140 V 54 H 150");
  });
});
