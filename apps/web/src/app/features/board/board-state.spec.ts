import { TestBed } from "@angular/core/testing";
import { SERVER_EVENTS, compactCardSummary, expandCardSummary } from "@kanera/shared/events";
import type { CardAttachmentRow, WireBoardMemberUser, WireCard, WireCardChecklist, WireCardDetail, WireCardLabel, WireCardSummary, WireComment, WireCustomField, WireList } from "@kanera/shared/events";
import type { Board, Card, CardCustomFieldValue, CardLabel, List } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSocket } from "../../core/realtime/socket.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { BoardSocketBridge } from "./board-socket-bridge";
import { BoardState } from "./board-state";

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
    name: "Roadmap",
    description: null,
    icon: null,
    iconColor: null,
    backgroundGradient: null,
    position: "1000.0000000000",
    visibility: "workspace",
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
      viewerRole: "owner",
    });
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

  it("applies workspace member realtime changes on workspace-visible boards", () => {
    const socket = new SocketStub();
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

    expect(state.members().map((member) => member.userId)).toEqual(["user-2"]);
    state.setCardAssignees("card-1", ["user-2"]);
    expect(state.assigneeIdsForCard("card-1")).toEqual(["user-2"]);

    socket.trigger(SERVER_EVENTS.WORKSPACE_MEMBER_UPDATED, {
      workspaceId: "workspace-1",
      member: {
        workspaceId: "workspace-1",
        userId: "user-2",
        role: "observer",
        addedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    expect(state.members()[0]?.role).toBe("observer");

    socket.trigger(SERVER_EVENTS.WORKSPACE_MEMBER_REMOVED, { workspaceId: "workspace-1", userId: "user-2" });
    expect(state.members()).toEqual([]);
    expect(state.assigneeIdsForCard("card-1")).toEqual([]);
  });

  it("does not add workspace members to private board member state", () => {
    const socket = new SocketStub();
    state.board.set(createBoard({ visibility: "private" }));

    bridge.attach(socket.asSocket(), "board-1");
    socket.trigger(SERVER_EVENTS.WORKSPACE_MEMBER_ADDED, {
      workspaceId: "workspace-1",
      member: {
        workspaceId: "workspace-1",
        userId: "user-2",
        role: "editor",
        displayName: "Grace Hopper",
        addedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    expect(state.members()).toEqual([]);
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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
      viewerRole: "owner",
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

    socket.trigger("card:checklistItem:created", { boardId: "board-1", cardId: "card-1", cardTitle: "Card 1", listId: "list-1", checklistId: "checklist-1", item: createdItem });
    expect(state.cards()[0]).toMatchObject({ checklistDoneCount: 1, checklistTotalCount: 3 });

    socket.trigger("card:checklistItem:updated", {
      boardId: "board-1",
      cardId: "card-1",
      cardTitle: "Card 1",
      listId: "list-1",
      checklistId: "checklist-1",
      prevCompletedAt: null,
      item: { ...createdItem, completedAt: new Date("2026-05-21T01:00:00.000Z"), completedById: "user-1" },
    });
    expect(state.cards()[0]).toMatchObject({ checklistDoneCount: 2, checklistTotalCount: 3 });

    socket.trigger("card:checklistItem:deleted", { boardId: "board-1", cardId: "card-1", checklistId: "checklist-1", itemId: "item-3", completedAt: new Date("2026-05-21T01:00:00.000Z") });
    expect(state.cards()[0]).toMatchObject({ checklistDoneCount: 1, checklistTotalCount: 2 });
  });
});
