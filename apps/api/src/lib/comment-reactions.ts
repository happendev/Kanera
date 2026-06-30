import type { dto } from "@kanera/shared";
import { commentReactions, users } from "@kanera/shared/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { withSignedMedia } from "./media-keys.js";

export async function fetchReactionsByComment(commentIds: string[], clientId?: string) {
  const map = new Map<string, dto.CommentReactionSummary[]>();
  if (commentIds.length === 0) return map;
  const rows = await db
    .select({
      commentId: commentReactions.commentId,
      type: commentReactions.reactionType,
      userId: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      createdAt: commentReactions.createdAt,
    })
    .from(commentReactions)
    .innerJoin(users, eq(users.id, commentReactions.userId))
    .where(inArray(commentReactions.commentId, commentIds))
    .orderBy(asc(commentReactions.createdAt));

  for (const row of rows) {
    const summaries = map.get(row.commentId) ?? [];
    const type = row.type as dto.ReactionType;
    let summary = summaries.find((s) => s.type === type);
    if (!summary) {
      summary = { type, count: 0, userIds: [], users: [] };
      summaries.push(summary);
    }
    summary.count += 1;
    summary.userIds.push(row.userId);
    summary.users.push(withSignedMedia(clientId ?? "", {
      id: row.userId,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
    }));
    map.set(row.commentId, summaries);
  }
  return map;
}
