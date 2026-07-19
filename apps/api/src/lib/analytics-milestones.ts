import {
  activityEvents,
  boardInvitations,
  boardInvitationGrants,
  boardMembers,
  boards,
  clients,
  inviteTokens,
  inviteWorkspaceGrants,
  users,
  workspaceAnalyticsMilestones,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import { productAnalytics } from "./product-analytics.js";

function elapsedBand(value: number, unit: "hours" | "days"): string {
  const cutoffs = unit === "hours" ? [1, 6, 24, 72, 168] : [1, 3, 7, 14, 30];
  const labels = unit === "hours"
    ? ["under_1h", "1_6h", "6_24h", "1_3d", "3_7d", "over_7d"]
    : ["under_1d", "1_3d", "3_7d", "7_14d", "14_30d", "over_30d"];
  return labels[cutoffs.findIndex((cutoff) => value < cutoff)] ?? labels.at(-1)!;
}

/**
 * Re-evaluates durable workspace milestones after a confirmed business write. The conditional updates
 * are the idempotency boundary: concurrent requests may both evaluate, but only one captures each event.
 */
async function evaluateWorkspaceAnalyticsMilestonesInternal(input: {
  workspaceId: string;
  actorId: string;
  supportSession?: boolean;
}): Promise<void> {
  if (input.supportSession) return;
  await db.insert(workspaceAnalyticsMilestones)
    .values({ workspaceId: input.workspaceId })
    .onConflictDoNothing();
  const [workspace] = await db
    .select({
      id: workspaces.id,
      clientId: workspaces.clientId,
      createdAt: workspaces.createdAt,
      analyticsActivatedAt: workspaceAnalyticsMilestones.activatedAt,
      analyticsQualifiedAt: workspaceAnalyticsMilestones.qualifiedAt,
      analyticsExcluded: clients.analyticsExcluded,
    })
    .from(workspaces)
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .innerJoin(workspaceAnalyticsMilestones, eq(workspaceAnalyticsMilestones.workspaceId, workspaces.id))
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  if (!workspace || workspace.analyticsExcluded) return;

  const [firstBoard, firstOrgInvite, firstGuestInvite] = await Promise.all([
    db.select({ id: boards.id, createdAt: boards.createdAt }).from(boards)
      .where(and(eq(boards.workspaceId, workspace.id), isNull(boards.archivedAt)))
      .orderBy(boards.createdAt).limit(1),
    db.select({ createdAt: inviteTokens.createdAt }).from(inviteWorkspaceGrants)
      .innerJoin(inviteTokens, eq(inviteTokens.id, inviteWorkspaceGrants.inviteId))
      .where(and(eq(inviteWorkspaceGrants.workspaceId, workspace.id), isNull(inviteTokens.revokedAt)))
      .orderBy(inviteTokens.createdAt).limit(1),
    db.select({ createdAt: boardInvitations.createdAt }).from(boardInvitationGrants)
      .innerJoin(boardInvitations, eq(boardInvitations.id, boardInvitationGrants.invitationId))
      .innerJoin(boards, eq(boards.id, boardInvitationGrants.boardId))
      .where(and(eq(boards.workspaceId, workspace.id), isNull(boardInvitations.revokedAt)))
      .orderBy(boardInvitations.createdAt).limit(1),
  ]);

  const boardAt = firstBoard[0]?.createdAt;
  const inviteAt = [firstOrgInvite[0]?.createdAt, firstGuestInvite[0]?.createdAt]
    .filter((value): value is Date => !!value)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  if (!workspace.analyticsActivatedAt && boardAt && inviteAt) {
    const now = new Date();
    const updated = await db.update(workspaceAnalyticsMilestones)
      .set({ activatedAt: now, updatedAt: now })
      .where(and(eq(workspaceAnalyticsMilestones.workspaceId, workspace.id), isNull(workspaceAnalyticsMilestones.activatedAt)))
      .returning({ id: workspaceAnalyticsMilestones.workspaceId });
    if (updated.length > 0) {
      const [boardActivity] = await db.select({
        importedFrom: sql<string | null>`${activityEvents.payload}->>'importedFrom'`,
      }).from(activityEvents).where(and(
        eq(activityEvents.entityType, "board"),
        eq(activityEvents.entityId, firstBoard[0]!.id),
        eq(activityEvents.action, "created"),
      )).limit(1);
      const delta = boardAt.getTime() - inviteAt.getTime();
      await productAnalytics.capture({
        event: "workspace_activation_completed",
        distinctId: input.actorId,
        organizationId: workspace.clientId,
        properties: {
          activation_path: delta === 0 ? "same_transaction" : delta < 0 ? "board_then_invitation" : "invitation_then_board",
          hours_to_activation_band: elapsedBand((now.getTime() - workspace.createdAt.getTime()) / 3_600_000, "hours"),
          board_source: boardActivity?.importedFrom ? "imported" : "created",
        },
      });
    }
  }

  if (workspace.analyticsQualifiedAt) return;
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const [[memberCount], [collaboratorCount]] = await Promise.all([
    db.select({ count: sql<number>`count(distinct ${users.id})::int` }).from(users)
      .leftJoin(workspaceMembers, and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.workspaceId, workspace.id)))
      .where(and(
        eq(users.clientId, workspace.clientId),
        isNull(users.removedAt),
        isNull(users.deletedAt),
        isNull(users.suspendedAt),
        or(sql`${workspaceMembers.userId} is not null`, inArray(users.clientRole, ["owner", "admin"])),
      )),
    db.select({ count: sql<number>`count(distinct ${activityEvents.actorId})::int` }).from(activityEvents)
      .where(and(
        eq(activityEvents.workspaceId, workspace.id),
        eq(activityEvents.actorKind, "user"),
        gte(activityEvents.createdAt, sevenDaysAgo),
        or(
          and(eq(activityEvents.entityType, "card"), inArray(activityEvents.action, ["created", "moved", "completed", "attachment_added"])),
          and(eq(activityEvents.entityType, "comment"), eq(activityEvents.action, "created")),
          and(
            eq(activityEvents.entityType, "card"),
            eq(activityEvents.action, "completion_set"),
            sql`${activityEvents.payload}->>'toValue' = 'true'`,
          ),
        ),
        sql`coalesce(${activityEvents.payload}->>'seededFromWorkspaceTemplate', 'false') <> 'true'`,
      )),
  ]);
  const activeMembers = memberCount?.count ?? 0;
  const collaborators = collaboratorCount?.count ?? 0;
  if (activeMembers < 3 && collaborators < 2) return;

  const now = new Date();
  const qualified = await db.update(workspaceAnalyticsMilestones)
    .set({ qualifiedAt: now, updatedAt: now })
    .where(and(eq(workspaceAnalyticsMilestones.workspaceId, workspace.id), isNull(workspaceAnalyticsMilestones.qualifiedAt)))
    .returning({ id: workspaceAnalyticsMilestones.workspaceId });
  if (qualified.length === 0) return;
  await productAnalytics.capture({
    event: "workspace_qualified",
    distinctId: input.actorId,
    organizationId: workspace.clientId,
    properties: {
      qualification_reason: activeMembers >= 3 && collaborators >= 2 ? "both" : activeMembers >= 3 ? "three_active_members" : "collaborative_activity",
      active_member_count: activeMembers,
      distinct_collaborator_count: collaborators,
      days_to_qualification_band: elapsedBand((now.getTime() - workspace.createdAt.getTime()) / 86_400_000, "days"),
    },
  });
}

export async function evaluateWorkspaceAnalyticsMilestones(input: {
  workspaceId: string;
  actorId: string;
  supportSession?: boolean;
}): Promise<void> {
  try {
    await evaluateWorkspaceAnalyticsMilestonesInternal(input);
  } catch {
    // Analytics bookkeeping is deliberately fail-open: the confirmed product mutation still succeeds.
  }
}

async function captureWorkspaceInvitationCreatedInternal(input: {
  organizationId: string;
  workspaceIds: string[];
  actorId: string;
  invitationMethod: "link" | "email" | "guest";
  invitedRole: "owner" | "admin" | "member" | "editor" | "observer";
  supportSession?: boolean;
}): Promise<void> {
  if (input.supportSession) return;
  const [[members], [pendingMembers], [pendingGuests]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(users)
      .where(and(eq(users.clientId, input.organizationId), isNull(users.removedAt), isNull(users.deletedAt))),
    db.select({ count: sql<number>`count(*)::int` }).from(inviteTokens)
      .where(and(
        eq(inviteTokens.clientId, input.organizationId),
        isNull(inviteTokens.revokedAt),
        sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
      )),
    db.select({ count: sql<number>`count(*)::int` }).from(boardInvitations)
      .where(and(
        eq(boardInvitations.clientId, input.organizationId),
        isNull(boardInvitations.revokedAt),
        isNull(boardInvitations.acceptedAt),
        sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
      )),
  ]);
  const pendingCount = (pendingMembers?.count ?? 0) + (pendingGuests?.count ?? 0);
  await productAnalytics.capture({
    event: "workspace_invitation_created",
    distinctId: input.actorId,
    organizationId: input.organizationId,
    properties: {
      invitation_method: input.invitationMethod,
      invited_role: input.invitedRole,
      member_count_before: members?.count ?? 0,
      pending_invitation_count: pendingCount,
      is_first_colleague_invitation: pendingCount === 1,
    },
  });
  await Promise.all(input.workspaceIds.map((workspaceId) => evaluateWorkspaceAnalyticsMilestones({
    workspaceId,
    actorId: input.actorId,
    supportSession: input.supportSession,
  })));
}

export async function captureWorkspaceInvitationCreated(input: {
  organizationId: string;
  workspaceIds: string[];
  actorId: string;
  invitationMethod: "link" | "email" | "guest";
  invitedRole: "owner" | "admin" | "member" | "editor" | "observer";
  supportSession?: boolean;
}): Promise<void> {
  try {
    await captureWorkspaceInvitationCreatedInternal(input);
  } catch {
    // Database or provider analytics failures must not roll back an accepted invitation.
  }
}

async function captureWorkspaceMemberJoinedInternal(input: {
  organizationId: string;
  workspaceIds: string[];
  actorId: string;
  joinSource: "invitation" | "direct" | "guest_invitation";
  supportSession?: boolean;
}): Promise<void> {
  if (input.supportSession) return;
  const [members] = input.workspaceIds.length > 0
    ? await db.select({ count: sql<number>`count(distinct ${users.id})::int` }).from(users)
      .leftJoin(workspaceMembers, and(
        eq(workspaceMembers.userId, users.id),
        inArray(workspaceMembers.workspaceId, input.workspaceIds),
      ))
      .leftJoin(boardMembers, eq(boardMembers.userId, users.id))
      .leftJoin(boards, and(eq(boards.id, boardMembers.boardId), inArray(boards.workspaceId, input.workspaceIds)))
      .where(and(
        isNull(users.removedAt),
        isNull(users.deletedAt),
        isNull(users.suspendedAt),
        or(
          and(
            eq(users.clientId, input.organizationId),
            or(sql`${workspaceMembers.userId} is not null`, inArray(users.clientRole, ["owner", "admin"])),
          ),
          sql`${boards.id} is not null`,
        ),
      ))
    : await db.select({ count: sql<number>`count(*)::int` }).from(users)
      .where(and(eq(users.clientId, input.organizationId), isNull(users.removedAt), isNull(users.deletedAt), isNull(users.suspendedAt)));
  const count = members?.count ?? 0;
  await productAnalytics.capture({
    event: "workspace_member_joined",
    distinctId: input.actorId,
    organizationId: input.organizationId,
    properties: {
      join_source: input.joinSource,
      member_count_after: count,
      is_second_member: count === 2,
      is_third_member: count === 3,
    },
  });
  await Promise.all(input.workspaceIds.map((workspaceId) => evaluateWorkspaceAnalyticsMilestones({
    workspaceId,
    actorId: input.actorId,
    supportSession: input.supportSession,
  })));
}

export async function captureWorkspaceMemberJoined(input: {
  organizationId: string;
  workspaceIds: string[];
  actorId: string;
  joinSource: "invitation" | "direct" | "guest_invitation";
  supportSession?: boolean;
}): Promise<void> {
  try {
    await captureWorkspaceMemberJoinedInternal(input);
  } catch {
    // Membership is authoritative; analytics remains best-effort.
  }
}
