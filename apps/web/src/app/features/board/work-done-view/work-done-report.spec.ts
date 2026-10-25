import type { WorkDoneEvent } from "@kanera/shared/dto";
import type { WireCardSummary } from "@kanera/shared/events";
import { describe, expect, it } from "vitest";
import { addDays, localDateKey, startOfLocalDay } from "../../../shared/day-key.util";
import { buildReportText, buildWorkDoneReport, niceTicks, type WorkDoneReportInput } from "./work-done-report";

/**
 * The report is pure arithmetic over counts, which is exactly where an off-by-one or a wrong sign hides
 * behind a plausible-looking sentence. These pin the edge cases the rendered page cannot reveal at a
 * glance: deltas against a missing comparison, the solo/team wording switch, the net-flow direction,
 * duplicate completions, and the "right now" groups reading the live board rather than the period.
 */

const DAY = 24 * 60 * 60 * 1000;
const today = startOfLocalDay(new Date());
const now = today.getTime() + 12 * 60 * 60 * 1000;

function card(overrides: Partial<WireCardSummary> & { id: string }): WireCardSummary {
  return {
    workspaceId: "ws-1",
    organisationKey: "acme",
    number: 1,
    key: "ACME-1",
    title: `Card ${overrides.id}`,
    listId: "todo",
    boardId: "board-1",
    position: "1",
    dueDateLocalDate: null,
    startDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: null,
    inProgressSince: null,
    inProgressSeconds: 0,
    createdAt: new Date(now - 5 * DAY),
    updatedAt: new Date(now - 60_000),
    hasDescription: false,
    commentCount: 0,
    attachmentCount: 0,
    checklistDoneCount: 0,
    checklistTotalCount: 0,
    blockedByCount: 0,
    coverUrl: null,
    coverImageWidth: null,
    coverImageHeight: null,
    coverImageColor: null,
    labelIds: [],
    assigneeIds: [],
    customFieldValues: [],
    ...overrides,
  };
}

function event(type: "created" | "completed" | "moved", actor: { id: string; name: string }, c: WireCardSummary, daysAgo = 0): WorkDoneEvent {
  const base = {
    id: `${type}:${c.id}:${actor.id}:${daysAgo}`,
    at: new Date(now - daysAgo * DAY).toISOString(),
    card: c,
    boardId: "board-1",
    listId: c.listId,
    actorUserId: actor.id,
    actorName: actor.name,
    actorAvatarUrl: null,
    agentName: null,
  };
  if (type === "moved") return { ...base, type, listPath: ["todo", "done"] };
  return { ...base, type };
}

const ada = { id: "u-ada", name: "Ada" };
const bob = { id: "u-bob", name: "Bob" };

function input(overrides: Partial<WorkDoneReportInput> = {}): WorkDoneReportInput {
  return {
    from: addDays(today, -4),
    to: today,
    today,
    now,
    events: [],
    previousDays: null,
    cards: [],
    lists: [
      { id: "todo", name: "To do", icon: null, color: null, inProgress: false },
      { id: "doing", name: "Doing", icon: "progress", color: "blue", inProgress: true },
    ],
    members: [
      { userId: ada.id, displayName: ada.name, avatarUrl: null, role: "member", source: "workspace" },
      { userId: bob.id, displayName: bob.name, avatarUrl: null, role: "member", source: "workspace" },
    ],
    assigneeIdsByCard: new Map(),
    labelIdsByCard: new Map(),
    labelsById: new Map(),
    selectFields: [],
    fieldValuesByCard: new Map(),
    inProgressEnabled: true,
    inProgressAlertDays: 7,
    inactiveCardsDays: 14,
    timeZone: "UTC",
    ...overrides,
  };
}

describe("buildWorkDoneReport", () => {
  it("says nothing happened when the period is empty and nothing needs attention", () => {
    const report = buildWorkDoneReport(input());
    expect(report.headline[0]).toBe("No cards were worked on in this period.");
    expect(report.headline).toContain("Nothing is overdue, blocked or stuck right now.");
    expect(report.attention).toEqual([]);
    expect(report.kpis.every((kpi) => kpi.delta === null)).toBe(true);
    expect(report.comparisonLabel).toBeNull();
  });

  it("names the one active person, and switches to the team once a second person acts", () => {
    const done = card({ id: "c1", completedAt: new Date(now - 1000) });
    const solo = buildWorkDoneReport(input({ events: [event("completed", ada, done), event("created", ada, card({ id: "c2" }))] }));
    expect(solo.headline[0]).toBe("Ada completed 1 card and started 1 new one.");

    const team = buildWorkDoneReport(input({ events: [event("completed", ada, done), event("created", bob, card({ id: "c2" }))] }));
    expect(team.headline[0]).toBe("The team completed 1 card and started 1 new one.");
    expect(team.headline).toContain("2 people were active.");
  });

  it("speaks to the viewer on My Cards instead of naming them or the team", () => {
    const done = card({ id: "d", completedAt: new Date(now - DAY) });
    const solo = buildWorkDoneReport(input({
      viewerUserId: ada.id,
      events: [event("completed", ada, done, 1), event("created", ada, card({ id: "n" }), 1)],
    }));
    expect(solo.headline[0]).toBe("You completed 1 card and started 1 new one.");
    // Someone else touched the viewer's cards too: neither "you" nor "the team" did all of it.
    const shared = buildWorkDoneReport(input({
      viewerUserId: ada.id,
      events: [event("completed", ada, done, 1), event("completed", bob, card({ id: "e" }), 2), event("created", bob, card({ id: "n" }), 1)],
    }));
    expect(shared.headline[0]).toBe("Across your cards, 2 were completed and 1 started.");
    expect(shared.headline).toContain("2 people were active.");
    expect(shared.headline.some((line) => line.includes("completed the most"))).toBe(false);
  });

  it("reports the net direction of open work and the leader only when there is a clear one", () => {
    const grew = buildWorkDoneReport(input({ events: [event("created", ada, card({ id: "a" })), event("created", ada, card({ id: "b" })), event("created", bob, card({ id: "c" })), event("completed", bob, card({ id: "d", completedAt: new Date(now) }))] }));
    expect(grew.headline).toContain("More cards were started than finished, so open work grew by 2 cards.");
    // Bob completed one card: not enough to be called out as "the most".
    expect(grew.headline.some((sentence) => sentence.includes("completed the most"))).toBe(false);

    const shrank = buildWorkDoneReport(input({
      events: [
        event("completed", ada, card({ id: "a", completedAt: new Date(now) })),
        event("completed", ada, card({ id: "b", completedAt: new Date(now) })),
        event("completed", bob, card({ id: "c", completedAt: new Date(now) })),
      ],
    }));
    expect(shrank.headline).toContain("More cards were finished than started, so open work shrank by 3 cards.");
    expect(shrank.headline).toContain("Ada completed the most (2 cards).");
  });

  it("compares with the previous period and words the trend from the completion count", () => {
    const events = [event("completed", ada, card({ id: "a", completedAt: new Date(now) })), event("moved", ada, card({ id: "b" }))];
    const previousDays = [{ date: "2026-01-01", created: 2, moved: 0, completed: 3, checklistItemCompleted: 1 }];
    const report = buildWorkDoneReport(input({ events, previousDays }));
    expect(report.comparisonLabel).toBe("vs previous 5 days");
    expect(report.kpis.find((kpi) => kpi.key === "completed")?.delta).toBe(-2);
    expect(report.kpis.find((kpi) => kpi.key === "moved")?.delta).toBe(1);
    expect(report.kpis.find((kpi) => kpi.key === "created")?.delta).toBe(-2);
    expect(report.headline).toContain("That is down from 3 completions in the previous 5 days.");
  });

  it("counts a card completed twice in the period once for delivery timing", () => {
    const c = card({ id: "twice", createdAt: new Date(now - 3 * DAY), completedAt: new Date(now), dueDateLocalDate: localDateKey(addDays(today, 1)) });
    const others = ["x", "y"].map((id) => card({ id, createdAt: new Date(now - 1 * DAY), completedAt: new Date(now), dueDateLocalDate: localDateKey(addDays(today, -1)), dueDateTimezone: "UTC" }));
    const report = buildWorkDoneReport(input({
      events: [event("completed", ada, c, 2), event("completed", ada, c), ...others.map((o) => event("completed", bob, o))],
    }));
    expect(report.kpis.find((kpi) => kpi.key === "completed")?.value).toBe(4);
    expect(report.cycleTime?.samples).toBe(3);
    // Three completed cards with due dates: one on time, two late.
    expect(report.onTime).toEqual({ onTime: 1, total: 3 });
  });

  it("builds the attention groups from the live board, worst first, and caps the named cards", () => {
    const overdueCards = Array.from({ length: 8 }, (_unused, index) =>
      card({ id: `od-${index}`, dueDateLocalDate: localDateKey(addDays(today, -(index + 1))), dueDateTimezone: "UTC" }),
    );
    const blocked = card({ id: "blocked", blockedByCount: 2 });
    const stuck = card({ id: "stuck", listId: "doing", inProgressSince: new Date(now - 9 * DAY) });
    const finished = card({ id: "finished", completedAt: new Date(now), dueDateLocalDate: "2000-01-01" });
    const report = buildWorkDoneReport(input({
      cards: [...overdueCards, blocked, stuck, finished],
      assigneeIdsByCard: new Map([[blocked.id, [ada.id]]]),
    }));
    const kinds = report.attention.map((group) => group.kind);
    expect(kinds).toEqual(["overdue", "blocked", "tooLong", "inProgress", "unassigned"]);
    const overdue = report.attention[0]!;
    expect(overdue.count).toBe(8);
    expect(overdue.cards).toHaveLength(6);
    // Most overdue first: the card due 8 days ago.
    expect(overdue.cards[0]!.card.id).toBe("od-7");
    expect(report.attention.find((group) => group.kind === "blocked")?.cards[0]?.detail).toBe("Blocked by 2 open cards");
    expect(report.attention.find((group) => group.kind === "tooLong")?.cards[0]?.detail).toBe("In progress for 9 days");
    // The completed card is not open work, whatever its due date.
    expect(report.openCount).toBe(10);
    expect(report.headline).toContain("8 cards are overdue.");
    expect(report.headline).toContain("1 card has been in progress longer than 7 days.");
    // The running stint shows among the period's numbers and as its own group, not only once overdue.
    expect(report.kpis.find((kpi) => kpi.key === "inProgress")?.value).toBe(1);
    expect(report.attention.find((group) => group.kind === "inProgress")?.cards[0]?.card.id).toBe("stuck");
    expect(report.headline).toContain("1 card is in progress right now.");
  });

  it("keeps one bar per shared list and adds by-board and by-workspace breakdowns once the cards span them", () => {
    const boards = [
      { id: "board-1", name: "Platform", icon: "server", color: "blue", inProgressEnabled: true },
      { id: "board-2", name: "Website", icon: null, color: null, inProgressEnabled: true },
    ];
    const open = [
      card({ id: "p1", boardId: "board-1", listId: "todo" }),
      card({ id: "p2", boardId: "board-1", listId: "doing" }),
      card({ id: "w1", boardId: "board-2", listId: "todo", workspaceId: "ws-2" }),
      card({ id: "w2", boardId: "board-2", listId: "todo", workspaceId: "ws-2" }),
      card({ id: "w3", boardId: "board-2", listId: "todo", workspaceId: "ws-2" }),
    ];
    const finished = card({ id: "done", boardId: "board-2", listId: "doing", workspaceId: "ws-2", completedAt: new Date(now - DAY) });
    const report = buildWorkDoneReport(input({
      cards: open,
      boards,
      workspaces: [
        { id: "ws-1", name: "Engineering", icon: null, color: null },
        { id: "ws-2", name: "Marketing", icon: "speakerphone", color: "pink" },
      ],
      lists: [
        { id: "todo", name: "To do", icon: null, color: null, inProgress: false, group: "Engineering" },
        { id: "doing", name: "Doing", icon: "progress", color: "blue", inProgress: true, group: "Engineering" },
        { id: "review", name: "Review", icon: null, color: null, inProgress: false, group: "Marketing" },
      ],
      events: [{ ...event("completed", ada, finished, 1), boardId: "board-2" }],
    }));
    // Lists are shared across a workspace's boards, so one bar per list; the empty one is dropped.
    expect(report.lists.map((bar) => [bar.name, bar.value, bar.group])).toEqual([
      ["To do", 4, "Engineering"],
      ["Doing", 1, "Engineering"],
    ]);
    expect(report.lists[0]!.share).toBe(1);
    expect(report.workspaces.map((bar) => [bar.name, bar.value, bar.hint, bar.icon])).toEqual([
      ["Marketing", 3, "1 completed", "speakerphone"],
      ["Engineering", 2, null, "rocket"],
    ]);
    expect(report.boards.map((bar) => [bar.name, bar.value, bar.hint])).toEqual([
      ["Website", 3, "1 completed"],
      ["Platform", 2, null],
    ]);
    expect(report.boards[0]!.icon).toBe("layout-kanban");
    // Unassigned rows say which board's list the card sits in.
    expect(report.attention.find((group) => group.kind === "unassigned")?.cards[0]?.detail).toBe("Platform · To do");
  });

  it("keeps the plain list chart and no board breakdown for a single board", () => {
    const report = buildWorkDoneReport(input({
      cards: [card({ id: "a" })],
      boards: [{ id: "board-1", name: "Platform", icon: null, color: null, inProgressEnabled: true }],
    }));
    expect(report.lists.map((bar) => bar.name)).toEqual(["To do", "Doing"]);
    expect(report.boards).toEqual([]);
    expect(report.workspaces).toEqual([]);
  });

  it("judges each card by its own workspace's thresholds and skips boards without time in progress", () => {
    const boards = [
      { id: "board-1", name: "Platform", icon: null, color: null, inProgressEnabled: true },
      { id: "board-2", name: "Website", icon: null, color: null, inProgressEnabled: true },
      { id: "board-3", name: "Ops", icon: null, color: null, inProgressEnabled: false },
    ];
    const strict = card({ id: "strict", boardId: "board-1", workspaceId: "ws-strict", listId: "doing", inProgressSince: new Date(now - 3 * DAY) });
    const lax = card({ id: "lax", boardId: "board-2", workspaceId: "ws-lax", listId: "doing", inProgressSince: new Date(now - 3 * DAY) });
    const untracked = card({ id: "untracked", boardId: "board-3", workspaceId: "ws-strict", listId: "doing", inProgressSince: new Date(now - 30 * DAY) });
    const stale = card({ id: "stale", boardId: "board-2", workspaceId: "ws-lax", updatedAt: new Date(now - 5 * DAY) });
    const report = buildWorkDoneReport(input({
      cards: [strict, lax, untracked, stale],
      boards,
      workspaceSettings: new Map([
        ["ws-strict", { inProgressAlertDays: 2, inactiveCardsDays: 14, timeZone: "UTC" }],
        ["ws-lax", { inProgressAlertDays: 10, inactiveCardsDays: 3, timeZone: "UTC" }],
      ]),
    }));
    expect(report.attention.find((group) => group.kind === "tooLong")?.cards.map((entry) => entry.card.id)).toEqual(["strict"]);
    expect(report.attention.find((group) => group.kind === "inactive")?.cards.map((entry) => entry.card.id)).toEqual(["stale"]);
    expect(report.headline).toContain("1 card has been in progress longer than 2 days.");

    // Two thresholds among the stuck cards: no single number is true, so the sentence drops it.
    const both = buildWorkDoneReport(input({
      cards: [strict, card({ id: "lax-stuck", boardId: "board-2", workspaceId: "ws-lax", listId: "doing", inProgressSince: new Date(now - 12 * DAY) })],
      boards,
      workspaceSettings: new Map([
        ["ws-strict", { inProgressAlertDays: 2, inactiveCardsDays: 14, timeZone: "UTC" }],
        ["ws-lax", { inProgressAlertDays: 10, inactiveCardsDays: 14, timeZone: "UTC" }],
      ]),
    }));
    expect(both.headline).toContain("2 cards have been in progress longer than its workspace allows.");
  });

  it("drops the too-long group when time in progress is switched off", () => {
    const stuck = card({ id: "stuck", listId: "doing", inProgressSince: new Date(now - 9 * DAY) });
    const report = buildWorkDoneReport(input({ cards: [stuck], inProgressEnabled: false }));
    expect(report.attention.map((group) => group.kind)).toEqual(["unassigned"]);
  });

  it("adds people with open work but no activity, and scales bars to the busiest person", () => {
    const open = card({ id: "open", dueDateLocalDate: "2000-01-01", dueDateTimezone: "UTC" });
    const report = buildWorkDoneReport(input({
      events: [event("completed", ada, card({ id: "a", completedAt: new Date(now) })), event("moved", ada, card({ id: "b" })), event("moved", ada, card({ id: "c" }))],
      cards: [open],
      assigneeIdsByCard: new Map([[open.id, [bob.id]]]),
    }));
    expect(report.people.map((person) => person.name)).toEqual(["Ada", "Bob"]);
    expect(report.people[0]).toMatchObject({ completed: 1, other: 2, share: 1, open: 0 });
    expect(report.people[1]).toMatchObject({ completed: 0, other: 0, share: 0, open: 1, overdue: 1 });
    expect(report.kpis.find((kpi) => kpi.key === "people")?.value).toBe(1);
  });

  it("breaks open cards down by label and select option, folding long tails into Other", () => {
    const labels = new Map(Array.from({ length: 10 }, (_unused, index) => [`l${index}`, { id: `l${index}`, name: `Label ${index}`, color: null }]));
    const cards = Array.from({ length: 10 }, (_unused, index) => card({ id: `c${index}` }));
    const labelIdsByCard = new Map(cards.map((c, index) => [c.id, [`l${index}`]]));
    const field = { id: "f1", name: "Priority", icon: "flag", options: [{ id: "hi", name: "High", color: "red" }, { id: "lo", name: "Low", color: null }] };
    const fieldValuesByCard = new Map(cards.slice(0, 3).map((c) => [c.id, new Map([["f1", { cardId: c.id, fieldId: "f1", updatedAt: new Date(), valueText: null, valueNumber: null, valueCheckbox: null, valueDate: null, valueUrl: null, valueOptionIds: ["hi"], valueUserIds: null }]])]));
    const report = buildWorkDoneReport(input({ cards, labelsById: labels, labelIdsByCard, selectFields: [field], fieldValuesByCard }));
    expect(report.labels).toHaveLength(8);
    expect(report.labels[7]).toMatchObject({ id: "other", value: 3 });
    expect(report.fields).toHaveLength(1);
    expect(report.fields[0]!.bars).toEqual([expect.objectContaining({ id: "hi", value: 3, share: 1 })]);
    expect(report.fields[0]!.unset).toBe(7);
  });

  it("writes the flow over every day of the period, labelling weekdays for short ranges only", () => {
    const short = buildWorkDoneReport(input({ events: [event("created", ada, card({ id: "a" }), 2)] }));
    expect(short.flow).toHaveLength(5);
    expect(short.flow.every((day) => day.label.length > 0)).toBe(true);
    expect(short.flow[2]!.created).toBe(1);
    expect(short.flow[4]!.isToday).toBe(true);
    expect(short.flowPeak).toBe(1);
    // Thirteen on one day: gridlines at 5, 10 and 15, so the axis runs to 15 and the top label stays inside.
    const busy = buildWorkDoneReport(input({ events: Array.from({ length: 13 }, (_unused, index) => event("created", ada, card({ id: `c${index}` }), 0)) }));
    expect(busy.flowTicks).toEqual([5, 10, 15]);
    expect(busy.flowPeak).toBe(15);

    const long = buildWorkDoneReport(input({ from: addDays(today, -29) }));
    expect(long.flow).toHaveLength(30);
    expect(long.flow.filter((day) => day.label).length).toBeLessThanOrEqual(5);
  });

  it("renders plain text with the headline, the numbers and the named attention cards", () => {
    const overdue = card({ id: "od", key: "ACME-9", title: "Fix billing", dueDateLocalDate: "2000-01-01", dueDateTimezone: "UTC" });
    const report = buildWorkDoneReport(input({
      events: [event("completed", ada, card({ id: "a", completedAt: new Date(now) }))],
      previousDays: [],
      cards: [overdue],
    }));
    const text = buildReportText(report, "Report for Platform · 14–18 Oct");
    expect(text.startsWith("Report for Platform · 14–18 Oct\n\nAda completed 1 card and started no new ones.")).toBe(true);
    expect(text).toContain("Completed: 1 (+1)");
    expect(text).toMatch(/Overdue \(1\)\n- ACME-9 Fix billing · Due .*2000/);
  });
});

describe("niceTicks", () => {
  it("uses every integer up to four, then round steps that cover the peak", () => {
    expect(niceTicks(0)).toEqual([]);
    expect(niceTicks(3)).toEqual([1, 2, 3]);
    expect(niceTicks(9)).toEqual([2.5, 5, 7.5, 10]);
    expect(niceTicks(23)).toEqual([10, 20, 30]);
    expect(niceTicks(100)).toEqual([25, 50, 75, 100]);
  });
});
