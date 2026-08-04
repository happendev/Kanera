import type { NotificationRow } from "@kanera/shared/dto";
import { describe, expect, it } from "vitest";
import { buildFeedEntries, type ActivityChangeSummary } from "./notification-clusters";

/**
 * Local-time ISO builder. Blocks bucket by the viewer's local calendar day, so a hardcoded "…Z"
 * string would land on a different day depending on where the suite runs.
 */
function localAt(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

function row(overrides: Partial<NotificationRow> & { id: string }): NotificationRow {
  return {
    userId: "user-1",
    clientId: "client-1",
    activityId: "activity-1",
    cardId: "card-1",
    checklistItemId: null,
    listId: "list-1",
    boardId: "board-1",
    workspaceId: "workspace-1",
    reason: "watching",
    readAt: null,
    createdAt: localAt(2026, 5, 21, 10),
    activity: null,
    actorName: "Ada",
    actorAvatarUrl: null,
    cardTitle: "Ship tests",
    cardKey: "WORK-1",
    organisationKey: "0123456789ABCDEF",
    cardCompletedAt: null,
    cardArchivedAt: null,
    cardDueDateLocalDate: null,
    cardDueDateSlot: null,
    cardDueDateTimezone: null,
    checklistItemText: null,
    checklistItemDueDateLocalDate: null,
    checklistItemDueDateSlot: null,
    checklistItemDueDateTimezone: null,
    viewerRole: "editor",
    listName: "Todo",
    listColor: null,
    listIcon: null,
    boardName: "Board",
    boardIcon: null,
    boardIconColor: null,
    workspaceName: "Workspace",
    workspaceIcon: null,
    workspaceAccentColor: null,
    orgName: "Kanera",
    orgLogoUrl: null,
    attachment: null,
    commentBody: null,
    ...overrides,
  } as NotificationRow;
}

const summarise = (n: NotificationRow): ActivityChangeSummary => ({ icon: "ti ti-history", text: `summary-${n.id}` });

/** Newest first, the order the panel hands to buildFeedEntries. */
function build(rows: NotificationRow[]) {
  return buildFeedEntries(rows, summarise);
}

describe("buildFeedEntries", () => {
  it("collapses several unread rows for one card on one day into a block at the newest row's position", () => {
    const entries = build([
      row({ id: "c", createdAt: localAt(2026, 5, 21, 14) }),
      row({ id: "b", createdAt: localAt(2026, 5, 21, 11) }),
      row({ id: "a", createdAt: localAt(2026, 5, 21, 9) }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("cluster");
    const cluster = entries[0]!.cluster!;
    expect(cluster.head.id).toBe("c");
    expect(cluster.entries.map((entry) => entry.notification.id)).toEqual(["c", "b", "a"]);
    expect(cluster.unreadIds).toEqual(["c", "b", "a"]);
    // Summaries are precomputed here, not left to the template.
    expect(cluster.entries.map((entry) => entry.summary.text)).toEqual(["summary-c", "summary-b", "summary-a"]);
  });

  it("starts a fresh block when the same card's activity crosses local midnight", () => {
    const entries = build([
      row({ id: "today-late", createdAt: localAt(2026, 5, 22, 0, 30) }),
      row({ id: "today-early", createdAt: localAt(2026, 5, 22, 0, 5) }),
      row({ id: "yesterday-b", createdAt: localAt(2026, 5, 21, 23, 50) }),
      row({ id: "yesterday-a", createdAt: localAt(2026, 5, 21, 23, 10) }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["cluster", "cluster"]);
    expect(entries[0]!.cluster!.entries.map((entry) => entry.notification.id)).toEqual(["today-late", "today-early"]);
    expect(entries[1]!.cluster!.entries.map((entry) => entry.notification.id)).toEqual(["yesterday-b", "yesterday-a"]);
    expect(entries[0]!.key).not.toBe(entries[1]!.key);
  });

  it("keeps read rows as individual rows even when the card has a block that day", () => {
    const entries = build([
      row({ id: "unread-b", createdAt: localAt(2026, 5, 21, 14) }),
      row({ id: "read", createdAt: localAt(2026, 5, 21, 13), readAt: localAt(2026, 5, 21, 13, 5) }),
      row({ id: "unread-a", createdAt: localAt(2026, 5, 21, 12) }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["cluster", "row"]);
    expect(entries[0]!.cluster!.entries.map((entry) => entry.notification.id)).toEqual(["unread-b", "unread-a"]);
    expect(entries[1]!.notification!.id).toBe("read");
  });

  it("leaves card-less rows and a card's single unread row as plain rows", () => {
    const entries = build([
      row({ id: "board-only", cardId: null, cardTitle: null, createdAt: localAt(2026, 5, 21, 15) }),
      row({ id: "lone", createdAt: localAt(2026, 5, 21, 14) }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["row", "row"]);
    expect(entries.map((entry) => entry.notification!.id)).toEqual(["board-only", "lone"]);
  });

  it("keeps recency order between blocks for interleaved cards", () => {
    const entries = build([
      row({ id: "a2", cardId: "card-a", createdAt: localAt(2026, 5, 21, 16) }),
      row({ id: "b2", cardId: "card-b", createdAt: localAt(2026, 5, 21, 15) }),
      row({ id: "a1", cardId: "card-a", createdAt: localAt(2026, 5, 21, 14) }),
      row({ id: "b1", cardId: "card-b", createdAt: localAt(2026, 5, 21, 13) }),
    ]);

    expect(entries.map((entry) => entry.cluster!.head.id)).toEqual(["a2", "b2"]);
    expect(entries[0]!.cluster!.entries.map((entry) => entry.notification.id)).toEqual(["a2", "a1"]);
    expect(entries[1]!.cluster!.entries.map((entry) => entry.notification.id)).toEqual(["b2", "b1"]);
  });
});
