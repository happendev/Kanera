import { z } from "zod";

export const reactionTypeSchema = z.enum(["thumbs_up"]);
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
