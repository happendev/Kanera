import type { dto } from "@kanera/shared";
import { activityEvents, cards, comments, users } from "@kanera/shared/schema";
import { and, asc, desc, eq, getTableColumns, gt, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assignedCardVisibility, assertBoardAccess } from "../../lib/access.js";
import { fetchReactionsByComment } from "../../lib/comment-reactions.js";
import { badRequest } from "../../lib/errors.js";
import { signedAvatarUrl, signEmbeddedMediaUrls } from "../../lib/media-keys.js";

type BoardActivityCursor = { boardId: string; createdAt: string; priority: number; id: string };

function encodeBoardActivityCursor(cursor: BoardActivityCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeBoardActivityCursor(value: string | undefined, boardId: string): BoardActivityCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<BoardActivityCursor>;
    if (
      cursor.boardId !== boardId
      || typeof cursor.createdAt !== "string"
      || !Number.isFinite(new Date(cursor.createdAt).getTime())
      || (cursor.priority !== 0 && cursor.priority !== 1)
      || typeof cursor.id !== "string"
      || cursor.id.length === 0
    ) throw badRequest("activity cursor does not match this board");
    return cursor as BoardActivityCursor;
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw badRequest("invalid activity cursor");
  }
}

function afterCursor(cursor: BoardActivityCursor, createdAt: typeof activityEvents.createdAt | typeof comments.createdAt, id: typeof activityEvents.id | typeof comments.id, priority: SQL) {
  const at = new Date(cursor.createdAt);
  return or(
    lt(createdAt, at),
    and(
      eq(createdAt, at),
      or(gt(priority, cursor.priority), and(eq(priority, cursor.priority), gt(id, cursor.id))),
    ),
  );
}

function cardFeedSortPriority(item: dto.CardFeedItem): number {
  return item.type === "activity" && item.data.entityType === "card" && item.data.action === "created" ? 0 : 1;
}

function compareCardFeedItems(a: dto.CardFeedItem, b: dto.CardFeedItem): number {
  const ta = new Date(a.data.createdAt as unknown as string).getTime();
  const tb = new Date(b.data.createdAt as unknown as string).getTime();
  if (ta !== tb) return tb - ta;
  const priority = cardFeedSortPriority(a) - cardFeedSortPriority(b);
  if (priority !== 0) return priority;
  return String(a.data.id).localeCompare(String(b.data.id));
}

export async function activityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/boards/:id/activity", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: string; cursor?: string };
    const limit = Math.min(Number(q.limit ?? 50), 200);
    if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit must be a positive integer");
    const cursor = decodeBoardActivityCursor(q.cursor, id);
    const publicRequest = req.url.startsWith("/api/v1/");
    const access = await assertBoardAccess(req.auth, id);
    const activityPriority = sql<number>`case when ${activityEvents.entityType} = 'card' and ${activityEvents.action} = 'created' then 0 else 1 end`;
    const commentPriority = sql<number>`1`;

    const [activityRows, commentRows] = await Promise.all([
      db
        .select({
          ...getTableColumns(activityEvents),
          actorName: sql<string>`case when ${activityEvents.actorKind} = 'apiKey' then coalesce(${activityEvents.apiKeyName}, 'API key') else ${users.displayName} end`,
          actorAvatarUrl: sql<string | null>`case when ${activityEvents.actorKind} = 'apiKey' then null else ${users.avatarUrl} end`,
          actorClientId: users.clientId,
        })
        .from(activityEvents)
        .innerJoin(users, eq(users.id, activityEvents.actorId))
        // Hidden rows are retained for audit/coalescing, but normal feeds only
        // show activity that left a meaningful final state.
        .where(and(
          eq(activityEvents.boardId, id),
          eq(activityEvents.feedVisible, true),
          // Comments are selected as rich rows below; exclude their audit twins before limiting so
          // a comment burst cannot hide older card activity or make a cursor page appear complete.
          ne(activityEvents.entityType, "comment"),
          // Legacy mirror summaries do not describe a user action and duplicate the structured
          // audit events now copied from the source card.
          sql`${activityEvents.coalesceKey} is distinct from 'card:mirrorSync'`,
          // Mirror lifecycle rows expose the relationship itself, unlike ordinary card/content
          // activity. Keep them visible only to an organisation that owns either participating
          // workspace; deleted rows carry the organisation ids in their immutable payload.
          sql`(
            ${activityEvents.action} not in ('mirror:created', 'mirror:updated', 'mirror:deleted', 'mirror:disabled', 'mirror:enabled')
            or ${activityEvents.payload}->>'sourceClientId' = ${req.auth.cid}
            or ${activityEvents.payload}->>'targetClientId' = ${req.auth.cid}
            or exists (
              select 1 from board_mirror bm
              inner join workspace sw on sw.id = bm.source_workspace_id
              inner join workspace tw on tw.id = bm.target_workspace_id
              where bm.id::text = ${activityEvents.payload}->>'mirrorId'
                and (sw.client_id = ${req.auth.cid} or tw.client_id = ${req.auth.cid})
            )
          )`,
          access.assignedItemsOnly ? and(eq(activityEvents.entityType, "card"), assignedCardVisibility(req.auth.sub, activityEvents.entityId)) : undefined,
          cursor ? afterCursor(cursor, activityEvents.createdAt, activityEvents.id, activityPriority) : undefined,
        ))
        .orderBy(desc(activityEvents.createdAt), asc(activityPriority), asc(activityEvents.id))
        .limit(limit + 1),
      db
        .select({
          id: comments.id,
          cardId: comments.cardId,
          authorId: comments.authorId,
          authorKind: comments.authorKind,
          apiKeyId: comments.apiKeyId,
          apiKeyName: comments.apiKeyName,
          authorName: sql<string>`case when ${comments.authorKind} = 'system' then 'Kanera' when ${comments.authorKind} = 'apiKey' then coalesce(${comments.apiKeyName}, 'API key') else ${users.displayName} end`,
          authorAvatarUrl: sql<string | null>`case when ${comments.authorKind} in ('system', 'apiKey') then null else ${users.avatarUrl} end`,
          authorClientId: users.clientId,
          body: comments.body,
          editedAt: comments.editedAt,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .innerJoin(cards, eq(cards.id, comments.cardId))
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(and(
          eq(cards.boardId, id),
          access.assignedItemsOnly ? assignedCardVisibility(req.auth.sub) : undefined,
          cursor ? afterCursor(cursor, comments.createdAt, comments.id, commentPriority) : undefined,
        ))
        .orderBy(desc(comments.createdAt), asc(comments.id))
        .limit(limit + 1),
    ]);

    const reactionsMap = await fetchReactionsByComment(commentRows.map((c) => c.id));

    const feed: dto.CardFeedItem[] = [
      ...activityRows
        .map(({ actorClientId, actorAvatarUrl, ...event }) => ({
          type: "activity" as const,
          data: { ...event, actorAvatarUrl: signedAvatarUrl(actorClientId, actorAvatarUrl) },
        })),
      ...commentRows.map(({ authorClientId, authorAvatarUrl, ...comment }) => ({
        type: "comment" as const,
        data: {
          ...comment,
          authorAvatarUrl: signedAvatarUrl(authorClientId, authorAvatarUrl),
          body: signEmbeddedMediaUrls(comment.body, req.auth.cid) ?? comment.body,
          reactions: reactionsMap.get(comment.id) ?? [],
        },
      })),
    ];

    const sorted = feed.sort(compareCardFeedItems);
    const page = sorted.slice(0, limit);
    if (!publicRequest) return page;
    const hasMore = sorted.length > limit;
    const last = page.at(-1);
    return {
      items: page,
      nextCursor: hasMore && last
        ? encodeBoardActivityCursor({
            boardId: id,
            createdAt: new Date(last.data.createdAt as unknown as string).toISOString(),
            priority: cardFeedSortPriority(last),
            id: last.data.id,
          })
        : null,
    };
  });
}
