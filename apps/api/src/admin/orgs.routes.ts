import { dto } from "@kanera/shared";
import { boardMembers, boards, cards, clients, users, workspaces } from "@kanera/shared/schema";
import { and, asc, desc, eq, ilike, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { forbidden, notFound } from "../lib/errors.js";
import { getOrgStorageUsage } from "../lib/entitlements.js";
import { withSignedMedia } from "../lib/media-keys.js";
import { getEntitlements } from "../lib/tier-limits.js";
import { writeAdminAudit } from "./audit.js";

// Destructive actions (delete) are superadmin-only; staff get read + non-destructive mutations.
function requireSuperadmin(req: FastifyRequest) {
  if (req.adminAuth.role !== "superadmin") throw forbidden("superadmin required");
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function loadOrgOr404(clientId: string) {
  const [row] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!row) throw notFound("organisation not found");
  return row;
}

export async function adminOrgRoutes(app: FastifyInstance) {
  // List + search + paginate. Deliberately spans every tenant (no cid filter — that is the whole point
  // of the admin console). Soft-deleted orgs are included so they remain visible/recoverable.
  app.get("/orgs", async (req) => {
    const query = dto.adminListOrgsQuery.parse(req.query);
    const filters = [
      query.q ? ilike(clients.name, `%${query.q}%`) : undefined,
      query.plan ? eq(clients.plan, query.plan) : undefined,
      query.billingStatus ? eq(clients.billingStatus, query.billingStatus) : undefined,
    ].filter(Boolean);
    const where = filters.length ? and(...filters) : undefined;

    const [totalRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(clients)
      .where(where);
    const total = totalRow?.total ?? 0;

    const statusSort = sql`case when ${clients.deletedAt} is not null then 2 when ${clients.suspendedAt} is not null then 1 else 0 end`;
    const memberCountSort = sql`count(${users.id})`;
    // Keep user input out of SQL by mapping validated public sort names to Drizzle expressions.
    const sortColumns = { name: clients.name, plan: clients.plan, billingStatus: clients.billingStatus, memberCount: memberCountSort, createdAt: clients.createdAt, status: statusSort } as const;
    const order = query.direction === "asc" ? asc : desc;
    const rows = await db
      .select({
        id: clients.id,
        name: clients.name,
        logoUrl: clients.logoUrl,
        plan: clients.plan,
        billingStatus: clients.billingStatus,
        billingInterval: clients.billingInterval,
        suspendedAt: clients.suspendedAt,
        deletedAt: clients.deletedAt,
        createdAt: clients.createdAt,
        // Active members only, matching how the tenant counts seats (excludes removed/soft-deleted rows).
        memberCount: sql<number>`count(${users.id})::int`,
      })
      .from(clients)
      .leftJoin(users, and(eq(users.clientId, clients.id), isNull(users.removedAt), isNull(users.deletedAt)))
      .where(where)
      .groupBy(clients.id)
      .orderBy(order(sortColumns[query.sort]), asc(clients.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: rows.map((r) => ({
        ...withSignedMedia(r.id, { logoUrl: r.logoUrl }),
        id: r.id,
        name: r.name,
        plan: r.plan,
        billingStatus: r.billingStatus,
        billingInterval: r.billingInterval,
        memberCount: r.memberCount,
        suspendedAt: iso(r.suspendedAt),
        deletedAt: iso(r.deletedAt),
        createdAt: iso(r.createdAt)!,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });

  app.get("/orgs/:clientId", async (req) => {
    const { clientId } = req.params as { clientId: string };
    const org = await loadOrgOr404(clientId);

    const usage = await getOrgStorageUsage(db, clientId);
    const entitlements = getEntitlements(org.billingStatus, org.currentPeriodEnd);

    // Platform operations counts hidden standalone-board workspaces too; this is an infrastructure
    // metric rather than a product-level count of visible workspaces.
    const [workspaceRow] = await db
      .select({ workspaceCount: sql<number>`count(*)::int` })
      .from(workspaces)
      .where(eq(workspaces.clientId, clientId));
    const workspaceCount = workspaceRow?.workspaceCount ?? 0;
    const [boardRow] = await db
      .select({ boardCount: sql<number>`count(*)::int` })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(eq(workspaces.clientId, clientId), isNull(boards.archivedAt)));
    const boardCount = boardRow?.boardCount ?? 0;
    const [cardRow] = await db
      .select({ cardCount: sql<number>`count(*)::int` })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(eq(workspaces.clientId, clientId), isNull(boards.archivedAt), isNull(cards.archivedAt)));
    const cardCount = cardRow?.cardCount ?? 0;
    const [memberRow] = await db
      .select({ memberCount: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.clientId, clientId), isNull(users.removedAt), isNull(users.deletedAt)));
    const memberCount = memberRow?.memberCount ?? 0;
    // Guests belong to another organisation and can appear on several boards; group by user so the
    // admin view and usage count describe people rather than board memberships.
    const guestRows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        lastOnlineAt: users.lastOnlineAt,
        boardCount: sql<number>`count(distinct ${boardMembers.boardId})::int`,
      })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(users, eq(users.id, boardMembers.userId))
      .where(and(eq(workspaces.clientId, clientId), ne(users.clientId, clientId), isNull(users.removedAt), isNull(users.deletedAt)))
      .groupBy(users.id)
      .orderBy(asc(users.displayName));

    return {
      ...withSignedMedia(org.id, { logoUrl: org.logoUrl }),
      id: org.id,
      name: org.name,
      plan: org.plan,
      billingStatus: org.billingStatus,
      billingInterval: org.billingInterval,
      deploymentMode: env.KANERA_DEPLOYMENT_MODE,
      storageQuotaBytes: org.storageQuotaBytes,
      currentPeriodEnd: iso(org.currentPeriodEnd),
      suspendedAt: iso(org.suspendedAt),
      deletedAt: iso(org.deletedAt),
      createdAt: iso(org.createdAt)!,
      memberCount,
      usage: {
        storageUsedBytes: usage.usedBytes,
        storageQuotaBytes: usage.quotaBytes,
        workspaceCount,
        boardCount,
        cardCount,
        memberCount,
        guestCount: guestRows.length,
      },
      entitlements,
    };
  });

  app.get("/orgs/:clientId/people", async (req) => {
    const { clientId } = req.params as { clientId: string };
    await loadOrgOr404(clientId);
    const query = dto.adminListOrgPeopleQuery.parse(req.query);
    const members = await db.select({ id: users.id, displayName: users.displayName, email: users.email, role: users.clientRole, lastOnlineAt: users.lastOnlineAt })
      .from(users).where(and(eq(users.clientId, clientId), isNull(users.removedAt), isNull(users.deletedAt)));
    const guests = await db.select({ id: users.id, displayName: users.displayName, email: users.email, lastOnlineAt: users.lastOnlineAt, boardCount: sql<number>`count(distinct ${boardMembers.boardId})::int` })
      .from(boardMembers).innerJoin(boards, eq(boards.id, boardMembers.boardId)).innerJoin(workspaces, eq(workspaces.id, boards.workspaceId)).innerJoin(users, eq(users.id, boardMembers.userId))
      .where(and(eq(workspaces.clientId, clientId), ne(users.clientId, clientId), isNull(users.removedAt), isNull(users.deletedAt))).groupBy(users.id);
    let people = [
      ...members.map((row) => ({ ...row, kind: "user" as const, boardCount: null, lastOnlineAt: iso(row.lastOnlineAt) })),
      ...guests.map((row) => ({ ...row, kind: "guest" as const, role: null, lastOnlineAt: iso(row.lastOnlineAt) })),
    ];
    if (query.q) { const q = query.q.toLocaleLowerCase(); people = people.filter((p) => p.displayName.toLocaleLowerCase().includes(q) || p.email.toLocaleLowerCase().includes(q)); }
    const value = (p: (typeof people)[number]) => query.sort === "access" ? (p.kind === "guest" ? p.boardCount ?? 0 : p.role ?? "") : p[query.sort];
    people.sort((a, b) => { const av = value(a) ?? "", bv = value(b) ?? ""; const compared = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv)); return (query.direction === "asc" ? compared : -compared) || a.id.localeCompare(b.id); });
    const total = people.length;
    const start = (query.page - 1) * query.pageSize;
    return { items: people.slice(start, start + query.pageSize), total, page: query.page, pageSize: query.pageSize };
  });

  app.post("/orgs/:clientId/suspend", async (req) => {
    const { clientId } = req.params as { clientId: string };
    await loadOrgOr404(clientId);
    await db.transaction(async (tx) => {
      await tx.update(clients).set({ suspendedAt: new Date(), updatedAt: new Date() }).where(eq(clients.id, clientId));
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "org.suspend", targetType: "org", targetClientId: clientId });
    });
    return { ok: true };
  });

  app.post("/orgs/:clientId/reactivate", async (req) => {
    const { clientId } = req.params as { clientId: string };
    await loadOrgOr404(clientId);
    await db.transaction(async (tx) => {
      await tx.update(clients).set({ suspendedAt: null, updatedAt: new Date() }).where(eq(clients.id, clientId));
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "org.reactivate", targetType: "org", targetClientId: clientId });
    });
    return { ok: true };
  });

  app.patch("/orgs/:clientId/plan", async (req) => {
    const { clientId } = req.params as { clientId: string };
    await loadOrgOr404(clientId);
    const body = dto.adminUpdateOrgPlanBody.parse(req.body);

    const updates: Partial<typeof clients.$inferInsert> = { updatedAt: new Date() };
    if (body.plan !== undefined) updates.plan = body.plan;
    if (body.billingStatus !== undefined) updates.billingStatus = body.billingStatus;
    if (body.billingInterval !== undefined) updates.billingInterval = body.billingInterval;
    if (body.storageQuotaBytes !== undefined) updates.storageQuotaBytes = body.storageQuotaBytes;
    if (body.currentPeriodEnd !== undefined) updates.currentPeriodEnd = body.currentPeriodEnd;

    await db.transaction(async (tx) => {
      await tx.update(clients).set(updates).where(eq(clients.id, clientId));
      await writeAdminAudit(tx, {
        adminUserId: req.adminAuth.sub,
        action: "org.plan.update",
        targetType: "org",
        targetClientId: clientId,
        details: body as Record<string, unknown>,
      });
    });
    return { ok: true };
  });

  app.patch("/orgs/:clientId/settings", async (req) => {
    const { clientId } = req.params as { clientId: string };
    await loadOrgOr404(clientId);
    const body = dto.adminUpdateOrgSettingsBody.parse(req.body);

    const updates: Partial<typeof clients.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.logoUrl !== undefined) updates.logoUrl = body.logoUrl;

    await db.transaction(async (tx) => {
      await tx.update(clients).set(updates).where(eq(clients.id, clientId));
      await writeAdminAudit(tx, {
        adminUserId: req.adminAuth.sub,
        action: "org.settings.update",
        targetType: "org",
        targetClientId: clientId,
        details: body as Record<string, unknown>,
      });
    });
    return { ok: true };
  });

  // Soft-delete: sets deletedAt so tenant auth/listings hide the org (see tenant-side enforcement). Data
  // and storage objects are retained — recoverable until a future purge job. Superadmin only.
  app.delete("/orgs/:clientId", async (req) => {
    requireSuperadmin(req);
    const { clientId } = req.params as { clientId: string };
    await loadOrgOr404(clientId);
    await db.transaction(async (tx) => {
      await tx.update(clients).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(clients.id, clientId));
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "org.delete", targetType: "org", targetClientId: clientId });
    });
    return { ok: true };
  });
}
