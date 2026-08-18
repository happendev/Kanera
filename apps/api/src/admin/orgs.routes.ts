import { dto } from "@kanera/shared";
import { boardMembers, boards, cards, clientGuestSeats, clientMembers, clients, users, workspaces } from "@kanera/shared/schema";
import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { getOrgStorageUsage, isPaidTier } from "../lib/entitlements.js";
import { withSignedMedia } from "../lib/media-keys.js";
import { convertClientPlan } from "../lib/plan-conversion.js";
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

async function loadOrgGuests(clientId: string) {
  const [paidRows, boardRows] = await Promise.all([
    db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        lastOnlineAt: users.lastOnlineAt,
      })
      .from(clientGuestSeats)
      .innerJoin(users, eq(users.id, clientGuestSeats.userId))
      .where(and(eq(clientGuestSeats.clientId, clientId), isNull(users.deletedAt), sql`not exists (
        select 1 from ${clientMembers} cm where cm.client_id = ${clientId}
          and cm.user_id = ${users.id}
      )`)),
    db
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
      .where(and(eq(workspaces.clientId, clientId), isNull(boards.archivedAt), isNull(users.deletedAt), sql`not exists (
        select 1 from ${clientMembers} cm where cm.client_id = ${clientId}
          and cm.user_id = ${users.id}
      )`))
      .groupBy(users.id),
  ]);

  // Start with durable paid-seat assignments so an inconsistent/stale assignment cannot disappear
  // from the admin billing view merely because its last board grant was removed out of band.
  const guests = new Map(paidRows.map((row) => [row.id, { ...row, boardCount: 0, paidGuestSeat: true }]));
  for (const row of boardRows) {
    const paid = guests.get(row.id);
    guests.set(row.id, { ...row, paidGuestSeat: paid?.paidGuestSeat ?? false });
  }
  return [...guests.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
}

function memberAccess(plan: string, billingStatus: string) {
  if (plan === "paid" && billingStatus === "trialing") return "trial_member" as const;
  if (plan === "paid" && (billingStatus === "active" || billingStatus === "past_due")) return "pro_member" as const;
  return "free_member" as const;
}

function guestAccess(paidGuestSeat: boolean, plan: string, billingStatus: string) {
  if (!paidGuestSeat) return "free_guest" as const;
  if (plan === "paid" && billingStatus === "trialing") return "trial_guest" as const;
  if (plan === "paid" && (billingStatus === "active" || billingStatus === "past_due")) return "paid_guest" as const;
  return "free_guest" as const;
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
        currentPeriodEnd: clients.currentPeriodEnd,
        cancelAtPeriodEnd: clients.cancelAtPeriodEnd,
        seatLimit: clients.seatLimit,
        suspendedAt: clients.suspendedAt,
        deletedAt: clients.deletedAt,
        createdAt: clients.createdAt,
        // Active members only, matching how the tenant counts seats (excludes removed/soft-deleted rows).
        memberCount: sql<number>`count(${users.id})::int`,
        paidGuestCount: sql<number>`(
          select count(*)::int from client_guest_seat cgs
          join "user" gu on gu.id = cgs.user_id and gu.deleted_at is null
          where cgs.client_id = ${clients.id}
            and not exists (select 1 from client_member cm where cm.client_id = ${clients.id} and cm.user_id = cgs.user_id)
        )`,
        freeGuestCount: sql<number>`(
          select count(distinct bm.user_id)::int from board_member bm
          join board gb on gb.id = bm.board_id and gb.archived_at is null
          join workspace gw on gw.id = gb.workspace_id
          join "user" gu on gu.id = bm.user_id and gu.deleted_at is null
          where gw.client_id = ${clients.id}
            and not exists (select 1 from client_member cm where cm.client_id = ${clients.id} and cm.user_id = bm.user_id)
            and not exists (select 1 from client_guest_seat cgs where cgs.client_id = ${clients.id} and cgs.user_id = bm.user_id)
        )`,
      })
      .from(clients)
      .leftJoin(clientMembers, and(eq(clientMembers.clientId, clients.id), isNull(clientMembers.suspendedAt), isNull(clientMembers.removedAt)))
      .leftJoin(users, and(eq(users.id, clientMembers.userId), isNull(users.deletedAt)))
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
        currentPeriodEnd: iso(r.currentPeriodEnd),
        cancelAtPeriodEnd: r.cancelAtPeriodEnd,
        seatLimit: r.seatLimit,
        memberCount: r.memberCount,
        paidGuestCount: r.paidGuestCount,
        freeGuestCount: r.freeGuestCount,
        usedSeatCount: r.memberCount + r.paidGuestCount,
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
    const entitlements = getEntitlements(org.plan, org.billingStatus, org.currentPeriodEnd);

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
      .from(clientMembers)
      .innerJoin(users, eq(users.id, clientMembers.userId))
      .where(and(eq(clientMembers.clientId, clientId), isNull(clientMembers.suspendedAt), isNull(clientMembers.removedAt), isNull(users.deletedAt)));
    const memberCount = memberRow?.memberCount ?? 0;
    const guestRows = await loadOrgGuests(clientId);
    const paidGuestCount = guestRows.filter((guest) => guest.paidGuestSeat).length;
    const freeGuestCount = guestRows.length - paidGuestCount;

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
      cancelAtPeriodEnd: org.cancelAtPeriodEnd,
      seatLimit: org.seatLimit,
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
        paidGuestCount,
        freeGuestCount,
        usedSeatCount: memberCount + paidGuestCount,
      },
      entitlements,
    };
  });

  app.get("/orgs/:clientId/people", async (req) => {
    const { clientId } = req.params as { clientId: string };
    const org = await loadOrgOr404(clientId);
    const query = dto.adminListOrgPeopleQuery.parse(req.query);
    const members = await db.select({ id: users.id, displayName: users.displayName, email: users.email, role: clientMembers.clientRole, lastOnlineAt: users.lastOnlineAt })
      .from(clientMembers).innerJoin(users, eq(users.id, clientMembers.userId))
      .where(and(eq(clientMembers.clientId, clientId), isNull(clientMembers.suspendedAt), isNull(clientMembers.removedAt), isNull(users.deletedAt)));
    const guests = await loadOrgGuests(clientId);
    let people = [
      ...members.map((row) => ({ ...row, kind: "user" as const, access: memberAccess(org.plan, org.billingStatus), boardCount: null, lastOnlineAt: iso(row.lastOnlineAt) })),
      ...guests.map((row) => ({ ...row, kind: "guest" as const, access: guestAccess(row.paidGuestSeat, org.plan, org.billingStatus), role: null, lastOnlineAt: iso(row.lastOnlineAt) })),
    ];
    if (query.q) { const q = query.q.toLocaleLowerCase(); people = people.filter((p) => p.displayName.toLocaleLowerCase().includes(q) || p.email.toLocaleLowerCase().includes(q)); }
    const value = (p: (typeof people)[number]) => query.sort === "access" ? p.access : p[query.sort];
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
    const org = await loadOrgOr404(clientId);
    const body = dto.adminUpdateOrgPlanBody.parse(req.body);

    const targetPlan = body.plan
      ?? (body.billingStatus !== undefined ? (isPaidTier(body.billingStatus) ? "paid" : "free") : org.plan);
    const targetBillingStatus = body.billingStatus
      ?? (body.plan !== undefined ? (body.plan === "paid" ? "active" : "none") : org.billingStatus);
    if (
      (body.plan !== undefined || body.billingStatus !== undefined)
      && (targetPlan === "paid") !== isPaidTier(targetBillingStatus)
    ) {
      throw badRequest("paid plans require trialing, active, or past_due billing status");
    }
    const target = { plan: targetPlan, billingStatus: targetBillingStatus };
    const updates: Partial<typeof clients.$inferInsert> = {};
    if (body.billingInterval !== undefined) updates.billingInterval = body.billingInterval;
    if (body.storageQuotaBytes !== undefined) updates.storageQuotaBytes = body.storageQuotaBytes;
    if (body.currentPeriodEnd !== undefined) {
      updates.currentPeriodEnd = isPaidTier(target.billingStatus) ? body.currentPeriodEnd : null;
    }

    await db.transaction(async (tx) => {
      if (body.plan !== undefined || body.billingStatus !== undefined) {
        // Admin overrides must use the same reversible conversion as Stripe. A direct clients-row
        // update can advertise paid access while leaving downgrade-archived resources disabled.
        await convertClientPlan(clientId, target, tx);
      }
      if (Object.keys(updates).length > 0) {
        await tx.update(clients).set({ ...updates, updatedAt: new Date() }).where(eq(clients.id, clientId));
      }
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
