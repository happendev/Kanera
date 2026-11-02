import type { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { boards, standaloneBoardGroups, workspaces } from "@kanera/shared/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { boardRealtimeAudience, emitToBoardAudience, emitToClientDurable, emitToUserDurable } from "../../realtime/emit.js";
import { externalBoardGuestUserIds } from "./client-queries.js";

/**
 * `PATCH /clients/me/standalone-boards/:boardId/group`: moves a standalone board into a group
 * (creating it by title when needed) and drops the previous group once it is empty.
 */
export async function assignStandaloneBoardGroup({ auth, boardId, body }: { auth: AuthClaims; boardId: string; body: dto.AssignStandaloneBoardGroupBody }) {
  const audience = await boardRealtimeAudience(boardId);
  const guestUserIds = await externalBoardGuestUserIds(boardId, auth.cid);
  const result = await db.transaction(async (tx) => {
    // Group names are the configuration surface. Serialize per organisation so two boards using
    // the same new name converge on one row even when saved concurrently.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${auth.cid}))`);
    const [current] = await tx.select({ board: boards, workspace: workspaces })
      .from(boards).innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(eq(boards.id, boardId), eq(workspaces.clientId, auth.cid))).limit(1);
    if (!current) throw notFound("board not found");
    if (current.workspace.kind !== "board") throw badRequest("board is not a standalone board");
    const [previousGroup] = current.board.standaloneGroupId
      ? await tx.select().from(standaloneBoardGroups).where(eq(standaloneBoardGroups.id, current.board.standaloneGroupId)).limit(1)
      : [];
    let group = null;
    if (body.groupTitle) {
      [group] = await tx.select().from(standaloneBoardGroups)
        .where(and(
          eq(standaloneBoardGroups.clientId, auth.cid),
          sql`lower(${standaloneBoardGroups.title}) = lower(${body.groupTitle})`,
        )).orderBy(asc(standaloneBoardGroups.createdAt)).limit(1);
      if (!group) {
        [group] = await tx.insert(standaloneBoardGroups).values({ clientId: auth.cid, title: body.groupTitle }).returning();
        await recordActivity(tx, {
          boardId: null, workspaceId: null, clientId: auth.cid, actorId: auth.sub,
          entityType: "standaloneBoardGroup", entityId: group!.id, action: "created", payload: { title: group!.title },
        });
      }
    }
    const [board] = await tx.update(boards).set({ standaloneGroupId: group?.id ?? null, updatedAt: new Date() })
      .where(eq(boards.id, boardId)).returning();
    await recordActivity(tx, {
      boardId, workspaceId: board!.workspaceId, clientId: auth.cid, actorId: auth.sub,
      entityType: "board", entityId: boardId, action: "updated",
      payload: { standaloneGroupId: group?.id ?? null, standaloneGroupTitle: group?.title ?? null, previousStandaloneGroupId: current.board.standaloneGroupId },
    });
    let deletedGroup = null;
    if (previousGroup && previousGroup.id !== group?.id) {
      const [countRow] = await tx.select({ count: sql<number>`count(*)::int` }).from(boards).where(eq(boards.standaloneGroupId, previousGroup.id));
      if ((countRow?.count ?? 0) === 0) {
        await tx.delete(standaloneBoardGroups).where(eq(standaloneBoardGroups.id, previousGroup.id));
        await recordActivity(tx, {
          boardId: null, workspaceId: null, clientId: auth.cid, actorId: auth.sub,
          entityType: "standaloneBoardGroup", entityId: previousGroup.id, action: "deleted", payload: { title: previousGroup.title },
        });
        deletedGroup = previousGroup;
      }
    }
    return { board: board!, group, deletedGroup };
  });
  return { ...result, boardId, audience, guestUserIds };
}

export async function emitStandaloneBoardGroupAssigned({ auth, result }: { auth: AuthClaims; result: Awaited<ReturnType<typeof assignStandaloneBoardGroup>> }) {
  const { boardId, audience, guestUserIds } = result;
  if (result.deletedGroup) {
    await emitToClientDurable(auth.cid, SERVER_EVENTS.STANDALONE_BOARD_GROUP_DELETED, { clientId: auth.cid, groupId: result.deletedGroup.id });
    await Promise.all(guestUserIds.map((userId) => emitToUserDurable(userId, SERVER_EVENTS.STANDALONE_BOARD_GROUP_DELETED, { clientId: auth.cid, groupId: result.deletedGroup!.id })));
  }
  if (result.group) {
    await emitToClientDurable(auth.cid, SERVER_EVENTS.STANDALONE_BOARD_GROUP_UPSERTED, { group: result.group });
    await Promise.all(guestUserIds.map((userId) => emitToUserDurable(userId, SERVER_EVENTS.STANDALONE_BOARD_GROUP_UPSERTED, { group: result.group! })));
  }
  await emitToBoardAudience(boardId, SERVER_EVENTS.BOARD_UPDATED, { board: result.board }, { workspaceId: result.board.workspaceId, audienceUserIds: audience });
}
