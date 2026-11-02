import type { dto } from "@kanera/shared";
import { activityEvents, comments, externalLinks, users } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db.js";
import { fetchReactionsByComment } from "../../lib/comment-reactions.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { signedAvatarUrl, signEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { commentAuthorColumns } from "../../lib/comment-rows.js";

type CommentCursor = { kind: "cardComments"; createdAt: string; id: string };
export type CardFeedCursor = { kind: "cardFeed"; createdAt: string; priority: number; id: string };

export function encodeCursor(cursor: CommentCursor | CardFeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodedCursor(raw: string | undefined): CommentCursor | CardFeedCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      kind?: unknown;
      createdAt?: unknown;
      id?: unknown;
      priority?: unknown;
    };
    if (
      (parsed.kind !== "cardComments" && parsed.kind !== "cardFeed")
      || typeof parsed.createdAt !== "string"
      || !Number.isFinite(new Date(parsed.createdAt).getTime())
      || typeof parsed.id !== "string"
      || !/^[0-9a-f-]{36}$/i.test(parsed.id)
      || (parsed.kind === "cardFeed" && parsed.priority !== 0 && parsed.priority !== 1)
    ) throw new Error();
    return parsed as CommentCursor | CardFeedCursor;
  } catch {
    // Preserve cursors issued by older clients while making every newly issued cursor lossless.
    if (Number.isFinite(new Date(raw).getTime())) return { kind: "cardComments", createdAt: raw, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" };
    throw badRequest("invalid card feed cursor");
  }
}

export function commentCursor(raw: string | undefined): CommentCursor | null {
  const cursor = decodedCursor(raw);
  if (!cursor) return null;
  if (cursor.kind !== "cardComments") throw badRequest("cursor does not belong to card comments");
  return cursor;
}

export function cardFeedCursor(raw: string | undefined): CardFeedCursor | null {
  const cursor = decodedCursor(raw);
  if (!cursor) return null;
  if (cursor.kind === "cardFeed") return cursor;
  // A legacy timestamp cursor means strictly before that instant for every feed item.
  return { kind: "cardFeed", createdAt: cursor.createdAt, priority: 1, id: cursor.id };
}

function commentAfterCursor(cursor: CommentCursor, createdAt = comments.createdAt, id = comments.id): SQL {
  const at = new Date(cursor.createdAt);
  return or(lt(createdAt, at), and(eq(createdAt, at), gt(id, cursor.id)))!;
}

export async function selectCommentRow(commentId: string, clientId: string): Promise<dto.CommentRow> {
  const rows = await selectCommentRows([commentId], clientId);
  const comment = rows[0];
  if (!comment) throw notFound();
  return comment;
}

export async function mirrorIdsByCommentId(commentIds: string[]): Promise<Map<string, string>> {
  if (commentIds.length === 0) return new Map();
  const [links, mirrorCommentActivities] = await Promise.all([
    db
      .select({ commentId: externalLinks.entityId, provider: externalLinks.provider })
      .from(externalLinks)
      .where(and(
        eq(externalLinks.entityType, "comment"),
        eq(externalLinks.externalType, "comment"),
        inArray(externalLinks.entityId, commentIds),
        sql`${externalLinks.provider} like 'mirror:%'`,
      )),
    // Initial provenance and source-archive comments are destination-owned notes rather than
    // externally linked source comments. Their durable activity payload carries the mirror id,
    // including for cards created before CommentRow exposed mirror provenance.
    db
      .select({
        commentId: activityEvents.entityId,
        mirrorId: sql<string | null>`${activityEvents.payload}->>'mirrorId'`,
      })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.entityType, "comment"),
        inArray(activityEvents.entityId, commentIds),
        sql`${activityEvents.payload}->>'mirrorId' is not null`,
      )),
  ]);
  const result = new Map(links.flatMap((link) => {
    const mirrorId = link.provider.slice("mirror:".length);
    return mirrorId ? [[link.commentId, mirrorId] as const] : [];
  }));
  for (const row of mirrorCommentActivities) {
    if (row.mirrorId) result.set(row.commentId, row.mirrorId);
  }
  return result;
}

export async function selectCommentRows(commentIds: string[], clientId: string): Promise<dto.CommentRow[]> {
  if (commentIds.length === 0) return [];
  const rows = await db
    .select({
      id: comments.id,
      cardId: comments.cardId,
      authorId: comments.authorId,
      authorKind: comments.authorKind,
      apiKeyId: comments.apiKeyId,
      apiKeyName: comments.apiKeyName,
      agentName: comments.agentName,
      ...commentAuthorColumns,
      authorClientId: users.clientId,
      body: comments.body,
      editedAt: comments.editedAt,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(inArray(comments.id, commentIds));
  const [reactionsMap, mirrorIds] = await Promise.all([
    fetchReactionsByComment(commentIds),
    mirrorIdsByCommentId(commentIds),
  ]);
  const byId = new Map(rows.map((row) => [row.id, signedCommentRow({ ...row, mirrorId: mirrorIds.get(row.id) ?? null }, reactionsMap.get(row.id) ?? [], clientId)]));
  return commentIds.flatMap((commentId) => {
    const row = byId.get(commentId);
    return row ? [row] : [];
  });
}

export function signedCommentRow(
  comment: Omit<dto.CommentRow, "reactions"> & { authorClientId: string },
  reactions: dto.CommentRow["reactions"],
  clientId: string,
): dto.CommentRow {
  const { authorClientId, ...wireComment } = comment;
  return {
    ...wireComment,
    authorAvatarUrl: signedAvatarUrl(authorClientId, comment.authorAvatarUrl),
    body: signEmbeddedMediaUrls(comment.body, clientId) ?? comment.body,
    reactions,
  };
}

/** The `GET /cards/:id/comments` page; the route has already parsed the cursor and authorised the card. */
export async function listCardComments({
  cardId,
  cursor,
  limit,
  clientId,
}: {
  cardId: string;
  cursor: CommentCursor | null;
  limit: number;
  clientId: string;
}): Promise<dto.CardCommentsPage> {
  const conditions = [eq(comments.cardId, cardId)];
  if (cursor) conditions.push(commentAfterCursor(cursor));

  const rows = await db
    .select({
      id: comments.id,
      cardId: comments.cardId,
      authorId: comments.authorId,
      authorKind: comments.authorKind,
      apiKeyId: comments.apiKeyId,
      apiKeyName: comments.apiKeyName,
      agentName: comments.agentName,
      ...commentAuthorColumns,
      authorClientId: users.clientId,
      body: comments.body,
      editedAt: comments.editedAt,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(and(...conditions))
    .orderBy(desc(comments.createdAt), asc(comments.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const [reactionsMap, mirrorIds] = await Promise.all([
    fetchReactionsByComment(pageRows.map((row) => row.id)),
    mirrorIdsByCommentId(pageRows.map((row) => row.id)),
  ]);

  return {
    items: pageRows.map((row) => signedCommentRow({ ...row, mirrorId: mirrorIds.get(row.id) ?? null }, reactionsMap.get(row.id) ?? [], clientId)),
    nextCursor: hasMore
      ? encodeCursor({
          kind: "cardComments",
          createdAt: pageRows[pageRows.length - 1]!.createdAt.toISOString(),
          id: pageRows[pageRows.length - 1]!.id,
        })
      : null,
  };
}
