import { dto } from "@kanera/shared";
import { boardMembers, boards, clients, passwordResetTokens, refreshTokens, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, asc, desc, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { withSignedMedia } from "../lib/media-keys.js";
import { countOwners } from "../lib/org-owners.js";
import { pinOrgAdminToClientBoards, unpinOrgAdminFromClientBoards } from "../lib/board-membership.js";
import { newOpaqueToken } from "../lib/tokens.js";
import { writeAdminAudit } from "./audit.js";
import { resetMfa } from "../auth/mfa.js";

function requireSuperadmin(req: FastifyRequest) {
  if (req.adminAuth.role !== "superadmin") throw forbidden("superadmin required");
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function loadUserOr404(userId: string) {
  const [row] = await db
    .select({
      id: users.id,
      clientId: users.clientId,
      email: users.email,
      displayName: users.displayName,
      role: users.clientRole,
      suspendedAt: users.suspendedAt,
      removedAt: users.removedAt,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw notFound("user not found");
  return row;
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
  // Global cross-tenant user search. No cid filter by design; joined to clients for the org name.
  app.get("/users", async (req) => {
    const query = dto.adminListUsersQuery.parse(req.query);
    const filters = [
      query.q ? or(ilike(users.email, `%${query.q}%`), ilike(users.displayName, `%${query.q}%`), ilike(clients.name, `%${query.q}%`)) : undefined,
      query.clientId ? eq(users.clientId, query.clientId) : undefined,
      query.suspended === true ? sql`${users.suspendedAt} is not null` : undefined,
      query.suspended === false ? isNull(users.suspendedAt) : undefined,
    ].filter(Boolean);
    const where = filters.length ? and(...filters) : undefined;

    const [totalRow] = await db.select({ total: sql<number>`count(*)::int` }).from(users).innerJoin(clients, eq(clients.id, users.clientId)).where(where);
    const total = totalRow?.total ?? 0;

    const statusSort = sql`case when ${users.deletedAt} is not null then 2 when ${users.suspendedAt} is not null then 1 else 0 end`;
    // Sort keys are schema-validated and mapped to expressions here; never interpolate query strings into SQL.
    const sortColumns = { displayName: users.displayName, email: users.email, orgName: clients.name, role: users.clientRole, createdAt: users.createdAt, lastOnlineAt: users.lastOnlineAt, status: statusSort } as const;
    const sortColumn = sortColumns[query.sort];
    const order = query.direction === "asc" ? asc : desc;
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        clientId: users.clientId,
        orgName: clients.name,
        role: users.clientRole,
        suspendedAt: users.suspendedAt,
        removedAt: users.removedAt,
        deletedAt: users.deletedAt,
        createdAt: users.createdAt,
        lastOnlineAt: users.lastOnlineAt,
      })
      .from(users)
      .innerJoin(clients, eq(clients.id, users.clientId))
      .where(where)
      .orderBy(order(sortColumn), asc(users.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: rows.map((r) => ({
        ...withSignedMedia(r.clientId, { avatarUrl: r.avatarUrl }),
        id: r.id,
        email: r.email,
        displayName: r.displayName,
        clientId: r.clientId,
        orgName: r.orgName,
        role: r.role,
        suspendedAt: iso(r.suspendedAt),
        removedAt: iso(r.removedAt),
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
        clientId: users.clientId,
        orgName: clients.name,
        role: users.clientRole,
        emailVerifiedAt: users.emailVerifiedAt,
        lastOnlineAt: users.lastOnlineAt,
        suspendedAt: users.suspendedAt,
        removedAt: users.removedAt,
        deletedAt: users.deletedAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .innerJoin(clients, eq(clients.id, users.clientId))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) throw notFound("user not found");

    const memberships = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        workspaceName: workspaces.name,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId));

    // A board membership is guest access only when the board's organisation differs from the
    // user's home organisation; private-board restrictions inside their own org are not guests.
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
      .where(and(eq(boardMembers.userId, userId), ne(workspaces.clientId, row.clientId)))
      .orderBy(asc(clients.name), asc(workspaces.name), asc(boards.name));

    return {
      ...withSignedMedia(row.clientId, { avatarUrl: row.avatarUrl }),
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      clientId: row.clientId,
      orgName: row.orgName,
      role: row.role,
      emailVerifiedAt: iso(row.emailVerifiedAt),
      lastOnlineAt: iso(row.lastOnlineAt),
      suspendedAt: iso(row.suspendedAt),
      removedAt: iso(row.removedAt),
      deletedAt: iso(row.deletedAt),
      createdAt: iso(row.createdAt)!,
      memberships,
      guestBoardAccess: guestBoardAccess.map((access) => ({ ...access, addedAt: access.addedAt.toISOString() })),
    };
  });

  app.patch("/users/:userId/role", async (req) => {
    const { userId } = req.params as { userId: string };
    const body = dto.adminUpdateUserRoleBody.parse(req.body);
    const target = await loadUserOr404(userId);

    await db.transaction(async (tx) => {
      // Never strip an org of its last owner — that would leave the tenant unadministrable.
      if (target.role === "owner" && body.role !== "owner") {
        const owners = await countOwners(target.clientId, tx);
        if (owners <= 1) throw badRequest("cannot demote the last owner");
      }
      await tx.update(users).set({ clientRole: body.role, updatedAt: new Date() }).where(eq(users.id, userId));
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
    const target = await loadUserOr404(userId);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ suspendedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
      await revokeUserRefreshTokens(tx, userId);
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "user.suspend", targetType: "user", targetClientId: target.clientId, targetUserId: userId });
    });
    return { ok: true };
  });

  app.post("/users/:userId/unsuspend", async (req) => {
    const { userId } = req.params as { userId: string };
    const target = await loadUserOr404(userId);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ suspendedAt: null, updatedAt: new Date() }).where(eq(users.id, userId));
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
      if (target.role === "owner") {
        const owners = await countOwners(target.clientId, tx);
        if (owners <= 1) throw badRequest("cannot delete the last owner");
      }
      await tx.update(users).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
      await revokeUserRefreshTokens(tx, userId);
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "user.delete", targetType: "user", targetClientId: target.clientId, targetUserId: userId });
    });
    return { ok: true };
  });
}
