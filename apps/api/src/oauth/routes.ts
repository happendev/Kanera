import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthDeviceCodes,
  oauthGrants,
  oauthTokens,
  users,
  workspaces,
  workspaceApiKeys,
  type WorkspaceApiKeyScope,
} from "@kanera/shared/schema";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AuthClaims } from "../auth/plugin.js";
import { resolvePersonalCredentialOrganisation } from "../auth/personal-credential-context.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { hashOpaqueToken } from "../lib/tokens.js";
import { assertApiKeysAllowed } from "../lib/tier-limits.js";
import { oauthOperationsTotal } from "../lib/metrics.js";

const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const DEVICE_CODE_TTL_MS = 10 * 60_000;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const DEVICE_SLOW_DOWN_SECONDS = 5;
const MCP_DELEGATION_TTL_MS = 60_000;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const interactiveScopes = new Set(["kanera:read", "kanera:write", "offline_access"]);
const mandatoryInteractiveScopes = ["kanera:read", "kanera:write"] as const;

const clientRegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(200),
  redirect_uris: z.array(z.url()).max(20).default([]),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token", DEVICE_GRANT_TYPE])).default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.literal("code")).default(["code"]),
  token_endpoint_auth_method: z.enum(["none", "client_secret_basic", "client_secret_post"]).default("none"),
  application_type: z.enum(["native", "web"]).optional(),
  scope: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.grant_types.includes("authorization_code") && value.redirect_uris.length === 0) {
    ctx.addIssue({ code: "custom", path: ["redirect_uris"], message: "authorization_code clients require a redirect URI" });
  }
});

const authorizationSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.url(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(2000).optional(),
  // Interactive MCP connections always receive both resource capabilities. The MCP client owns
  // tool visibility/approval, while Kanera's live user and board permissions authorize each call.
  scope: z.string().default(mandatoryInteractiveScopes.join(" ")),
  resource: z.url(),
});

const deviceConsentSchema = z.object({
  user_code: z.string().trim().min(4).max(32),
  decision: z.enum(["approve", "deny"]),
});

function publicApiIssuer() {
  return env.PUBLIC_API_OAUTH_ISSUER;
}

function mcpResource() {
  return canonicalResource(env.MCP_PUBLIC_URL);
}

function canonicalResource(value: string) {
  const url = new URL(value);
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
}

function requestedMcpResource(value: string | undefined) {
  if (!value) throw badRequest("resource is required");
  const resource = canonicalResource(value);
  if (resource !== mcpResource()) throw badRequest("unsupported OAuth resource");
  return resource;
}

function token(prefix: string) {
  const raw = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashOpaqueToken(raw) };
}

function deviceUserCode() {
  const bytes = randomBytes(8);
  const raw = [...bytes].map((byte) => DEVICE_USER_CODE_ALPHABET[byte! % DEVICE_USER_CODE_ALPHABET.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeDeviceUserCode(value: string) {
  return value.trim().replace(/[-\s]/g, "").toUpperCase();
}

function oauthError(reply: FastifyReply, error: string, errorDescription: string) {
  return reply.status(400).send({ error, error_description: errorDescription });
}

function scopes(raw: string) {
  const requested = [...new Set(raw.split(/\s+/).filter(Boolean))];
  if (requested.length === 0 || requested.some((scope) => !interactiveScopes.has(scope))) throw badRequest("unsupported OAuth scope");
  return [
    ...mandatoryInteractiveScopes,
    ...(requested.includes("offline_access") ? ["offline_access"] : []),
  ];
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

async function findActiveClient(clientId: string) {
  const [client] = await db.select().from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.revokedAt))).limit(1);
  return client;
}

async function activeClient(clientId: string) {
  const client = await findActiveClient(clientId);
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

type IssueTokenInput = {
  clientId: string;
  userId?: string;
  apiKeyId?: string;
  grantId?: string;
  scopes: string[];
  resource: string;
  familyId?: string;
  issueRefreshToken?: boolean;
};

function prepareTokens(input: IssueTokenInput) {
  // This is a protected-resource token for the MCP endpoint, never a public API bearer token.
  const access = token("kanera_mcp");
  // MCP clients register refresh_token support independently of whether they know to request the
  // optional offline_access scope. Honor the registered grant type so short access-token TTLs work
  // across Claude, the reference SDK, and other conforming clients without repeated user consent.
  const refresh = input.issueRefreshToken && input.userId ? token("kanera_refresh") : null;
  const familyId = input.familyId ?? randomUUID();
  const now = Date.now();
  const values: (typeof oauthTokens.$inferInsert)[] = [
    {
      kind: "access",
      tokenHash: access.hash,
      clientId: input.clientId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      grantId: input.grantId,
      familyId,
      scopes: input.scopes,
      resource: input.resource,
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
      resource: input.resource,
      expiresAt: new Date(now + REFRESH_TTL_MS),
    }] : []),
  ];
  const response = {
    access_token: access.raw,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    scope: input.scopes.join(" "),
    ...(refresh ? { refresh_token: refresh.raw } : {}),
  };
  return { values, response };
}

async function issueTokens(input: IssueTokenInput) {
  const prepared = prepareTokens(input);
  await db.insert(oauthTokens).values(prepared.values);
  return prepared.response;
}

async function authenticateMcpToken(raw: string, resource: string): Promise<AuthClaims | null> {
  const now = new Date();
  const [row] = await db.select({
    token: oauthTokens,
    client: oauthClients,
    userId: users.id,
    activeClientId: users.activeClientId,
    grantOrgClientId: oauthGrants.orgClientId,
    apiKeyName: workspaceApiKeys.name,
    apiKeyWorkspaceId: workspaceApiKeys.workspaceId,
    apiKeyClientId: workspaceApiKeys.clientId,
    workspaceClientId: workspaces.clientId,
    apiKeyScope: workspaceApiKeys.scope,
    apiKeyRevokedAt: workspaceApiKeys.revokedAt,
  }).from(oauthTokens)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthTokens.clientId))
    .leftJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(users, eq(users.id, oauthTokens.userId))
    .leftJoin(workspaceApiKeys, eq(workspaceApiKeys.id, oauthTokens.apiKeyId))
    .leftJoin(workspaces, eq(workspaces.id, workspaceApiKeys.workspaceId))
    .where(and(
      eq(oauthTokens.kind, "access"),
      eq(oauthTokens.tokenHash, hashOpaqueToken(raw)),
      eq(oauthTokens.resource, resource),
      or(isNull(oauthTokens.grantId), eq(oauthGrants.resource, resource)),
      gt(oauthTokens.expiresAt, now),
      isNull(oauthTokens.revokedAt),
      isNull(oauthClients.revokedAt),
      isNull(users.deletedAt),
    )).limit(1);
  if (!row) return null;

  const pinnedClientId = row.apiKeyClientId ?? row.workspaceClientId;
  const organisation = await resolvePersonalCredentialOrganisation(row.userId, row.client.kind === "service"
    ? { requiredClientId: pinnedClientId ?? undefined }
    : { preferredClientIds: [row.grantOrgClientId, row.activeClientId] });
  if (!organisation) return null;
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
      cid: organisation.clientId,
      role: organisation.role,
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
    cid: organisation.clientId,
    role: organisation.role,
    authKind: "apiKey",
    apiKeyKind: "personal",
    // Reuse the existing per-credential public-API rate-limit bucket without attributing activity
    // to an API key; the auth plugin's personal branch deliberately keeps request context as user.
    // Key on the grant (falling back to the token family), NOT the access-token row id: access tokens
    // rotate every 15 min, so keying on row.id would hand a fresh rate-limit bucket to any agent that
    // refreshes, defeating the per-key limit. grantId/familyId are stable across the whole connection.
    apiKeyId: `oauth_grant_${row.token.grantId ?? row.token.familyId}`,
    // Interactive MCP OAuth is always resource-write-capable. The client decides whether a write
    // tool may run; Kanera still evaluates the represented user's live role on every resource.
    // Keeping this unconditional also upgrades access tokens minted before this policy changed.
    apiKeyScope: "write",
  };
}

type McpDelegationPayload = {
  claims: AuthClaims;
  resource: string;
  audience: "kanera-public-api";
  expiresAt: number;
};

function delegationSignature(encodedPayload: string) {
  return createHmac("sha256", env.MCP_INTERNAL_SECRET).update(encodedPayload).digest("base64url");
}

function issueMcpDelegationToken(claims: AuthClaims, resource: string) {
  const payload: McpDelegationPayload = {
    claims,
    resource,
    audience: "kanera-public-api",
    expiresAt: Date.now() + MCP_DELEGATION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `kanera_delegate_${encoded}.${delegationSignature(encoded)}`;
}

export function authenticateMcpDelegationToken(raw: string): AuthClaims | null {
  const match = /^kanera_delegate_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(raw);
  if (!match || !safeEqual(match[2]!, delegationSignature(match[1]!))) return null;
  try {
    const payload = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as McpDelegationPayload;
    if (payload.audience !== "kanera-public-api" || payload.resource !== mcpResource() || payload.expiresAt <= Date.now()) return null;
    return payload.claims;
  } catch {
    return null;
  }
}

export async function oauthPublicRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/oauth/token") || req.url.startsWith("/oauth/register") || req.url.startsWith("/oauth/device/code") || req.url.startsWith("/oauth/mcp/delegate")) {
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
    device_authorization_endpoint: `${publicApiIssuer()}/oauth/device/code`,
    registration_endpoint: `${publicApiIssuer()}/oauth/register`,
    revocation_endpoint: `${publicApiIssuer()}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials", DEVICE_GRANT_TYPE],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: ["kanera:read", "kanera:write", "offline_access"],
  }));

  app.post("/oauth/mcp/delegate", async (req, reply) => {
    const suppliedSecret = req.headers["x-kanera-mcp-secret"];
    if (typeof suppliedSecret !== "string" || !safeEqual(suppliedSecret, env.MCP_INTERNAL_SECRET)) {
      throw unauthorized("invalid MCP service credential");
    }
    const body = z.object({
      token: z.string().regex(/^kanera_mcp_[A-Za-z0-9_-]{43}$/u),
      resource: z.url(),
    }).parse(req.body);
    const resource = requestedMcpResource(body.resource);
    const claims = await authenticateMcpToken(body.token, resource);
    if (!claims) throw unauthorized("invalid or expired MCP access token");
    // The bridge receives a separate, minute-lived bearer credential. The protected-resource token
    // itself never crosses into /api/v1 and cannot be replayed there by a client.
    return reply.send({
      accessToken: issueMcpDelegationToken(claims, resource),
      expiresIn: MCP_DELEGATION_TTL_MS / 1000,
    });
  });

  app.post("/oauth/register", async (req, reply) => {
    const body = clientRegistrationSchema.parse(req.body);
    if (body.redirect_uris.some((uri) => !validRedirectUri(uri))) throw badRequest("redirect URIs must use HTTPS, except localhost callbacks");
    const registeredScopes = scopes(body.scope ?? mandatoryInteractiveScopes.join(" "));
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
      response_types: body.response_types,
      token_endpoint_auth_method: body.token_endpoint_auth_method,
      scope: registeredScopes.join(" "),
      ...(body.application_type ? { application_type: body.application_type } : {}),
      ...(secret ? { client_secret: secret.raw } : {}),
      ...(secret ? { client_secret_expires_at: 0 } : {}),
    });
  });

  app.post("/oauth/device/code", async (req, reply) => {
    const body = z.record(z.string(), z.string()).parse(req.body ?? {});
    const clientId = body.client_id ?? parseBasicAuth(req)?.clientId;
    if (!clientId) return oauthError(reply, "invalid_client", "client_id is required");
    const client = await findActiveClient(clientId);
    if (!client) return oauthError(reply, "invalid_client", "unknown or revoked OAuth client");
    if (client.kind !== "public" || !client.grantTypes.includes(DEVICE_GRANT_TYPE)) {
      return oauthError(reply, "unauthorized_client", "device authorization is not allowed for this client");
    }
    if (client.clientSecretHash) await authenticateConfidentialClient(req, body);
    let resource: string;
    try {
      resource = requestedMcpResource(body.resource);
    } catch {
      return oauthError(reply, "invalid_target", body.resource ? "unsupported OAuth resource" : "resource is required");
    }

    let requestedScopes: string[];
    try {
      requestedScopes = scopes(body.scope ?? mandatoryInteractiveScopes.join(" "));
    } catch {
      return oauthError(reply, "invalid_scope", "unsupported OAuth scope");
    }

    const device = token("kanera_device");
    const userCode = deviceUserCode();
    const verificationUri = `${env.WEB_ORIGIN}/oauth/device`;
    await db.insert(oauthDeviceCodes).values({
      deviceCodeHash: device.hash,
      userCodeHash: hashOpaqueToken(normalizeDeviceUserCode(userCode)),
      clientId: client.clientId,
      scopes: requestedScopes,
      resource,
      pollingInterval: DEVICE_POLL_INTERVAL_SECONDS,
      expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_MS),
    });
    oauthOperationsTotal.inc({ operation: "device_code_issued", client_kind: "public" });
    return reply.send({
      device_code: device.raw,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?${new URLSearchParams({ user_code: userCode }).toString()}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    });
  });

  app.get("/oauth/authorize", async (req, reply) => {
    const params = authorizationSchema.parse(req.query);
    const client = await activeClient(params.client_id);
    if (client.kind !== "public" || !client.grantTypes.includes("authorization_code") || !client.redirectUris.includes(params.redirect_uri)) throw badRequest("client cannot use this authorization request");
    const grantedScopes = scopes(params.scope);
    requestedMcpResource(params.resource);
    const query = new URLSearchParams(Object.entries(req.query as Record<string, string>));
    // Normalize before entering the browser consent flow. Some MCP clients omit scope or send only
    // one advertised value; every interoperable path must show and persist Kanera's full policy.
    query.set("scope", grantedScopes.join(" "));
    return reply.redirect(`${env.WEB_ORIGIN}/oauth/authorize?${query.toString()}`);
  });

  app.post("/oauth/token", async (req, reply) => {
    const body = z.record(z.string(), z.string()).parse(req.body ?? {});
    let resource: string;
    try {
      resource = requestedMcpResource(body.resource);
    } catch {
      return oauthError(reply, "invalid_target", body.resource ? "unsupported OAuth resource" : "resource is required");
    }
    if (body.grant_type === DEVICE_GRANT_TYPE) {
      if (!body.device_code || !body.client_id) return oauthError(reply, "invalid_request", "device_code and client_id are required");
      const client = await findActiveClient(body.client_id);
      if (!client) return oauthError(reply, "invalid_client", "unknown or revoked OAuth client");
      if (client.kind !== "public" || !client.grantTypes.includes(DEVICE_GRANT_TYPE)) {
        return oauthError(reply, "unauthorized_client", "device authorization is not allowed for this client");
      }
      if (client.clientSecretHash) await authenticateConfidentialClient(req, body);

      // Serialize polls for a device request. This makes approval consumption and refresh-token
      // creation one atomic, one-time operation even when a CLI accidentally polls concurrently.
      const result = await db.transaction(async (tx) => {
        const [request] = await tx.select().from(oauthDeviceCodes).where(and(
          eq(oauthDeviceCodes.deviceCodeHash, hashOpaqueToken(body.device_code!)),
          eq(oauthDeviceCodes.clientId, client.clientId),
        )).for("update").limit(1);
        if (!request) return { ok: false, error: "invalid_grant", description: "invalid device code" } as const;
        if (request.resource !== resource) return { ok: false, error: "invalid_target", description: "resource does not match the device authorization" } as const;

        const now = new Date();
        if (request.expiresAt <= now) return { ok: false, error: "expired_token", description: "device code expired" } as const;
        if (request.status === "denied") return { ok: false, error: "access_denied", description: "the user denied this request" } as const;
        if (request.status === "consumed") return { ok: false, error: "expired_token", description: "device code has already been used" } as const;
        if (request.status === "pending") {
          const tooSoon = request.lastPolledAt !== null
            && now.getTime() < request.lastPolledAt.getTime() + request.pollingInterval * 1000;
          const pollingInterval = tooSoon ? request.pollingInterval + DEVICE_SLOW_DOWN_SECONDS : request.pollingInterval;
          await tx.update(oauthDeviceCodes).set({ lastPolledAt: now, pollingInterval, updatedAt: now }).where(eq(oauthDeviceCodes.id, request.id));
          return tooSoon
            ? { ok: false, error: "slow_down", description: "polling too quickly" } as const
            : { ok: false, error: "authorization_pending", description: "the user has not completed authorization" } as const;
        }

        if (!request.grantId || !request.userId) return { ok: false, error: "access_denied", description: "device authorization is incomplete" } as const;
        const [grant] = await tx.select().from(oauthGrants).where(and(
          eq(oauthGrants.id, request.grantId),
          isNull(oauthGrants.revokedAt),
        )).limit(1);
        if (!grant) return { ok: false, error: "access_denied", description: "authorization grant is revoked" } as const;

        const prepared = prepareTokens({
          clientId: client.clientId,
          userId: request.userId,
          grantId: grant.id,
          scopes: request.scopes,
          resource,
          issueRefreshToken: client.grantTypes.includes("refresh_token"),
        });
        await tx.insert(oauthTokens).values(prepared.values);
        await tx.update(oauthDeviceCodes).set({ status: "consumed", updatedAt: now }).where(eq(oauthDeviceCodes.id, request.id));
        return { ok: true, tokens: prepared.response } as const;
      });
      if (!result.ok) return oauthError(reply, result.error, result.description);
      oauthOperationsTotal.inc({ operation: "device_code_exchanged", client_kind: "public" });
      return reply.send(result.tokens);
    }
    if (body.grant_type === "authorization_code") {
      const client = await activeClient(body.client_id ?? parseBasicAuth(req)?.clientId ?? "");
      // Only interactive (public) clients issue authorization codes; service clients use client_credentials.
      if (client.kind !== "public" || !client.grantTypes.includes("authorization_code")) throw unauthorized("authorization_code is not allowed for this client");
      if (!body.code || !body.redirect_uri || !body.code_verifier) throw badRequest("code, redirect_uri, and code_verifier are required");
      if (client.clientSecretHash) await authenticateConfidentialClient(req, body);
      // Lock and consume the code in the same transaction that creates its tokens. Concurrent
      // exchanges must never mint two refresh families from one browser authorization.
      const exchange = await db.transaction(async (tx) => {
        const [code] = await tx.select().from(oauthAuthorizationCodes).where(and(
          eq(oauthAuthorizationCodes.codeHash, hashOpaqueToken(body.code!)),
          eq(oauthAuthorizationCodes.clientId, client.clientId),
          gt(oauthAuthorizationCodes.expiresAt, new Date()),
          isNull(oauthAuthorizationCodes.consumedAt),
        )).for("update").limit(1);
        if (!code || code.redirectUri !== body.redirect_uri || !safeEqual(code.codeChallenge, pkceChallenge(body.code_verifier!))) {
          return { ok: false, error: "invalid authorization code" } as const;
        }
        if (code.resource !== resource) return { ok: false, error: "invalid_target" } as const;
        const [grant] = await tx.select().from(oauthGrants).where(and(eq(oauthGrants.id, code.grantId), isNull(oauthGrants.revokedAt))).limit(1);
        if (!grant) return { ok: false, error: "authorization grant is revoked" } as const;
        const prepared = prepareTokens({
          clientId: client.clientId,
          userId: grant.userId,
          grantId: grant.id,
          scopes: code.scopes,
          resource,
          issueRefreshToken: client.grantTypes.includes("refresh_token"),
        });
        await tx.update(oauthAuthorizationCodes).set({ consumedAt: new Date() }).where(eq(oauthAuthorizationCodes.id, code.id));
        await tx.insert(oauthTokens).values(prepared.values);
        return { ok: true, tokens: prepared.response } as const;
      });
      if (!exchange.ok) {
        if (exchange.error === "invalid_target") return oauthError(reply, "invalid_target", "resource does not match the authorization code");
        throw unauthorized(exchange.error);
      }
      oauthOperationsTotal.inc({ operation: "authorization_code_exchanged", client_kind: "public" });
      return reply.send(exchange.tokens);
    }
    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token) throw badRequest("refresh_token is required");
      const [old] = await db.select().from(oauthTokens).where(and(eq(oauthTokens.kind, "refresh"), eq(oauthTokens.tokenHash, hashOpaqueToken(body.refresh_token)))).limit(1);
      if (!old) throw unauthorized("invalid refresh token");
      if (old.resource !== resource) return oauthError(reply, "invalid_target", "resource does not match the refresh token");
      if (!body.client_id || body.client_id !== old.clientId) throw unauthorized("refresh token client mismatch");
      const client = await activeClient(old.clientId);
      if (client.kind !== "public" || !client.grantTypes.includes("refresh_token")) throw unauthorized("refresh_token is not allowed for this client");
      if (client.clientSecretHash) await authenticateConfidentialClient(req, body);
      // Rotation is serialized per token. A replay that arrives while another refresh is completing
      // waits for the lock, observes revocation, and invalidates the whole family as required by
      // OAuth 2.1 instead of minting a second live refresh token.
      const rotation = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(oauthTokens).where(eq(oauthTokens.id, old.id)).for("update").limit(1);
        if (!locked || locked.revokedAt || locked.expiresAt <= new Date()) {
          if (locked) await tx.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.familyId, locked.familyId));
          return { ok: false } as const;
        }
        const prepared = prepareTokens({
          clientId: locked.clientId,
          userId: locked.userId!,
          grantId: locked.grantId!,
          // Refreshing a legacy read-only interactive grant persists the current full MCP policy.
          scopes: scopes(locked.scopes.join(" ")),
          resource,
          familyId: locked.familyId,
          issueRefreshToken: true,
        });
        await tx.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.id, locked.id));
        await tx.insert(oauthTokens).values(prepared.values);
        return { ok: true, tokens: prepared.response } as const;
      });
      if (!rotation.ok) throw unauthorized("refresh token reuse or expiry detected");
      oauthOperationsTotal.inc({ operation: "refresh_rotated", client_kind: "public" });
      return reply.send(rotation.tokens);
    }
    if (body.grant_type === "client_credentials") {
      const client = await authenticateConfidentialClient(req, body);
      if (client.kind !== "service" || !client.grantTypes.includes("client_credentials") || !client.apiKeyId || !client.createdById) throw forbidden("client is not a service connection");
      const requested = body.scope?.split(/\s+/).filter(Boolean) ?? [`kanera:${client.maxScope ?? "read"}`];
      const rank: Record<string, number> = { "kanera:read": 0, "kanera:write": 1, "kanera:admin": 2 };
      const maximum = `kanera:${client.maxScope ?? "read"}`;
      if (requested.some((scope) => rank[scope] === undefined || rank[scope]! > rank[maximum]!)) throw forbidden("requested scope exceeds the service connection maximum");
      oauthOperationsTotal.inc({ operation: "client_credentials_exchanged", client_kind: "service" });
      return reply.send(await issueTokens({ clientId: client.clientId, userId: client.createdById, apiKeyId: client.apiKeyId, scopes: requested, resource }));
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

  app.get("/oauth/device/context", async (req) => {
    await assertApiKeysAllowed(req.auth.cid);
    const { user_code: userCode } = z.object({ user_code: z.string().trim().min(4).max(32) }).parse(req.query);
    const normalized = normalizeDeviceUserCode(userCode);
    const [row] = await db.select({ request: oauthDeviceCodes, client: oauthClients })
      .from(oauthDeviceCodes)
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthDeviceCodes.clientId))
      .where(and(
        eq(oauthDeviceCodes.userCodeHash, hashOpaqueToken(normalized)),
        eq(oauthDeviceCodes.status, "pending"),
        gt(oauthDeviceCodes.expiresAt, new Date()),
        isNull(oauthClients.revokedAt),
      )).limit(1);
    if (!row || row.client.kind !== "public" || !row.client.grantTypes.includes(DEVICE_GRANT_TYPE)) {
      throw notFound("Device code is invalid or expired");
    }
    return {
      clientName: row.client.name,
      scopes: row.request.scopes,
      userCode: `${normalized.slice(0, 4)}-${normalized.slice(4)}`,
      expiresAt: row.request.expiresAt,
    };
  });

  app.post("/oauth/device/consent", async (req) => {
    await assertApiKeysAllowed(req.auth.cid);
    const body = deviceConsentSchema.parse(req.body);
    const normalized = normalizeDeviceUserCode(body.user_code);
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select({ request: oauthDeviceCodes, client: oauthClients })
        .from(oauthDeviceCodes)
        .innerJoin(oauthClients, eq(oauthClients.clientId, oauthDeviceCodes.clientId))
        .where(eq(oauthDeviceCodes.userCodeHash, hashOpaqueToken(normalized)))
        .for("update")
        .limit(1);
      if (!row || row.request.status !== "pending" || row.request.expiresAt <= new Date()
        || row.client.revokedAt || row.client.kind !== "public" || !row.client.grantTypes.includes(DEVICE_GRANT_TYPE)) {
        throw notFound("Device code is invalid or expired");
      }

      const now = new Date();
      if (body.decision === "deny") {
        await tx.update(oauthDeviceCodes).set({ status: "denied", userId: req.auth.sub, updatedAt: now })
          .where(eq(oauthDeviceCodes.id, row.request.id));
        return { approved: false, clientName: row.client.name };
      }

      // The grant and approval transition commit together so the polling client can never observe an
      // approved device request without the durable connection it needs to mint tokens.
      const [grant] = await tx.insert(oauthGrants).values({
        clientId: row.client.clientId,
        userId: req.auth.sub,
        orgClientId: req.auth.cid,
        scopes: row.request.scopes,
        resource: row.request.resource,
      }).returning();
      await tx.update(oauthDeviceCodes).set({
        status: "approved",
        userId: req.auth.sub,
        grantId: grant!.id,
        updatedAt: now,
      }).where(eq(oauthDeviceCodes.id, row.request.id));
      return { approved: true, clientName: row.client.name };
    });
    oauthOperationsTotal.inc({ operation: result.approved ? "device_consent_granted" : "device_consent_denied", client_kind: "public" });
    return result;
  });

  app.get("/oauth/authorize/context", async (req) => {
    await assertApiKeysAllowed(req.auth.cid);
    const params = authorizationSchema.parse(req.query);
    const client = await activeClient(params.client_id);
    // Mirror the invariants enforced by the public GET /oauth/authorize: a logged-in browser can hit
    // this consent path directly, so re-validate the client rather than trusting that the GET ran first.
    if (client.kind !== "public" || !client.grantTypes.includes("authorization_code")) throw badRequest("client cannot use this authorization request");
    if (!client.redirectUris.includes(params.redirect_uri)) throw badRequest("redirect_uri is not registered");
    const resource = requestedMcpResource(params.resource);
    return { clientName: client.name, scopes: scopes(params.scope), redirectUri: params.redirect_uri, resource };
  });

  app.post("/oauth/authorize/consent", async (req) => {
    await assertApiKeysAllowed(req.auth.cid);
    const params = authorizationSchema.parse(req.body);
    const client = await activeClient(params.client_id);
    // Mirror the invariants enforced by the public GET /oauth/authorize: a logged-in browser can hit
    // this consent path directly, so re-validate the client rather than trusting that the GET ran first.
    if (client.kind !== "public" || !client.grantTypes.includes("authorization_code")) throw badRequest("client cannot use this authorization request");
    if (!client.redirectUris.includes(params.redirect_uri)) throw badRequest("redirect_uri is not registered");
    const resource = requestedMcpResource(params.resource);
    const grantedScopes = scopes(params.scope);
    const code = token("kanera_code");
    // Grant and its authorization code are written together so a mid-write failure cannot leave an
    // orphaned grant with no code (which would show up as a phantom connection in /me/oauth-connections).
    await db.transaction(async (tx) => {
      const [grant] = await tx.insert(oauthGrants).values({
        clientId: client.clientId,
        userId: req.auth.sub,
        orgClientId: req.auth.cid,
        scopes: grantedScopes,
        resource,
      }).returning();
      await tx.insert(oauthAuthorizationCodes).values({
        codeHash: code.hash,
        clientId: client.clientId,
        grantId: grant!.id,
        redirectUri: params.redirect_uri,
        codeChallenge: params.code_challenge,
        scopes: grantedScopes,
        resource,
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
