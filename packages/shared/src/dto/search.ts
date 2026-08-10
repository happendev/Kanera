import { z } from "zod";
import { workScopeSchema } from "./work.js";

export const SEARCH_RESULT_TYPES = ["card", "comment", "note", "attachment"] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

export const searchQuery = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});
export type SearchQuery = z.infer<typeof searchQuery>;

/**
 * Agent-facing search is intentionally a single bounded result stream. The web search endpoint
 * keeps its grouped response, while agents can narrow the same access-filtered index by work scope
 * and result type without receiving `limit` rows from every entity table.
 */
export const agentSearchQueryBody = z.object({
  query: z.string().trim().min(1).max(200),
  scope: workScopeSchema.optional(),
  types: z.array(z.enum(SEARCH_RESULT_TYPES)).min(1).max(SEARCH_RESULT_TYPES.length).optional(),
  limit: z.number().int().min(1).max(25).default(10),
});
export type AgentSearchQuery = z.infer<typeof agentSearchQueryBody>;

// Shared context every search result carries for rendering + navigation.
export interface SearchResultBase {
  id: string;
  // ts_headline HTML snippet; source text is Postgres-escaped, only <mark> tags added.
  snippet: string;
  workspaceId: string;
  workspaceName: string;
  /** Canonical browser destination for agents and other non-Angular consumers. */
  webUrl?: string;
}

export interface CardSearchResult extends SearchResultBase {
  organisationKey: string;
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardColor: string | null;
  listName: string;
  cardId: string;
  cardKey: string;
  cardTitle: string;
}

export interface NoteSearchResult extends SearchResultBase {
  // null = workspace-level note, set = board-scoped note
  boardId: string | null;
  boardName: string | null;
  boardIcon: string | null;
  boardColor: string | null;
  title: string;
}

export interface CommentSearchResult extends SearchResultBase {
  organisationKey: string;
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardColor: string | null;
  listName: string;
  cardId: string;
  cardKey: string;
  cardTitle: string;
}

export interface AttachmentSearchResult extends SearchResultBase {
  organisationKey: string;
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardColor: string | null;
  listName: string;
  cardId: string;
  cardKey: string;
  cardTitle: string;
  fileName: string;
}

export interface WireSearchResults {
  cards: CardSearchResult[];
  notes: NoteSearchResult[];
  comments: CommentSearchResult[];
  attachments: AttachmentSearchResult[];
  query: string;
}

export interface AgentSearchResultBase {
  type: SearchResultType;
  id: string;
  matchContext: string;
  workspaceId: string;
  workspaceName: string;
  boardId: string | null;
  boardName: string | null;
  url: string;
}

export interface AgentCardSearchResult extends AgentSearchResultBase {
  type: "card";
  boardId: string;
  boardName: string;
  cardId: string;
  cardKey: string;
  cardTitle: string;
  listName: string;
}

export interface AgentCommentSearchResult extends AgentSearchResultBase {
  type: "comment";
  boardId: string;
  boardName: string;
  cardId: string;
  cardKey: string;
  cardTitle: string;
  listName: string;
}

export interface AgentNoteSearchResult extends AgentSearchResultBase {
  type: "note";
  title: string;
}

export interface AgentAttachmentSearchResult extends AgentSearchResultBase {
  type: "attachment";
  boardId: string;
  boardName: string;
  cardId: string;
  cardKey: string;
  cardTitle: string;
  listName: string;
  fileName: string;
}

export type AgentSearchResult =
  | AgentCardSearchResult
  | AgentCommentSearchResult
  | AgentNoteSearchResult
  | AgentAttachmentSearchResult;

export interface AgentSearchResponse {
  query: string;
  results: AgentSearchResult[];
}
