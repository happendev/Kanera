import { cardAssignees, users, type cards } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import type { assertCardAccess } from "../../lib/access.js";
import { ensureBoardMembershipForUsers } from "../../lib/card-assignment.js";
import { lockWorkspaceRelations } from "../../lib/card-relations.js";
import { badRequest } from "../../lib/errors.js";
import { applyCardAssignees } from "./route-support.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;

/**
 * Replaces one card's assignees with assignable board members, resolves display names for the
 * activity, then writes through `applyCardAssignees`. `nextUserIds` must already be de-duplicated.
 */
export async function setCardAssignees({ auth, card, ctx, nextUserIds }: {
  auth: AuthClaims;
  card: typeof cards.$inferSelect;
  ctx: CardAccessContext;
  nextUserIds: string[];
}) {
  const id = card.id;
  if (nextUserIds.length > 0) {
    const eligibleUserIds = await ensureBoardMembershipForUsers(card.boardId, nextUserIds);
    if (eligibleUserIds.length !== nextUserIds.length) {
      throw badRequest("one or more user ids are not assignable members");
    }
  }

  const currentAssignments = await db
    .select({ userId: cardAssignees.userId })
    .from(cardAssignees)
    .where(eq(cardAssignees.cardId, id));
  const previousUserIds = currentAssignments.map((assignment) => assignment.userId);
  const relevantUserIds = Array.from(new Set([...previousUserIds, ...nextUserIds]));
  let assigneeNamesById: Record<string, string> = {};

  if (relevantUserIds.length > 0) {
    const changedUsers = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, relevantUserIds));
    assigneeNamesById = Object.fromEntries(changedUsers.map((user) => [user.id, user.displayName]));
  }

  return db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    const update = await applyCardAssignees(tx, {
      cardId: id,
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      clientId: ctx.clientId,
      actorId: auth.sub,
      previousIds: previousUserIds,
      nextIds: nextUserIds,
      assigneeNamesById,
    });
    const finalAssignments = await tx
      .select({ userId: cardAssignees.userId })
      .from(cardAssignees)
      .where(eq(cardAssignees.cardId, id));
    // Single-card writes publish the final set; bulk writes replay the authored set before effects.
    return { ...update, assigneeIds: finalAssignments.map((assignment) => assignment.userId) };
  });
}
