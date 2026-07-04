import { createHash, randomBytes } from "node:crypto";
import { dto } from "@kanera/shared";
import { adminInvites, adminRefreshTokens, adminUsers } from "@kanera/shared/schema";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { hashPassword } from "../auth/password.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { writeAdminAudit } from "./audit.js";

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const requireSuperadmin = (req: FastifyRequest) => {
  if (req.adminAuth.role !== "superadmin") throw forbidden("superadmin required");
};

export async function adminInvitePublicRoutes(app: FastifyInstance) {
  app.get("/invites/validate", async (req) => {
    const { token } = dto.adminInviteTokenQuery.parse(req.query);
    const [invite] = await db.select({ email: adminInvites.email, displayName: adminInvites.displayName })
      .from(adminInvites).where(and(eq(adminInvites.tokenHash, tokenHash(token)), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), gt(adminInvites.expiresAt, new Date()))).limit(1);
    if (!invite) throw notFound("invalid or expired invitation");
    return invite;
  });

  app.post("/invites/accept", async (req) => {
    const body = dto.adminAcceptInviteBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const result = await db.transaction(async (tx) => {
      const [invite] = await tx.select().from(adminInvites)
        .where(and(eq(adminInvites.tokenHash, tokenHash(body.token)), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), gt(adminInvites.expiresAt, new Date())))
        .for("update").limit(1);
      if (!invite) throw unauthorized("invalid or expired invitation");
      const [existing] = await tx.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, invite.email)).limit(1);
      if (existing) throw conflict("an administrator with this email already exists");
      const [admin] = await tx.insert(adminUsers).values({ email: invite.email, displayName: invite.displayName, passwordHash, role: "superadmin" }).returning({ id: adminUsers.id });
      await tx.update(adminInvites).set({ acceptedAt: new Date(), updatedAt: new Date() }).where(eq(adminInvites.id, invite.id));
      await writeAdminAudit(tx, { adminUserId: invite.invitedById, action: "admin.invite.accept", targetType: "admin_user", details: { adminUserId: admin!.id, email: invite.email } });
      return admin!;
    });
    return { ok: true, adminId: result.id };
  });
}

export async function adminManagementRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req) => requireSuperadmin(req));

  app.get("/admins", async (req) => {
    const query = dto.adminListAdminsQuery.parse(req.query);
    const [accounts, invites] = await Promise.all([
      db.select().from(adminUsers).where(eq(adminUsers.role, "superadmin")).orderBy(desc(adminUsers.createdAt)),
      db.select().from(adminInvites).where(and(isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), gt(adminInvites.expiresAt, new Date()))).orderBy(desc(adminInvites.createdAt)),
    ]);
    // Accounts and pending invitations live in separate tables, so normalize them before applying one
    // stable search/sort/page contract to the combined administrator directory.
    let items = [
      ...accounts.map((a) => ({ id: a.id, kind: "account", email: a.email, displayName: a.displayName, status: a.disabledAt ? "disabled" : "active", createdAt: a.createdAt.toISOString(), lastLoginAt: a.lastLoginAt?.toISOString() ?? null, expiresAt: null })),
      ...invites.map((i) => ({ id: i.id, kind: "invite", email: i.email, displayName: i.displayName, status: "pending", createdAt: i.createdAt.toISOString(), lastLoginAt: null, expiresAt: i.expiresAt.toISOString() })),
    ];
    if (query.q) { const q = query.q.toLocaleLowerCase(); items = items.filter((i) => i.displayName.toLocaleLowerCase().includes(q) || i.email.toLocaleLowerCase().includes(q)); }
    const value = (i: (typeof items)[number]) => query.sort === "lastActivityAt" ? (i.lastLoginAt ?? i.expiresAt ?? "") : i[query.sort];
    items.sort((a, b) => { const compared = String(value(a) ?? "").localeCompare(String(value(b) ?? "")); return (query.direction === "asc" ? compared : -compared) || a.id.localeCompare(b.id); });
    const total = items.length;
    const start = (query.page - 1) * query.pageSize;
    return { items: items.slice(start, start + query.pageSize), total, page: query.page, pageSize: query.pageSize };
  });

  app.post("/admins/invites", async (req, reply) => {
    const body = dto.adminCreateInviteBody.parse(req.body);
    const raw = randomBytes(32).toString("base64url");
    const invite = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, body.email)).limit(1);
      if (existing) throw conflict("an administrator with this email already exists");
      await tx.update(adminInvites).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(eq(adminInvites.email, body.email), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt)));
      const [row] = await tx.insert(adminInvites).values({ ...body, tokenHash: tokenHash(raw), invitedById: req.adminAuth.sub, expiresAt: new Date(Date.now() + INVITE_TTL_MS) }).returning();
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "admin.invite.create", targetType: "admin_user", details: { inviteId: row!.id, email: body.email } });
      return row!;
    });
    await app.mailer.sendAdminInvite(invite.email, invite.displayName, `${env.ADMIN_WEB_ORIGIN}/accept-invite?token=${encodeURIComponent(raw)}`);
    return reply.status(201).send({ ok: true, id: invite.id });
  });

  app.post("/admins/invites/:id/resend", async (req) => {
    const { id } = req.params as { id: string };
    const raw = randomBytes(32).toString("base64url");
    const [invite] = await db.update(adminInvites).set({ tokenHash: tokenHash(raw), expiresAt: new Date(Date.now() + INVITE_TTL_MS), updatedAt: new Date() })
      .where(and(eq(adminInvites.id, id), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt))).returning();
    if (!invite) throw notFound("pending invitation not found");
    await writeAdminAudit(db, { adminUserId: req.adminAuth.sub, action: "admin.invite.resend", targetType: "admin_user", details: { inviteId: id, email: invite.email } });
    await app.mailer.sendAdminInvite(invite.email, invite.displayName, `${env.ADMIN_WEB_ORIGIN}/accept-invite?token=${encodeURIComponent(raw)}`);
    return { ok: true };
  });

  app.delete("/admins/invites/:id", async (req) => {
    const { id } = req.params as { id: string };
    const [invite] = await db.update(adminInvites).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(eq(adminInvites.id, id), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt))).returning();
    if (!invite) throw notFound("pending invitation not found");
    await writeAdminAudit(db, { adminUserId: req.adminAuth.sub, action: "admin.invite.revoke", targetType: "admin_user", details: { inviteId: id, email: invite.email } });
    return { ok: true };
  });

  app.post("/admins/:id/disable", async (req) => {
    const { id } = req.params as { id: string };
    if (id === req.adminAuth.sub) throw badRequest("you cannot disable your own account");
    await db.transaction(async (tx) => {
      // Serialize all disable decisions so two requests cannot both observe another active superadmin.
      await tx.execute(sql`select pg_advisory_xact_lock(71001)`);
      const [target] = await tx.select().from(adminUsers).where(and(eq(adminUsers.id, id), eq(adminUsers.role, "superadmin"))).for("update").limit(1);
      if (!target) throw notFound("administrator not found");
      if (target.disabledAt) return;
      const [count] = await tx.select({ value: sql<number>`count(*)::int` }).from(adminUsers).where(and(eq(adminUsers.role, "superadmin"), isNull(adminUsers.disabledAt)));
      if ((count?.value ?? 0) <= 1) throw conflict("the final active superadmin cannot be disabled");
      await tx.update(adminUsers).set({ disabledAt: new Date(), updatedAt: new Date() }).where(eq(adminUsers.id, id));
      await tx.update(adminRefreshTokens).set({ revokedAt: new Date() }).where(and(eq(adminRefreshTokens.adminUserId, id), isNull(adminRefreshTokens.revokedAt)));
      await writeAdminAudit(tx, { adminUserId: req.adminAuth.sub, action: "admin.disable", targetType: "admin_user", details: { adminUserId: id, email: target.email } });
    });
    return { ok: true };
  });

  app.post("/admins/:id/enable", async (req) => {
    const { id } = req.params as { id: string };
    const [target] = await db.update(adminUsers).set({ disabledAt: null, updatedAt: new Date() }).where(and(eq(adminUsers.id, id), eq(adminUsers.role, "superadmin"))).returning();
    if (!target) throw notFound("administrator not found");
    await writeAdminAudit(db, { adminUserId: req.adminAuth.sub, action: "admin.enable", targetType: "admin_user", details: { adminUserId: id, email: target.email } });
    return { ok: true };
  });
}
