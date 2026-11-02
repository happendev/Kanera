import type { CreateBoardBody } from "@kanera/shared/dto";
import { boards, workspaces } from "@kanera/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { recordActivity } from "../../lib/activity.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { seedBoardMembersFromWorkspace } from "../../lib/board-membership.js";
import { between } from "../../lib/position.js";
import { ANALYTICS_EVENT_VERSION, analyticsCountBand, capturePremiumFeatureUsed, productAnalytics } from "../../lib/product-analytics.js";
import { assertBoardLimit } from "../../lib/tier-limits.js";
import { emitToBoardAudience } from "../../realtime/emit.js";
import { validateBoardGroup } from "./route-support.js";

type CreatedBoard = typeof boards.$inferSelect;

export async function createBoard({
  auth,
  workspaceId,
  clientId,
  body,
}: {
  auth: AuthClaims;
  workspaceId: string;
  clientId: string;
  body: CreateBoardBody;
}): Promise<CreatedBoard> {
  const groupId = await validateBoardGroup(workspaceId, body.groupId);

  const [last] = await db
    .select({ position: boards.position })
    .from(boards)
    .where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt)))
    .orderBy(sql`${boards.position} desc`)
    .limit(1);
  const { position } = between(last?.position ?? null, null);

  return db.transaction(async (tx) => {
    // Enforce inside the tx so the cap check and insert share one transaction; the helper takes a
    // tenant row lock to serialize concurrent board creates against the free cap.
    await assertBoardLimit(clientId, tx);
    const [board] = await tx
      .insert(boards)
      .values({
        workspaceId,
        groupId,
        name: body.name,
        inProgressEnabled: body.inProgressEnabled,
        description: body.description,
        icon: body.icon ?? null,
        iconColor: body.iconColor ?? null,
        backgroundGradient: body.backgroundGradient ?? null,
        position,
      })
      .returning();

    // Seed pinned editor rows for every workspace admin so the "admins are on every board"
    // invariant holds from creation. Regular members are not auto-added; they are granted access
    // explicitly per board thereafter. Note: an org owner/admin creator has no workspace_members
    // row, so seeding does not materialize a row for them here — their editor access comes from the
    // org short-circuit in access.ts, and GET /boards/:id/members surfaces them as a pinned admin.
    await seedBoardMembersFromWorkspace(tx, board!.id, workspaceId, auth.sub);

    await recordActivity(tx, {
      boardId: board!.id,
      workspaceId,
      actorId: auth.sub,
      entityType: "board",
      entityId: board!.id,
      action: "created",
      payload: { name: board!.name },
    });

    return board!;
  });
}

export async function emitBoardCreated({
  auth,
  workspaceId,
  clientId,
  board: result,
}: {
  auth: AuthClaims;
  workspaceId: string;
  clientId: string;
  board: CreatedBoard;
}) {
  await emitToBoardAudience(result.id, "board:created", { workspaceId, board: result });
  const supportSession = auth.authKind === "support";
  const [[boardCount], [organizationBoardCount]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(boards)
      .where(and(eq(boards.workspaceId, workspaceId), isNull(boards.archivedAt))),
    db.select({ count: sql<number>`count(*)::int` })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt), isNull(boards.archivedAt))),
  ]);
  void productAnalytics.capture({
    event: "board_created",
    distinctId: auth.sub,
    organizationId: clientId,
    supportSession,
    properties: {
      user_id: auth.sub,
      workspace_id: workspaceId,
      board_count_band: analyticsCountBand(boardCount?.count ?? 1),
      event_version: ANALYTICS_EVENT_VERSION,
    },
  });
  const totalBoards = organizationBoardCount?.count ?? 1;
  if (totalBoards > env.HOSTED_FREE_MAX_BOARDS) void capturePremiumFeatureUsed({
    organizationId: clientId,
    workspaceId,
    actorId: auth.sub,
    premiumFeature: "boards",
    currentUsage: totalBoards,
    supportSession,
  });
  await evaluateWorkspaceAnalyticsMilestones({ workspaceId, actorId: auth.sub, supportSession });
}
