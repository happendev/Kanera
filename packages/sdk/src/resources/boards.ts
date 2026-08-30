import { paginateCursor, paginateOffset, type PageIterator } from "../pagination.js";
import type {
  AccessibleBoard, ActivityEvent, Board, BoardRole, Card, CustomField, Label, List, Member, Uuid, WorkspaceKind,
} from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

export interface BoardDetail {
  board: Board;
  lists: List[];
  /** Named `cardLabels`, not `labels`: these are the labels assignable to this board's cards. */
  cardLabels: Label[];
  customFields: CustomField[];
  separators: unknown[];
  checklistTemplates: unknown[];
  members: Member[];
  workspaceKind: WorkspaceKind;
  workspaceClientId: Uuid;
  /** This credential's authority on the board, after any read-scope downgrade. */
  viewerRole: BoardRole;
  viewerIsWorkspaceAdmin: boolean;
  viewerCanAccessWorkspace: boolean;
  /** Present only when the request asked for cards. Bounded by `cardLimit`. */
  cards?: Card[];
  cardPage?: { hasMore: boolean };
}

export interface OpenBoardOptions extends CallOptions {
  /** Defaults to false. Board detail without cards is the cheap discovery call. */
  includeCards?: boolean;
  includeCompleted?: boolean;
  archived?: boolean;
  /** Restrict returned cards to one workflow list. */
  listId?: Uuid;
  cardLimit?: number;
  cardOffset?: number;
}

export class Boards {
  constructor(private readonly ctx: ResourceContext) {}

  /**
   * Every accessible board: workspace boards, standalone boards, and cross-organisation guest
   * boards. This is the complete directory; the per-workspace listing is not.
   */
  list(options: { limit?: number; offset?: number } & CallOptions = {}): Promise<AccessibleBoard[]> {
    const { limit, offset, ...call } = options;
    return this.ctx.http.get<AccessibleBoard[]>("/api/v1/boards", { ...call, query: { limit, offset } });
  }

  iterate(options: { pageSize?: number } & CallOptions = {}): PageIterator<AccessibleBoard> {
    const { pageSize, ...call } = options;
    return paginateOffset((limit, offset) => this.list({ limit, offset, ...call }), pageSize);
  }

  /**
   * Read a board's configuration, and optionally a bounded page of its cards.
   *
   * This is a POST because the endpoint is a read with a request body, not a mutation — it creates
   * nothing and is safe to repeat.
   */
  open(boardId: Uuid, options: OpenBoardOptions = {}): Promise<BoardDetail> {
    const { includeCards, includeCompleted, archived, listId, cardLimit, cardOffset, ...call } = options;
    return this.ctx.http.post<BoardDetail>(`/api/v1/boards/${boardId}/open`, undefined, {
      ...call,
      query: { includeCards: includeCards ?? false, includeCompleted, archived, listId, cardLimit, cardOffset },
    });
  }

  /** One bounded page of cards from exactly one workflow list. */
  async cards(
    boardId: Uuid,
    listId: Uuid,
    options: { limit?: number; offset?: number; includeCompleted?: boolean; archived?: boolean } & CallOptions = {},
  ): Promise<{ cards: Card[]; hasMore: boolean }> {
    const { limit = 50, offset = 0, includeCompleted = true, archived = false, ...call } = options;
    const detail = await this.open(boardId, {
      ...call,
      includeCards: true,
      includeCompleted,
      archived,
      listId,
      cardLimit: limit,
      cardOffset: offset,
    });
    // The board-open response is list-filtered server side, but a defensive filter keeps a future
    // response shape from leaking another list's cards into a call that promised one list.
    const cards = (detail.cards ?? []).filter((card) => card.listId === listId);
    return { cards, hasMore: detail.cardPage?.hasMore ?? false };
  }

  iterateCards(boardId: Uuid, listId: Uuid, options: { pageSize?: number } & CallOptions = {}): PageIterator<Card> {
    const { pageSize = 50, ...call } = options;
    return paginateOffset(async (limit, offset) => (await this.cards(boardId, listId, { limit, offset, ...call })).cards, pageSize);
  }

  activity(
    boardId: Uuid,
    options: { cursor?: string; limit?: number } & CallOptions = {},
  ): Promise<{ items: ActivityEvent[]; nextCursor: string | null }> {
    const { cursor, limit, ...call } = options;
    return this.ctx.http.get(`/api/v1/boards/${boardId}/activity`, { ...call, query: { cursor, limit } });
  }

  iterateActivity(boardId: Uuid, options: { limit?: number } & CallOptions = {}): PageIterator<ActivityEvent> {
    return paginateCursor((cursor) => this.activity(boardId, { ...options, cursor }));
  }
}

export class Lists {
  constructor(private readonly ctx: ResourceContext) {}

  /** Archive every card in a list. Destructive; there is no bulk unarchive. */
  archiveCards(listId: Uuid, options: CallOptions = {}): Promise<{ archived: number }> {
    return this.ctx.http.patch(`/api/v1/lists/${listId}/cards/archive`, undefined, options);
  }

  moveCards(listId: Uuid, body: { targetListId: Uuid; atTop?: boolean }, options: CallOptions = {}): Promise<{ moved: number }> {
    return this.ctx.http.post(`/api/v1/lists/${listId}/cards/move`, body, options);
  }

  setCardCompletion(
    boardId: Uuid,
    listId: Uuid,
    completed: boolean,
    options: CallOptions = {},
  ): Promise<{ updated: number }> {
    return this.ctx.http.post(`/api/v1/boards/${boardId}/lists/${listId}/cards/completion`, { completed }, options);
  }
}
