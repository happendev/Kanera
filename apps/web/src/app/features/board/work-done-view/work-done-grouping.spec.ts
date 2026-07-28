import type { WorkDoneEvent } from "@kanera/shared/dto";
import type { WireCardSummary } from "@kanera/shared/events";
import { describe, expect, it } from "vitest";
import {
  MOVE_PATH_MAX,
  buildRangeStandupText,
  buildStandupText,
  collapseListPath,
  countsByDay,
  groupIntoDays,
} from "./work-done-grouping";
import type { ListLookup } from "./work-done-grouping";

function cardSummary(overrides: Partial<WireCardSummary> & { id: string; title: string }): WireCardSummary {
  return {
    listId: "list-1",
    boardId: "board-1",
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
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
  } as WireCardSummary;
}

/**
 * Local-time ISO builder. Tests must construct instants in the *runner's* zone, because grouping
 * buckets by local calendar day — a hardcoded "…Z" string would land on a different day depending on
 * where the suite runs.
 */
function localAt(year: number, month: number, day: number, hour: number, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

const lists: ListLookup = new Map([
  ["list-a", { name: "Backlog", icon: null, color: null }],
  ["list-b", { name: "Doing", icon: "player-play", color: "blue" }],
  ["list-c", { name: "Review", icon: null, color: null }],
  ["list-d", { name: "QA", icon: null, color: null }],
  ["list-e", { name: "Done", icon: null, color: "green" }],
]);

function created(id: string, at: string, card: WireCardSummary, actor = "Ada", actorId = "user-1"): WorkDoneEvent {
  return { id, type: "created", at, card, boardId: card.boardId, listId: card.listId, actorUserId: actorId, actorName: actor, actorAvatarUrl: null };
}

function moved(id: string, at: string, card: WireCardSummary, listPath: string[], actor = "Ada", actorId = "user-1"): WorkDoneEvent {
  return { id, type: "moved", at, card, boardId: card.boardId, listId: card.listId, actorUserId: actorId, actorName: actor, actorAvatarUrl: null, listPath };
}

function completed(id: string, at: string, card: WireCardSummary, actor = "Ada", actorId = "user-1"): WorkDoneEvent {
  return { id, type: "completed", at, card, boardId: card.boardId, listId: card.listId, actorUserId: actorId, actorName: actor, actorAvatarUrl: null };
}

function checklistTick(id: string, at: string, card: WireCardSummary, text: string, actor = "Ada", actorId = "user-1"): WorkDoneEvent {
  return {
    id, type: "checklistItemCompleted", at, card, boardId: card.boardId, listId: card.listId,
    itemId: `item-${id}`, text, checklistId: "checklist-1", checklistTitle: "Release checks",
    completedByUserId: actorId, completedByName: actor, completedByAvatarUrl: null,
  };
}

describe("groupIntoDays", () => {
  const today = new Date(2026, 6, 26); // 26 July 2026, local
  const shipIt = cardSummary({ id: "card-1", title: "Ship billing page" });
  const fixAvatar = cardSummary({ id: "card-2", title: "Fix avatar signing" });

  it("buckets events into local calendar days, newest day first", () => {
    const days = groupIntoDays([
      completed("e1", localAt(2026, 7, 26, 10), shipIt),
      created("e2", localAt(2026, 7, 24, 9), fixAvatar),
      completed("e3", localAt(2026, 7, 25, 17), fixAvatar),
    ], lists, today);

    expect(days.map((day) => day.dateKey)).toEqual(["2026-07-26", "2026-07-25", "2026-07-24"]);
    expect(days[0]!.label).toBe("Today");
    expect(days[1]!.label).toBe("Yesterday");
    // Older days fall back to a dated label rather than a relative one.
    expect(days[2]!.label).not.toBe("Yesterday");
  });

  it("keeps a late-evening event on the viewer's day rather than shifting it to UTC's", () => {
    // 23:30 local. If grouping went through toISOString(), anyone east of UTC would see this land on
    // the 27th.
    const days = groupIntoDays([completed("e1", localAt(2026, 7, 26, 23, 30), shipIt)], lists, today);

    expect(days).toHaveLength(1);
    expect(days[0]!.dateKey).toBe("2026-07-26");
  });

  it("collapses a card's whole day into one digest row", () => {
    const days = groupIntoDays([
      created("e1", localAt(2026, 7, 26, 8), shipIt),
      moved("e2", localAt(2026, 7, 26, 9), shipIt, ["list-a", "list-b"]),
      moved("e3", localAt(2026, 7, 26, 11), shipIt, ["list-b", "list-e"]),
      completed("e4", localAt(2026, 7, 26, 12), shipIt),
    ], lists, today);

    expect(days).toHaveLength(1);
    // Four events, one row.
    expect(days[0]!.digests).toHaveLength(1);
    const digest = days[0]!.digests[0]!;
    expect(digest.eventCount).toBe(4);
    expect(digest.created).toBe(true);
    expect(digest.completed).toBe(true);
    // The two move events' paths join without repeating the shared list.
    expect(digest.listPath.map((step) => step.text)).toEqual(["Backlog", "Doing", "Done"]);
    // Completion is the headline outcome even though it is not the only thing that happened.
    expect(digest.leadType).toBe("completed");
    // The row's time is the card's last event that day.
    expect(digest.lastAt).toBe(localAt(2026, 7, 26, 12));
  });

  it("keeps the same card on separate days as separate rows", () => {
    const days = groupIntoDays([
      moved("e1", localAt(2026, 7, 25, 14), shipIt, ["list-a", "list-b"]),
      moved("e2", localAt(2026, 7, 26, 10), shipIt, ["list-b", "list-e"]),
    ], lists, today);

    expect(days.map((day) => day.dateKey)).toEqual(["2026-07-26", "2026-07-25"]);
    expect(days[0]!.digests).toHaveLength(1);
    expect(days[1]!.digests).toHaveLength(1);
    // Digest keys are day-scoped, so the two rows never collide as track keys.
    expect(days[0]!.digests[0]!.key).not.toBe(days[1]!.digests[0]!.key);
  });

  it("sorts a day's cards by their latest activity", () => {
    const days = groupIntoDays([
      completed("e1", localAt(2026, 7, 26, 9), shipIt),
      completed("e2", localAt(2026, 7, 26, 16), fixAvatar),
    ], lists, today);

    expect(days[0]!.digests.map((digest) => digest.card.title)).toEqual(["Fix avatar signing", "Ship billing page"]);
  });

  it("counts events by type and credits every contributor once", () => {
    const days = groupIntoDays([
      created("e1", localAt(2026, 7, 26, 8), shipIt, "Ada", "user-1"),
      moved("e2", localAt(2026, 7, 26, 9), shipIt, ["list-a", "list-b"], "Bob", "user-2"),
      completed("e3", localAt(2026, 7, 26, 10), fixAvatar, "Ada", "user-1"),
      checklistTick("e4", localAt(2026, 7, 26, 11), fixAvatar, "Verify deploy", "Ada", "user-1"),
    ], lists, today);

    const day = days[0]!;
    expect(day.counts).toEqual({ created: 1, moved: 1, completed: 1, checklistItemCompleted: 1 });
    expect(day.eventCount).toBe(4);
    // Busiest contributor first; checklist ticks are attributed via completedBy, not actor.
    expect(day.actors.map((actor) => [actor.name, actor.eventCount])).toEqual([["Ada", 3], ["Bob", 1]]);
  });

  it("does not merge distinct system and API-key actors, which have no user id", () => {
    const systemEvent = { ...completed("e1", localAt(2026, 7, 26, 9), shipIt), actorUserId: null, actorName: "Kanera" };
    const apiEvent = { ...completed("e2", localAt(2026, 7, 26, 10), fixAvatar), actorUserId: null, actorName: "Deploy bot" };

    const days = groupIntoDays([systemEvent, apiEvent], lists, today);

    expect(days[0]!.actors.map((actor) => actor.name).sort()).toEqual(["Deploy bot", "Kanera"]);
  });

  it("gathers a card's checklist ticks onto its row", () => {
    const days = groupIntoDays([
      checklistTick("e1", localAt(2026, 7, 26, 9), shipIt, "Verify deploy"),
      checklistTick("e2", localAt(2026, 7, 26, 10), shipIt, "Update changelog"),
    ], lists, today);

    const digest = days[0]!.digests[0]!;
    expect(digest.checklistTicks.map((tick) => tick.text)).toEqual(["Verify deploy", "Update changelog"]);
    expect(digest.leadType).toBe("checklistItemCompleted");
  });

  it("drops list ids the catalog cannot resolve rather than rendering blanks", () => {
    const days = groupIntoDays([
      moved("e1", localAt(2026, 7, 26, 9), shipIt, ["list-a", "list-unknown", "list-e"]),
    ], lists, today);

    expect(days[0]!.digests[0]!.listPath.map((step) => step.text)).toEqual(["Backlog", "Done"]);
  });

  it("returns no days for an empty stream", () => {
    expect(groupIntoDays([], lists, today)).toEqual([]);
  });
});

describe("collapseListPath", () => {
  const step = (text: string) => ({ text, icon: null, color: null, ellipsis: false });

  it("leaves short journeys intact", () => {
    const path = [step("A"), step("B"), step("C")];
    expect(collapseListPath(path).map((entry) => entry.text)).toEqual(["A", "B", "C"]);
  });

  it("collapses the middle of long journeys, keeping the destination", () => {
    const path = [step("A"), step("B"), step("C"), step("D"), step("E")];
    const collapsed = collapseListPath(path);

    expect(collapsed.map((entry) => entry.text)).toEqual(["A", "B", "C", "…", "E"]);
    expect(collapsed).toHaveLength(MOVE_PATH_MAX + 1);
    expect(collapsed[3]!.ellipsis).toBe(true);
  });
});

describe("countsByDay", () => {
  it("keys one metric's counts by local day for the activity strip", () => {
    const today = new Date(2026, 6, 26);
    const card = cardSummary({ id: "card-1", title: "Ship it" });
    const days = groupIntoDays([
      completed("e1", localAt(2026, 7, 26, 10), card),
      completed("e2", localAt(2026, 7, 26, 11), cardSummary({ id: "card-2", title: "Other" })),
      moved("e3", localAt(2026, 7, 25, 10), card, ["list-a", "list-b"]),
    ], lists, today);

    expect(countsByDay(days, "completed")).toEqual(new Map([["2026-07-26", 2], ["2026-07-25", 0]]));
    expect(countsByDay(days, "moved")).toEqual(new Map([["2026-07-26", 0], ["2026-07-25", 1]]));
  });
});

describe("buildStandupText", () => {
  const today = new Date(2026, 6, 26);
  const shipIt = cardSummary({ id: "card-1", title: "Ship billing page" });
  const fixAvatar = cardSummary({ id: "card-2", title: "Fix avatar signing" });
  const release = cardSummary({ id: "card-3", title: "Release" });

  it("groups a day by outcome, naming board and contributor", () => {
    const days = groupIntoDays([
      completed("e1", localAt(2026, 7, 26, 10), shipIt, "Ada", "user-1"),
      moved("e2", localAt(2026, 7, 26, 9), fixAvatar, ["list-a", "list-b"], "Bob", "user-2"),
      checklistTick("e3", localAt(2026, 7, 26, 11), release, "Verify deploy", "Cy", "user-3"),
    ], lists, today);

    const text = buildStandupText(days[0]!, new Map([["board-1", "Platform"]]));

    // The copied heading follows the viewer's locale, so assert against the localized day model.
    expect(text.split("\n")[0]).toBe(`Work done — ${days[0]!.fullLabel}`);
    expect(text).toContain("Completed\n- Ship billing page (Platform · Ada)");
    // Moved rows carry their journey so the line is useful without opening the card.
    expect(text).toContain("Moved\n- Fix avatar signing (Platform · Bob) — Backlog → Doing");
    expect(text).toContain("Checklist\n- Release (Platform · Cy) — Verify deploy");
  });

  it("reports a completed card once, under Completed", () => {
    const days = groupIntoDays([
      created("e1", localAt(2026, 7, 26, 8), shipIt),
      moved("e2", localAt(2026, 7, 26, 9), shipIt, ["list-a", "list-e"]),
      completed("e3", localAt(2026, 7, 26, 10), shipIt),
    ], lists, today);

    const text = buildStandupText(days[0]!);

    expect(text.match(/Ship billing page/g)).toHaveLength(1);
    expect(text).toContain("Completed");
    expect(text).not.toContain("Moved");
    expect(text).not.toContain("Created");
  });

  it("summarises multiple checklist ticks as a count", () => {
    const days = groupIntoDays([
      checklistTick("e1", localAt(2026, 7, 26, 9), release, "Verify deploy"),
      checklistTick("e2", localAt(2026, 7, 26, 10), release, "Update changelog"),
    ], lists, today);

    expect(buildStandupText(days[0]!)).toContain("— 2 items");
  });

  it("omits the board when no name is known", () => {
    const days = groupIntoDays([completed("e1", localAt(2026, 7, 26, 10), shipIt, "Ada", "user-1")], lists, today);

    expect(buildStandupText(days[0]!)).toContain("- Ship billing page (Ada)");
  });

  it("joins every day for a range export, newest first", () => {
    const days = groupIntoDays([
      completed("e1", localAt(2026, 7, 26, 10), shipIt),
      completed("e2", localAt(2026, 7, 25, 10), fixAvatar),
    ], lists, today);

    const text = buildRangeStandupText(days);

    expect(text.indexOf(`Work done — ${days[0]!.fullLabel}`))
      .toBeLessThan(text.indexOf(`Work done — ${days[1]!.fullLabel}`));
    expect(text).toContain("Ship billing page");
    expect(text).toContain("Fix avatar signing");
  });

  it("says so plainly when a range has nothing in it", () => {
    expect(buildRangeStandupText([])).toBe("No work recorded.");
  });
});
