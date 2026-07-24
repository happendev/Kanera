import { z } from "zod";
import { COMMENT_REACTION_TYPES } from "../schema/comment-reaction.js";

export const reactionTypeSchema = z.enum(COMMENT_REACTION_TYPES);
export type ReactionType = z.infer<typeof reactionTypeSchema>;

export const addReactionBody = z.object({ type: reactionTypeSchema });
export type AddReactionBody = z.infer<typeof addReactionBody>;

export interface ReactionUserSummary {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CommentReactionSummary {
  type: ReactionType;
  count: number;
  userIds: string[];
  users: ReactionUserSummary[];
}
