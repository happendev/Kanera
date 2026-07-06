import { TestBed } from "@angular/core/testing";
import type {
  CardAttachmentRow,
  WireAssignedWorkPayload,
  WireAssignedWorkSeparator,
  WireCardDetail,
  WireCardSummary,
} from "@kanera/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { SocketService, type AppSocket } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { AssignedWorkSocketBridge } from "./assigned-work-socket-bridge";
import { AssignedWorkState } from "./assigned-work-state";

class SocketStub {
  connected = true;
  readonly emit = vi.fn((event: string, ...args: unknown[]) => {
    if (event === "board:join") {
      const ack = args[1];
      if (typeof ack === "function") (ack as (ok: boolean) => void)(true);
    }
    return this;
  });
  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  });
  readonly off = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.get(event)?.delete(handler);
    return this;
  });
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  trigger(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

function summary(overrides: Partial<WireCardSummary> = {}): WireCardSummary {
  return {
    id: "card-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Demo",
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
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
    assigneeIds: ["user-target"],
    customFieldValues: [],
    ...overrides,
  };
}

function attachment(overrides: Partial<CardAttachmentRow> = {}): CardAttachmentRow {
  return {
    id: "attachment-1",
    cardId: "card-1",
    fileName: "brief.pdf",
    mimeType: "application/pdf",
    byteSize: 1234,
    url: "/uploads/brief.pdf",
    thumbnailUrl: null,
    source: "attachment",
    commentId: null,
    uploadedById: "user-1",
    uploadedByName: "Me",
    uploadedByAvatarUrl: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function assignedSeparator(overrides: Partial<WireAssignedWorkSeparator> = {}): WireAssignedWorkSeparator {
  return {
    id: "separator-1",
    workspaceId: "ws-1",
    targetUserId: "user-target",
    listId: "list-1",
    title: "Break",
    color: null,
    position: "1500.0000000000",
    createdById: "user-1",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function payload(overrides: Partial<WireAssignedWorkPayload> = {}): WireAssignedWorkPayload {
  return {
    workspace: {
      id: "ws-1",
      clientId: "client-1",
      name: "Delivery",
      icon: null,
      accentColor: null,
      completedCardsActiveDays: 35,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      archivedAt: null,
    },
    lists: [
      {
        id: "list-1",
        workspaceId: "ws-1",
        name: "Todo",
        icon: null,
        color: null,
        position: "1000.0000000000",
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      },
    ],
    customFields: [],
    cardLabels: [],
    members: [],
    memberStats: [],
    boards: [
      { id: "board-1", workspaceId: "ws-1", name: "Public", icon: null, iconColor: null },
      { id: "board-2", workspaceId: "ws-1", name: "Private", icon: null, iconColor: null },
    ],
    cards: [summary()],
    checklistItems: [],
    targetUser: { userId: "user-target", displayName: "Target", avatarUrl: null, role: "member" },
    viewerRole: "admin",
    ...overrides,
  };
}

describe("AssignedWorkState", () => {
  let state: AssignedWorkState;
  let bridge: AssignedWorkSocketBridge;
  let api: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    api = { get: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        AssignedWorkState,
        AssignedWorkSocketBridge,
        { provide: WorkspaceService, useValue: { cacheLists: vi.fn(), registerBoards: vi.fn() } },
        { provide: ApiClient, useValue: api },
        { provide: SocketService, useValue: { joinWorkspace: vi.fn(() => vi.fn()) } },
      ],
    });
    state = TestBed.inject(AssignedWorkState);
    bridge = TestBed.inject(AssignedWorkSocketBridge);
    state.hydrateAssignedWork(payload());
  });

  it("removes a card when assignees change away from the target user", () => {
    const socket = new SocketStub();
    socket.connected = false;
    bridge.attach(socket.asSocket(), "ws-1");
    expect(state.cards().map((c) => c.id)).toEqual(["card-1"]);

    socket.trigger("card:assignees:set", { boardId: "board-1", cardId: "card-1", assigneeIds: ["user-other"] });

    expect(state.cards()).toEqual([]);
  });

  it("applies custom field value set and clear events to assigned work card state", () => {
    const socket = new SocketStub();
    socket.connected = false;
    bridge.attach(socket.asSocket(), "ws-1");

    socket.trigger("card:customFieldValue:set", {
      boardId: "board-1",
      cardId: "card-1",
      fieldId: "field-1",
      valueText: "Realtime value",
    });

    expect(state.customFieldValuesForCard("card-1").get("field-1")?.valueText).toBe("Realtime value");

    socket.trigger("card:customFieldValue:cleared", {
      boardId: "board-1",
      cardId: "card-1",
      fieldId: "field-1",
    });

    expect(state.customFieldValuesForCard("card-1").has("field-1")).toBe(false);
  });

  it("hydrates member overdue counts for team tabs", () => {
    state.hydrateAssignedWork(payload({ memberStats: [{ userId: "user-target", overdueCards: 2, overdueChecklistItems: 0 }] }));

    expect(state.memberOverdueCounts().get("user-target")).toBe(2);
  });

  it("requests one assigned-work refresh for assignee changes so tab counts stay current", async () => {
    const socket = new SocketStub();
    socket.connected = false;
    const onDesync = vi.fn();
    bridge.attach(socket.asSocket(), "ws-1", { onDesync });

    socket.trigger("card:assignees:set", { boardId: "board-1", cardId: "card-1", assigneeIds: ["user-target", "user-other"] });
    socket.trigger("card:assignees:set", { boardId: "board-1", cardId: "card-1", assigneeIds: ["user-other"] });
    await Promise.resolve();

    expect(onDesync).toHaveBeenCalledTimes(1);
  });

  it("requests an assigned-work refresh for card updates so overdue and completed tab counts stay current", async () => {
    const socket = new SocketStub();
    socket.connected = false;
    const onDesync = vi.fn();
    bridge.attach(socket.asSocket(), "ws-1", { onDesync });

    socket.trigger("card:updated", {
      boardId: "board-1",
      card: {
        id: "card-1",
        listId: "list-1",
        boardId: "board-1",
        title: "Demo",
        description: null,
        position: "1000.0000000000",
        dueDateLocalDate: "2026-05-20",
        dueDateSlot: "anyTime",
        completedAt: new Date("2026-05-21T10:00:00.000Z"),
        archivedAt: null,
        createdById: "user-1",
        coverAttachmentId: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T10:00:00.000Z"),
      },
    });
    await Promise.resolve();

    expect(onDesync).toHaveBeenCalledTimes(1);
    expect(state.cards()[0]?.completedAt).toEqual(new Date("2026-05-21T10:00:00.000Z"));
  });

  it("ignores board separator events in assigned work", () => {
    const socket = new SocketStub();
    socket.connected = false;
    bridge.attach(socket.asSocket(), "ws-1");

    socket.trigger("separator:created", {
      boardId: "board-1",
      separator: {
        id: "board-separator-1",
        boardId: "board-1",
        listId: "list-1",
        title: "Board only",
        color: null,
        position: "1500.0000000000",
        createdById: "user-1",
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      },
    });

    expect(state.separators()).toEqual([]);
  });

  it("applies only matching assigned-work separator events", () => {
    const socket = new SocketStub();
    socket.connected = false;
    bridge.attach(socket.asSocket(), "ws-1");

    socket.trigger("assignedWorkSeparator:created", {
      workspaceId: "ws-1",
      targetUserId: "user-other",
      separator: assignedSeparator({ id: "separator-other", targetUserId: "user-other" }),
    });
    expect(state.separators()).toEqual([]);

    socket.trigger("assignedWorkSeparator:created", {
      workspaceId: "ws-1",
      targetUserId: "user-target",
      separator: assignedSeparator(),
    });
    expect(state.separators().map((separator) => separator.id)).toEqual(["separator-1"]);

    socket.trigger("assignedWorkSeparator:moved", {
      workspaceId: "ws-1",
      targetUserId: "user-target",
      separatorId: "separator-1",
      fromListId: "list-1",
      toListId: "list-1",
      position: "2500.0000000000",
      prevPosition: "1500.0000000000",
    });
    expect(state.separators()[0]?.position).toBe("2500.0000000000");

    socket.trigger("assignedWorkSeparator:deleted", {
      workspaceId: "ws-1",
      targetUserId: "user-target",
      separatorId: "separator-1",
    });
    expect(state.separators()).toEqual([]);
  });

  it("fetches and adds a card when a previously unassigned card gets assigned to the target user", async () => {
    const socket = new SocketStub();
    socket.connected = false;
    const detail: WireCardDetail = {
      card: {
        id: "card-new",
        listId: "list-1",
        boardId: "board-1",
        title: "Fresh assignment",
        description: null,
        position: "2000.0000000000",
        dueDateLocalDate: null,
        dueDateSlot: null,
        dueDateTimezone: null,
        completedAt: null,
        archivedAt: null,
        createdById: "user-1",
        coverAttachmentId: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      },
      customFieldValues: [],
      labelIds: [],
      assigneeIds: ["user-target"],
      attachments: [],
      checklists: [],
      appliedChecklistTemplateIds: [], linkedNotes: [],
    };
    api.get.mockResolvedValueOnce(detail);
    bridge.attach(socket.asSocket(), "ws-1");

    socket.trigger("card:assignees:set", { boardId: "board-1", cardId: "card-new", assigneeIds: ["user-target"] });
    await Promise.resolve();
    await Promise.resolve();

    expect(api.get).toHaveBeenCalledWith("/cards/card-new/detail");
    const ids = state.cards().map((c) => c.id).sort();
    expect(ids).toEqual(["card-1", "card-new"]);
  });

  it("removes a card when refreshing a new assignment fails", async () => {
    const socket = new SocketStub();
    socket.connected = false;
    api.get.mockRejectedValueOnce(new Error("not found"));
    bridge.attach(socket.asSocket(), "ws-1");

    socket.trigger("card:assignees:set", { boardId: "board-1", cardId: "card-new", assigneeIds: ["user-target"] });
    await Promise.resolve();
    await Promise.resolve();

    expect(api.get).toHaveBeenCalledWith("/cards/card-new/detail");
    expect(state.cards().map((c) => c.id)).toEqual(["card-1"]);
  });

  it("ignores card events from boards not in the visible set", () => {
    const socket = new SocketStub();
    socket.connected = false;
    bridge.attach(socket.asSocket(), "ws-1");

    socket.trigger("card:deleted", { boardId: "board-not-visible", cardId: "card-1" });

    expect(state.cards().map((c) => c.id)).toEqual(["card-1"]);
  });

  it("keeps assigned card attachments and counts in sync from realtime events", () => {
    const socket = new SocketStub();
    socket.connected = false;
    bridge.attach(socket.asSocket(), "ws-1");

    const row = attachment();
    socket.trigger("card:attachment:created", { boardId: "board-1", cardId: "card-1", attachment: row });
    socket.trigger("card:attachment:created", { boardId: "board-1", cardId: "card-1", attachment: row });

    expect(state.attachmentsForCard("card-1").map((a) => a.id)).toEqual(["attachment-1"]);
    expect(state.attachmentCountForCard("card-1")).toBe(1);

    socket.trigger("card:attachment:deleted", { boardId: "board-1", cardId: "card-1", attachmentId: "attachment-1" });
    socket.trigger("card:attachment:deleted", { boardId: "board-1", cardId: "card-1", attachmentId: "attachment-1" });

    expect(state.attachmentsForCard("card-1")).toEqual([]);
    expect(state.attachmentCountForCard("card-1")).toBe(0);
  });

  it("requests a desync refresh when a card moves to an unknown workspace list", () => {
    const socket = new SocketStub();
    socket.connected = false;
    const onDesync = vi.fn();
    bridge.attach(socket.asSocket(), "ws-1", { onDesync });

    socket.trigger("card:moved", {
      boardId: "board-1",
      cardId: "card-1",
      fromListId: "list-1",
      toListId: "list-missing",
      position: "2000.0000000000",
      prevPosition: "1000.0000000000",
    });

    expect(onDesync).toHaveBeenCalledTimes(1);
    expect(state.cards()[0]?.listId).toBe("list-1");
  });

  it("applies workspace-scoped list field and label events only for the attached workspace", () => {
    const socket = new SocketStub();
    socket.connected = false;
    bridge.attach(socket.asSocket(), "ws-1");

    socket.trigger("list:created", {
      workspaceId: "ws-2",
      list: { ...payload().lists[0]!, id: "list-other", workspaceId: "ws-2", name: "Elsewhere" },
    });
    expect(state.lists().map((l) => l.id)).toEqual(["list-1"]);

    socket.trigger("list:created", {
      workspaceId: "ws-1",
      list: { ...payload().lists[0]!, id: "list-2", name: "Doing", position: "2000.0000000000" },
    });
    socket.trigger("customField:created", {
      workspaceId: "ws-1",
      customField: {
        id: "field-1",
        workspaceId: "ws-1",
        name: "Priority",
        icon: "flag",
        type: "text",
        position: "1000.0000000000",
        showOnCard: true,
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      },
    });
    socket.trigger("cardLabel:created", {
      workspaceId: "ws-1",
      cardLabel: {
        id: "label-1",
        workspaceId: "ws-1",
        name: "Blocked",
        color: "rose",
        position: "1000.0000000000",
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      },
    });

    expect(state.lists().map((l) => l.id).sort()).toEqual(["list-1", "list-2"]);
    expect(state.customFields().map((f) => f.id)).toEqual(["field-1"]);
    expect(state.cardLabels().map((l) => l.id)).toEqual(["label-1"]);
  });

  it("keeps visible board summaries and cards in sync with board lifecycle events", () => {
    const socket = new SocketStub();
    socket.connected = false;
    bridge.attach(socket.asSocket(), "ws-1");

    socket.trigger("board:updated", {
      board: {
        id: "board-1",
        workspaceId: "ws-1",
        name: "Renamed",
        description: null,
        icon: "rocket",
        iconColor: "blue",
        backgroundGradient: null,
        position: "1000.0000000000",
        archivedAt: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z"),
      },
    });
    expect(state.boardsById().get("board-1")?.name).toBe("Renamed");

    socket.trigger("board:deleted", { boardId: "board-1" });

    expect(state.isBoardVisible("board-1")).toBe(false);
    expect(state.cards()).toEqual([]);
  });

  it("joins every accessible board on attach", () => {
    const socket = new SocketStub();
    bridge.attach(socket.asSocket(), "ws-1");

    const joinedBoards = socket.emit.mock.calls
      .filter(([event]) => event === "board:join")
      .map(([, id]) => id)
      .sort();
    expect(joinedBoards).toEqual(["board-1", "board-2"]);
  });

  it("notifies once after each assigned-work board join cycle", () => {
    const socket = new SocketStub();
    const onJoined = vi.fn();

    bridge.attach(socket.asSocket(), "ws-1", { onJoined });

    expect(onJoined).toHaveBeenCalledTimes(1);

    socket.trigger("connect");

    expect(onJoined).toHaveBeenCalledTimes(2);
  });
});
