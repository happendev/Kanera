import type { dto } from "@kanera/shared";
import { activityEvents, cards, comments, users } from "@kanera/shared/schema";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assignedCardVisibility, assertBoardAccess } from "../../lib/access.js";
import { fetchReactionsByComment } from "../../lib/comment-reactions.js";
import { signEmbeddedMediaUrls, withSignedMedia } from "../../lib/media-keys.js";

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
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const access = await assertBoardAccess(req.auth, id);

    const [activityRows, commentRows] = await Promise.all([
      db
        .select({
          ...getTableColumns(activityEvents),
          actorName: sql<string>`case when ${activityEvents.actorKind} = 'apiKey' then coalesce(${activityEvents.apiKeyName}, 'API key') else ${users.displayName} end`,
          actorAvatarUrl: sql<string | null>`case when ${activityEvents.actorKind} = 'apiKey' then null else ${users.avatarUrl} end`,
        })
        .from(activityEvents)
        .innerJoin(users, eq(users.id, activityEvents.actorId))
        // Hidden rows are retained for audit/coalescing, but normal feeds only
        // show activity that left a meaningful final state.
        .where(and(
          eq(activityEvents.boardId, id),
          eq(activityEvents.feedVisible, true),
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
        ))
        .orderBy(desc(activityEvents.createdAt))
        .limit(limit),
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
          body: comments.body,
          editedAt: comments.editedAt,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .innerJoin(cards, eq(cards.id, comments.cardId))
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(and(eq(cards.boardId, id), access.assignedItemsOnly ? assignedCardVisibility(req.auth.sub) : undefined))
        .orderBy(desc(comments.createdAt))
        .limit(limit),
    ]);

    const reactionsMap = await fetchReactionsByComment(commentRows.map((c) => c.id), req.auth.cid);

    const feed: dto.CardFeedItem[] = [
      ...activityRows
        .filter((e) => e.entityType !== "comment")
        .map((e) => ({ type: "activity" as const, data: withSignedMedia(req.auth.cid, e) })),
      ...commentRows.map((c) => ({
        type: "comment" as const,
        data: withSignedMedia(req.auth.cid, { ...c, body: signEmbeddedMediaUrls(c.body, req.auth.cid) ?? c.body, reactions: reactionsMap.get(c.id) ?? [] }),
      })),
    ];

    return feed.sort(compareCardFeedItems).slice(0, limit);
  });
}
