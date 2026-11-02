import type { HomeProUsageSummary } from "@kanera/shared/dto";
import { automations, boardMembers, boards, clientMembers, oauthGrants, users, workspaceApiKeys, workspaces } from "@kanera/shared/schema";
import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db.js";
import { env } from "../../env.js";

/**
 * Turns persisted resource use into an owner-readable statement of value.
 *
 * Current resources are intentional: a board or guest still available to the team is value they
 * would lose on Free even if nobody happened to edit it today. Connections use a monthly boundary
 * because an old, dormant key is not demonstrated value. Counts are organisation-owned rather
 * than viewer-accessible so the owner sees the whole commercial footprint.
 */
export async function loadProUsage(clientId: string, now = new Date()): Promise<HomeProUsageSummary> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const usedThisMonth = (lastUsedAt: typeof workspaceApiKeys.lastUsedAt, createdAt: typeof workspaceApiKeys.createdAt) =>
    or(gte(lastUsedAt, monthStart), and(isNull(lastUsedAt), gte(createdAt, monthStart)));

  const [memberRows, boardRows, automationRows, guestRows, apiKeyRows, oauthRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(clientMembers)
      .where(and(
        eq(clientMembers.clientId, clientId),
        isNull(clientMembers.suspendedAt),
        isNull(clientMembers.removedAt),
      )),
    db.select({ count: sql<number>`count(*)::int` })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(
        eq(workspaces.clientId, clientId),
        isNull(workspaces.archivedAt),
        isNull(boards.archivedAt),
      )),
    db.select({ count: sql<number>`count(*)::int` })
      .from(automations)
      .innerJoin(workspaces, eq(workspaces.id, automations.workspaceId))
      .where(and(
        eq(workspaces.clientId, clientId),
        eq(automations.enabled, true),
        isNull(workspaces.archivedAt),
        isNull(automations.archivedAt),
      )),
    db.select({ count: sql<number>`count(distinct ${boardMembers.userId})::int` })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .leftJoin(clientMembers, and(
        eq(clientMembers.clientId, clientId),
        eq(clientMembers.userId, boardMembers.userId),
        isNull(clientMembers.suspendedAt),
        isNull(clientMembers.removedAt),
      ))
      .where(and(
        eq(workspaces.clientId, clientId),
        // Organisation members can also hold explicit board rows. Only people without active
        // membership are guests; a user's original/home client id is not authoritative here.
        isNull(clientMembers.userId),
        isNull(users.deletedAt),
        isNull(workspaces.archivedAt),
        isNull(boards.archivedAt),
      )),
    db.select({ id: workspaceApiKeys.id })
      .from(workspaceApiKeys)
      .leftJoin(workspaces, eq(workspaces.id, workspaceApiKeys.workspaceId))
      .where(and(
        isNull(workspaceApiKeys.revokedAt),
        or(
          and(eq(workspaceApiKeys.kind, "workspace"), eq(workspaces.clientId, clientId)),
          and(eq(workspaceApiKeys.kind, "personal"), eq(workspaceApiKeys.clientId, clientId)),
        ),
        usedThisMonth(workspaceApiKeys.lastUsedAt, workspaceApiKeys.createdAt),
      ))
      .limit(1),
    db.select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(and(
        eq(oauthGrants.orgClientId, clientId),
        isNull(oauthGrants.revokedAt),
        or(
          gte(oauthGrants.lastUsedAt, monthStart),
          and(isNull(oauthGrants.lastUsedAt), gte(oauthGrants.createdAt, monthStart)),
        ),
      ))
      .limit(1),
  ]);

  const memberCount = memberRows[0]?.count ?? 0;
  const boardCount = boardRows[0]?.count ?? 0;
  const automationCount = automationRows[0]?.count ?? 0;
  const guestCount = guestRows[0]?.count ?? 0;
  const apiConnection = apiKeyRows.length > 0 || oauthRows.length > 0;

  // Count concrete units protected by Pro, not the five labels in the supporting sentence. This
  // makes "7 capabilities" mean seven things the owner would actually have to remove on Free.
  const capabilityCount = Math.max(0, memberCount - env.HOSTED_FREE_MAX_ORG_MEMBERS)
    + Math.max(0, boardCount - env.HOSTED_FREE_MAX_BOARDS)
    + Math.max(0, automationCount - env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS)
    + (apiConnection ? 1 : 0)
    + guestCount;

  return { capabilityCount, memberCount, boardCount, automationCount, apiConnection, guestCount };
}
