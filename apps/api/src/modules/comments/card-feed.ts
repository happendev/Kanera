import type { dto } from "@kanera/shared";
import { activityEvents, comments, users, type cards } from "@kanera/shared/schema";
import { and, asc, desc, eq, getTableColumns, ne, or, sql } from "drizzle-orm";
import { db } from "../../db.js";
import { fetchReactionsByComment } from "../../lib/comment-reactions.js";
import { signedAvatarUrl } from "../../lib/media-keys.js";
import { cardFeedSortPriority, compareCardFeedItems, feedAfterCursor } from "../../lib/card-feed.js";
import { commentAuthorColumns } from "../../lib/comment-rows.js";
import { encodeCursor, mirrorIdsByCommentId, signedCommentRow, type CardFeedCursor } from "./comment-queries.js";

/** The `GET /cards/:id/feed` page; the route has already parsed the cursor and authorised the card. */
export async function loadCardFeedPage({
  card,
  cursor,
  limit,
  clientId,
}: {
  card: typeof cards.$inferSelect;
  cursor: CardFeedCursor | null;
  limit: number;
  clientId: string;
}): Promise<dto.CardFeedPage> {
  const cardId = card.id;
  const commentConditions = [eq(comments.cardId, cardId)];
  const commentPriority = sql<number>`1`;
  if (cursor) commentConditions.push(feedAfterCursor(cursor, comments.createdAt, comments.id, commentPriority));

  const activityConditions = [
    eq(activityEvents.boardId, card.boardId),
    // Comments already appear as rich feed rows. Exclude their audit rows before applying the
    // source limit so a burst of comments cannot hide older card activity or end pagination early.
    ne(activityEvents.entityType, "comment"),
    // Keep collapsed/no-op bursts out of the card detail feed while the
    // underlying activity row remains available to the audit trail.
    eq(activityEvents.feedVisible, true),
    or(
      and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, cardId)),
      sql`${activityEvents.payload}->>'cardId' = ${cardId}`,
    )!,
  ];
  const activityPriority = sql<number>`case when ${activityEvents.entityType} = 'card' and ${activityEvents.action} = 'created' then 0 else 1 end`;
  if (cursor) activityConditions.push(feedAfterCursor(cursor, activityEvents.createdAt, activityEvents.id, activityPriority));

  const [commentRows, activityRows] = await Promise.all([
    db
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
      .where(and(...commentConditions))
      .orderBy(desc(comments.createdAt), asc(comments.id))
      .limit(limit + 1),
    db
      .select({
        ...getTableColumns(activityEvents),
        actorName: sql<string>`case when ${activityEvents.actorKind} = 'system' then 'Kanera' when ${activityEvents.actorKind} = 'apiKey' then coalesce(${activityEvents.apiKeyName}, 'API key') else ${users.displayName} end`,
        actorAvatarUrl: sql<string | null>`case when ${activityEvents.actorKind} in ('system', 'apiKey') then null else ${users.avatarUrl} end`,
        actorClientId: users.clientId,
      })
      .from(activityEvents)
      .leftJoin(users, eq(users.id, activityEvents.actorId))
      .where(and(...activityConditions))
      .orderBy(desc(activityEvents.createdAt), asc(activityPriority), asc(activityEvents.id))
      .limit(limit + 1),
  ]);

  const [reactionsMap, mirrorIds] = await Promise.all([
    fetchReactionsByComment(commentRows.map((c) => c.id)),
    mirrorIdsByCommentId(commentRows.map((comment) => comment.id)),
  ]);

  const feed: dto.CardFeedItem[] = [
    ...commentRows.map((comment) => ({
      type: "comment" as const,
      data: signedCommentRow({ ...comment, mirrorId: mirrorIds.get(comment.id) ?? null }, reactionsMap.get(comment.id) ?? [], clientId),
    })),
    ...activityRows
      .map(({ actorClientId, actorAvatarUrl, ...event }) => ({
        type: "activity" as const,
        data: { ...event, actorAvatarUrl: actorClientId ? signedAvatarUrl(actorClientId, actorAvatarUrl) : null },
      })),
  ];

  const sortedFeed = feed.sort(compareCardFeedItems);
  const hasMore = sortedFeed.length > limit;
  const page = sortedFeed.slice(0, limit);

  return {
    revision: String(card.detailRevision),
    items: page,
    nextCursor: hasMore
      ? encodeCursor({
          kind: "cardFeed",
          createdAt: new Date(page[page.length - 1]!.data.createdAt as unknown as string).toISOString(),
          priority: cardFeedSortPriority(page[page.length - 1]!),
          id: page[page.length - 1]!.data.id,
        })
      : null,
  } satisfies dto.CardFeedPage;
}
