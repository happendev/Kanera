import { dto } from "@kanera/shared";
import type {
  AttachmentSearchResult,
  CardSearchResult,
  CommentSearchResult,
  NoteSearchResult,
  WireSearchResults,
} from "@kanera/shared/dto";
import {
  boardMembers,
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
import { assignedCardVisibility, isOrgAdmin } from "../../lib/access.js";

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
  orgAdmin: boolean;
}

// Compute the user's full accessible scope once, in bulk, rather than per-row.
async function buildAccessScope(claims: AuthClaims): Promise<AccessScope> {
  const orgAdmin = isOrgAdmin(claims);

  if (claims.authKind === "apiKey") {
    // API keys are scoped to a single workspace (and can't reach this route via
    // the JWT-only auth path, but stay defensive).
    return {
      workspaceIds: claims.apiKeyWorkspaceId ? [claims.apiKeyWorkspaceId] : [],
      boardIds: [],
      orgAdmin: false,
    };
  }

  const memberWorkspaces = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, claims.sub));
  const workspaceIds = new Set(memberWorkspaces.map((r) => r.id));

  // Org admins implicitly access every workspace in their client.
  if (orgAdmin) {
    const orgWorkspaces = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.clientId, claims.cid));
    for (const r of orgWorkspaces) workspaceIds.add(r.id);
  }

  const memberBoards = await db
    .select({ id: boardMembers.boardId })
    .from(boardMembers)
    .where(eq(boardMembers.userId, claims.sub));

  return { workspaceIds: [...workspaceIds], boardIds: memberBoards.map((r) => r.id), orgAdmin };
}

function workspaceVisiblePredicate(scope: AccessScope, workspaceId: typeof workspaces.id | typeof notes.workspaceId | typeof boards.workspaceId): SQL {
  return scope.workspaceIds.length ? inArray(workspaceId, scope.workspaceIds) : sql`false`;
}

function explicitBoardPredicate(scope: AccessScope, boardId: typeof boards.id | typeof notes.boardId): SQL {
  return scope.boardIds.length ? inArray(boardId, scope.boardIds) : sql`false`;
}

// Board membership is the access model: org admins see every board in their org's workspaces,
// everyone else sees only the boards they hold an explicit membership on.
function boardVisiblePredicate(scope: AccessScope): SQL {
  if (scope.orgAdmin) return workspaceVisiblePredicate(scope, boards.workspaceId);
  return explicitBoardPredicate(scope, boards.id);
}

function noteVisiblePredicate(scope: AccessScope): SQL {
  const workspaceMatch = workspaceVisiblePredicate(scope, notes.workspaceId);
  if (scope.orgAdmin) return workspaceMatch;

  // Workspace-scoped notes follow workspace membership; board-scoped notes require an explicit
  // board membership (board access no longer flows from workspace membership).
  return or(
    and(isNull(notes.boardId), workspaceMatch),
    explicitBoardPredicate(scope, notes.boardId),
  )!;
}

export async function searchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/search", async (req) => {
    const { q, limit } = dto.searchQuery.parse(req.query);
    const take = limit ?? DEFAULT_LIMIT;
    const scope = await buildAccessScope(req.auth);

    const empty: WireSearchResults = { cards: [], notes: [], comments: [], attachments: [], query: q };
    // No accessible workspaces or explicit board memberships → nothing to search.
    if (scope.workspaceIds.length === 0 && scope.boardIds.length === 0) return empty;

    const tsq = sql`websearch_to_tsquery('english', ${q})`;
    const cardTitleMatch = sql`lower(${cards.title}) like ${escapedSearchPattern(q)} escape '\\'`;
    const attachmentFileNameMatch = sql`lower(${cardAttachments.fileName}) like ${escapedSearchPattern(q)} escape '\\'`;
    const boardPredicate = boardVisiblePredicate(scope);
    const cardPredicate = and(boardPredicate, sql`(
      not exists (select 1 from board_member restricted_member
        where restricted_member.board_id = ${boards.id}
          and restricted_member.user_id = ${req.auth.sub}
          and restricted_member.assigned_items_only = true)
      or ${assignedCardVisibility(req.auth.sub)}
    )`)!;
    const notePredicate = noteVisiblePredicate(scope);

    const [cardRows, noteRows, commentRows, attachmentRows] = await Promise.all([
      // Cards
      db
        .select({
          id: cards.id,
          cardId: cards.id,
          cardTitle: cards.title,
          boardId: boards.id,
          boardName: boards.name,
          boardIcon: boards.icon,
          boardColor: boards.iconColor,
          listName: lists.name,
          workspaceId: workspaces.id,
          workspaceName: workspaces.name,
          snippet: sql<string>`ts_headline('english', coalesce(${cards.title}, '') || ' ' || coalesce(${cards.description}, ''), ${tsq}, ${HEADLINE_OPTS})`,
        })
        .from(cards)
        .innerJoin(lists, eq(lists.id, cards.listId))
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
        .where(and(or(sql`${cards.searchVector} @@ ${tsq}`, cardTitleMatch), isNull(cards.archivedAt), cardPredicate))
        .orderBy(sql`ts_rank(${cards.searchVector}, ${tsq}) desc`)
        .limit(take),

      // Notes (workspace- or board-scoped; personal notes only for their owner;
      // private-board notes require board membership unless org admin).
      db
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
        })
        .from(notes)
        .innerJoin(workspaces, eq(workspaces.id, notes.workspaceId))
        .leftJoin(boards, eq(boards.id, notes.boardId))
        .where(
          and(
            sql`${notes.searchVector} @@ ${tsq}`,
            or(eq(notes.scope, "team"), eq(notes.ownerId, req.auth.sub)),
            notePredicate,
          ),
        )
        .orderBy(sql`ts_rank(${notes.searchVector}, ${tsq}) desc`)
        .limit(take),

      // Comments
      db
        .select({
          id: comments.id,
          cardId: cards.id,
          cardTitle: cards.title,
          boardId: boards.id,
          boardName: boards.name,
          boardIcon: boards.icon,
          boardColor: boards.iconColor,
          listName: lists.name,
          workspaceId: workspaces.id,
          workspaceName: workspaces.name,
          snippet: sql<string>`ts_headline('english', coalesce(${comments.body}, ''), ${tsq}, ${HEADLINE_OPTS})`,
        })
        .from(comments)
        .innerJoin(cards, eq(cards.id, comments.cardId))
        .innerJoin(lists, eq(lists.id, cards.listId))
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
        .where(and(sql`${comments.searchVector} @@ ${tsq}`, isNull(cards.archivedAt), cardPredicate))
        .orderBy(sql`ts_rank(${comments.searchVector}, ${tsq}) desc`)
        .limit(take),

      // Attachment filenames
      db
        .select({
          id: cardAttachments.id,
          fileName: cardAttachments.fileName,
          cardId: cards.id,
          cardTitle: cards.title,
          boardId: boards.id,
          boardName: boards.name,
          boardIcon: boards.icon,
          boardColor: boards.iconColor,
          listName: lists.name,
          workspaceId: workspaces.id,
          workspaceName: workspaces.name,
          snippet: sql<string>`ts_headline('english', coalesce(${cardAttachments.fileName}, ''), ${tsq}, ${HEADLINE_OPTS})`,
        })
        .from(cardAttachments)
        .innerJoin(cards, eq(cards.id, cardAttachments.cardId))
        .innerJoin(lists, eq(lists.id, cards.listId))
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
        .where(
          and(
            or(sql`${cardAttachments.searchVector} @@ ${tsq}`, attachmentFileNameMatch),
            isNull(cards.archivedAt),
            cardPredicate,
          ),
        )
        .orderBy(sql`ts_rank(${cardAttachments.searchVector}, ${tsq}) desc`)
        .limit(take),
    ]);

    const result: WireSearchResults = {
      cards: cardRows satisfies CardSearchResult[],
      notes: noteRows satisfies NoteSearchResult[],
      comments: commentRows satisfies CommentSearchResult[],
      attachments: attachmentRows satisfies AttachmentSearchResult[],
      query: q,
    };
    return result;
  });
}
