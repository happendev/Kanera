import { z } from "zod";

export const searchQuery = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});
export type SearchQuery = z.infer<typeof searchQuery>;

// Shared context every search result carries for rendering + navigation.
export interface SearchResultBase {
  id: string;
  // ts_headline HTML snippet; source text is Postgres-escaped, only <mark> tags added.
  snippet: string;
  workspaceId: string;
  workspaceName: string;
}

export interface CardSearchResult extends SearchResultBase {
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardColor: string | null;
  listName: string;
  cardId: string;
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
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardColor: string | null;
  listName: string;
  cardId: string;
  cardTitle: string;
}

export interface AttachmentSearchResult extends SearchResultBase {
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardColor: string | null;
  listName: string;
  cardId: string;
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
