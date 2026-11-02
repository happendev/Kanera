import type { UpdateBoardBackgroundBody, UpdateBoardBody } from "@kanera/shared/dto";
import { boards, workspaces } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { validateBoardGroup, type BoardAccessContext } from "./route-support.js";

export async function updateBoard({
  auth,
  ctx,
  boardId: id,
  body,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  body: UpdateBoardBody;
}) {
  if (body.groupId !== undefined) await validateBoardGroup(ctx.workspaceId, body.groupId);

  return db.transaction(async (tx) => {
    const [board] = await tx
      .update(boards)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.groupId !== undefined && { groupId: body.groupId }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.iconColor !== undefined && { iconColor: body.iconColor }),
        ...(body.backgroundGradient !== undefined && { backgroundGradient: body.backgroundGradient }),
        ...(body.inProgressEnabled !== undefined && { inProgressEnabled: body.inProgressEnabled }),
        updatedAt: new Date(),
      })
      .where(eq(boards.id, id))
      .returning();
    let mirroredWorkspace: typeof workspaces.$inferSelect | null = null;
    const updatesStandaloneIdentity = body.name !== undefined || body.icon !== undefined || body.iconColor !== undefined;
    if (updatesStandaloneIdentity) {
      const [updatedWorkspace] = await tx
        .update(workspaces)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.icon !== undefined && { icon: body.icon }),
          ...(body.iconColor !== undefined && { accentColor: body.iconColor }),
          updatedAt: new Date(),
        })
        .where(and(eq(workspaces.id, ctx.workspaceId), eq(workspaces.kind, "board")))
        .returning();
      mirroredWorkspace = updatedWorkspace ?? null;
    }
    // This is the other half of standalone identity mirroring. The board activity represents the
    // user action, so do not create a duplicate workspace activity row for the same edit.
    await recordActivity(tx, {
      boardId: id,
      workspaceId: ctx.workspaceId,
      actorId: auth.sub,
      entityType: "board",
      entityId: id,
      action: "updated",
      payload: body,
    });
    return { board: board!, mirroredWorkspace };
  });
}

export async function updateBoardBackground({
  auth,
  ctx,
  boardId: id,
  body,
}: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  body: UpdateBoardBackgroundBody;
}) {
  const [board] = await db
    .update(boards)
    .set({ backgroundGradient: body.backgroundGradient, updatedAt: new Date() })
    .where(eq(boards.id, id))
    .returning();

  await recordActivity(db, {
    boardId: id,
    workspaceId: ctx.workspaceId,
    actorId: auth.sub,
    entityType: "board",
    entityId: id,
    action: "updated",
    payload: { backgroundGradient: body.backgroundGradient },
  });
  return board!;
}
