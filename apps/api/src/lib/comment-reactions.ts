import type { dto } from "@kanera/shared";
import { cardAttachmentReactions, commentReactions, users } from "@kanera/shared/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { signedAvatarUrl } from "./media-keys.js";

type ReactionRow = {
  targetId: string;
  type: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  userClientId: string;
};

function summarizeReactions(rows: ReactionRow[]) {
  const map = new Map<string, dto.CommentReactionSummary[]>();
  for (const row of rows) {
    const summaries = map.get(row.targetId) ?? [];
    const type = row.type as dto.ReactionType;
    let summary = summaries.find((s) => s.type === type);
    if (!summary) {
      summary = { type, count: 0, userIds: [], users: [] };
      summaries.push(summary);
    }
    summary.count += 1;
    summary.userIds.push(row.userId);
    summary.users.push({
      id: row.userId,
      displayName: row.displayName,
      avatarUrl: signedAvatarUrl(row.userClientId, row.avatarUrl),
    });
    map.set(row.targetId, summaries);
  }
  return map;
}

export async function fetchReactionsByComment(commentIds: string[]) {
  if (commentIds.length === 0) return new Map<string, dto.CommentReactionSummary[]>();
  const rows = await db
    .select({
      targetId: commentReactions.commentId,
      type: commentReactions.reactionType,
      userId: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      userClientId: users.clientId,
    })
    .from(commentReactions)
    .innerJoin(users, eq(users.id, commentReactions.userId))
    .where(inArray(commentReactions.commentId, commentIds))
    .orderBy(asc(commentReactions.createdAt));
  return summarizeReactions(rows);
}

export async function fetchReactionsByAttachment(attachmentIds: string[]) {
  if (attachmentIds.length === 0) return new Map<string, dto.CommentReactionSummary[]>();
  const rows = await db
    .select({
      targetId: cardAttachmentReactions.attachmentId,
      type: cardAttachmentReactions.reactionType,
      userId: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      userClientId: users.clientId,
    })
    .from(cardAttachmentReactions)
    .innerJoin(users, eq(users.id, cardAttachmentReactions.userId))
    .where(inArray(cardAttachmentReactions.attachmentId, attachmentIds))
    .orderBy(asc(cardAttachmentReactions.createdAt));
  return summarizeReactions(rows);
}
