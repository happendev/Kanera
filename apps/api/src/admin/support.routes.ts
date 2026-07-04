import { dto } from "@kanera/shared";
import { adminUsers, supportSessions } from "@kanera/shared/schema";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { clientIpForRequest } from "../lib/client-ip.js";
import { forbidden, notFound } from "../lib/errors.js";
import { resolveSupportTargetOwner } from "../lib/support-session.js";
import { writeAdminAudit } from "./audit.js";
import { signSupportToken } from "./plugin.js";

// Impersonating into a customer's workspace is the most sensitive capability in the console, so it is
// gated to the superadmin role — matching how destructive user/org actions are gated (users.routes.ts).
function requireSuperadmin(req: FastifyRequest) {
  if (req.adminAuth.role !== "superadmin") throw forbidden("superadmin required");
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function adminSupportRoutes(app: FastifyInstance) {
  // Start a cross-tenant support session that acts as the target org's owner and return the enter URL.
  app.post("/orgs/:clientId/support-session", async (req) => {
    requireSuperadmin(req);
    const { clientId } = req.params as { clientId: string };
    const body = dto.adminStartSupportSessionBody.parse(req.body);

    // The admin claims carry only sub/role; load the email for the immutable audit snapshot + support claim.
    const [admin] = await db.select({ email: adminUsers.email }).from(adminUsers).where(eq(adminUsers.id, req.adminAuth.sub)).limit(1);
    if (!admin) throw forbidden();

    const target = await resolveSupportTargetOwner(clientId);
    if (!target) throw notFound("target org not found or has no active user to act as");

    const ttlMinutes = env.SUPPORT_SESSION_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    // Audit row + admin_audit_log entry share one transaction so a support session can never exist without
    // both durable records — the audit trail is the only thing standing behind an impersonation.
    const session = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(supportSessions)
        .values({
          adminUserId: req.adminAuth.sub,
          adminEmail: admin.email,
          targetClientId: clientId,
          targetOrgName: target.orgName,
          targetUserId: target.userId,
          targetUserEmail: target.userEmail,
          reason: body.reason,
          ipAddress: clientIpForRequest(req),
          userAgent: req.headers["user-agent"] ?? null,
          expiresAt,
        })
        .returning({ id: supportSessions.id });
      await writeAdminAudit(tx, {
        adminUserId: req.adminAuth.sub,
        action: "support.session.start",
        targetType: "org",
        targetClientId: clientId,
        targetUserId: target.userId,
        details: { sessionId: row!.id, reason: body.reason, expiresAt: expiresAt.toISOString() },
      });
      return row!;
    });

    // Sign a tenant token that acts as the org owner. authKind:"support" makes the tenant plugin re-check
    // the durable row on every request (so ending the session revokes the token immediately) and carries
    // the operator identity for attribution. No refresh companion, so it self-expires at the TTL.
    const accessToken = signSupportToken(
      app,
      {
        sub: target.userId,
        cid: clientId,
        role: "owner",
        authKind: "support",
        support: { sessionId: session.id, byAdminId: req.adminAuth.sub, byEmail: admin.email },
      },
      ttlMinutes * 60,
    );
    // Put the credential in the fragment so opening the returned URL pre-fills the support page without
    // sending the bearer token to the web server or exposing it through referrer headers.
    const supportUrl = new URL("/support/enter", env.WEB_ORIGIN);
    supportUrl.hash = new URLSearchParams({ token: accessToken }).toString();

    // High-signal audit log alongside the durable rows so support sessions surface in log-based alerting
    // even if someone later tampers with the tables.
    req.log.warn(
      { supportSessionId: session.id, adminUserId: req.adminAuth.sub, adminEmail: admin.email, targetClientId: clientId, targetUserId: target.userId, reason: body.reason },
      "portal support session started",
    );

    return {
      url: supportUrl.toString(),
      expiresAt: expiresAt.toISOString(),
      session: { id: session.id, targetClientId: clientId, targetUserId: target.userId, orgName: target.orgName },
      actingAsEmail: target.userEmail,
    } satisfies dto.AdminSupportSessionResponse;
  });

  // Revoke a live support session. Stamping endedAt fails the tenant plugin's per-request row check, so the
  // signed token stops working immediately (the operator's web session also lets them self-close from the
  // tenant side; this is the admin-side revoke).
  app.post("/support-sessions/:id/end", async (req) => {
    requireSuperadmin(req);
    const { id } = req.params as { id: string };
    const [row] = await db.select({ targetClientId: supportSessions.targetClientId, targetUserId: supportSessions.targetUserId }).from(supportSessions).where(eq(supportSessions.id, id)).limit(1);
    if (!row) throw notFound("support session not found");

    await db.transaction(async (tx) => {
      await tx.update(supportSessions).set({ endedAt: new Date() }).where(and(eq(supportSessions.id, id), isNull(supportSessions.endedAt)));
      await writeAdminAudit(tx, {
        adminUserId: req.adminAuth.sub,
        action: "support.session.end",
        targetType: "org",
        targetClientId: row.targetClientId,
        targetUserId: row.targetUserId,
        details: { sessionId: id },
      });
    });
    return { ok: true };
  });

  // Read the support-session audit trail (active + historical) for portal visibility.
  app.get("/support-sessions", async (req) => {
    const query = dto.adminListSupportSessionsQuery.parse(req.query);
    const now = new Date();
    const filters = [
      query.clientId ? eq(supportSessions.targetClientId, query.clientId) : undefined,
      // A session is live only while un-ended AND unexpired — mirror the tenant plugin's acceptance rule.
      query.status === "active" ? and(isNull(supportSessions.endedAt), gt(supportSessions.expiresAt, now)) : undefined,
    ].filter(Boolean);
    const where = filters.length ? and(...filters) : undefined;

    const [totalRow] = await db.select({ total: sql<number>`count(*)::int` }).from(supportSessions).where(where);
    const total = totalRow?.total ?? 0;

    const sortColumn = query.sort === "expiresAt" ? supportSessions.expiresAt : supportSessions.createdAt;
    const rows = await db
      .select()
      .from(supportSessions)
      .where(where)
      .orderBy(query.direction === "asc" ? sortColumn : desc(sortColumn))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: rows.map((r) => ({
        id: r.id,
        adminEmail: r.adminEmail,
        targetClientId: r.targetClientId,
        targetOrgName: r.targetOrgName,
        targetUserEmail: r.targetUserEmail,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        endedAt: iso(r.endedAt),
        active: !r.endedAt && r.expiresAt > now,
      })) satisfies dto.AdminSupportSessionListItem[],
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}
