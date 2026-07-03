import { boardMembers, boards, cardMentions, type MentionSource } from "@kanera/shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db.js";

type MentionDb = Pick<Db, "select" | "insert" | "delete">;

const MENTION_RE = /@\[([^\]]+)\]\(kanera-user:([0-9a-fA-F-]{36})\)/g;

export function extractMentionUserIds(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  for (const match of markdown.matchAll(MENTION_RE)) {
    ids.add(match[2]!.toLowerCase());
  }
  return [...ids];
}

export async function replaceCardMentions(params: {
  tx: MentionDb;
  boardId: string;
  cardId: string;
  commentId?: string | null;
  source: MentionSource;
  markdown: string | null | undefined;
}): Promise<string[]> {
  const { tx, boardId, cardId, commentId = null, source, markdown } = params;
  await tx
    .delete(cardMentions)
    .where(
      and(
        eq(cardMentions.cardId, cardId),
        source === "comment" && commentId ? eq(cardMentions.commentId, commentId) : isNull(cardMentions.commentId),
        eq(cardMentions.source, source),
      ),
    );

  const mentionedIds = extractMentionUserIds(markdown);
  if (mentionedIds.length === 0) return [];

  const [board] = await tx.select({ id: boards.id }).from(boards).where(eq(boards.id, boardId)).limit(1);
  if (!board) return [];

  // Only explicit board members may be mentioned. Board membership is the access model, so a
  // non-member must not be pulled into a card thread via an @mention.
  const boardRows = await tx
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), inArray(boardMembers.userId, mentionedIds)));

  const allowed = new Set(boardRows.map((row) => row.userId));
  const rows = mentionedIds
    .filter((userId) => allowed.has(userId))
    .map((userId) => ({ cardId, commentId, userId, source }));

  if (rows.length > 0) {
    await tx.insert(cardMentions).values(rows).onConflictDoNothing();
  }
  return rows.map((row) => row.userId);
}
