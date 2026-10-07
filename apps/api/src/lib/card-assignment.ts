import { boardMembers } from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { AuthClaims } from "../auth/plugin.js";
import { db } from "../db.js";

/** People who author a card through the UI watch it; integrations writing on their behalf do not. */
export function shouldAutoWatchAuthoredCards(authKind: AuthClaims["authKind"]) {
  return authKind !== "apiKey";
}

/**
 * Narrows requested assignees to the ones allowed to own work on the board. Only explicit,
 * non-observer board members qualify: board membership is the access model, so assignment never
 * auto-adds anyone, and a workspace member who is not on the board is ineligible until an admin adds
 * them. Observers can watch and be notified but cannot be card owners.
 */
export async function ensureBoardMembershipForUsers(boardId: string, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const existingMembers = await db
    .select({ userId: boardMembers.userId, role: boardMembers.role })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), inArray(boardMembers.userId, userIds)));
  const eligible = new Set(existingMembers.filter((m) => m.role !== "observer").map((m) => m.userId));
  return userIds.filter((uid) => eligible.has(uid));
}
