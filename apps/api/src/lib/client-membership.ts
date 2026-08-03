import { clientMembers, clients, notifications, users, workspaceMembers, workspaces, type ClientRole } from "@kanera/shared/schema";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type Db } from "../db.js";
import { withSignedMedia } from "./media-keys.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export function activeClientMembership(clientId: string, userId: string) {
  return and(
    eq(clientMembers.clientId, clientId),
    eq(clientMembers.userId, userId),
    isNull(clientMembers.suspendedAt),
    isNull(clientMembers.removedAt),
  );
}

export async function hasActiveClientMembership(clientId: string, userId: string, tx: Tx = db): Promise<boolean> {
  const [row] = await tx
    .select({ userId: clientMembers.userId })
    .from(clientMembers)
    .where(activeClientMembership(clientId, userId))
    .limit(1);
  return Boolean(row);
}

export async function listActiveOrganisations(userId: string, tx: Tx = db, knownHomeClientId?: string) {
  const [identity] = knownHomeClientId ? [{ homeClientId: knownHomeClientId }] : await tx
    .select({ homeClientId: users.clientId })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!identity) return [];

  const rows = await tx
    .select({
      clientId: clients.id,
      name: clients.name,
      logoUrl: clients.logoUrl,
      role: clientMembers.clientRole,
      plan: clients.plan,
      billingStatus: clients.billingStatus,
      analyticsExcluded: clients.analyticsExcluded,
      requireMfa: clients.requireMfa,
      addedAt: clientMembers.addedAt,
      hasWorkspace: sql<boolean>`case
        when ${clientMembers.clientRole} in ('owner', 'admin') then exists (
          select 1 from ${workspaces}
          where ${workspaces.clientId} = ${clients.id}
            and ${workspaces.kind} <> 'board'
            and ${workspaces.archivedAt} is null
        )
        else exists (
          select 1 from ${workspaceMembers}
          inner join ${workspaces} on ${workspaces.id} = ${workspaceMembers.workspaceId}
          where ${workspaceMembers.userId} = ${userId}
            and ${workspaces.clientId} = ${clients.id}
            and ${workspaces.kind} <> 'board'
            and ${workspaces.archivedAt} is null
        )
      end`,
      unreadCount: sql<number>`(
        select count(*)::int from ${notifications}
        where ${notifications.userId} = ${userId}
          and ${notifications.clientId} = ${clients.id}
          and ${notifications.readAt} is null
      )`,
    })
    .from(clientMembers)
    .innerJoin(clients, eq(clients.id, clientMembers.clientId))
    .where(and(
      eq(clientMembers.userId, userId),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(clients.suspendedAt),
      isNull(clients.deletedAt),
    ))
    .orderBy(asc(clientMembers.addedAt), asc(clientMembers.clientId));

  return rows.map((row) => ({
    clientId: row.clientId,
    name: row.name,
    logoUrl: withSignedMedia(row.clientId, { logoUrl: row.logoUrl }).logoUrl,
    role: row.role,
    plan: row.plan,
    billingStatus: row.billingStatus,
    hasWorkspace: row.hasWorkspace,
    isHome: row.clientId === identity.homeClientId,
    unreadCount: row.unreadCount,
    addedAt: row.addedAt,
    analyticsExcluded: row.analyticsExcluded,
    requireMfa: row.requireMfa,
  }));
}

export type ActiveOrganisation = Awaited<ReturnType<typeof listActiveOrganisations>>[number];

export async function resolveActiveOrganisationContext(
  userId: string,
  requestedClientId?: string | null,
  tx: Tx = db,
): Promise<{ active: ActiveOrganisation | null; organisations: ActiveOrganisation[] }> {
  const [identity] = await tx
    .select({ activeClientId: users.activeClientId, homeClientId: users.clientId })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!identity) return { active: null, organisations: [] };
  const organisations = await listActiveOrganisations(userId, tx, identity.homeClientId);
  const active = requestedClientId
    ? organisations.find((organisation) => organisation.clientId === requestedClientId) ?? null
    : organisations.find((organisation) => organisation.clientId === identity.activeClientId)
      ?? organisations[0]
      ?? null;
  return { active, organisations };
}

export async function resolveActiveOrganisation(
  userId: string,
  requestedClientId?: string | null,
  tx: Tx = db,
): Promise<ActiveOrganisation | null> {
  return (await resolveActiveOrganisationContext(userId, requestedClientId, tx)).active;
}

export async function repointActiveOrganisation(
  userId: string,
  leavingClientId: string,
  tx: Tx,
): Promise<string | null> {
  const [identity] = await tx.select({ activeClientId: users.activeClientId }).from(users).where(eq(users.id, userId)).limit(1);
  if (identity?.activeClientId !== leavingClientId) return identity?.activeClientId ?? null;
  const [fallback] = await tx
    .select({ clientId: clientMembers.clientId })
    .from(clientMembers)
    .innerJoin(clients, eq(clients.id, clientMembers.clientId))
    .where(and(
      eq(clientMembers.userId, userId),
      ne(clientMembers.clientId, leavingClientId),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(clients.suspendedAt),
      isNull(clients.deletedAt),
    ))
    .orderBy(asc(clientMembers.addedAt), asc(clientMembers.clientId))
    .limit(1);
  await tx.update(users).set({ activeClientId: fallback?.clientId ?? null, updatedAt: new Date() }).where(eq(users.id, userId));
  return fallback?.clientId ?? null;
}

export function isClientAdminRole(role: ClientRole): boolean {
  return role === "owner" || role === "admin";
}
