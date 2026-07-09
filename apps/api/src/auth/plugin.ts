import jwt from "@fastify/jwt";
import { requestContext } from "@fastify/request-context";
import { clients, supportSessions, users, workspaceApiKeys, type ClientRole, type WorkspaceApiKeyKind, type WorkspaceApiKeyScope } from "@kanera/shared/schema";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { db } from "../db.js";
import { env } from "../env.js";
import { isPaidTier } from "../lib/entitlements.js";
import { unauthorized } from "../lib/errors.js";
import { hashOpaqueToken } from "../lib/tokens.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    auth: AuthClaims;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthClaims;
    user: AuthClaims;
  }
}

declare module "@fastify/request-context" {
  interface RequestContextData {
    authKind?: "user" | "apiKey" | "support";
    apiKeyId?: string;
    apiKeyName?: string;
    // Set for support-session tokens so activity/audit paths can tell an operator impersonation
    // apart from a genuine user action even though the token acts as a real user in the target org.
    supportSessionId?: string;
    supportActorEmail?: string;
  }
}

// Identity carried by a support-session token minted from the management portal. The token acts as
// (sub/cid/role of) the target org's owner, but these fields preserve which portal admin the real
// operator is for attribution and audit. `byAdminId` references admin_user, not the tenant users table.
export interface SupportClaims {
  sessionId: string;
  byAdminId: string;
  byEmail: string;
}

export interface AuthClaims {
  sub: string; // userId
  cid: string; // clientId
  role: ClientRole; // organisation-level role
  authKind?: "user" | "apiKey" | "support";
  apiKeyId?: string;
  apiKeyName?: string;
  // Personal keys are not pinned to a workspace and carry no scope: they act with the owner's real
  // (board-content-only) access. `apiKeyWorkspaceId`/`apiKeyScope` are set for workspace keys only.
  apiKeyKind?: WorkspaceApiKeyKind;
  apiKeyWorkspaceId?: string;
  apiKeyScope?: WorkspaceApiKeyScope;
  support?: SupportClaims;
}

const API_KEY_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

async function authenticateApiKey(req: FastifyRequest, raw: string): Promise<AuthClaims | null> {
  if (!req.url.startsWith("/api/v1/")) return null;
  const [row] = await db
    .select({
      apiKeyId: workspaceApiKeys.id,
      apiKeyName: workspaceApiKeys.name,
      kind: workspaceApiKeys.kind,
      workspaceId: workspaceApiKeys.workspaceId,
      scope: workspaceApiKeys.scope,
      userId: users.id,
      clientId: users.clientId,
      clientRole: users.clientRole,
      billingStatus: clients.billingStatus,
    })
    .from(workspaceApiKeys)
    .innerJoin(users, eq(users.id, workspaceApiKeys.createdById))
    .innerJoin(clients, eq(clients.id, users.clientId))
    // A suspended, removed, or soft-deleted creator — or a suspended/soft-deleted org — immediately
    // disables the API keys. Otherwise a platform-admin suspend/delete would be bypassable via API key.
    .where(and(
      eq(workspaceApiKeys.keyHash, hashOpaqueToken(raw)),
      isNull(workspaceApiKeys.revokedAt),
      isNull(users.suspendedAt),
      isNull(users.removedAt),
      isNull(users.deletedAt),
      isNull(clients.suspendedAt),
      isNull(clients.deletedAt),
    ))
    .limit(1);
  if (!row) return null;
  // Defense-in-depth: the API is a paid-only feature. Downgrade already revokes keys, but reject at
  // request time too so a hosted free org can never use /api/v1/* even if a key slips past
  // reconciliation. Self-hosted and trial/paid orgs are unaffected.
  if (env.KANERA_DEPLOYMENT_MODE === "hosted" && !isPaidTier(row.billingStatus)) return null;

  const lastUsedCutoff = new Date(Date.now() - API_KEY_LAST_USED_THROTTLE_MS);
  await db
    .update(workspaceApiKeys)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    // Keep last-used visibility approximate so high-volume integrations do not
    // turn every authenticated request into an avoidable write.
    .where(and(
      eq(workspaceApiKeys.id, row.apiKeyId),
      or(isNull(workspaceApiKeys.lastUsedAt), lt(workspaceApiKeys.lastUsedAt, lastUsedCutoff)),
    ));

  // A personal key acts as its owner: it carries no workspace pin or scope, and access.ts evaluates it
  // through the owner's real memberships (board content only). A workspace key stays pinned + scoped.
  if (row.kind === "personal") {
    return {
      sub: row.userId,
      cid: row.clientId,
      role: row.clientRole,
      authKind: "apiKey",
      apiKeyKind: "personal",
      apiKeyId: row.apiKeyId,
    };
  }

  return {
    sub: row.userId,
    cid: row.clientId,
    role: row.clientRole,
    authKind: "apiKey",
    apiKeyKind: "workspace",
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKeyName ?? undefined,
    apiKeyWorkspaceId: row.workspaceId ?? undefined,
    apiKeyScope: row.scope,
  };
}

export default fp(async (app) => {
  app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_TTL },
  });

  app.decorate("authenticate", async (req: FastifyRequest) => {
    if (req.auth) return;

    const authorization = req.headers.authorization;
    if (authorization?.startsWith("Bearer kanera_")) {
      const claims = await authenticateApiKey(req, authorization.slice("Bearer ".length));
      if (!claims) throw unauthorized();
      req.auth = claims;
      requestContext.set("clientId", claims.cid);
      requestContext.set("userId", claims.sub);
      if (claims.apiKeyKind === "personal") {
        // A personal key must read as its owner everywhere downstream: record authKind "user" so
        // activity attribution (currentAttribution) shows the person, not a key name, and leave the
        // apiKey*/workspace context unset. The per-key rate-limit bucket still uses claims.apiKeyId.
        requestContext.set("authKind", "user");
      } else {
        requestContext.set("authKind", claims.authKind);
        requestContext.set("apiKeyId", claims.apiKeyId);
        requestContext.set("apiKeyName", claims.apiKeyName);
        requestContext.set("workspaceId", claims.apiKeyWorkspaceId);
      }
      return;
    }

    try {
      await req.jwtVerify();
      // No live DB check here: JWT_ACCESS_TTL is 5 minutes and the refresh token is revoked
      // on removal/suspension, so at most a 5-minute window remains on existing access tokens.
      // Preserve the token's own authKind: a support-session token is signed with authKind:"support"
      // (and no refresh companion, so it self-expires); default to "user" for normal access tokens.
      const authKind = req.user.authKind === "support" ? "support" : "user";
      if (authKind === "support") {
        const support = req.user.support;
        if (!support) throw unauthorized();

        // Unlike ordinary short-lived access tokens, support sessions are explicitly revocable.
        // Match every identity-bearing claim against the durable row so a session can only act as
        // the exact operator/tenant/user combination for which it was minted.
        const [activeSession] = await db
          .select({ id: supportSessions.id })
          .from(supportSessions)
          .where(and(
            eq(supportSessions.id, support.sessionId),
            eq(supportSessions.adminUserId, support.byAdminId),
            eq(supportSessions.adminEmail, support.byEmail),
            eq(supportSessions.targetClientId, req.user.cid),
            eq(supportSessions.targetUserId, req.user.sub),
            isNull(supportSessions.endedAt),
            gt(supportSessions.expiresAt, new Date()),
          ))
          .limit(1);
        if (!activeSession) throw unauthorized();
      }
      req.auth = { ...req.user, authKind };
      requestContext.set("clientId", req.user.cid);
      requestContext.set("userId", req.user.sub);
      requestContext.set("authKind", authKind);
      if (authKind === "support") {
        requestContext.set("supportSessionId", req.user.support?.sessionId);
        requestContext.set("supportActorEmail", req.user.support?.byEmail);
      }
    } catch {
      throw unauthorized();
    }
  });
});
