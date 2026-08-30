import type { SearchResult, SearchResultType, Uuid, WorkScope } from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

export interface SearchInput {
  query: string;
  /** Narrow to particular organisations, workspaces, or boards. Omit to search everything visible. */
  scope?: WorkScope;
  types?: SearchResultType[];
  limit?: number;
}

export class Search {
  constructor(private readonly ctx: ResourceContext) {}

  /**
   * One relevance-ranked, bounded result stream across cards, comments, notes, and attachment
   * filenames — not `limit` rows from each. Results are access-filtered to the credential.
   */
  query(input: SearchInput, options: CallOptions = {}): Promise<{ results: SearchResult[] }> {
    return this.ctx.http.post("/api/v1/search/query", { limit: 10, ...input }, options);
  }

  /** Grouped legacy search, kept for card-key lookups where the ranked stream is not wanted. */
  simple(q: string, options: { limit?: number } & CallOptions = {}): Promise<{ cards: { cardId: Uuid; cardKey: string; organisationKey: string }[] }> {
    const { limit, ...call } = options;
    return this.ctx.http.get("/api/v1/search", { ...call, query: { q, limit } });
  }
}
