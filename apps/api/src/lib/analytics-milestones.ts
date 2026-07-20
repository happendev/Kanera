import {
  activityEvents,
  boardMembers,
  boards,
  clients,
  users,
  workspaceAnalyticsMilestones,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import { ANALYTICS_EVENT_VERSION, analyticsCountBand, analyticsDaysSince, productAnalytics } from "./product-analytics.js";

// v1 is intentionally simple and content-free: three real cards, including imported cards, while
// excluding starter-template seeds. Changing this definition requires a new version value.
const MEANINGFUL_WORK_THRESHOLD_VERSION = "three_real_cards_v1";
const MEANINGFUL_WORK_CARD_COUNT = 3;

async function workspaceMemberCount(workspaceId: string, organizationId: string): Promise<number> {
  const [members] = await db
    .select({ count: sql<number>`count(distinct ${users.id})::int` })
    .from(users)
    .leftJoin(workspaceMembers, and(
      eq(workspaceMembers.userId, users.id),
      eq(workspaceMembers.workspaceId, workspaceId),
    ))
    .leftJoin(boardMembers, eq(boardMembers.userId, users.id))
    .leftJoin(boards, and(eq(boards.id, boardMembers.boardId), eq(boards.workspaceId, workspaceId)))
    .where(and(
      isNull(users.removedAt),
      isNull(users.deletedAt),
      isNull(users.suspendedAt),
      or(
        and(
          eq(users.clientId, organizationId),
          or(sql`${workspaceMembers.userId} is not null`, inArray(users.clientRole, ["owner", "admin"])),
        ),
        sql`${boards.id} is not null`,
      ),
    ));
  return members?.count ?? 0;
}

async function organizationMemberCount(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${users.id})::int` })
    .from(users)
    .where(and(
      eq(users.clientId, organizationId),
      isNull(users.removedAt),
      isNull(users.deletedAt),
      isNull(users.suspendedAt),
    ));
  return row?.count ?? 0;
}

/**
 * Resolves a single scope for member_invited / invitation_accepted so one invite produces exactly one
 * collaboration event, never one per workspace. A single-workspace invite stays workspace-scoped; an
 * invite spanning multiple workspaces, or an organisation-wide admin invite, collapses to one
 * organisation-scoped event whose workspace_id carries the org id (mirroring the commercial events).
 * Returns null when the invite grants no collaboration scope, so no event is emitted.
 */
async function resolveMemberEventScope(input: {
  organizationId: string;
  workspaceIds: string[];
  orgWide?: boolean;
}): Promise<{ workspaceId: string; memberCount: number } | null> {
  if (input.workspaceIds.length === 1) {
    const workspaceId = input.workspaceIds[0]!;
    return { workspaceId, memberCount: await workspaceMemberCount(workspaceId, input.organizationId) };
  }
  if (input.workspaceIds.length > 1 || input.orgWide) {
    return { workspaceId: input.organizationId, memberCount: await organizationMemberCount(input.organizationId) };
  }
  return null;
}

/**
 * Re-evaluates durable workspace milestones after a confirmed business write. Conditional updates
 * are the idempotency boundary, so concurrent requests can evaluate without duplicating an event.
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
      signupAt: clients.createdAt,
      meaningfulWorkCreatedAt: workspaceAnalyticsMilestones.meaningfulWorkCreatedAt,
      collaborationStartedAt: workspaceAnalyticsMilestones.collaborationStartedAt,
      analyticsExcluded: clients.analyticsExcluded,
    })
    .from(workspaces)
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .innerJoin(workspaceAnalyticsMilestones, eq(workspaceAnalyticsMilestones.workspaceId, workspaces.id))
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  if (!workspace || workspace.analyticsExcluded) return;

  if (!workspace.meaningfulWorkCreatedAt) {
    const [realCards] = await db
      .select({ count: sql<number>`count(distinct ${activityEvents.entityId})::int` })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.workspaceId, workspace.id),
        eq(activityEvents.actorKind, "user"),
        eq(activityEvents.entityType, "card"),
        eq(activityEvents.action, "created"),
        sql`coalesce(${activityEvents.payload}->>'seededFromWorkspaceTemplate', 'false') <> 'true'`,
      ));
    if ((realCards?.count ?? 0) >= MEANINGFUL_WORK_CARD_COUNT) {
      const now = new Date();
      const claimed = await db.update(workspaceAnalyticsMilestones)
        .set({ meaningfulWorkCreatedAt: now, updatedAt: now })
        .where(and(
          eq(workspaceAnalyticsMilestones.workspaceId, workspace.id),
          isNull(workspaceAnalyticsMilestones.meaningfulWorkCreatedAt),
        ))
        .returning({ id: workspaceAnalyticsMilestones.workspaceId });
      if (claimed.length > 0) {
        await productAnalytics.capture({
          event: "meaningful_work_created",
          distinctId: input.actorId,
          organizationId: workspace.clientId,
          properties: {
            workspace_id: workspace.id,
            threshold_version: MEANINGFUL_WORK_THRESHOLD_VERSION,
            days_since_signup: analyticsDaysSince(workspace.signupAt, now),
            event_version: ANALYTICS_EVENT_VERSION,
          },
        });
      }
    }
  }

  if (workspace.collaborationStartedAt) return;
  // Treat members as active when their approved action occurred in the same rolling seven-day
  // window; this avoids declaring collaboration from unrelated historical activity.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const [collaborators] = await db
    .select({ count: sql<number>`count(distinct ${activityEvents.actorId})::int` })
    .from(activityEvents)
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
    ));
  const activeMembers = collaborators?.count ?? 0;
  if (activeMembers < 2) return;

  const now = new Date();
  const claimed = await db.update(workspaceAnalyticsMilestones)
    .set({ collaborationStartedAt: now, updatedAt: now })
    .where(and(
      eq(workspaceAnalyticsMilestones.workspaceId, workspace.id),
      isNull(workspaceAnalyticsMilestones.collaborationStartedAt),
    ))
    .returning({ id: workspaceAnalyticsMilestones.workspaceId });
  if (claimed.length === 0) return;
  await productAnalytics.capture({
    event: "collaboration_started",
    distinctId: input.actorId,
    organizationId: workspace.clientId,
    properties: {
      workspace_id: workspace.id,
      active_member_band: analyticsCountBand(activeMembers),
      days_since_signup: analyticsDaysSince(workspace.signupAt, now),
      event_version: ANALYTICS_EVENT_VERSION,
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
  orgWide?: boolean;
  actorId: string;
  supportSession?: boolean;
}): Promise<void> {
  if (input.supportSession) return;
  const [organization] = await db
    .select({ signupAt: clients.createdAt })
    .from(clients)
    .where(eq(clients.id, input.organizationId))
    .limit(1);
  if (!organization) return;
  const scope = await resolveMemberEventScope(input);
  if (!scope) return;
  await productAnalytics.capture({
    event: "member_invited",
    distinctId: input.actorId,
    organizationId: input.organizationId,
    properties: {
      workspace_id: scope.workspaceId,
      member_count_band: analyticsCountBand(scope.memberCount),
      days_since_signup: analyticsDaysSince(organization.signupAt),
      event_version: ANALYTICS_EVENT_VERSION,
    },
  });
}

export async function captureWorkspaceInvitationCreated(input: {
  organizationId: string;
  // Specific workspaces the invite grants. Empty with orgWide=true means an organisation-wide admin
  // invite; both multi-workspace and org-wide invites collapse to a single organisation-scoped event.
  workspaceIds: string[];
  orgWide?: boolean;
  actorId: string;
  supportSession?: boolean;
}): Promise<void> {
  try {
    await captureWorkspaceInvitationCreatedInternal(input);
  } catch {
    // Invitation creation is authoritative; analytics remains best-effort.
  }
}

async function captureWorkspaceMemberJoinedInternal(input: {
  organizationId: string;
  workspaceIds: string[];
  orgWide?: boolean;
  actorId: string;
  joinSource: "invitation" | "direct" | "guest_invitation";
  supportSession?: boolean;
}): Promise<void> {
  if (input.supportSession) return;
  // A direct add (an admin dropping an existing member onto a board) is not an invitation acceptance.
  if (input.joinSource === "direct") return;
  const [organization] = await db
    .select({ signupAt: clients.createdAt })
    .from(clients)
    .where(eq(clients.id, input.organizationId))
    .limit(1);
  if (!organization) return;
  const scope = await resolveMemberEventScope(input);
  if (!scope) return;
  await productAnalytics.capture({
    event: "invitation_accepted",
    distinctId: input.actorId,
    organizationId: input.organizationId,
    properties: {
      workspace_id: scope.workspaceId,
      member_count_band: analyticsCountBand(scope.memberCount),
      days_since_signup: analyticsDaysSince(organization.signupAt),
      event_version: ANALYTICS_EVENT_VERSION,
    },
  });
}

export async function captureWorkspaceMemberJoined(input: {
  organizationId: string;
  workspaceIds: string[];
  orgWide?: boolean;
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
