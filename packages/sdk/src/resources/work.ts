import { paginateCursor, type PageIterator } from "../pagination.js";
import type {
  Card, PriorityAnchor, PriorityQueue, PriorityTarget, Uuid, WorkCardsResult, WorkFilters, WorkScope, WorkSort,
} from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

export interface WorkCardsInput {
  /** `my` for the credential owner's assignments; `team` with `filters.assigneeIds` for others. */
  lens?: "my" | "team";
  scope?: WorkScope;
  filters?: WorkFilters;
  sort?: WorkSort;
  cursor?: string;
  limit?: number;
}

export interface WorkHistoryInput {
  /** Omit for the connected user. */
  userId?: Uuid;
  preset?: "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month";
  from?: string;
  to?: string;
  timeZone?: string;
  scope?: WorkScope;
  q?: string;
  cursor?: string;
  limit?: number;
}

function anchorBody(anchor: PriorityAnchor): { afterId: Uuid | null } | { beforeId: Uuid | null } {
  return anchor.side === "after" ? { afterId: anchor.id } : { beforeId: anchor.id };
}

/**
 * Cross-board reporting and the "Up next" priority queue.
 *
 * These endpoints exist so an integration never has to enumerate boards and merge card lists by
 * hand: one call is access-filtered, bounded, and returns name maps for rendering.
 */
export class Work {
  constructor(private readonly ctx: ResourceContext) {}

  cards(input: WorkCardsInput = {}, options: CallOptions = {}): Promise<WorkCardsResult> {
    return this.ctx.http.post<WorkCardsResult>("/api/v1/work/cards/query", { lens: "my", sort: "dueAsc", ...input }, options);
  }

  iterateCards(input: WorkCardsInput = {}, options: CallOptions = {}): PageIterator<Card> {
    return paginateCursor(async (cursor) => {
      const page = await this.cards({ ...input, cursor }, options);
      return { items: page.cards, nextCursor: page.nextCursor };
    });
  }

  history(input: WorkHistoryInput = {}, options: CallOptions = {}): Promise<Record<string, unknown>> {
    if (Boolean(input.from) !== Boolean(input.to)) throw new TypeError("from and to must be provided together");
    if (input.preset && (input.from ?? input.to)) throw new TypeError("preset cannot be combined with from and to");
    return this.ctx.http.post("/api/v1/work/history/query", input, options);
  }

  portfolio(
    input: { scope?: WorkScope; filters?: WorkFilters; days?: number; timeZone?: string } = {},
    options: CallOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.ctx.http.post("/api/v1/work/portfolio/query", { days: 30, timeZone: "UTC", ...input }, options);
  }

  /** Whose queues this credential may read: the owner, plus teammates it has admin authority over. */
  priorityTargets(options: CallOptions = {}): Promise<{ targets: PriorityTarget[] }> {
    return this.ctx.http.get("/api/v1/work/priority-targets", options);
  }

  /**
   * Every queue this credential may read, in one call — the caller's own plus any teammate covered
   * by its admin authority. Targets with empty queues are included: "nothing queued" is exactly
   * what an overview must show. Use this instead of N sequential {@link priorities} calls.
   */
  priorityQueues(options: CallOptions = {}): Promise<{ queues: { target: PriorityTarget; queue: PriorityQueue }[] }> {
    return this.ctx.http.get("/api/v1/work/priorities", options);
  }

  /**
   * A user's ranked cross-board queue. Entries whose card the credential cannot see keep their rank
   * and return `card: null`, so ranks stay stable rather than silently renumbering. `limit`
   * truncates the response, never the ranking.
   */
  priorities(userId: Uuid, options: { limit?: number } & CallOptions = {}): Promise<PriorityQueue> {
    const { limit, ...call } = options;
    return this.ctx.http.get(`/api/v1/work/priorities/${userId}`, { ...call, query: { limit } });
  }

  /**
   * Add a card to a queue. The card must already be assigned to the target user.
   *
   * Exactly one anchor is sent, never both: `{afterId, beforeId}` together has no defined winner
   * and `{afterId: null, beforeId: null}` names two different edges, so the API rejects both.
   * Omitting the anchor appends at the bottom.
   */
  async addPriority(
    userId: Uuid,
    card: string,
    body: { anchor?: PriorityAnchor } = {},
    options: CallOptions = {},
  ): Promise<PriorityQueue> {
    const anchor = body.anchor ?? { side: "before" as const, id: null };
    return this.ctx.http.post(`/api/v1/work/priorities/${userId}/cards`, {
      cardId: await this.ctx.resolveCard(card),
      ...anchorBody(anchor),
    }, options);
  }

  movePriority(priorityId: Uuid, anchor: PriorityAnchor, options: CallOptions = {}): Promise<PriorityQueue> {
    return this.ctx.http.post(`/api/v1/card-priorities/${priorityId}/move`, anchorBody(anchor), options);
  }

  /** Removes the queue entry only; the card itself is untouched. */
  removePriority(priorityId: Uuid, options: CallOptions = {}): Promise<PriorityQueue> {
    return this.ctx.http.delete(`/api/v1/card-priorities/${priorityId}`, options);
  }
}
