import { cardLabelAssignments, cardLabels, type cards } from "@kanera/shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import type { assertCardAccess } from "../../lib/access.js";
import { lockWorkspaceRelations } from "../../lib/card-relations.js";
import { badRequest } from "../../lib/errors.js";
import { applyCardLabels } from "./route-support.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;

/**
 * Replaces one card's labels with workspace labels (labels are workspace-scoped). Resolves the
 * names of added and removed labels for the activity, then writes through `applyCardLabels`.
 */
export async function setCardLabels({ auth, card, ctx, labelIds }: {
  auth: AuthClaims;
  card: typeof cards.$inferSelect;
  ctx: CardAccessContext;
  labelIds: string[];
}) {
  const id = card.id;
  const currentAssignments = await db
    .select({ labelId: cardLabelAssignments.labelId })
    .from(cardLabelAssignments)
    .where(eq(cardLabelAssignments.cardId, id));
  const previousLabelIds = currentAssignments.map((assignment) => assignment.labelId);
  const nextLabelIdSet = new Set(labelIds);
  let labelNames: string[] = [];
  let labelNamesById: Record<string, string> = {};

  if (labelIds.length > 0) {
    const validLabels = await db
      .select({ id: cardLabels.id, name: cardLabels.name })
      .from(cardLabels)
      .where(and(eq(cardLabels.workspaceId, ctx.workspaceId), inArray(cardLabels.id, labelIds), isNull(cardLabels.archivedAt)));
    if (validLabels.length !== labelIds.length) throw badRequest("one or more label ids are invalid");

    const labelNameById = new Map(validLabels.map((label) => [label.id, label.name]));
    labelNamesById = Object.fromEntries(validLabels.map((label) => [label.id, label.name]));
    labelNames = labelIds
      .map((labelId) => labelNameById.get(labelId))
      .filter((labelName): labelName is string => Boolean(labelName));
  }

  if (previousLabelIds.length > 0) {
    const removedLabelIds = previousLabelIds.filter((labelId) => !nextLabelIdSet.has(labelId));
    if (removedLabelIds.length > 0) {
      const previousLabels = await db
        .select({ id: cardLabels.id, name: cardLabels.name })
        .from(cardLabels)
        .where(and(eq(cardLabels.workspaceId, ctx.workspaceId), inArray(cardLabels.id, removedLabelIds)));
      labelNamesById = {
        ...labelNamesById,
        ...Object.fromEntries(previousLabels.map((label) => [label.id, label.name])),
      };
    }
  }

  return db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    const update = await applyCardLabels(tx, {
      cardId: id,
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      clientId: ctx.clientId,
      actorId: auth.sub,
      previousIds: previousLabelIds,
      nextIds: labelIds,
      labelNames,
      labelNamesById,
    });
    const finalAssignments = await tx
      .select({ labelId: cardLabelAssignments.labelId })
      .from(cardLabelAssignments)
      .where(eq(cardLabelAssignments.cardId, id));
    return { update, finalLabelIds: finalAssignments.map((assignment) => assignment.labelId) };
  });
}
