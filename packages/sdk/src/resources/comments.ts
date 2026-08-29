import { paginateCursor, type PageIterator } from "../pagination.js";
import type { Comment, Uuid } from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

export class Comments {
  constructor(private readonly ctx: ResourceContext) {}

  async list(
    card: string,
    options: { cursor?: string; limit?: number } & CallOptions = {},
  ): Promise<{ items: Comment[]; nextCursor: string | null }> {
    const { cursor, limit, ...call } = options;
    return this.ctx.http.get(`/api/v1/cards/${await this.ctx.resolveCard(card)}/comments`, { ...call, query: { cursor, limit } });
  }

  iterate(card: string, options: { limit?: number } & CallOptions = {}): PageIterator<Comment> {
    return paginateCursor((cursor) => this.list(card, { ...options, cursor }));
  }

  /**
   * Not idempotent on its own. Pass `idempotencyKey` if you may retry after an ambiguous failure,
   * otherwise a retry posts the comment twice.
   */
  async create(
    card: string,
    body: { body: string; attachmentIds?: Uuid[] },
    options: CallOptions = {},
  ): Promise<Comment> {
    return this.ctx.http.post<Comment>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/comments`, body, options);
  }

  /** Only the acting user's own comments may be edited. */
  update(commentId: Uuid, body: { body: string; attachmentIds?: Uuid[] }, options: CallOptions = {}): Promise<Comment> {
    return this.ctx.http.patch<Comment>(`/api/v1/comments/${commentId}`, body, options);
  }

  delete(commentId: Uuid, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.delete<void>(`/api/v1/comments/${commentId}`, options);
  }

  addReaction(commentId: Uuid, type: string, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.post<void>(`/api/v1/comments/${commentId}/reactions`, { type }, options);
  }

  removeReaction(commentId: Uuid, type: string, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.delete<void>(`/api/v1/comments/${commentId}/reactions/${encodeURIComponent(type)}`, options);
  }
}
