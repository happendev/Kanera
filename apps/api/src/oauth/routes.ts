import {
  clients,
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthTokens,
  users,
  workspaceApiKeys,
  type WorkspaceApiKeyScope,
} from "@kanera/shared/schema";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AuthClaims } from "../auth/plugin.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { isPaidTier } from "../lib/entitlements.js";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { hashOpaqueToken } from "../lib/tokens.js";
import { assertApiKeysAllowed } from "../lib/tier-limits.js";
import { oauthOperationsTotal } from "../lib/metrics.js";

const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const interactiveScopes = new Set(["kanera:read", "kanera:write", "offline_access"]);

const clientRegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(200),
  redirect_uris: z.array(z.url()).min(1).max(20),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).default(["authorization_code", "refresh_token"]),
  token_endpoint_auth_method: z.enum(["none", "client_secret_basic", "client_secret_post"]).default("none"),
});

const authorizationSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.url(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(2000).optional(),
  // Deliberate product default: agents that omit scope get read+write+offline_access. Interactive
  // agents are near-useless read-only, and the write grant is still capped to the authorizing user's
  // current organisation, workspace, and board permissions. Clients wanting least privilege send scope.
  scope: z.string().default("kanera:read kanera:write offline_access"),
  resource: z.url().optional(),
});

function publicApiIssuer() {
  return env.PUBLIC_API_OAUTH_ISSUER;
}

function mcpResource() {
  return env.MCP_PUBLIC_URL;
}

function token(prefix: string) {
  const raw = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashOpaqueToken(raw) };
}

function scopes(raw: string) {
  const result = [...new Set(raw.split(/\s+/).filter(Boolean))];
  if (result.length === 0 || result.some((scope) => !interactiveScopes.has(scope))) throw badRequest("unsupported OAuth scope");
  return result;
}

function validRedirectUri(value: string) {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function activeClient(clientId: string) {
  const [client] = await db.select().from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.revokedAt))).limit(1);
  if (!client) throw unauthorized("unknown or revoked OAuth client");
  return client;
}

function parseBasicAuth(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { clientId: decodeURIComponent(decoded.slice(0, separator)), clientSecret: decodeURIComponent(decoded.slice(separator + 1)) };
  } catch {
    return null;
  }
}

async function authenticateConfidentialClient(req: FastifyRequest, body: Record<string, string>) {
  const basic = parseBasicAuth(req);
  const clientId = basic?.clientId ?? body.client_id;
  const secret = basic?.clientSecret ?? body.client_secret;
  if (!clientId || !secret) throw unauthorized("client authentication required");
  const client = await activeClient(clientId);
  if (!client.clientSecretHash || !safeEqual(client.clientSecretHash, hashOpaqueToken(secret))) throw unauthorized("invalid client credentials");
  return client;
}

async function issueTokens(input: { clientId: string; userId?: string; apiKeyId?: string; grantId?: string; scopes: string[]; familyId?: string }) {
  const access = token("kanera_oauth");
  const refresh = input.scopes.includes("offline_access") && input.userId ? token("kanera_refresh") : null;
  const familyId = input.familyId ?? randomUUID();
  const now = Date.now();
  await db.insert(oauthTokens).values([
    {
      kind: "access",
      tokenHash: access.hash,
      clientId: input.clientId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      grantId: input.grantId,
      familyId,
      scopes: input.scopes,
      expiresAt: new Date(now + ACCESS_TTL_MS),
    },
    ...(refresh ? [{
      kind: "refresh" as const,
      tokenHash: refresh.hash,
      clientId: input.clientId,
      userId: input.userId,
      grantId: input.grantId,
      familyId,
      scopes: input.scopes,
      expiresAt: new Date(now + REFRESH_TTL_MS),
    }] : []),
  ]);
  return {
    access_token: access.raw,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    scope: input.scopes.join(" "),
    ...(refresh ? { refresh_token: refresh.raw } : {}),
  };
}

export async function authenticateOauthToken(raw: string): Promise<AuthClaims | null> {
  const now = new Date();
  const [row] = await db.select({
    token: oauthTokens,
    client: oauthClients,
    userId: users.id,
    clientOrgId: users.clientId,
    clientRole: users.clientRole,
    billingStatus: clients.billingStatus,
    apiKeyName: workspaceApiKeys.name,
    apiKeyWorkspaceId: workspaceApiKeys.workspaceId,
    apiKeyScope: workspaceApiKeys.scope,
    apiKeyRevokedAt: workspaceApiKeys.revokedAt,
  }).from(oauthTokens)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthTokens.clientId))
    .innerJoin(users, eq(users.id, oauthTokens.userId))
    .innerJoin(clients, eq(clients.id, users.clientId))
    .leftJoin(workspaceApiKeys, eq(workspaceApiKeys.id, oauthTokens.apiKeyId))
    .where(and(
      eq(oauthTokens.kind, "access"),
      eq(oauthTokens.tokenHash, hashOpaqueToken(raw)),
      gt(oauthTokens.expiresAt, now),
      isNull(oauthTokens.revokedAt),
      isNull(oauthClients.revokedAt),
      isNull(users.suspendedAt),
      isNull(users.removedAt),
      isNull(users.deletedAt),
      isNull(clients.suspendedAt),
      isNull(clients.deletedAt),
    )).limit(1);
  if (!row || (env.KANERA_DEPLOYMENT_MODE === "hosted" && !isPaidTier(row.billingStatus))) return null;
  const lastUsedCutoff = new Date(Date.now() - 5 * 60_000);
  await db.update(oauthClients).set({ lastUsedAt: now, updatedAt: now }).where(and(
    eq(oauthClients.clientId, row.client.clientId),
    or(isNull(oauthClients.lastUsedAt), lt(oauthClients.lastUsedAt, lastUsedCutoff)),
  ));
  if (row.token.grantId) {
    await db.update(oauthGrants).set({ lastUsedAt: now, updatedAt: now }).where(and(
      eq(oauthGrants.id, row.token.grantId),
      or(isNull(oauthGrants.lastUsedAt), lt(oauthGrants.lastUsedAt, lastUsedCutoff)),
    ));
  }
  if (row.client.kind === "service") {
    if (!row.token.apiKeyId || row.apiKeyRevokedAt) return null;
    const requestedScope = row.token.scopes.includes("kanera:admin") ? "admin" : row.token.scopes.includes("kanera:write") ? "write" : "read";
    const rank: Record<WorkspaceApiKeyScope, number> = { read: 0, write: 1, admin: 2 };
    const storedScope = row.apiKeyScope ?? "read";
    const effectiveScope = rank[requestedScope] <= rank[storedScope] ? requestedScope : storedScope;
    return {
      sub: row.userId,
      cid: row.clientOrgId,
      role: row.clientRole,
      authKind: "apiKey",
      apiKeyKind: "workspace",
      apiKeyId: row.token.apiKeyId,
      apiKeyName: row.apiKeyName ?? row.client.name,
      apiKeyWorkspaceId: row.apiKeyWorkspaceId ?? undefined,
      apiKeyScope: effectiveScope,
    };
  }
  return {
    sub: row.userId,
    cid: row.clientOrgId,
    role: row.clientRole,
    authKind: "apiKey",
    apiKeyKind: "personal",
    // Reuse the existing per-credential public-API rate-limit bucket without attributing activity
    // to an API key; the auth plugin's personal branch deliberately keeps request context as user.
    // Key on the grant (falling back to the token family), NOT the access-token row id: access tokens
    // rotate every 15 min, so keying on row.id would hand a fresh rate-limit bucket to any agent that
    // refreshes, defeating the per-key limit. grantId/familyId are stable across the whole connection.
    apiKeyId: `oauth_grant_${row.token.grantId ?? row.token.familyId}`,
    apiKeyScope: row.token.scopes.includes("kanera:write") ? "write" : "read",
  };
}

export async function oauthPublicRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/oauth/token") || req.url.startsWith("/oauth/register")) {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
    }
    return payload;
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body.toString())));
  });

  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer: publicApiIssuer(),
    authorization_endpoint: `${publicApiIssuer()}/oauth/authorize`,
    token_endpoint: `${publicApiIssuer()}/oauth/token`,
    registration_endpoint: `${publicApiIssuer()}/oauth/register`,
    revocation_endpoint: `${publicApiIssuer()}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: ["kanera:read", "kanera:write", "offline_access"],
  }));

  app.post("/oauth/register", async (req, reply) => {
    const body = clientRegistrationSchema.parse(req.body);
    if (body.redirect_uris.some((uri) => !validRedirectUri(uri))) throw badRequest("redirect URIs must use HTTPS, except localhost callbacks");
    const clientId = `kanera_client_${randomBytes(18).toString("base64url")}`;
    const confidential = body.token_endpoint_auth_method !== "none";
    const secret = confidential ? token("kanera_client_secret") : null;
    await db.insert(oauthClients).values({
      clientId,
      kind: "public",
      name: body.client_name,
      clientSecretHash: secret?.hash,
      redirectUris: body.redirect_uris,
      grantTypes: body.grant_types,
    });
    oauthOperationsTotal.inc({ operation: "client_registered", client_kind: "public" });
    return reply.status(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      grant_types: body.grant_types,
      token_endpoint_auth_method: body.token_endpoint_auth_method,
      ...(secret ? { client_secret: secret.raw } : {}),
      ...(secret ? { client_secret_expires_at: 0 } : {}),
    });
  });

  app.get("/oauth/authorize", async (req, reply) => {
    const params = authorizationSchema.parse(req.query);
    const client = await activeClient(params.client_id);
    if (client.kind !== "public" || !client.grantTypes.includes("authorization_code") || !client.redirectUris.includes(params.redirect_uri)) throw badRequest("client cannot use this authorization request");
    scopes(params.scope);
    if (params.resource && params.resource !== mcpResource()) throw badRequest("unsupported OAuth resource");
    const query = new URLSearchParams(Object.entries(req.query as Record<string, string>));
    return reply.redirect(`${env.WEB_ORIGIN}/oauth/authorize?${query.toString()}`);
  });

  app.post("/oauth/token", async (req, reply) => {
    const body = z.record(z.string(), z.string()).parse(req.body ?? {});
    if (body.grant_type === "authorization_code") {
      const client = await activeClient(body.client_id ?? parseBasicAuth(req)?.clientId ?? "");
      // Only interactive (public) clients issue authorization codes; service clients use client_credentials.
      if (client.kind !== "public" || !client.grantTypes.includes("authorization_code")) throw unauthorized("authorization_code is not allowed for this client");
      if (!body.code || !body.redirect_uri || !body.code_verifier) throw badRequest("code, redirect_uri, and code_verifier are required");
      if (client.clientSecretHash) await authenticateConfidentialClient(req, body);
      const [code] = await db.select().from(oauthAuthorizationCodes).where(and(
        eq(oauthAuthorizationCodes.codeHash, hashOpaqueToken(body.code)),
        eq(oauthAuthorizationCodes.clientId, client.clientId),
        gt(oauthAuthorizationCodes.expiresAt, new Date()),
        isNull(oauthAuthorizationCodes.consumedAt),
      )).limit(1);
      if (!code || code.redirectUri !== body.redirect_uri || !safeEqual(code.codeChallenge, pkceChallenge(body.code_verifier))) throw unauthorized("invalid authorization code");
      const [grant] = await db.select().from(oauthGrants).where(and(eq(oauthGrants.id, code.grantId), isNull(oauthGrants.revokedAt))).limit(1);
      if (!grant) throw unauthorized("authorization grant is revoked");
      await db.update(oauthAuthorizationCodes).set({ consumedAt: new Date() }).where(eq(oauthAuthorizationCodes.id, code.id));
      oauthOperationsTotal.inc({ operation: "authorization_code_exchanged", client_kind: "public" });
      return reply.send(await issueTokens({ clientId: client.clientId, userId: grant.userId, grantId: grant.id, scopes: code.scopes }));
    }
    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token) throw badRequest("refresh_token is required");
      const [old] = await db.select().from(oauthTokens).where(and(eq(oauthTokens.kind, "refresh"), eq(oauthTokens.tokenHash, hashOpaqueToken(body.refresh_token)))).limit(1);
      if (!old) throw unauthorized("invalid refresh token");
      if (!body.client_id || body.client_id !== old.clientId) throw unauthorized("refresh token client mismatch");
      if (old.revokedAt || old.expiresAt <= new Date()) {
        await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.familyId, old.familyId));
        throw unauthorized("refresh token reuse or expiry detected");
      }
      const client = await activeClient(old.clientId);
      if (!client.grantTypes.includes("refresh_token")) throw unauthorized("refresh_token is not allowed for this client");
      if (client.clientSecretHash) await authenticateConfidentialClient(req, body);
      await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.id, old.id));
      oauthOperationsTotal.inc({ operation: "refresh_rotated", client_kind: "public" });
      return reply.send(await issueTokens({ clientId: old.clientId, userId: old.userId!, grantId: old.grantId!, scopes: old.scopes, familyId: old.familyId }));
    }
    if (body.grant_type === "client_credentials") {
      const client = await authenticateConfidentialClient(req, body);
      if (client.kind !== "service" || !client.grantTypes.includes("client_credentials") || !client.apiKeyId || !client.createdById) throw forbidden("client is not a service connection");
      const requested = body.scope?.split(/\s+/).filter(Boolean) ?? [`kanera:${client.maxScope ?? "read"}`];
      const rank: Record<string, number> = { "kanera:read": 0, "kanera:write": 1, "kanera:admin": 2 };
      const maximum = `kanera:${client.maxScope ?? "read"}`;
      if (requested.some((scope) => rank[scope] === undefined || rank[scope]! > rank[maximum]!)) throw forbidden("requested scope exceeds the service connection maximum");
      oauthOperationsTotal.inc({ operation: "client_credentials_exchanged", client_kind: "service" });
      return reply.send(await issueTokens({ clientId: client.clientId, userId: client.createdById, apiKeyId: client.apiKeyId, scopes: requested }));
    }
    throw badRequest("unsupported grant_type");
  });

  app.post("/oauth/revoke", async (req, reply) => {
    const body = z.record(z.string(), z.string()).parse(req.body ?? {});
    if (body.token) {
      const [existing] = await db.select({ familyId: oauthTokens.familyId }).from(oauthTokens)
        .where(eq(oauthTokens.tokenHash, hashOpaqueToken(body.token))).limit(1);
      if (existing) await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.familyId, existing.familyId));
    }
    return reply.status(200).send();
  });
}

export async function oauthUserRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/oauth/authorize/context", async (req) => {
    await assertApiKeysAllowed(req.auth.cid);
    const params = authorizationSchema.parse(req.query);
    const client = await activeClient(params.client_id);
    // Mirror the invariants enforced by the public GET /oauth/authorize: a logged-in browser can hit
    // this consent path directly, so re-validate the client rather than trusting that the GET ran first.
    if (client.kind !== "public" || !client.grantTypes.includes("authorization_code")) throw badRequest("client cannot use this authorization request");
    if (!client.redirectUris.includes(params.redirect_uri)) throw badRequest("redirect_uri is not registered");
    if (params.resource && params.resource !== mcpResource()) throw badRequest("unsupported OAuth resource");
    return { clientName: client.name, scopes: scopes(params.scope), redirectUri: params.redirect_uri };
  });

  app.post("/oauth/authorize/consent", async (req) => {
    await assertApiKeysAllowed(req.auth.cid);
    const params = authorizationSchema.parse(req.body);
    const client = await activeClient(params.client_id);
    // Mirror the invariants enforced by the public GET /oauth/authorize: a logged-in browser can hit
    // this consent path directly, so re-validate the client rather than trusting that the GET ran first.
    if (client.kind !== "public" || !client.grantTypes.includes("authorization_code")) throw badRequest("client cannot use this authorization request");
    if (!client.redirectUris.includes(params.redirect_uri)) throw badRequest("redirect_uri is not registered");
    if (params.resource && params.resource !== mcpResource()) throw badRequest("unsupported OAuth resource");
    const grantedScopes = scopes(params.scope);
    const code = token("kanera_code");
    // Grant and its authorization code are written together so a mid-write failure cannot leave an
    // orphaned grant with no code (which would show up as a phantom connection in /me/oauth-connections).
    await db.transaction(async (tx) => {
      const [grant] = await tx.insert(oauthGrants).values({ clientId: client.clientId, userId: req.auth.sub, scopes: grantedScopes }).returning();
      await tx.insert(oauthAuthorizationCodes).values({
        codeHash: code.hash,
        clientId: client.clientId,
        grantId: grant!.id,
        redirectUri: params.redirect_uri,
        codeChallenge: params.code_challenge,
        scopes: grantedScopes,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
    });
    oauthOperationsTotal.inc({ operation: "consent_granted", client_kind: "public" });
    const redirect = new URL(params.redirect_uri);
    redirect.searchParams.set("code", code.raw);
    if (params.state) redirect.searchParams.set("state", params.state);
    return { redirectUrl: redirect.toString() };
  });

  app.get("/me/oauth-connections", async (req) => {
    return db.select({ id: oauthGrants.id, clientId: oauthGrants.clientId, clientName: oauthClients.name, scopes: oauthGrants.scopes, lastUsedAt: oauthGrants.lastUsedAt, createdAt: oauthGrants.createdAt })
      .from(oauthGrants).innerJoin(oauthClients, eq(oauthClients.clientId, oauthGrants.clientId))
      .where(and(eq(oauthGrants.userId, req.auth.sub), isNull(oauthGrants.revokedAt)));
  });

  app.get("/me/agent-connection-config", async () => ({ mcpUrl: env.MCP_PUBLIC_URL }));

  app.delete("/me/oauth-connections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [grant] = await db.update(oauthGrants).set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, req.auth.sub), isNull(oauthGrants.revokedAt))).returning();
    if (!grant) throw notFound("OAuth connection not found");
    await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.grantId, grant.id));
    return reply.status(204).send();
  });
}

export function newServiceClientSecret() {
  return token("kanera_service_secret");
}

export function newServiceClientId() {
  return `kanera_service_${randomBytes(18).toString("base64url")}`;
}

export function oauthScopeForWorkspaceScope(scope: WorkspaceApiKeyScope) {
  return `kanera:${scope}`;
}
