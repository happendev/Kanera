import { dto } from "@kanera/shared";
import { cardPath } from "@kanera/shared/card-links";
import type {
  AgentSearchResponse,
  AttachmentSearchResult,
  CardSearchResult,
  CommentSearchResult,
  NoteSearchResult,
  SearchResultType,
  WorkScope,
  WireSearchResults,
} from "@kanera/shared/dto";
import {
  boards,
  cardAttachments,
  cards,
  comments,
  lists,
  notes,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assignedCardVisibility, isOrgAdmin } from "../../lib/access.js";
import { applyWorkScope, loadAccessibleBoards } from "../../lib/accessible-boards.js";

const DEFAULT_LIMIT = 8;

// ts_headline options: wrap matches in <mark>, keep snippets short. Postgres
// HTML-escapes the source text, so the only markup introduced is <mark>.
const HEADLINE_OPTS = "StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MaxWords=18,MinWords=5";

function escapedSearchPattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

interface AccessScope {
  workspaceIds: string[];
  // Boards the user is explicitly a member of, including board-only guests.
  boardIds: string[];
}

// Compute the user's full accessible scope once, in bulk, rather than per-row.
async function buildAccessScope(claims: AuthClaims, requestedScope?: WorkScope): Promise<AccessScope> {
  const accessibleBoards = await loadAccessibleBoards(claims);
  let workspaceIds: string[];
  // Personal keys mirror the owner's real reach, so they follow the normal-user path below with the
  // owner's actual org-admin visibility. Only pinned workspace keys use the single-workspace scope.
  if (claims.authKind === "apiKey" && claims.apiKeyKind !== "personal") {
    workspaceIds = claims.apiKeyWorkspaceId ? [claims.apiKeyWorkspaceId] : [];
  } else if (claims.apiKeyKind === "personal") {
    workspaceIds = Array.from(new Set(
        accessibleBoards.filter((board) => board.canAccessWorkspace).map((board) => board.workspaceId),
      ));
  } else {
    const memberWorkspaces = await db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .innerJoin(workspaces, and(eq(workspaces.id, workspaceMembers.workspaceId), isNull(workspaces.archivedAt)))
      .where(eq(workspaceMembers.userId, claims.sub));
    const ids = new Set(memberWorkspaces.map((row) => row.id));
    // Org admins implicitly access every workspace in their client.
    if (isOrgAdmin(claims)) {
      const orgWorkspaces = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.clientId, claims.cid), isNull(workspaces.archivedAt)));
      for (const row of orgWorkspaces) ids.add(row.id);
    }
    workspaceIds = [...ids];
  }

  if (!requestedScope || requestedScope.allAccessible) {
    return { workspaceIds, boardIds: accessibleBoards.map((board) => board.id) };
  }

  const scopedBoards = applyWorkScope(accessibleBoards, requestedScope);
  const selectedWorkspaceIds = new Set(requestedScope.workspaceIds);
  for (const board of accessibleBoards) {
    if (requestedScope.organisationIds.includes(board.clientId)) selectedWorkspaceIds.add(board.workspaceId);
  }
  // A board-only scope includes that board's notes, not unrelated workspace-level notes. This is
  // the same narrowing agents expect when they use the work scope on card queries.
  return {
    workspaceIds: workspaceIds.filter((id) => selectedWorkspaceIds.has(id)),
    boardIds: scopedBoards.map((board) => board.id),
  };
}

function workspaceVisiblePredicate(scope: AccessScope, workspaceId: typeof workspaces.id | typeof notes.workspaceId | typeof boards.workspaceId): SQL {
  return scope.workspaceIds.length ? inArray(workspaceId, scope.workspaceIds) : sql`false`;
}

function explicitBoardPredicate(scope: AccessScope, boardId: typeof boards.id | typeof notes.boardId): SQL {
  return scope.boardIds.length ? inArray(boardId, scope.boardIds) : sql`false`;
}

// Board ids come from the shared resolver, which has already expanded org-admin access and removed
// archived sources. Keeping the final predicate exact also covers standalone and guest boards.
function boardVisiblePredicate(scope: AccessScope): SQL {
  return explicitBoardPredicate(scope, boards.id);
}

function noteVisiblePredicate(scope: AccessScope): SQL {
  const workspaceMatch = workspaceVisiblePredicate(scope, notes.workspaceId);
  // Workspace-scoped notes follow workspace membership; board-scoped notes require an explicit
  // board in the resolved access set. Organisation-admin access is already expanded into that set.
  return or(
    and(isNull(notes.boardId), workspaceMatch),
    explicitBoardPredicate(scope, notes.boardId),
  )!;
}

const cardUrl = (organisationKey: string, cardKey: string) =>
  new URL(cardPath(organisationKey, cardKey), env.WEB_ORIGIN).toString();

const noteUrl = (note: { id: string; boardId: string | null; workspaceId: string }) => {
  const url = new URL(note.boardId ? `/b/${note.boardId}` : `/w/${note.workspaceId}/notes`, env.WEB_ORIGIN);
  if (note.boardId) url.searchParams.set("view", "notes");
  url.searchParams.set("noteId", note.id);
  return url.toString();
};

function plainSnippet(snippet: string): string {
  // ts_headline HTML-escapes source text. Agent results deliberately return plain context so hosts
  // do not need to render or sanitize snippets before supplying them to a model.
  return snippet
    .replaceAll("<mark>", "")
    .replaceAll("</mark>", "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

async function searchData(
  auth: AuthClaims,
  q: string,
  take: number,
  requestedScope?: WorkScope,
  requestedTypes: readonly SearchResultType[] = dto.SEARCH_RESULT_TYPES,
) {
  const scope = await buildAccessScope(auth, requestedScope);
  const types = new Set(requestedTypes);
  if (scope.workspaceIds.length === 0 && scope.boardIds.length === 0) {
    return { cardRows: [], noteRows: [], commentRows: [], attachmentRows: [] };
  }

  const tsq = sql`websearch_to_tsquery('english', ${q})`;
  const keyMatch = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]*)$/.exec(q.trim());
  const exactCardKeyMatch = keyMatch
    ? sql`(${cards.number} = ${Number(keyMatch[2])} and exists (
        select 1 from card_key_prefix_reservation key_alias
        where key_alias.workspace_id = ${cards.workspaceId}
          and key_alias.prefix = ${keyMatch[1]!.toUpperCase()}
      ))`
    : sql`false`;
  const cardTitleMatch = sql`lower(${cards.title}) like ${escapedSearchPattern(q)} escape '\\'`;
  const attachmentFileNameMatch = sql`lower(${cardAttachments.fileName}) like ${escapedSearchPattern(q)} escape '\\'`;
  const boardPredicate = boardVisiblePredicate(scope);
  const cardPredicate = and(boardPredicate, sql`(
    not exists (select 1 from board_member restricted_member
      where restricted_member.board_id = ${boards.id}
        and restricted_member.user_id = ${auth.sub}
        and restricted_member.assigned_items_only = true)
    or ${assignedCardVisibility(auth.sub)}
  )`)!;
  const notePredicate = noteVisiblePredicate(scope);

  const [cardRows, noteRows, commentRows, attachmentRows] = await Promise.all([
    types.has("card") ? db
      .select({
        id: cards.id,
        organisationKey: cards.organisationKey,
        cardId: cards.id,
        cardKey: cards.key,
        cardTitle: cards.title,
        boardId: boards.id,
        boardName: boards.name,
        boardIcon: boards.icon,
        boardColor: boards.iconColor,
        listName: lists.name,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        snippet: sql<string>`ts_headline('english', coalesce(${cards.title}, '') || ' ' || coalesce(${cards.description}, ''), ${tsq}, ${HEADLINE_OPTS})`,
        rank: sql<number>`ts_rank(${cards.searchVector}, ${tsq})`,
        exactPriority: sql<number>`case when ${exactCardKeyMatch} then 1 else 0 end`,
      })
      .from(cards)
      .innerJoin(lists, eq(lists.id, cards.listId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(or(exactCardKeyMatch, sql`${cards.searchVector} @@ ${tsq}`, cardTitleMatch), isNull(cards.archivedAt), cardPredicate))
      .orderBy(sql`case when ${exactCardKeyMatch} then 1 else 0 end desc`, sql`ts_rank(${cards.searchVector}, ${tsq}) desc`)
      .limit(take) : Promise.resolve([]),

    types.has("note") ? db
      .select({
        id: notes.id,
        title: notes.title,
        boardId: notes.boardId,
        boardName: boards.name,
        boardIcon: boards.icon,
        boardColor: boards.iconColor,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        snippet: sql<string>`ts_headline('english', coalesce(${notes.title}, '') || ' ' || coalesce(${notes.content}, ''), ${tsq}, ${HEADLINE_OPTS})`,
        rank: sql<number>`ts_rank(${notes.searchVector}, ${tsq})`,
      })
      .from(notes)
      .innerJoin(workspaces, eq(workspaces.id, notes.workspaceId))
      .leftJoin(boards, eq(boards.id, notes.boardId))
      .where(and(sql`${notes.searchVector} @@ ${tsq}`, or(eq(notes.scope, "team"), eq(notes.ownerId, auth.sub)), notePredicate))
      .orderBy(sql`ts_rank(${notes.searchVector}, ${tsq}) desc`)
      .limit(take) : Promise.resolve([]),

    types.has("comment") ? db
      .select({
        id: comments.id,
        organisationKey: cards.organisationKey,
        cardId: cards.id,
        cardKey: cards.key,
        cardTitle: cards.title,
        boardId: boards.id,
        boardName: boards.name,
        boardIcon: boards.icon,
        boardColor: boards.iconColor,
        listName: lists.name,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        snippet: sql<string>`ts_headline('english', coalesce(${comments.body}, ''), ${tsq}, ${HEADLINE_OPTS})`,
        rank: sql<number>`ts_rank(${comments.searchVector}, ${tsq})`,
      })
      .from(comments)
      .innerJoin(cards, eq(cards.id, comments.cardId))
      .innerJoin(lists, eq(lists.id, cards.listId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(sql`${comments.searchVector} @@ ${tsq}`, isNull(cards.archivedAt), cardPredicate))
      .orderBy(sql`ts_rank(${comments.searchVector}, ${tsq}) desc`)
      .limit(take) : Promise.resolve([]),

    types.has("attachment") ? db
      .select({
        id: cardAttachments.id,
        organisationKey: cards.organisationKey,
        fileName: cardAttachments.fileName,
        cardId: cards.id,
        cardKey: cards.key,
        cardTitle: cards.title,
        boardId: boards.id,
        boardName: boards.name,
        boardIcon: boards.icon,
        boardColor: boards.iconColor,
        listName: lists.name,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        snippet: sql<string>`ts_headline('english', coalesce(${cardAttachments.fileName}, ''), ${tsq}, ${HEADLINE_OPTS})`,
        rank: sql<number>`ts_rank(${cardAttachments.searchVector}, ${tsq})`,
      })
      .from(cardAttachments)
      .innerJoin(cards, eq(cards.id, cardAttachments.cardId))
      .innerJoin(lists, eq(lists.id, cards.listId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(or(sql`${cardAttachments.searchVector} @@ ${tsq}`, attachmentFileNameMatch), isNull(cards.archivedAt), cardPredicate))
      .orderBy(sql`ts_rank(${cardAttachments.searchVector}, ${tsq}) desc`)
      .limit(take) : Promise.resolve([]),
  ]);

  return { cardRows, noteRows, commentRows, attachmentRows };
}

export async function searchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/search", async (req) => {
    const { q, limit } = dto.searchQuery.parse(req.query);
    const take = limit ?? DEFAULT_LIMIT;
    const { cardRows, noteRows, commentRows, attachmentRows } = await searchData(req.auth, q, take);
    const result: WireSearchResults = {
      cards: cardRows.map(({ rank: _rank, exactPriority: _exactPriority, ...row }) => ({ ...row, webUrl: cardUrl(row.organisationKey, row.cardKey) })) satisfies CardSearchResult[],
      notes: noteRows.map(({ rank: _rank, ...row }) => ({ ...row, webUrl: noteUrl(row) })) satisfies NoteSearchResult[],
      comments: commentRows.map(({ rank: _rank, ...row }) => ({ ...row, webUrl: cardUrl(row.organisationKey, row.cardKey) })) satisfies CommentSearchResult[],
      attachments: attachmentRows.map(({ rank: _rank, ...row }) => ({ ...row, webUrl: cardUrl(row.organisationKey, row.cardKey) })) satisfies AttachmentSearchResult[],
      query: q,
    };
    return result;
  });

  app.post("/search/query", async (req) => {
    const query = dto.agentSearchQueryBody.parse(req.body ?? {});
    const rows = await searchData(req.auth, query.query, query.limit, query.scope, query.types);
    const ranked = [
      ...rows.cardRows.map((row) => ({
        score: Number(row.rank) + Number(row.exactPriority) * 1_000,
        result: {
          type: "card" as const,
          id: row.id,
          matchContext: plainSnippet(row.snippet),
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          boardId: row.boardId,
          boardName: row.boardName,
          cardId: row.cardId,
          cardKey: row.cardKey,
          cardTitle: row.cardTitle,
          listName: row.listName,
          url: cardUrl(row.organisationKey, row.cardKey),
        },
      })),
      ...rows.noteRows.map((row) => ({
        score: Number(row.rank),
        result: {
          type: "note" as const,
          id: row.id,
          title: row.title,
          matchContext: plainSnippet(row.snippet),
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          boardId: row.boardId,
          boardName: row.boardName,
          url: noteUrl(row),
        },
      })),
      ...rows.commentRows.map((row) => ({
        score: Number(row.rank),
        result: {
          type: "comment" as const,
          id: row.id,
          matchContext: plainSnippet(row.snippet),
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          boardId: row.boardId,
          boardName: row.boardName,
          cardId: row.cardId,
          cardKey: row.cardKey,
          cardTitle: row.cardTitle,
          listName: row.listName,
          url: cardUrl(row.organisationKey, row.cardKey),
        },
      })),
      ...rows.attachmentRows.map((row) => ({
        score: Number(row.rank),
        result: {
          type: "attachment" as const,
          id: row.id,
          fileName: row.fileName,
          matchContext: plainSnippet(row.snippet),
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          boardId: row.boardId,
          boardName: row.boardName,
          cardId: row.cardId,
          cardKey: row.cardKey,
          cardTitle: row.cardTitle,
          listName: row.listName,
          url: cardUrl(row.organisationKey, row.cardKey),
        },
      })),
    ].sort((a, b) => b.score - a.score || a.result.type.localeCompare(b.result.type) || a.result.id.localeCompare(b.result.id));
    const response: AgentSearchResponse = { query: query.query, results: ranked.slice(0, query.limit).map((item) => item.result) };
    return response;
  });
}
