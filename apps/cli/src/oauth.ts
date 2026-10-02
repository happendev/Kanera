import { hostname } from "node:os";
import { readConfig, validateEndpointUrl, withConfigLock, writeConfig, type Credential, type OAuthProfile } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import type { ToolSessionOptions } from "./tools.js";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// offline_access is what earns a refresh token; without it a CLI sign-in would last 15 minutes.
const SCOPES = "kanera:read kanera:write offline_access";
/** Refresh this long before expiry so a token never lapses between the check and the request. */
const REFRESH_MARGIN_MS = 60_000;
const SLOW_DOWN_SECONDS = 5;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OAuthDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultDeps: OAuthDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface DiscoveredServer {
  mcpUrl: string;
  resource: string;
  issuer: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function getJson(deps: OAuthDeps, url: string, what: string): Promise<Response> {
  try {
    return await deps.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new CliError(`could not reach ${what} at ${url}: ${error instanceof Error ? error.message : String(error)}`, EXIT.failed);
  }
}

async function postForm(deps: OAuthDeps, url: string, body: Record<string, string>): Promise<Response> {
  try {
    return await deps.fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CliError(`could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`, EXIT.failed);
  }
}

/** RFC 8414 / RFC 9728 well-known URL: the suffix is inserted before any path on the identifier. */
function wellKnown(identifier: string, suffix: string): string {
  const url = new URL(identifier);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  return `${url.origin}/.well-known/${suffix}${path}`;
}

function sameIdentifier(left: string, right: string): boolean {
  return left.replace(/\/+$/u, "") === right.replace(/\/+$/u, "");
}

/**
 * Find the authorization server through the MCP endpoint's protected-resource metadata, the same
 * discovery an MCP client performs. Starting from the MCP URL rather than the public API origin
 * matters for self-hosted installs: the token's `resource` must be the MCP URL the server was
 * configured with, and only that server can say what it is.
 */
export async function discover(mcpUrlInput: string, deps: OAuthDeps = defaultDeps): Promise<DiscoveredServer> {
  const mcpUrl = validateEndpointUrl(mcpUrlInput, "Kanera MCP URL");
  let response = await getJson(deps, wellKnown(mcpUrl, "oauth-protected-resource"), "the Kanera MCP server");
  if (response.status === 404) response = await getJson(deps, wellKnown(new URL(mcpUrl).origin, "oauth-protected-resource"), "the Kanera MCP server");
  if (!response.ok) {
    throw new CliError(`${mcpUrl} did not publish OAuth metadata (HTTP ${response.status})`, EXIT.failed, "Check the MCP URL, or sign in with --with-api-key.");
  }
  const resourceMetadata = await response.json() as { resource?: unknown; authorization_servers?: unknown };
  const resource = typeof resourceMetadata.resource === "string" ? resourceMetadata.resource : undefined;
  const issuer = Array.isArray(resourceMetadata.authorization_servers) && typeof resourceMetadata.authorization_servers[0] === "string"
    ? resourceMetadata.authorization_servers[0]
    : undefined;
  if (!resource || !issuer) throw new CliError(`${mcpUrl} returned incomplete OAuth metadata`, EXIT.failed);
  // RFC 9728 §3.3: metadata for a different resource than the one asked about must be rejected,
  // otherwise a misconfigured host could have the CLI mint tokens for someone else's server.
  if (new URL(validateEndpointUrl(resource, "OAuth resource")).origin !== new URL(mcpUrl).origin) {
    throw new CliError(`${mcpUrl} advertised OAuth metadata for a different server (${resource})`, EXIT.failed);
  }
  validateEndpointUrl(issuer, "OAuth issuer");

  const asResponse = await getJson(deps, wellKnown(issuer, "oauth-authorization-server"), "the Kanera authorization server");
  if (!asResponse.ok) throw new CliError(`${issuer} did not publish authorization server metadata (HTTP ${asResponse.status})`, EXIT.failed);
  const server = await asResponse.json() as Record<string, unknown>;
  if (typeof server.issuer !== "string" || !sameIdentifier(server.issuer, issuer)) {
    throw new CliError(`authorization server metadata at ${issuer} names a different issuer`, EXIT.failed);
  }
  const endpoint = (key: string, required: boolean) => {
    const value = server[key];
    if (typeof value !== "string") {
      if (required) throw new CliError(`${issuer} does not support ${key.replace(/_/gu, " ")}`, EXIT.failed, "Sign in with --with-api-key instead.");
      return undefined;
    }
    // Every one of these receives a token or a device code, so each is held to the HTTPS rule.
    return validateEndpointUrl(value, `OAuth ${key.replace(/_/gu, " ")}`);
  };
  return {
    mcpUrl,
    resource,
    issuer,
    deviceAuthorizationEndpoint: endpoint("device_authorization_endpoint", true)!,
    tokenEndpoint: endpoint("token_endpoint", true)!,
    registrationEndpoint: endpoint("registration_endpoint", true)!,
    revocationEndpoint: endpoint("revocation_endpoint", false),
  };
}

/**
 * Register a public client for this machine. Each machine gets its own client so the consent screen
 * and Settings -> AI agents name the computer, and revoking one laptop leaves the others signed in.
 */
export async function registerClient(server: DiscoveredServer, deps: OAuthDeps = defaultDeps): Promise<string> {
  let response: Response;
  try {
    response = await deps.fetch(server.registrationEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `Kanera CLI (${hostname()})`.slice(0, 200),
        grant_types: [DEVICE_GRANT_TYPE, "refresh_token"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        scope: SCOPES,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CliError(`could not reach ${server.registrationEndpoint}: ${error instanceof Error ? error.message : String(error)}`, EXIT.failed);
  }
  const body = await response.json().catch(() => ({})) as { client_id?: unknown };
  if (!response.ok || typeof body.client_id !== "string") {
    throw new CliError(`Kanera refused to register the CLI (HTTP ${response.status})`, EXIT.failed);
  }
  return body.client_id;
}

export async function startDeviceAuthorization(server: DiscoveredServer, clientId: string, deps: OAuthDeps = defaultDeps): Promise<DeviceAuthorization> {
  const response = await postForm(deps, server.deviceAuthorizationEndpoint, { client_id: clientId, scope: SCOPES, resource: server.resource });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof body.verification_uri !== "string") {
    throw new CliError(`Kanera did not start device sign-in: ${typeof body.error_description === "string" ? body.error_description : `HTTP ${response.status}`}`, EXIT.failed);
  }
  // The verification page is opened in the user's browser, so it gets the same scheme check as any
  // endpoint: an http:// page off-loopback would put the approval on an interceptable connection.
  const verificationUri = validateEndpointUrl(body.verification_uri, "verification URL");
  const complete = typeof body.verification_uri_complete === "string"
    ? validateEndpointUrl(body.verification_uri_complete, "verification URL")
    : undefined;
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri,
    verificationUriComplete: complete,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 600,
    interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : 5,
  };
}

/**
 * Poll until the user approves or denies (RFC 8628 §3.4-3.5). `slow_down` permanently adds five
 * seconds, as the spec requires; ignoring it makes the server keep answering `slow_down` and the
 * sign-in would never complete.
 */
export async function pollForTokens(
  server: DiscoveredServer,
  clientId: string,
  device: DeviceAuthorization,
  deps: OAuthDeps = defaultDeps,
): Promise<OAuthProfile> {
  const deadline = deps.now() + device.expiresIn * 1000;
  let interval = device.interval;
  for (;;) {
    await deps.sleep(interval * 1000);
    if (deps.now() >= deadline) {
      throw new CliError("the sign-in code expired before it was approved", EXIT.unauthenticated, "Run `kanera auth login` again.");
    }
    const response = await postForm(deps, server.tokenEndpoint, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: device.deviceCode,
      client_id: clientId,
      resource: server.resource,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok) return profileFromTokens(server, clientId, body, deps);
    switch (body.error) {
      case "authorization_pending": continue;
      case "slow_down": interval += SLOW_DOWN_SECONDS; continue;
      case "access_denied": throw new CliError("sign-in was denied in the browser", EXIT.unauthenticated);
      case "expired_token": throw new CliError("the sign-in code expired before it was approved", EXIT.unauthenticated, "Run `kanera auth login` again.");
      default:
        throw new CliError(`sign-in failed: ${typeof body.error_description === "string" ? body.error_description : `HTTP ${response.status}`}`, EXIT.failed);
    }
  }
}

function profileFromTokens(server: Pick<DiscoveredServer, "mcpUrl" | "resource" | "issuer" | "tokenEndpoint" | "revocationEndpoint">, clientId: string, body: Record<string, unknown>, deps: OAuthDeps): OAuthProfile {
  const tokens = body as Partial<TokenResponse>;
  if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") {
    // Without a refresh token the sign-in would silently stop working after 15 minutes.
    throw new CliError("Kanera did not issue a refresh token for the CLI", EXIT.failed, "Sign in with --with-api-key instead.");
  }
  return {
    mcpUrl: server.mcpUrl,
    resource: server.resource,
    issuer: server.issuer,
    tokenEndpoint: server.tokenEndpoint,
    revocationEndpoint: server.revocationEndpoint,
    clientId,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(deps.now() + (typeof tokens.expires_in === "number" ? tokens.expires_in : 900) * 1000).toISOString(),
    refreshToken: tokens.refresh_token,
  };
}

function fresh(profile: OAuthProfile, deps: OAuthDeps): boolean {
  return Date.parse(profile.accessTokenExpiresAt) - REFRESH_MARGIN_MS > deps.now();
}

type OAuthConnection = Pick<OAuthProfile, "mcpUrl" | "resource" | "issuer" | "clientId" | "tokenEndpoint" | "revocationEndpoint">;

function assertConnection(profileName: string, current: OAuthProfile, expected: OAuthConnection): void {
  if (current.mcpUrl !== expected.mcpUrl || current.resource !== expected.resource
    || current.issuer !== expected.issuer || current.clientId !== expected.clientId
    || current.tokenEndpoint !== expected.tokenEndpoint || current.revocationEndpoint !== expected.revocationEndpoint) {
    throw new CliError(`OAuth connection for profile "${profileName}" changed`, EXIT.unauthenticated,
      "Restart the command or reconnect your MCP client to use the new sign-in.");
  }
}

/**
 * Return a usable access token for a stored OAuth profile, refreshing it when it is about to expire.
 * The rotated pair is written to disk before the new access token is used: if the process died
 * after refreshing but before saving, the next run would present the spent refresh token and Kanera
 * would revoke the sign-in.
 */
export async function accessTokenFor(profileName: string, options: { force?: boolean; connection?: OAuthConnection } = {}, deps: OAuthDeps = defaultDeps): Promise<string> {
  const initial = readConfig().profiles[profileName]?.oauth;
  if (!initial) throw new CliError(`profile "${profileName}" is not signed in with OAuth`, EXIT.unauthenticated, "Run `kanera auth login`.");
  const connection = options.connection ?? initial;
  assertConnection(profileName, initial, connection);
  if (!options.force && fresh(initial, deps)) return initial.accessToken;

  return await withConfigLock(async () => {
    // Re-read under the lock: another process may have refreshed while this one waited.
    const config = readConfig();
    const stored = config.profiles[profileName];
    const current = stored?.oauth;
    if (!stored || !current) throw new CliError(`profile "${profileName}" was signed out`, EXIT.unauthenticated, "Run `kanera auth login`.");
    assertConnection(profileName, current, connection);
    if (current.refreshToken !== initial.refreshToken || (!options.force && fresh(current, deps))) return current.accessToken;

    const response = await postForm(deps, current.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: current.clientId,
      resource: current.resource,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        throw new CliError(`Kanera could not refresh the sign-in (HTTP ${response.status})`, EXIT.failed, "Try again shortly.");
      }
      throw new CliError(
        `the Kanera sign-in for profile "${profileName}" has expired or was revoked`,
        EXIT.unauthenticated,
        "Run `kanera auth login` to sign in again.",
      );
    }
    const next = profileFromTokens(current, current.clientId, body, deps);
    stored.oauth = next;
    writeConfig(config);
    return next.accessToken;
  });
}

/**
 * Best-effort server-side sign-out. Revoking the refresh token ends the whole token family, so the
 * connection stops working even if a copy of the config file survives somewhere.
 */
export async function revoke(profile: OAuthProfile, deps: OAuthDeps = defaultDeps): Promise<boolean> {
  if (!profile.revocationEndpoint) return false;
  try {
    const response = await postForm(deps, profile.revocationEndpoint, {
      token: profile.refreshToken,
      token_type_hint: "refresh_token",
      client_id: profile.clientId,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** How to reach the tool layer for a resolved credential. */
export function sessionOptionsFor(credential: Credential): ToolSessionOptions {
  if (credential.kind === "apiKey") return { apiKey: credential.apiKey, publicApiUrl: credential.url };
  // Token rotation may change tokens, but a replacement sign-in must never supply credentials to
  // a transport that is still connected to the previous endpoint or acting for its previous user.
  const connection = { ...credential.oauth };
  return {
    mcpUrl: connection.mcpUrl,
    accessToken: (options) => accessTokenFor(credential.profile, { ...options, connection }),
  };
}
