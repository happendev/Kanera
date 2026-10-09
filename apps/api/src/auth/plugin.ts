import jwt from "@fastify/jwt";
import { requestContext } from "@fastify/request-context";
import { supportSessions, users, workspaceApiKeys, workspaces, type ClientMcpPolicy, type ClientRole, type WorkspaceApiKeyKind, type WorkspaceApiKeyScope } from "@kanera/shared/schema";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { db } from "../db.js";
import { env } from "../env.js";
import { unauthorized } from "../lib/errors.js";
import { hashOpaqueToken } from "../lib/tokens.js";
import { authenticateMcpDelegationToken } from "../oauth/routes.js";
import type { ApiRateTier } from "../lib/api-rate-limit.js";
import { resolvePersonalCredentialOrganisation } from "./personal-credential-context.js";
import { applyMcpPolicy } from "../lib/mcp-policy.js";
import { z } from "zod";

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
    authKind?: "user" | "apiKey" | "agent" | "support";
    apiKeyId?: string;
    apiKeyName?: string;
    // Set for authKind "agent": the OAuth grant an AI agent is acting through and the agent's
    // registered client name, so activity/comments can say "Ada via Claude" instead of just "Ada".
    agentGrantId?: string;
    agentName?: string;
    // Set for support-session tokens so activity/audit paths can tell an operator impersonation
    // apart from a genuine user action even though the token acts as a real user in the target org.
    supportSessionId?: string;
    supportActorEmail?: string;
    // The authenticating API key for every key-backed credential, including personal keys whose
    // activity deliberately reads as the user. Only change attribution (outbox actor) uses it, so
    // an MCP event subscriber can recognise writes made through its own connection.
    credentialApiKeyId?: string;
    credentialServiceClientId?: string;
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
  // Present when a personal OAuth credential belongs to an interactive agent connection (the
  // "Connect an AI agent" flow). Authorization is unchanged (the agent acts as its owner); these
  // only drive attribution, so the owner is notified about, and can audit, what the agent did.
  agentGrantId?: string;
  agentName?: string;
  // Service OAuth connections own event subscriptions separately from their backing API key.
  oauthServiceClientId?: string;
  // Personal keys are not pinned to a workspace and act as their owner; a `read` scope caps the
  // authority they may exercise below the owner's. OAuth personal credentials set apiKeyScope;
  // workspace credentials also set a pin.
  apiKeyKind?: WorkspaceApiKeyKind;
  apiKeyWorkspaceId?: string;
  // Typed as the workspace superset because workspace keys carry it, but personal keys only ever
  // hold the personal subset ("read" | "write"); "admin" is a workspace-key value. The one
  // "admin" comparison lives in the workspace branch of assertBoardAccess.
  apiKeyScope?: WorkspaceApiKeyScope;
  // Personal credentials only: the credential's own scope before the current organisation's MCP
  // policy capped it into apiKeyScope, and that effective policy (see lib/mcp-policy.ts). Both are
  // recomputed whenever the credential rebases onto another organisation.
  apiKeyGrantedScope?: WorkspaceApiKeyScope;
  mcpPolicy?: ClientMcpPolicy;
  // Plan tier of the credential's resolved default organisation (claims.cid at authentication). The
  // public API meters requests by the organisation that owns the touched board; this tier only applies
  // to requests that resolve no organisation themselves. Carried in claims so MCP delegation tokens
  // keep it. Absent on interactive session JWTs, which the public API does not meter by credential.
  apiRateTier?: ApiRateTier;
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
      activeClientId: users.activeClientId,
      clientId: sql<string | null>`coalesce(${workspaceApiKeys.clientId}, ${workspaces.clientId})`,
    })
    .from(workspaceApiKeys)
    .innerJoin(users, eq(users.id, workspaceApiKeys.createdById))
    .leftJoin(workspaces, eq(workspaces.id, workspaceApiKeys.workspaceId))
    // A soft-deleted creator immediately disables every key. Organisation membership and plan
    // eligibility are resolved below because personal credentials may use any active organisation.
    .where(and(
      eq(workspaceApiKeys.keyHash, hashOpaqueToken(raw)),
      isNull(workspaceApiKeys.revokedAt),
      isNull(users.deletedAt),
    ))
    .limit(1);
  if (!row) return null;

  const requestedHeader = req.headers["x-kanera-organisation-id"];
  const requestedOrganisation = requestedHeader === undefined
    ? undefined
    : typeof requestedHeader === "string" && z.uuid().safeParse(requestedHeader).success
      ? requestedHeader
      : null;
  if (requestedOrganisation === null) return null;
  if (!row.clientId) return null;
  // Personal keys work on every plan; workspace keys are unattended service credentials and only
  // authenticate while their pinned organisation is paid (they are also revoked on downgrade).
  const organisation = await resolvePersonalCredentialOrganisation(row.userId, row.kind === "personal"
    ? {
        ...(requestedOrganisation ? { requiredClientId: requestedOrganisation } : {}),
        preferredClientIds: [row.clientId, row.activeClientId],
      }
    : { requiredClientId: row.clientId, requirePaidOrganisation: true });
  if (!organisation) return null;

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

  // A personal key acts as its owner in a live organisation context. The key's stored client id is
  // only the default; a target resource (or explicit request header) may safely rebase it later.
  if (row.kind === "personal") {
    const claims: AuthClaims = {
      sub: row.userId,
      cid: organisation.clientId,
      role: organisation.role,
      authKind: "apiKey",
      apiKeyKind: "personal",
      apiKeyId: row.apiKeyId,
      // Scope rides along even though the key acts as its owner: access.ts downgrades org/board
      // authority for `read`, while the request-context authKind below stays "user". That split is
      // deliberate — attribution ("acts as its owner") is governed by authKind, authorization
      // ("may do less than its owner") by apiKeyScope — and the two must not be conflated.
      apiKeyScope: row.scope,
      apiRateTier: organisation.apiRateTier,
    };
    // Org-level routes that resolve no resource act in this default organisation, so cap the
    // credential by its policy now; resource access recomputes it for the owning organisation.
    applyMcpPolicy(claims, organisation.mcpPolicy);
    return claims;
  }

  return {
    sub: row.userId,
    cid: organisation.clientId,
    role: organisation.role,
    authKind: "apiKey",
    apiKeyKind: "workspace",
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKeyName ?? undefined,
    apiKeyWorkspaceId: row.workspaceId ?? undefined,
    apiKeyScope: row.scope,
    apiRateTier: "paid",
  };
}

/**
 * Install a bearer credential's claims on the request: authorization (`req.auth`) plus the request
 * context that activity attribution, rate limiting, and realtime actor fields read. Shared with
 * routes that authenticate by a stored capability (upload links) so their writes are attributed
 * exactly as the credential that minted them would be.
 */
export function applyBearerAuthContext(req: FastifyRequest, claims: AuthClaims): void {
  req.auth = claims;
  requestContext.set("clientId", claims.cid);
  requestContext.set("userId", claims.sub);
  if (claims.apiKeyId) requestContext.set("credentialApiKeyId", claims.apiKeyId);
  if (claims.oauthServiceClientId) requestContext.set("credentialServiceClientId", claims.oauthServiceClientId);
  if (claims.apiKeyKind === "personal" && claims.agentGrantId) {
    // An interactive agent grant acts as its owner for authorization but must NOT be recorded
    // as the owner's own action: Work Done, the activity feed, and self-notification
    // suppression all key off this. actorId stays the owner; the grant identifies the agent.
    requestContext.set("authKind", "agent");
    requestContext.set("agentGrantId", claims.agentGrantId);
    requestContext.set("agentName", claims.agentName);
  } else if (claims.apiKeyKind === "personal") {
    // A personal API key (scripts, CI) reads as its owner everywhere downstream: record authKind
    // "user" so activity attribution (currentAttribution) shows the person, not a key name, and
    // leave the apiKey*/workspace context unset. The per-key rate-limit bucket still uses
    // claims.apiKeyId.
    requestContext.set("authKind", "user");
  } else {
    requestContext.set("authKind", claims.authKind);
    requestContext.set("apiKeyId", claims.apiKeyId);
    requestContext.set("apiKeyName", claims.apiKeyName);
    requestContext.set("workspaceId", claims.apiKeyWorkspaceId);
  }
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
      const raw = authorization.slice("Bearer ".length);
      const claims = raw.startsWith("kanera_delegate_")
        ? req.url.startsWith("/api/v1/") ? authenticateMcpDelegationToken(raw) : null
        : await authenticateApiKey(req, raw);
      if (!claims) throw unauthorized();
      applyBearerAuthContext(req, claims);
      return;
    }

    try {
      await req.jwtVerify();
      // Normal access JWTs deliberately avoid a live DB check. Org removal repoints the user's
      // default membership and forces realtime eviction; an already-issued token has at most the
      // configured five-minute TTL before refresh validates membership again.
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
