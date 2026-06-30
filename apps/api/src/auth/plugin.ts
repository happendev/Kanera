import jwt from "@fastify/jwt";
import { requestContext } from "@fastify/request-context";
import { clients, users, workspaceApiKeys, type ClientRole, type WorkspaceApiKeyScope } from "@kanera/shared/schema";
import { and, eq, isNull, lt, or } from "drizzle-orm";
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
    authKind?: "user" | "apiKey";
    apiKeyId?: string;
    apiKeyName?: string;
  }
}

export interface AuthClaims {
  sub: string; // userId
  cid: string; // clientId
  role: ClientRole; // organisation-level role
  authKind?: "user" | "apiKey";
  apiKeyId?: string;
  apiKeyName?: string;
  apiKeyWorkspaceId?: string;
  apiKeyScope?: WorkspaceApiKeyScope;
}

const API_KEY_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

async function authenticateApiKey(req: FastifyRequest, raw: string): Promise<AuthClaims | null> {
  if (!req.url.startsWith("/api/v1/")) return null;
  const [row] = await db
    .select({
      apiKeyId: workspaceApiKeys.id,
      apiKeyName: workspaceApiKeys.name,
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
    // A suspended or removed creator immediately disables their API keys.
    .where(and(eq(workspaceApiKeys.keyHash, hashOpaqueToken(raw)), isNull(workspaceApiKeys.revokedAt), isNull(users.suspendedAt), isNull(users.removedAt)))
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

  return {
    sub: row.userId,
    cid: row.clientId,
    role: row.clientRole,
    authKind: "apiKey",
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKeyName,
    apiKeyWorkspaceId: row.workspaceId,
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
      requestContext.set("authKind", claims.authKind);
      requestContext.set("apiKeyId", claims.apiKeyId);
      requestContext.set("apiKeyName", claims.apiKeyName);
      requestContext.set("workspaceId", claims.apiKeyWorkspaceId);
      return;
    }

    try {
      await req.jwtVerify();
      // No live DB check here: JWT_ACCESS_TTL is 5 minutes and the refresh token is revoked
      // on removal/suspension, so at most a 5-minute window remains on existing access tokens.
      req.auth = { ...req.user, authKind: "user" };
      requestContext.set("clientId", req.user.cid);
      requestContext.set("userId", req.user.sub);
      requestContext.set("authKind", "user");
    } catch {
      throw unauthorized();
    }
  });
});
