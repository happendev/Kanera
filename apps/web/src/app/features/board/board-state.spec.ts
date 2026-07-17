import { TestBed } from "@angular/core/testing";
import { SERVER_EVENTS, compactCardSummary, expandCardSummary } from "@kanera/shared/events";
import type { CardAttachmentRow, WireBoardMemberUser, WireCard, WireCardChecklist, WireCardDetail, WireCardLabel, WireCardSummary, WireComment, WireCustomField, WireList, WireSeparator } from "@kanera/shared/events";
import type { Board, Card, CardCustomFieldValue, CardLabel, List } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineBoardSnapshot } from "../../core/offline/offline-cache.service";
import type { AppSocket } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BoardSocketBridge } from "./board-socket-bridge";
import { BoardState, type AnyCard } from "./board-state";

class SocketStub {
  connected = true;
  readonly emit = vi.fn((event: string, ...args: unknown[]) => {
    if (event === "board:join") {
      const ack = args[1];
      if (typeof ack === "function") {
        (ack as (ok: boolean) => void)(true);
      }
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
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

function createBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: "board-1",
    workspaceId: "workspace-1",
    groupId: null,
    standaloneGroupId: null,
    name: "Roadmap",
    description: null,
    icon: null,
    iconColor: null,
    backgroundGradient: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createList(overrides: Partial<List> = {}): WireList {
  return {
    id: "list-1",
    workspaceId: "workspace-1",
    name: "Todo",
    icon: null,
    color: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createCard(overrides: Partial<Card> = {}): WireCard {
  return {
    id: "card-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Ship realtime tests",
    description: null,
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    createdById: "user-1",
    coverAttachmentId: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createSeparator(overrides: Partial<WireSeparator> = {}): WireSeparator {
  return {
    id: "separator-1",
    boardId: "board-1",
    listId: "list-1",
    title: "Lane break",
    color: null,
    position: "1500.0000000000",
    createdById: "user-1",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  } as WireSeparator;
}

function createCardSummary(overrides: Partial<WireCardSummary> = {}): WireCardSummary {
  return {
    id: "card-1",
    listId: "list-1",
    boardId: "board-1",
    title: "Ship realtime tests",
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
    assigneeIds: [],
    customFieldValues: [],
    ...overrides,
  };
}

function createComment(overrides: Partial<WireComment> = {}): WireComment {
  return {
    id: "comment-1",
    cardId: "card-1",
    authorId: "user-1",
    authorKind: "user",
    apiKeyId: null,
    apiKeyName: null,
    body: "Looks good.",
    editedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    authorName: "Ada Lovelace",
    authorAvatarUrl: null,
    reactions: [],
    ...overrides,
  };
}

function createChecklist(overrides: Partial<WireCardChecklist> = {}): WireCardChecklist {
  return {
    id: "checklist-1",
    cardId: "card-1",
    parentItemId: null,
    title: "Launch prep",
    position: "1000.0000000000",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    items: [],
    ...overrides,
  };
}

function createCardDetail(overrides: Partial<WireCardDetail> = {}): WireCardDetail {
  return {
    card: createCard(),
    customFieldValues: [],
    labelIds: [],
    assigneeIds: [],
    attachments: [],
    checklists: [],
    appliedChecklistTemplateIds: [],
    linkedNotes: [],
    ...overrides,
  };
}

function createAttachment(overrides: Partial<CardAttachmentRow> = {}): CardAttachmentRow {
  return {
    id: "attachment-1",
    cardId: "card-1",
    fileName: "brief.pdf",
    mimeType: "application/pdf",
    byteSize: 1200,
    url: "/files/brief.pdf",
    thumbnailUrl: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    uploadedById: "user-1",
    uploadedByName: "Ada Lovelace",
    uploadedByAvatarUrl: null,
    source: "attachment",
    commentId: null,
    ...overrides,
  };
}

function createCardLabel(overrides: Partial<CardLabel> = {}): WireCardLabel {
  return {
    id: "label-1",
    workspaceId: "workspace-1",
    name: "Blocked",
    color: "rose",
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createMember(overrides: Partial<WireBoardMemberUser> = {}): WireBoardMemberUser {
  return {
    userId: "user-1",
    displayName: "Ada Lovelace",
    avatarUrl: null,
    role: "editor",
    source: "workspace",
    ...overrides,
  };
}

function createCustomField(overrides: Partial<WireCustomField> = {}): WireCustomField {
  return {
    id: "field-1",
    workspaceId: "workspace-1",
    name: "Owner",
    icon: "forms",
    type: "user",
    allowMultiple: false,
    position: "1000.0000000000",
    showOnCard: true,
    archivedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    options: [],
    ...overrides,
  };
}

function createCustomFieldValue(overrides: Partial<CardCustomFieldValue> = {}): CardCustomFieldValue {
  return {
    cardId: "card-1",
    fieldId: "field-1",
    valueText: null,
    valueNumber: null,
    valueCheckbox: null,
    valueDate: null,
    valueUrl: null,
    valueOptionIds: null,
    valueUserIds: null,
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function expectCardStateInvariants(state: BoardState) {
  const cards = state.cards();
  expect(state.snapshotCards()).toEqual(cards);
  expect(state.cardsById().size).toBe(cards.length);

  for (const card of cards) {
    expect(state.cardById(card.id)).toBe(card);
    expect(state.hasCard(card.id)).toBe(true);
    if ("attachmentCount" in card) {
      expect(state.attachmentCountForCard(card.id)).toBe(card.attachmentCount);
    }
  }

  for (const list of state.lists()) {
    const expected = cards
      .filter((card) => card.listId === list.id && !card.archivedAt)
      .sort((a, b) => Number(a.position) - Number(b.position));
    expect(state.cardsForList(list.id)).toEqual(expected);
  }
}

describe("card summary wire compaction", () => {
  it("drops default fields and restores them on expand", () => {
    const empty = createCardSummary();
    const compact = compactCardSummary(empty);
    // Default fields are absent on the wire...
    expect("archivedAt" in compact).toBe(false);
    expect("dueDateLocalDate" in compact).toBe(false);
    expect("coverUrl" in compact).toBe(false);
    expect("labelIds" in compact).toBe(false);
    expect("hasDescription" in compact).toBe(false);
    expect("commentCount" in compact).toBe(false);
    // ...identity/ordering fields always remain.
    expect(compact.id).toBe("card-1");
    expect(compact.position).toBe("1000.0000000000");
    // Expanding restores the full default-filled shape the rest of the app expects.
    expect(expandCardSummary(compact)).toEqual(empty);
  });

  it("preserves non-default values through a round trip", () => {
    const populated = createCardSummary({
      dueDateLocalDate: "2026-06-10",
      dueDateSlot: "morning",
      completedAt: new Date("2026-05-21T10:00:00.000Z"),
      coverUrl: "/media/cover.png",
      hasDescription: true,
      commentCount: 3,
      checklistTotalCount: 2,
      labelIds: ["label-1"],
      assigneeIds: ["user-1"],
      customFieldValues: [createCustomFieldValue()],
    });

    expect(expandCardSummary(compactCardSummary(populated))).toEqual(populated);
  });
});

describe("BoardState realtime regressions", () => {
  let state: BoardState;
  let bridge: BoardSocketBridge;
  let workspaceService: { cacheLists: ReturnType<typeof vi.fn>; registerBoards: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    workspaceService = { cacheLists: vi.fn(), registerBoards: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        BoardState,
        BoardSocketBridge,
        { provide: WorkspaceService, useValue: workspaceService },
      ],
    });

    state = TestBed.inject(BoardState);
    bridge = TestBed.inject(BoardSocketBridge);
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCard()],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
  });

  it("stores and clears the board workspace owner client id", () => {
    state.hydrate({
      board: createBoard(),
      workspaceClientId: "owner-org",
      lists: [createList()],
      cards: [createCard()],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    expect(state.workspaceClientId()).toBe("owner-org");

    state.clear();

    expect(state.workspaceClientId()).toBeNull();
  });

  it("keeps every separator in a lane when the supplied card set is filtered", () => {
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [
        createCard({ id: "card-a", position: "1000.0000000000" }),
        createCard({ id: "card-b", position: "4000.0000000000" }),
      ],
      separators: [
        createSeparator({ id: "separator-a", position: "2000.0000000000" }),
        createSeparator({ id: "separator-b", position: "3000.0000000000" }),
      ],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    const itemIds = (cards: AnyCard[]) => state.itemsForList("list-1", cards)
      .map((item) => item.kind === "card" ? item.card.id : item.separator.id);

    expect(itemIds([state.cardById("card-a")!])).toEqual(["card-a", "separator-a", "separator-b"]);
    expect(itemIds([])).toEqual(["separator-a", "separator-b"]);
  });

  it("re-emits board:join after reconnect", () => {
    const socket = new SocketStub();

    const detach = bridge.attach(socket.asSocket(), "board-1");

    let joinCalls = socket.emit.mock.calls.filter(([event]) => event === "board:join");
    expect(joinCalls).toHaveLength(1);

    socket.trigger("connect");

    joinCalls = socket.emit.mock.calls.filter(([event]) => event === "board:join");
    expect(joinCalls).toHaveLength(2);
    expect(joinCalls[1]?.[1]).toBe("board-1");

    detach();
    expect(socket.emit).toHaveBeenCalledWith("board:leave", "board-1");
  });

  it("notifies after each successful board join", () => {
    const socket = new SocketStub();
    const onJoined = vi.fn();

    bridge.attach(socket.asSocket(), "board-1", { onJoined });

    expect(onJoined).toHaveBeenCalledTimes(1);

    socket.trigger("connect");

    expect(onJoined).toHaveBeenCalledTimes(2);
  });

  it("applies board role changes to the roster and the active viewer in realtime", () => {
    const socket = new SocketStub();
    const viewer = createMember({ userId: "user-1", role: "editor", source: "board" });
    const teammate = createMember({ userId: "user-2", role: "editor", source: "board" });
    state.members.set([viewer, teammate]);
    state.assignableMembers.set([viewer, teammate]);
    bridge.attach(socket.asSocket(), "board-1", { viewerUserId: "user-1" });

    const emitRoleUpdate = (boardId: string, user: WireBoardMemberUser) => socket.trigger(
      SERVER_EVENTS.BOARD_MEMBER_UPDATED,
      {
        boardId,
        member: { boardId, userId: user.userId, role: user.role, pinned: false, addedAt: new Date() },
        user,
      },
    );

    emitRoleUpdate("board-1", { ...viewer, role: "observer" });
    expect(state.viewerRole()).toBe("observer");
    expect(state.canEditRole()).toBe(false);
    expect(state.members().find((member) => member.userId === "user-1")?.role).toBe("observer");
    expect(state.assignableMembers().find((member) => member.userId === "user-1")?.role).toBe("observer");

    emitRoleUpdate("board-1", { ...viewer, role: "editor" });
    expect(state.viewerRole()).toBe("editor");
    expect(state.canEditRole()).toBe(true);

    emitRoleUpdate("board-1", { ...teammate, role: "observer" });
    expect(state.viewerRole()).toBe("editor");
    expect(state.members().find((member) => member.userId === "user-2")?.role).toBe("observer");
    expect(state.assignableMembers().find((member) => member.userId === "user-2")?.role).toBe("observer");

    emitRoleUpdate("board-2", { ...viewer, role: "observer" });
    expect(state.viewerRole()).toBe("editor");
    expect(state.members().find((member) => member.userId === "user-1")?.role).toBe("editor");
  });

  it("applies the authoritative membership fields when a board member is added", () => {
    const socket = new SocketStub();
    bridge.attach(socket.asSocket(), "board-1");
    const user = createMember({ userId: "user-2", role: "editor", source: "board" });

    socket.trigger(SERVER_EVENTS.BOARD_MEMBER_ADDED, {
      boardId: "board-1",
      member: {
        boardId: "board-1",
        userId: "user-2",
        role: "observer",
        pinned: true,
        assignedItemsOnly: true,
        addedAt: new Date(),
      },
      user,
    });

    expect(state.members()).toContainEqual(expect.objectContaining({
      userId: "user-2",
      role: "observer",
      source: "board",
      pinned: true,
      assignedItemsOnly: true,
    }));
    expect(state.assignableMembers()).toEqual(state.members());
  });

  it("clears card and checklist assignments as soon as board membership is removed", () => {
    const socket = new SocketStub();
    const removed = createMember({ userId: "user-2" });
    state.members.set([createMember({ userId: "user-1" }), removed]);
    state.assignableMembers.set([createMember({ userId: "user-1" }), removed]);
    state.setCardAssignees("card-1", ["user-1", "user-2"]);
    state.detailedCards.set(new Map([["card-1", createCardDetail({
      checklists: [createChecklist({
        items: [{
          id: "item-1", checklistId: "checklist-1", text: "Review", position: "1000.0000000000",
          description: null,
          assigneeId: "user-2", dueDateLocalDate: null, dueDateSlot: null, dueDateTimezone: null,
          completedAt: null, completedById: null, createdAt: new Date(), updatedAt: new Date(),
        }],
      })],
    })]]));
    bridge.attach(socket.asSocket(), "board-1");

    socket.trigger(SERVER_EVENTS.BOARD_MEMBER_REMOVED, { boardId: "board-1", userId: "user-2" });

    expect(state.members().map((member) => member.userId)).toEqual(["user-1"]);
    expect(state.assignableMembers().map((member) => member.userId)).toEqual(["user-1"]);
    expect(state.assigneeIdsForCard("card-1")).toEqual(["user-1"]);
    expect(state.checklistsForCard("card-1")[0]?.items[0]?.assigneeId).toBeNull();
  });

  it("advances the card detail revision for realtime moves and rebalances", () => {
    const socket = new SocketStub();
    bridge.attach(socket.asSocket(), "board-1");

    expect(state.cardDetailRealtimeRevision("card-1")).toBe(0);
    socket.trigger(SERVER_EVENTS.CARD_MOVED, {
      boardId: "board-1",
      cardId: "card-1",
      fromListId: "list-1",
      toListId: "list-1",
      position: "2000.0000000000",
      prevPosition: "1000.0000000000",
    });
    expect(state.cardDetailRealtimeRevision("card-1")).toBe(1);

    socket.trigger(SERVER_EVENTS.CARD_REBALANCED, {
      boardId: "board-1",
      positions: [{ id: "card-1", position: "1000.0000000000" }],
    });
    expect(state.cardDetailRealtimeRevision("card-1")).toBe(2);
  });

  it("ignores workspace membership changes for board member state", () => {
    const socket = new SocketStub();
    state.members.set([createMember({ userId: "board-user" })]);
    state.setCardAssignees("card-1", ["board-user"]);
    bridge.attach(socket.asSocket(), "board-1");

    socket.trigger(SERVER_EVENTS.WORKSPACE_MEMBER_ADDED, {
      workspaceId: "workspace-1",
      member: {
        workspaceId: "workspace-1",
        userId: "user-2",
        role: "editor",
        displayName: "Grace Hopper",
        avatarUrl: null,
        lastOnlineAt: null,
        addedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    expect(state.members().map((member) => member.userId)).toEqual(["board-user"]);

    socket.trigger(SERVER_EVENTS.WORKSPACE_MEMBER_UPDATED, {
      workspaceId: "workspace-1",
      member: {
        workspaceId: "workspace-1",
        userId: "user-2",
        role: "observer",
        addedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    expect(state.members()[0]?.role).toBe("editor");

    socket.trigger(SERVER_EVENTS.WORKSPACE_MEMBER_REMOVED, { workspaceId: "workspace-1", userId: "user-2" });
    expect(state.members().map((member) => member.userId)).toEqual(["board-user"]);
    expect(state.assigneeIdsForCard("card-1")).toEqual(["board-user"]);
  });

  it("applies custom field value set and clear events to board and list card state", () => {
    const socket = new SocketStub();
    state.customFields.set([createCustomField()]);
    bridge.attach(socket.asSocket(), "board-1");

    socket.trigger(SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, {
      boardId: "board-1",
      cardId: "card-1",
      fieldId: "field-1",
      valueText: "Realtime value",
    });

    expect(state.customFieldValuesForCard("card-1").get("field-1")?.valueText).toBe("Realtime value");

    socket.trigger(SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED, {
      boardId: "board-1",
      cardId: "card-1",
      fieldId: "field-1",
    });

    expect(state.customFieldValuesForCard("card-1").has("field-1")).toBe(false);
  });

  it("hydrates card summary custom field values for all field types", () => {
    const values = [
      createCustomFieldValue({ fieldId: "field-date", valueDate: "2026-06-10" }),
      createCustomFieldValue({ fieldId: "field-url", valueUrl: "https://example.test/spec" }),
      createCustomFieldValue({ fieldId: "field-select", valueOptionIds: ["00000000-0000-0000-0000-000000000001"] }),
      createCustomFieldValue({ fieldId: "field-user", valueUserIds: ["00000000-0000-0000-0000-000000000002"] }),
    ];

    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCardSummary({ customFieldValues: values })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    const hydrated = state.customFieldValuesByCardAndField().get("card-1");
    expect(hydrated?.get("field-date")?.valueDate).toBe("2026-06-10");
    expect(hydrated?.get("field-url")?.valueUrl).toBe("https://example.test/spec");
    expect(hydrated?.get("field-select")?.valueOptionIds).toEqual(["00000000-0000-0000-0000-000000000001"]);
    expect(hydrated?.get("field-user")?.valueUserIds).toEqual(["00000000-0000-0000-0000-000000000002"]);
  });

  it("preserves present card details and prunes stale details when hydrating summaries", () => {
    const checklist = createChecklist();
    state.setCardDetail(createCardDetail({ checklists: [checklist] }));
    state.setCardDetail(createCardDetail({
      card: createCard({ id: "card-stale", position: "2000.0000000000" }),
      checklists: [createChecklist({ id: "checklist-stale", cardId: "card-stale" })],
    }));

    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCardSummary({ id: "card-1", checklistTotalCount: 1 })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    expect(state.checklistsForCard("card-1")).toEqual([checklist]);
    expect(state.detailForCard("card-stale")).toBeNull();
  });

  it("keeps an open card's attachments when a reconnect re-hydrates summaries", () => {
    // Regression: the summary payload from /boards/:id/open carries only an attachment
    // count, never the rows. A reconnect/desync refresh re-runs hydrate while a card
    // detail can be open, and previously blanked cardAttachments wholesale — making the
    // open card's attachments vanish until /cards/:id/detail refetched (forced by a
    // manual close/reopen). Rows for cards whose detail we retain must survive.
    const attachment = createAttachment();
    state.setCardDetail(createCardDetail({ attachments: [attachment] }));
    state.setCardDetail(createCardDetail({
      card: createCard({ id: "card-stale", position: "2000.0000000000" }),
      attachments: [createAttachment({ id: "attachment-stale", cardId: "card-stale" })],
    }));

    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      // card-1 keeps its loaded detail; card-stale is gone from the payload.
      cards: [createCardSummary({ id: "card-1", attachmentCount: 1 })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    expect(state.attachmentsForCard("card-1")).toEqual([attachment]);
    expect(state.attachmentCountForCard("card-1")).toBe(1);
    // The pruned card's detail and its orphaned attachment rows are dropped.
    expect(state.detailForCard("card-stale")).toBeNull();
    expect(state.attachmentsForCard("card-stale")).toEqual([]);
  });

  it("keeps an open card's hidden custom field values when a reconnect re-hydrates summaries", () => {
    // The board-open payload inlines only showOnCard field values. A reconnect re-hydrate
    // must not drop an open card detail's non-showOnCard values (loaded via setCardDetail)
    // or they blank until /cards/:id/detail refetches.
    const shownValue = createCustomFieldValue({ fieldId: "field-shown", valueText: "shown" });
    const hiddenValue = createCustomFieldValue({ fieldId: "field-hidden", valueText: "hidden" });
    state.setCardDetail(createCardDetail({ customFieldValues: [shownValue, hiddenValue] }));

    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      // Summary re-hydrate carries only the showOnCard value for the still-present card.
      cards: [createCardSummary({ id: "card-1", customFieldValues: [shownValue] })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
      customFieldValuesComplete: false,
    });

    const values = state.customFieldValuesForCard("card-1");
    expect(values.get("field-shown")?.valueText).toBe("shown");
    expect(values.get("field-hidden")?.valueText).toBe("hidden");
  });

  it("tracks card existence through the cardsById index across mutations", () => {
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCardSummary({ id: "card-a" }), createCardSummary({ id: "card-b", position: "2000.0000000000" })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    expect(state.hasCard("card-a")).toBe(true);
    expect(state.hasCard("card-b")).toBe(true);
    expect(state.hasCard("missing")).toBe(false);
    expect(state.cardById("card-a")?.id).toBe("card-a");

    state.addCard(createCardSummary({ id: "card-c", position: "3000.0000000000" }));
    expect(state.hasCard("card-c")).toBe(true);

    state.moveCard("card-a", "list-1", "4000.0000000000");
    expect(state.cardById("card-a")?.position).toBe("4000.0000000000");
  });

  it("maintains cheap lookup indexes for supporting board entities", () => {
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCardSummary({ labelIds: ["label-1"], assigneeIds: ["user-1"] })],
      customFields: [createCustomField()],
      cardLabels: [createCardLabel()],
      members: [createMember()],
      viewerRole: "editor",
    });

    expect(state.labelsById().get("label-1")?.name).toBe("Blocked");
    expect(state.membersById().get("user-1")?.displayName).toBe("Ada Lovelace");
    expect(state.customFieldsById().get("field-1")?.type).toBe("user");
    expect(state.labelIdSetsByCard().get("card-1")?.has("label-1")).toBe(true);
    expect(state.assigneeIdSetsByCard().get("card-1")?.has("user-1")).toBe(true);

    state.setCardLabels("card-1", ["label-2"]);
    state.setCardAssignees("card-1", ["user-2"]);

    expect(state.labelIdSetsByCard().get("card-1")?.has("label-1")).toBe(false);
    expect(state.labelIdSetsByCard().get("card-1")?.has("label-2")).toBe(true);
    expect(state.assigneeIdSetsByCard().get("card-1")?.has("user-1")).toBe(false);
    expect(state.assigneeIdSetsByCard().get("card-1")?.has("user-2")).toBe(true);
  });

  it("funnels card rebalance, delete, and attachment count mutations through BoardState", () => {
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [
        createCardSummary({ id: "card-a", position: "1000.0000000000", attachmentCount: 1 }),
        createCardSummary({ id: "card-b", position: "2000.0000000000", attachmentCount: 0 }),
      ],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    expectCardStateInvariants(state);

    state.rebalanceCards([
      { id: "card-a", position: "3000.0000000000" },
      { id: "card-hidden", position: "3500.0000000000" },
      { id: "card-b", position: "4000.0000000000" },
    ]);
    expect(state.cardById("card-a")?.position).toBe("3000.0000000000");
    expect(state.cardById("card-b")?.position).toBe("4000.0000000000");
    expect(state.hasCard("card-hidden")).toBe(false);
    expectCardStateInvariants(state);

    state.incrementAttachmentCount("card-a");
    expect(state.attachmentCountForCard("card-a")).toBe(2);
    expectCardStateInvariants(state);

    state.decrementAttachmentCount("card-a");
    state.decrementAttachmentCount("card-a");
    state.decrementAttachmentCount("card-a");
    expect(state.attachmentCountForCard("card-a")).toBe(0);
    expectCardStateInvariants(state);

    state.removeCard("card-b");
    expect(state.hasCard("card-b")).toBe(false);
    expect(state.cards().map((card) => card.id)).toEqual(["card-a"]);
    expectCardStateInvariants(state);

    state.upsertCard(createCardSummary({ id: "card-a", title: "Updated title", attachmentCount: 4 }));
    state.upsertCard(createCardSummary({ id: "card-c", position: "5000.0000000000", attachmentCount: 1 }));
    expect(state.cardById("card-a")?.title).toBe("Updated title");
    expect(state.hasCard("card-c")).toBe(true);
    expectCardStateInvariants(state);

    state.removeCardsForBoard("board-1");
    expect(state.cards()).toEqual([]);
    expectCardStateInvariants(state);
  });

  it("resolves rendered-slice boundary drops against hidden cards in the full list", () => {
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: Array.from({ length: 75 }, (_, i) =>
        createCardSummary({
          id: `card-${i}`,
          position: `${(i + 1) * 1000}.0000000000`,
        }),
      ),
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    const position = state.positionForCardDrop("card-0", "list-1", undefined, "card-29");

    expect(Number(position)).toBeGreaterThan(30000);
    expect(Number(position)).toBeLessThan(31000);
  });

  it("keeps completed cards in list cards when they are in active state", () => {
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [
        createCardSummary({ id: "card-open", position: "2000.0000000000" }),
        createCardSummary({ id: "card-completed", position: "1000.0000000000", completedAt: new Date("2026-05-21T10:00:00.000Z") }),
      ],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

    expect(state.cardsForList("list-1").map((card) => card.id)).toEqual(["card-completed", "card-open"]);
  });

  it("requests a resync when a board event references missing local state", () => {
    const socket = new SocketStub();
    socket.connected = false;
    const onDesync = vi.fn();

    bridge.attach(socket.asSocket(), "board-1", { onDesync });

    socket.trigger("card:moved", {
      boardId: "board-1",
      cardId: "missing-card",
      fromListId: "list-1",
      toListId: "list-1",
      position: "2000.0000000000",
      prevPosition: "1000.0000000000",
    });

    expect(onDesync).toHaveBeenCalledTimes(1);
    expect(state.cards().map((card) => card.id)).toEqual(["card-1"]);
  });

  it("applies card rebalance and delete socket events through board state", () => {
    const socket = new SocketStub();
    socket.connected = false;
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [
        createCardSummary({ id: "card-a", position: "1000.0000000000" }),
        createCardSummary({ id: "card-b", position: "2000.0000000000" }),
      ],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    bridge.attach(socket.asSocket(), "board-1");

    socket.trigger("card:rebalanced", {
      boardId: "board-1",
      positions: [
        { id: "card-a", position: "3000.0000000000" },
        { id: "card-b", position: "4000.0000000000" },
      ],
    });
    expect(state.cardById("card-a")?.position).toBe("3000.0000000000");
    expect(state.cardById("card-b")?.position).toBe("4000.0000000000");

    socket.trigger("card:deleted", { boardId: "board-1", cardId: "card-b" });

    expect(state.hasCard("card-b")).toBe(false);
    expect(state.cards().map((card) => card.id)).toEqual(["card-a"]);
  });

  it("ignores list events from a different workspace", () => {
    const socket = new SocketStub();
    socket.connected = false;

    bridge.attach(socket.asSocket(), "board-1");

    socket.trigger("list:created", {
      workspaceId: "workspace-2",
      list: createList({ id: "list-2", workspaceId: "workspace-2", name: "Elsewhere" }),
    });

    expect(state.lists().map((list) => list.id)).toEqual(["list-1"]);

    socket.trigger("list:created", {
      workspaceId: "workspace-1",
      list: createList({ id: "list-2", name: "Review" }),
    });

    expect(state.lists().map((list) => list.id)).toEqual(["list-1", "list-2"]);
  });

  it("ignores label events from a different workspace", () => {
    const socket = new SocketStub();
    socket.connected = false;

    bridge.attach(socket.asSocket(), "board-1");

    socket.trigger("cardLabel:created", {
      workspaceId: "workspace-2",
      cardLabel: createCardLabel({ id: "label-2", workspaceId: "workspace-2", name: "Foreign" }),
    });

    expect(state.cardLabels()).toEqual([]);

    socket.trigger("cardLabel:created", {
      workspaceId: "workspace-1",
      cardLabel: createCardLabel({ id: "label-2", name: "Ready" }),
    });

    expect(state.cardLabels().map((label) => label.id)).toEqual(["label-2"]);
  });

  it("does not double-count duplicate comment create or delete events", () => {
    const socket = new SocketStub();
    socket.connected = false;
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCardSummary({ commentCount: 1 })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    bridge.attach(socket.asSocket(), "board-1");

    const comment = createComment({ id: "comment-2" });
    socket.trigger("comment:created", { boardId: "board-1", cardId: "card-1", comment });
    socket.trigger("comment:created", { boardId: "board-1", cardId: "card-1", comment });

    expect(state.commentCountForCard("card-1")).toBe(2);

    socket.trigger("comment:deleted", { boardId: "board-1", cardId: "card-1", commentId: "comment-2" });
    socket.trigger("comment:deleted", { boardId: "board-1", cardId: "card-1", commentId: "comment-2" });

    expect(state.commentCountForCard("card-1")).toBe(1);
  });

  it("does not double-count duplicate attachment create or delete events", () => {
    const socket = new SocketStub();
    socket.connected = false;
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCardSummary()],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    bridge.attach(socket.asSocket(), "board-1");

    const attachment = createAttachment();
    socket.trigger("card:attachment:created", { boardId: "board-1", cardId: "card-1", attachment });
    socket.trigger("card:attachment:created", { boardId: "board-1", cardId: "card-1", attachment });

    expect(state.attachmentsForCard("card-1").map((row) => row.id)).toEqual(["attachment-1"]);
    expect(state.attachmentCountForCard("card-1")).toBe(1);

    socket.trigger("card:attachment:deleted", { boardId: "board-1", cardId: "card-1", attachmentId: "attachment-1" });
    socket.trigger("card:attachment:deleted", { boardId: "board-1", cardId: "card-1", attachmentId: "attachment-1" });

    expect(state.attachmentsForCard("card-1")).toEqual([]);
    expect(state.attachmentCountForCard("card-1")).toBe(0);
  });

  it("updates checklist progress counts from item realtime events", () => {
    const socket = new SocketStub();
    socket.connected = false;
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCardSummary({ checklistDoneCount: 1, checklistTotalCount: 2 })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    bridge.attach(socket.asSocket(), "board-1");

    const createdItem = {
      id: "item-3",
      checklistId: "checklist-1",
      text: "Ship it",
      position: "3000.0000000000",
      completedAt: null,
      completedById: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    };

    socket.trigger("card:checklistItem:created", { boardId: "board-1", cardId: "card-1", cardTitle: "Card 1", listId: "list-1", checklistId: "checklist-1", checklistParentItemId: null, item: createdItem });
    expect(state.cards()[0]).toMatchObject({ checklistDoneCount: 1, checklistTotalCount: 3 });

    socket.trigger("card:checklistItem:updated", {
      boardId: "board-1",
      cardId: "card-1",
      cardTitle: "Card 1",
      listId: "list-1",
      checklistId: "checklist-1",
      checklistParentItemId: null,
      prevCompletedAt: null,
      item: { ...createdItem, completedAt: new Date("2026-05-21T01:00:00.000Z"), completedById: "user-1" },
    });
    expect(state.cards()[0]).toMatchObject({ checklistDoneCount: 2, checklistTotalCount: 3 });

    socket.trigger("card:checklistItem:deleted", { boardId: "board-1", cardId: "card-1", checklistId: "checklist-1", checklistParentItemId: null, itemId: "item-3", completedAt: new Date("2026-05-21T01:00:00.000Z") });
    expect(state.cards()[0]).toMatchObject({ checklistDoneCount: 1, checklistTotalCount: 2 });
  });

  it("keeps nested checklist item realtime events out of the card progress badge", () => {
    const socket = new SocketStub();
    socket.connected = false;
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCardSummary({ checklistDoneCount: 1, checklistTotalCount: 2 })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    const nested = createChecklist({ id: "nested-1", parentItemId: "item-1" });
    state.setCardDetail(createCardDetail({ checklists: [createChecklist(), nested] }));
    bridge.attach(socket.asSocket(), "board-1");

    const item = {
      id: "nested-item-1",
      checklistId: nested.id,
      text: "Nested step",
      description: null,
      position: "1000.0000000000",
      assigneeId: null,
      dueDateLocalDate: null,
      dueDateSlot: null,
      dueDateTimezone: null,
      completedAt: null,
      completedById: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    };
    socket.trigger(SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED, { boardId: "board-1", cardId: "card-1", cardTitle: "Card 1", listId: "list-1", checklistId: nested.id, checklistParentItemId: "item-1", item });
    socket.trigger(SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, {
      boardId: "board-1",
      cardId: "card-1",
      cardTitle: "Card 1",
      listId: "list-1",
      checklistId: nested.id,
      checklistParentItemId: "item-1",
      prevCompletedAt: null,
      item: { ...item, completedAt: new Date("2026-05-21T01:00:00.000Z") },
    });
    expect(state.cards()[0]).toMatchObject({ checklistDoneCount: 1, checklistTotalCount: 2 });
  });

  // The badge-drift bug: when the card detail isn't cached locally, the client can't look up the
  // containing checklist's parentItemId, so it must trust the event's checklistParentItemId to tell
  // nested sub-items (excluded from the badge) from top-level items (counted). Without setCardDetail
  // here, the old cache-defaulting logic wrongly counted the nested item.
  it("uses checklistParentItemId to keep nested item events off the badge when the card detail is not cached", () => {
    const socket = new SocketStub();
    socket.connected = false;
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards: [createCardSummary({ checklistDoneCount: 1, checklistTotalCount: 2 })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    bridge.attach(socket.asSocket(), "board-1");

    const nestedItem = {
      id: "nested-item-1",
      checklistId: "nested-1",
      text: "Nested step",
      description: null,
      position: "1000.0000000000",
      assigneeId: null,
      dueDateLocalDate: null,
      dueDateSlot: null,
      dueDateTimezone: null,
      completedAt: null,
      completedById: null,
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    };

    // Nested item (checklistParentItemId set): must not touch the top-level badge.
    socket.trigger(SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED, { boardId: "board-1", cardId: "card-1", cardTitle: "Card 1", listId: "list-1", checklistId: "nested-1", checklistParentItemId: "item-1", item: nestedItem });
    socket.trigger(SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, {
      boardId: "board-1",
      cardId: "card-1",
      cardTitle: "Card 1",
      listId: "list-1",
      checklistId: "nested-1",
      checklistParentItemId: "item-1",
      prevCompletedAt: null,
      item: { ...nestedItem, completedAt: new Date("2026-05-21T01:00:00.000Z") },
    });
    socket.trigger(SERVER_EVENTS.CARD_CHECKLIST_ITEM_DELETED, { boardId: "board-1", cardId: "card-1", checklistId: "nested-1", checklistParentItemId: "item-1", itemId: "nested-item-1", completedAt: new Date("2026-05-21T01:00:00.000Z") });
    expect(state.cards()[0]).toMatchObject({ checklistDoneCount: 1, checklistTotalCount: 2 });

    // Top-level item (checklistParentItemId null): still counted even with no cached detail.
    socket.trigger(SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED, { boardId: "board-1", cardId: "card-1", cardTitle: "Card 1", listId: "list-1", checklistId: "checklist-1", checklistParentItemId: null, item: { ...nestedItem, id: "top-item-1", checklistId: "checklist-1" } });
    expect(state.cards()[0]).toMatchObject({ checklistDoneCount: 1, checklistTotalCount: 3 });
  });

  it("keeps only the ten most recently used card details", () => {
    for (let index = 1; index <= 10; index++) {
      state.setCardDetail(createCardDetail({ card: createCard({ id: `detail-${index}` }) }));
    }
    // Refresh detail-1's recency before two more drawers are hydrated.
    expect(state.detailForCard("detail-1")?.card.id).toBe("detail-1");
    state.setCardDetail(createCardDetail({ card: createCard({ id: "detail-11" }) }));
    state.setCardDetail(createCardDetail({ card: createCard({ id: "detail-12" }) }));

    expect(state.detailedCards().size).toBe(10);
    expect(state.detailForCard("detail-1")).not.toBeNull();
    expect(state.detailForCard("detail-2")).toBeNull();
    expect(state.detailForCard("detail-3")).toBeNull();
  });

  it("bounds realtime event idempotency history", () => {
    for (let index = 0; index < 2050; index++) {
      expect(state.tryMarkCommentCreate(`comment-${index}`)).toBe(true);
    }

    expect(state.tryMarkCommentCreate("comment-2049")).toBe(false);
    expect(state.tryMarkCommentCreate("comment-0")).toBe(true);
  });

  it("bounds per-card realtime revision history", () => {
    for (let index = 0; index < 2050; index++) {
      state.noteCardDetailRealtimeMutation(`revision-card-${index}`);
    }

    expect(state.cardDetailRealtimeRevision("revision-card-0")).toBe(0);
    expect(state.cardDetailRealtimeRevision("revision-card-2049")).toBe(1);
  });
});

// Regression coverage for the "created card vanishes, re-added, then duplicated" bug: a stale
// open-board refresh (its GET snapshot predating the create) must not blind-replace away a
// server-confirmed card the client already added. See BoardState.recentlyAddedCardAt.
describe("BoardState recent-card retention across a stale hydrate", () => {
  let state: BoardState;

  const rehydrate = (cards: WireCardSummary[]) =>
    state.hydrate({
      board: createBoard(),
      lists: [createList()],
      cards,
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        BoardState,
        { provide: WorkspaceService, useValue: { cacheLists: vi.fn(), registerBoards: vi.fn(), listsForBoard: vi.fn(() => []) } },
      ],
    });
    state = TestBed.inject(BoardState);
    rehydrate([createCardSummary({ id: "card-1" })]);
  });

  it("keeps a just-added card that a stale refresh payload omits, with its side-state", () => {
    state.addCard(createCardSummary({ id: "card-2", title: "New card" }));
    state.setCardAssignees("card-2", ["user-9"]);
    state.commentCounts.update((counts) => new Map(counts).set("card-2", 4));

    // Refresh whose snapshot predates the create: no card-2 in the payload.
    rehydrate([createCardSummary({ id: "card-1" })]);

    expect(state.hasCard("card-2")).toBe(true);
    expect(state.cardsForList("list-1").map((c) => c.id)).toContain("card-2");
    expect(state.cardAssignees().filter((a) => a.cardId === "card-2").map((a) => a.userId)).toEqual(["user-9"]);
    expect(state.commentCounts().get("card-2")).toBe(4);
  });

  it("stops retaining once the server payload includes the card", () => {
    state.addCard(createCardSummary({ id: "card-2" }));
    // Server caught up: payload now contains card-2, which clears tracking.
    rehydrate([createCardSummary({ id: "card-1" }), createCardSummary({ id: "card-2" })]);
    expect(state.hasCard("card-2")).toBe(true);

    // A later refresh that omits card-2 now reflects a real deletion elsewhere, so it drops.
    rehydrate([createCardSummary({ id: "card-1" })]);
    expect(state.hasCard("card-2")).toBe(false);
  });

  it("stops retaining after the TTL so a missed remote delete isn't resurrected forever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T00:00:00.000Z"));
    try {
      state.addCard(createCardSummary({ id: "card-2" }));
      vi.advanceTimersByTime(61_000);
      rehydrate([createCardSummary({ id: "card-1" })]);
      expect(state.hasCard("card-2")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retaining a card removed locally", () => {
    state.addCard(createCardSummary({ id: "card-2" }));
    state.removeCard("card-2");
    rehydrate([createCardSummary({ id: "card-1" })]);
    expect(state.hasCard("card-2")).toBe(false);
  });

  it("does not resurrect a card archived locally into a filtered (non-archived) payload", () => {
    state.addCard(createCardSummary({ id: "card-2" }));
    // Archive lands via a card update; the archived axis is a legitimate reason to omit it.
    state.updateCard(createCardSummary({ id: "card-2", archivedAt: new Date("2026-05-22T00:00:00.000Z") }));
    rehydrate([createCardSummary({ id: "card-1" })]);
    expect(state.hasCard("card-2")).toBe(false);
  });

  it("flushes retention when hydrating a different board", () => {
    state.addCard(createCardSummary({ id: "card-2" }));
    state.hydrate({
      board: createBoard({ id: "board-2" }),
      lists: [createList()],
      cards: [createCardSummary({ id: "card-9", boardId: "board-2" })],
      customFields: [],
      cardLabels: [],
      members: [],
      viewerRole: "editor",
    });
    expect(state.hasCard("card-2")).toBe(false);
  });

  it("retains a recent card when restoring an older offline snapshot", () => {
    const snapshot = { ...state.snapshot(), boardId: "board-1", cachedAt: "2026-05-21T00:00:00.000Z" } as OfflineBoardSnapshot;
    state.addCard(createCardSummary({ id: "card-2" }));
    state.restoreSnapshot(snapshot);
    expect(state.hasCard("card-2")).toBe(true);
  });

  it("advances cardMutationSeq on local card mutations so a racing refresh can re-converge", () => {
    const before = state.cardMutationSeq();
    state.addCard(createCardSummary({ id: "card-2" }));
    expect(state.cardMutationSeq()).toBeGreaterThan(before);
  });

  it("advances cardMutationSeq when a rebalance moves a known card, so a stale hydrate re-converges", () => {
    const before = state.cardMutationSeq();
    // A rebalance is emitted just before its paired card:moved; without the bump a refresh whose
    // GET predates it could overwrite the new sibling positions with no follow-up refetch.
    state.rebalanceCards([{ id: "card-1", position: "500.0000000000" }]);
    expect(state.cards().find((c) => c.id === "card-1")?.position).toBe("500.0000000000");
    expect(state.cardMutationSeq()).toBeGreaterThan(before);
  });

  it("does not advance cardMutationSeq for a rebalance carrying only unknown cards", () => {
    const before = state.cardMutationSeq();
    // Assigned Work receives per-board rebalances whose payload can list cards it doesn't show; a
    // no-op locally must not trigger a needless convergence refresh.
    state.rebalanceCards([{ id: "card-not-here", position: "500.0000000000" }]);
    expect(state.cardMutationSeq()).toBe(before);
  });
});
