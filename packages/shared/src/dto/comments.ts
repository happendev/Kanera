import { z } from "zod";
import type { ActivityEvent } from "../schema/activity-event.js";
import type { Comment } from "../schema/comment.js";
import type { CommentReactionSummary } from "./comment-reactions.js";

export const listCardCommentsQuery = z.object({
  cursor: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListCardCommentsQuery = z.infer<typeof listCardCommentsQuery>;

export const createCommentBody = z.object({
  body: z.string().min(1).max(20000),
  attachmentIds: z.array(z.uuid()).optional(),
});
export type CreateCommentBody = z.infer<typeof createCommentBody>;

export const updateCommentBody = z.object({
  body: z.string().min(1).max(20000),
  attachmentIds: z.array(z.uuid()).optional(),
});
export type UpdateCommentBody = z.infer<typeof updateCommentBody>;

export type CommentRow = Pick<Comment, "id" | "cardId" | "authorId" | "authorKind" | "apiKeyId" | "apiKeyName" | "body" | "editedAt" | "createdAt"> & {
  authorName: string;
  authorAvatarUrl: string | null;
  reactions: CommentReactionSummary[];
};

export type ActivityFeedEvent = ActivityEvent & {
  actorName: string;
  actorAvatarUrl: string | null;
};

export type CardFeedItem =
  | { type: "comment"; data: CommentRow }
  | { type: "activity"; data: ActivityFeedEvent };

export interface CardFeedPage {
  items: CardFeedItem[];
  nextCursor: string | null;
}

export interface CardCommentsPage {
  items: CommentRow[];
  nextCursor: string | null;
}
