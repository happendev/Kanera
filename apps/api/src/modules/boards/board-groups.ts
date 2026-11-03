import type { CreateBoardGroupBody, MoveBoardGroupBody, UpdateBoardGroupBody } from "@kanera/shared/dto";
import { boardGroups } from "@kanera/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { moveOrderedEntity } from "../../lib/move-ordered-entity.js";
import { between, neighbourPositions as resolveNeighbourPositions } from "../../lib/position.js";
import { rebalanceBoardGroups } from "../../lib/rebalance.js";
import { emitToWorkspace } from "../../realtime/emit.js";

type BoardGroup = typeof boardGroups.$inferSelect;
type MovedBoardGroup = Awaited<ReturnType<typeof moveBoardGroup>>;

// Board groups share the same sparse-position contract as boards; use one-neighbor
// probes rather than materializing every group in the workspace.
function groupNeighbourPositions(workspaceId: string, afterId?: string | null, beforeId?: string | null) {
  return resolveNeighbourPositions({
    table: boardGroups,
    id: boardGroups.id,
    position: boardGroups.position,
    scope: eq(boardGroups.workspaceId, workspaceId),
    afterId,
    beforeId,
    afterLabel: "afterGroupId",
    beforeLabel: "beforeGroupId",
  });
}

export async function createBoardGroup({
  auth,
  workspaceId,
  body,
}: {
  auth: AuthClaims;
  workspaceId: string;
  body: CreateBoardGroupBody;
}): Promise<BoardGroup> {
  const [last] = await db
    .select({ position: boardGroups.position })
    .from(boardGroups)
    .where(eq(boardGroups.workspaceId, workspaceId))
    .orderBy(sql`${boardGroups.position} desc`)
    .limit(1);
  const { position } = between(last?.position ?? null, null);
  const [group] = await db.insert(boardGroups).values({ workspaceId, title: body.title, position }).returning();
  await recordActivity(db, {
    boardId: null,
    workspaceId,
    actorId: auth.sub,
    entityType: "boardGroup",
    entityId: group!.id,
    action: "created",
    payload: { title: group!.title },
  });
  return group!;
}

export async function updateBoardGroup({
  auth,
  current,
  body,
}: {
  auth: AuthClaims;
  current: BoardGroup;
  body: UpdateBoardGroupBody;
}): Promise<BoardGroup> {
  const id = current.id;
  const [group] = await db
    .update(boardGroups)
    .set({ title: body.title, updatedAt: new Date() })
    .where(eq(boardGroups.id, id))
    .returning();
  await recordActivity(db, {
    boardId: null,
    workspaceId: current.workspaceId,
    actorId: auth.sub,
    entityType: "boardGroup",
    entityId: id,
    action: "updated",
    payload: { title: body.title },
  });
  return group!;
}

export async function moveBoardGroup({
  auth,
  current,
  body,
}: {
  auth: AuthClaims;
  current: BoardGroup;
  body: MoveBoardGroupBody;
}) {
  const id = current.id;
  const prevPosition = current.position;
  const { position, rebalancedPositions } = await moveOrderedEntity({
    table: boardGroups,
    idColumn: boardGroups.id,
    id,
    neighbours: await groupNeighbourPositions(current.workspaceId, body.afterGroupId, body.beforeGroupId),
    rebalance: (tx) => rebalanceBoardGroups(current.workspaceId, tx),
    activity: (position) => ({
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: auth.sub,
      entityType: "boardGroup",
      entityId: id,
      action: "moved",
      payload: { prevPosition, position },
    }),
  });
  return { id, workspaceId: current.workspaceId, prevPosition, position, rebalancedPositions };
}

export async function emitBoardGroupMoved({ id, workspaceId, prevPosition, position, rebalancedPositions }: MovedBoardGroup) {
  if (rebalancedPositions) {
    await emitToWorkspace(workspaceId, "boardGroup:rebalanced", { workspaceId, positions: rebalancedPositions });
  }
  await emitToWorkspace(workspaceId, "boardGroup:moved", {
    workspaceId,
    groupId: id,
    position,
    prevPosition,
  });
}

export async function deleteBoardGroup({ auth, group }: { auth: AuthClaims; group: BoardGroup }) {
  const id = group.id;
  await db.delete(boardGroups).where(eq(boardGroups.id, id));
  await recordActivity(db, {
    boardId: null,
    workspaceId: group.workspaceId,
    actorId: auth.sub,
    entityType: "boardGroup",
    entityId: id,
    action: "deleted",
    payload: { title: group.title },
  });
}
