import type { UpdateWorkspaceBody } from "@kanera/shared/dto";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { boardMirrors, boards, workspaces, type Workspace } from "@kanera/shared/schema";
import { eq, inArray, or } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { notFound } from "../../lib/errors.js";
import { changeWorkspaceCardKeyPrefix } from "../../lib/card-keys.js";
import { deleteExternalLinks } from "../../lib/external-links.js";
import { emitMirrorMetadataToBoards } from "../../lib/board-mirror/events.js";
import { emitWorkspaceFeaturesChanged } from "../../lib/workspace-features.js";
import { resetScheduleLatches } from "../../lib/schedule-events.js";
import { emitToBoardAudience, emitToWorkspace } from "../../realtime/emit.js";

type UpdateWorkspaceResult = Awaited<ReturnType<typeof updateWorkspace>>;

export async function updateWorkspace({ auth, workspaceId: id, body }: { auth: AuthClaims; workspaceId: string; body: UpdateWorkspaceBody }) {
  return db.transaction(async (tx) => {
    const [previous] = await tx.select({ dependenciesEnabled: workspaces.dependenciesEnabled, timelineEnabled: workspaces.timelineEnabled, inProgressEnabled: workspaces.inProgressEnabled })
      .from(workspaces).where(eq(workspaces.id, id)).for("update");
    if (!previous) throw notFound();
    const featuresChanged = (["dependenciesEnabled", "timelineEnabled", "inProgressEnabled"] as const)
      .some((key) => body[key] !== undefined && body[key] !== previous[key]);
    const mirrorsToDelete = body.boardLinkingEnabled === false
      ? await tx.select().from(boardMirrors).where(or(eq(boardMirrors.sourceWorkspaceId, id), eq(boardMirrors.targetWorkspaceId, id)))
      : [];
    // Mirror-created card links are not foreign keys to the mirror row. Remove those durable
    // associations before deleting the mirror definitions so card link indicators cannot linger.
    for (const mirror of mirrorsToDelete) {
      await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider: `mirror:${mirror.id}` }, tx);
    }
    if (mirrorsToDelete.length > 0) {
      await tx.delete(boardMirrors).where(inArray(boardMirrors.id, mirrorsToDelete.map((mirror) => mirror.id)));
    }
    if (body.cardKeyPrefix !== undefined) {
      await changeWorkspaceCardKeyPrefix(tx, id, body.cardKeyPrefix);
    }
    const [workspace] = await tx
      .update(workspaces)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.accentColor !== undefined && { accentColor: body.accentColor }),
        ...(body.completedCardsActiveDays !== undefined && { completedCardsActiveDays: body.completedCardsActiveDays }),
        ...(body.inactiveCardsDays !== undefined && { inactiveCardsDays: body.inactiveCardsDays }),
        ...(body.inProgressAlertDays !== undefined && { inProgressAlertDays: body.inProgressAlertDays }),
        ...(body.timeZone !== undefined && { timeZone: body.timeZone }),
        ...(body.boardLinkingEnabled !== undefined && { boardLinkingEnabled: body.boardLinkingEnabled }),
        ...(body.notesEnabled !== undefined && { notesEnabled: body.notesEnabled }),
        ...(body.dependenciesEnabled !== undefined && { dependenciesEnabled: body.dependenciesEnabled }),
        ...(body.timelineEnabled !== undefined && { timelineEnabled: body.timelineEnabled }),
        ...(body.inProgressEnabled !== undefined && { inProgressEnabled: body.inProgressEnabled }),
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, id))
      .returning();
    let mirroredBoard: typeof boards.$inferSelect | null = null;
    const updatesStandaloneBoard = workspace!.kind === "board" &&
      (body.name !== undefined || body.icon !== undefined || body.accentColor !== undefined);
    if (updatesStandaloneBoard) {
      // Standalone identity lives on both rows: settings edit the hidden workspace while every
      // board-facing surface renders the board. Keep one activity entry and emit both full entities.
      const [updatedBoard] = await tx
        .update(boards)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.icon !== undefined && { icon: body.icon }),
          ...(body.accentColor !== undefined && { iconColor: body.accentColor }),
          updatedAt: new Date(),
        })
        .where(eq(boards.workspaceId, id))
        .returning();
      mirroredBoard = updatedBoard ?? null;
    }
    await recordActivity(tx, {
      boardId: null,
      workspaceId: id,
      actorId: auth.sub,
      entityType: "workspace",
      entityId: id,
      action: "updated",
      payload: { ...body, ...(mirrorsToDelete.length > 0 && { deletedBoardLinkCount: mirrorsToDelete.length }) },
    });
    if ((["dependenciesEnabled", "timelineEnabled"] as const).some((key) => body[key] !== undefined && body[key] !== previous[key])) {
      await resetScheduleLatches(tx, { workspaceId: id });
    }
    return { workspace: workspace!, mirroredBoard, deletedMirrors: mirrorsToDelete, featuresChanged };
  });
}

export async function emitUpdateWorkspace({ workspaceId: id, publicWorkspace, mirroredBoard, deletedMirrors, featuresChanged }: UpdateWorkspaceResult & {
  workspaceId: string;
  publicWorkspace: Omit<Workspace, "lastCardNumber">;
}) {
  await emitToWorkspace(id, "workspace:updated", { workspace: publicWorkspace });
  if (featuresChanged) await emitWorkspaceFeaturesChanged({ workspaceId: id });
  if (mirroredBoard) await emitToBoardAudience(mirroredBoard.id, "board:updated", { board: mirroredBoard }, { workspaceId: id });
  // Disabling linking can remove cross-workspace relationships. Notify both board rooms for every
  // deleted mirror so the other workspace also drops stale link counts and management rows.
  await Promise.all(deletedMirrors.map((mirror) => {
    const payload = { mirrorId: mirror.id, sourceBoardId: mirror.sourceBoardId, targetBoardId: mirror.targetBoardId };
    return emitMirrorMetadataToBoards(mirror, SERVER_EVENTS.BOARD_MIRROR_DELETED, payload);
  }));
}
