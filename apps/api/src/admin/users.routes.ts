import { dto } from "@kanera/shared";
import { boardMembers, boards, clientMembers, clients, passwordResetTokens, refreshTokens, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { withSignedMedia } from "../lib/media-keys.js";
import { countOwners } from "../lib/org-owners.js";
import { repointActiveOrganisation } from "../lib/client-membership.js";
import { pinOrgAdminToClientBoards, unpinOrgAdminFromClientBoards } from "../lib/board-membership.js";
import { newOpaqueToken } from "../lib/tokens.js";
import { writeAdminAudit } from "./audit.js";
import { resetMfa } from "../auth/mfa.js";

function requireSuperadmin(req: FastifyRequest) {
  if (req.adminAuth.role !== "superadmin") throw forbidden("superadmin required");
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function loadUserOr404(userId: string, requestedClientId?: string) {
  const [identity] = await db
    .select({
      id: users.id,
      homeClientId: users.clientId,
      activeClientId: users.activeClientId,
      email: users.email,
      displayName: users.displayName,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!identity) throw notFound("user not found");
  const memberships = await db.select({
    clientId: clientMembers.clientId,
    orgName: clients.name,
    role: clientMembers.clientRole,
    suspendedAt: clientMembers.suspendedAt,
    removedAt: clientMembers.removedAt,
    addedAt: clientMembers.addedAt,
  }).from(clientMembers).innerJoin(clients, eq(clients.id, clientMembers.clientId))
    .where(eq(clientMembers.userId, userId)).orderBy(asc(clientMembers.addedAt));
  const membership = memberships.find((item) => item.clientId === requestedClientId)
    ?? memberships.find((item) => item.clientId === identity.activeClientId)
    ?? memberships.find((item) => item.clientId === identity.homeClientId)
    ?? memberships[0];
  if (!membership) throw notFound("organisation membership not found");
  return { ...identity, ...membership, memberships };
}

// Revoke every live refresh token for a user so a suspend/delete cannot be outlived by an open session.
// Runs inside the caller's tx. The tenant server rejects the next /auth/refresh; the access token lapses
// within its short TTL. (This admin server has no Socket.IO, so there are no sockets to disconnect here.)
async function revokeUserRefreshTokens(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userId: string) {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export async function adminUserRoutes(app: FastifyInstance) {
  // Global identities are returned once with every organisation membership attached. A person in
  // three organisations is one management-portal user, not three duplicate search rows.
  app.get("/users", async (req) => {
    const query = dto.adminListUsersQuery.parse(req.query);
    const filters = [
      query.q ? or(
        ilike(users.email, `%${query.q}%`),
        ilike(users.displayName, `%${query.q}%`),
        sql`exists (select 1 from ${clientMembers} cm join ${clients} c on c.id = cm.client_id where cm.user_id = ${users.id} and c.name ilike ${`%${query.q}%`})`,
      ) : undefined,
      query.clientId ? sql`exists (select 1 from ${clientMembers} cm where cm.user_id = ${users.id} and cm.client_id = ${query.clientId})` : undefined,
      query.suspended === true ? sql`exists (select 1 from ${clientMembers} cm where cm.user_id = ${users.id} and cm.suspended_at is not null ${query.clientId ? sql`and cm.client_id = ${query.clientId}` : sql``})` : undefined,
      query.suspended === false ? sql`not exists (select 1 from ${clientMembers} cm where cm.user_id = ${users.id} and cm.suspended_at is not null ${query.clientId ? sql`and cm.client_id = ${query.clientId}` : sql``})` : undefined,
    ].filter(Boolean);
    const where = filters.length ? and(...filters) : undefined;

    const [totalRow] = await db.select({ total: sql<number>`count(*)::int` }).from(users).where(where);
    const total = totalRow?.total ?? 0;

    const orgNameSort = sql`(select min(c.name) from ${clientMembers} cm join ${clients} c on c.id = cm.client_id where cm.user_id = ${users.id})`;
    const roleSort = sql`(select min(cm.client_role) from ${clientMembers} cm where cm.user_id = ${users.id})`;
    const statusSort = sql`case when ${users.deletedAt} is not null then 2 when exists (select 1 from ${clientMembers} cm where cm.user_id = ${users.id} and cm.suspended_at is not null) then 1 else 0 end`;
    // Sort keys are schema-validated and mapped to expressions here; never interpolate query strings into SQL.
    const sortColumns = { displayName: users.displayName, email: users.email, orgName: orgNameSort, role: roleSort, createdAt: users.createdAt, lastOnlineAt: users.lastOnlineAt, status: statusSort } as const;
    const sortColumn = sortColumns[query.sort];
    const order = query.direction === "asc" ? asc : desc;
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        homeClientId: users.clientId,
        deletedAt: users.deletedAt,
        createdAt: users.createdAt,
        lastOnlineAt: users.lastOnlineAt,
      })
      .from(users)
      .where(where)
      .orderBy(order(sortColumn), asc(users.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const membershipRows = rows.length === 0 ? [] : await db.select({
      userId: clientMembers.userId,
      clientId: clientMembers.clientId,
      name: clients.name,
      role: clientMembers.clientRole,
      suspendedAt: clientMembers.suspendedAt,
      removedAt: clientMembers.removedAt,
      addedAt: clientMembers.addedAt,
    }).from(clientMembers).innerJoin(clients, eq(clients.id, clientMembers.clientId))
      .where(inArray(clientMembers.userId, rows.map((row) => row.id))).orderBy(asc(clientMembers.addedAt));

    return {
      items: rows.map((r) => ({
        ...withSignedMedia(r.homeClientId, { avatarUrl: r.avatarUrl }),
        id: r.id,
        email: r.email,
        displayName: r.displayName,
        homeClientId: r.homeClientId,
        orgs: membershipRows.filter((membership) => membership.userId === r.id).map((membership) => ({
          clientId: membership.clientId,
          name: membership.name,
          role: membership.role,
          suspendedAt: iso(membership.suspendedAt),
          removedAt: iso(membership.removedAt),
          addedAt: iso(membership.addedAt)!,
        })),
        deletedAt: iso(r.deletedAt),
        createdAt: iso(r.createdAt)!,
        lastOnlineAt: iso(r.lastOnlineAt),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });

  app.get("/users/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        homeClientId: users.clientId,
        emailVerifiedAt: users.emailVerifiedAt,
        lastOnlineAt: users.lastOnlineAt,
        deletedAt: users.deletedAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) throw notFound("user not found");

    const orgs = await db.select({
      clientId: clientMembers.clientId,
      name: clients.name,
      role: clientMembers.clientRole,
      suspendedAt: clientMembers.suspendedAt,
      removedAt: clientMembers.removedAt,
      addedAt: clientMembers.addedAt,
    }).from(clientMembers).innerJoin(clients, eq(clients.id, clientMembers.clientId))
      .where(eq(clientMembers.userId, userId)).orderBy(asc(clientMembers.addedAt));

    const memberships = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        workspaceName: workspaces.name,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId));

    // A board membership is guest access only when no organisation-membership row exists. Inactive
    // rows are retained for restoration/history and must not be relabelled as external guests.
    const guestBoardAccess = await db
      .select({
        boardId: boards.id,
        boardName: boards.name,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        clientId: clients.id,
        orgName: clients.name,
        role: boardMembers.role,
        addedAt: boardMembers.addedAt,
      })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(and(eq(boardMembers.userId, userId), sql`not exists (
        select 1 from ${clientMembers} cm where cm.user_id = ${userId}
          and cm.client_id = ${workspaces.clientId}
      )`))
      .orderBy(asc(clients.name), asc(workspaces.name), asc(boards.name));

    return {
      ...withSignedMedia(row.homeClientId, { avatarUrl: row.avatarUrl }),
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      homeClientId: row.homeClientId,
      orgs: orgs.map((membership) => ({ ...membership, suspendedAt: iso(membership.suspendedAt), removedAt: iso(membership.removedAt), addedAt: iso(membership.addedAt)! })),
      emailVerifiedAt: iso(row.emailVerifiedAt),
      lastOnlineAt: iso(row.lastOnlineAt),
      deletedAt: iso(row.deletedAt),
      createdAt: iso(row.createdAt)!,
      memberships,
      guestBoardAccess: guestBoardAccess.map((access) => ({ ...access, addedAt: access.addedAt.toISOString() })),
    };
  });

  app.patch("/users/:userId/role", async (req) => {
    const { userId } = req.params as { userId: string };
    const body = dto.adminUpdateUserRoleBody.parse(req.body);
    const target = await loadUserOr404(userId, body.clientId);

    await db.transaction(async (tx) => {
      // Never strip an org of its last owner — that would leave the tenant unadministrable.
      if (target.role === "owner" && body.role !== "owner") {
        const owners = await countOwners(target.clientId, tx);
        if (owners <= 1) throw badRequest("cannot demote the last owner");
      }
      await tx.update(clientMembers).set({ clientRole: body.role }).where(and(eq(clientMembers.clientId, target.clientId), eq(clientMembers.userId, userId)));
      const wasOrgAdmin = target.role === "owner" || target.role === "admin";
      const isOrgAdminNow = body.role === "owner" || body.role === "admin";
      // The management portal changes the same organisation-level role as the tenant app, so it
      // must maintain the inherited board roster in the same transaction too.
      if (isOrgAdminNow) await pinOrgAdminToClientBoards(tx, target.clientId, userId);
      else if (wasOrgAdmin) await unpinOrgAdminFromClientBoards(tx, target.clientId, userId);
      await writeAdminAudit(tx, {
        adminUserId: req.adminAuth.sub,
        action: "user.role.update",
        targetType: "user",
        targetClientId: target.clientId,
        targetUserId: userId,
        details: { from: target.role, to: body.role },
      });
    });
    return { ok: true };
  });

  app.post("/users/:userId/suspend", async (req) => {
    const { userId } = req.params as { userId: string };
    const target = await loadUserOr404(userId, (req.query as { clientId?: string }).clientId);
    await db.transaction(async (tx) => {
      await tx.update(clientMembers).set({ suspendedAt: new Date() }).where(and(eq(clientMembers.clientId, target.clientId), eq(clientMembers.userId, userId)));
      await repointActiveOrganisation(userId, target.clientId, tx);
      // The admin API cannot directly evict sockets owned by the tenant API process. Revoke refresh
      // credentials so every tab must re-authenticate and can only return through an active org;
      // access.ts independently blocks the still-live short access token from this organisation.
      await revokeUserRefreshTokens(tx, userId);
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "user.suspend", targetType: "user", targetClientId: target.clientId, targetUserId: userId });
    });
    return { ok: true };
  });

  app.post("/users/:userId/unsuspend", async (req) => {
    const { userId } = req.params as { userId: string };
    const target = await loadUserOr404(userId, (req.query as { clientId?: string }).clientId);
    await db.transaction(async (tx) => {
      await tx.update(clientMembers).set({ suspendedAt: null }).where(and(eq(clientMembers.clientId, target.clientId), eq(clientMembers.userId, userId)));
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "user.unsuspend", targetType: "user", targetClientId: target.clientId, targetUserId: userId });
    });
    return { ok: true };
  });

  // Issues a standard tenant password-reset token + email. We never surface or set a plaintext password;
  // the user completes the reset through the normal tenant flow.
  app.post("/users/:userId/reset-password", async (req) => {
    const { userId } = req.params as { userId: string };
    const target = await loadUserOr404(userId);

    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db.transaction(async (tx) => {
      // Invalidate any prior unused reset tokens so only the freshly issued one is usable.
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
      await tx.insert(passwordResetTokens).values({ userId, tokenHash: token.hash, expiresAt });
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "user.password.reset", targetType: "user", targetClientId: target.clientId, targetUserId: userId });
    });

    const resetUrl = `${env.WEB_ORIGIN}/reset-password?token=${token.raw}`;
    try {
      await app.mailer.sendPasswordReset(target.email, target.displayName, resetUrl);
    } catch (err) {
      // The token is already issued and audited; a mail failure should not 500 the admin action.
      req.log.error({ err, userId }, "failed to send admin-triggered password reset email");
    }
    return { ok: true };
  });

  app.post("/users/:userId/force-reverify", async (req) => {
    const { userId } = req.params as { userId: string };
    const target = await loadUserOr404(userId);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ emailVerifiedAt: null, updatedAt: new Date() }).where(eq(users.id, userId));
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "user.email.reverify", targetType: "user", targetClientId: target.clientId, targetUserId: userId });
    });
    return { ok: true };
  });

  app.post("/users/:userId/reset-mfa", async (req) => {
    requireSuperadmin(req);
    const { userId } = req.params as { userId: string };
    const user = await loadUserOr404(userId);
    await db.transaction(async (tx) => {
      await resetMfa({ kind: "user", id: userId }, tx);
      await revokeUserRefreshTokens(tx, userId);
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "user.mfa.reset", targetType: "user", details: { userId, email: user.email } });
    });
    return { ok: true };
  });

  // Soft-delete: sets deletedAt + revokes refresh tokens. Tenant auth/listings then hide the user; the row
  // is retained so historical authorship stays valid. Superadmin only; last-owner guarded.
  app.delete("/users/:userId", async (req) => {
    requireSuperadmin(req);
    const { userId } = req.params as { userId: string };
    const target = await loadUserOr404(userId);
    await db.transaction(async (tx) => {
      for (const membership of target.memberships.filter((item) => item.role === "owner" && !item.removedAt)) {
        const owners = await countOwners(membership.clientId, tx);
        if (owners <= 1) throw badRequest(`cannot delete the last owner of ${membership.orgName}`);
      }
      await tx.update(users).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
      await revokeUserRefreshTokens(tx, userId);
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "user.delete", targetType: "user", targetClientId: target.clientId, targetUserId: userId });
    });
    return { ok: true };
  });
}
