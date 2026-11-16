import { decodeIdToken, generateCodeVerifier, generateState, GitHub, Google, MicrosoftEntraId, OAuth2Client, CodeChallengeMethod } from "arctic";
import type { SignInProvider } from "@kanera/shared/schema";
import { env } from "../../env.js";

/** What Kanera keeps from a provider sign-in. Everything else the provider returns is discarded. */
export type ProviderProfile = {
  /** Stable provider account id. The only key an existing link is matched on. */
  subject: string;
  email: string | null;
  /** True only when the provider vouches for the mailbox; otherwise Kanera emails a code first. */
  emailVerified: boolean;
  displayName: string | null;
};

export interface SignInProviderAdapter {
  readonly id: SignInProvider;
  authorizationUrl(state: string, codeVerifier: string): URL;
  exchange(code: string, codeVerifier: string): Promise<ProviderProfile>;
}

export { generateCodeVerifier, generateState };

function providerCallbackUrl(provider: SignInProvider): string {
  // Served through the web origin's /api proxy, the same public path the unsubscribe links use.
  return `${env.API_PUBLIC_URL}/api/auth/providers/${provider}/callback`;
}

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseGoogleClaims(claims: Record<string, unknown>): ProviderProfile {
  const subject = stringClaim(claims, "sub");
  if (!subject) throw new Error("google id token has no subject");
  return {
    subject,
    email: stringClaim(claims, "email"),
    emailVerified: claims.email_verified === true,
    displayName: stringClaim(claims, "name"),
  };
}

export function parseMicrosoftClaims(claims: Record<string, unknown>): ProviderProfile {
  // `sub` is pairwise per app registration; tenant + object id stays stable for the same account
  // if the registration is ever replaced.
  const tenantId = stringClaim(claims, "tid");
  const objectId = stringClaim(claims, "oid");
  if (!tenantId || !objectId) throw new Error("microsoft id token has no tenant/object id");
  return {
    subject: `${tenantId}:${objectId}`,
    email: stringClaim(claims, "email"),
    // Multi-tenant Entra apps receive whatever `email` a tenant admin typed, unverified. Only the
    // optional `xms_edov` claim (the tenant owns the email's domain) makes it safe to link on.
    emailVerified: claims.xms_edov === true || claims.xms_edov === "1" || claims.xms_edov === "true",
    displayName: stringClaim(claims, "name"),
  };
}

type GitHubEmail = { email?: unknown; primary?: unknown; verified?: unknown };

/** GitHub accounts list many addresses; only the primary one GitHub has verified identifies the person. */
export function pickGitHubEmail(emails: GitHubEmail[]): { email: string; verified: boolean } | null {
  const primary = emails.find((entry) => entry.primary === true && typeof entry.email === "string");
  if (!primary) return null;
  return { email: primary.email as string, verified: primary.verified === true };
}

async function githubJson<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "Kanera" },
  });
  if (!response.ok) throw new Error(`github ${path} failed with ${response.status}`);
  return await response.json() as T;
}

function googleAdapter(clientId: string, clientSecret: string): SignInProviderAdapter {
  const client = new Google(clientId, clientSecret, providerCallbackUrl("google"));
  return {
    id: "google",
    authorizationUrl: (state, verifier) => client.createAuthorizationURL(state, verifier, ["openid", "email", "profile"]),
    async exchange(code, verifier) {
      const tokens = await client.validateAuthorizationCode(code, verifier);
      // Received directly from the token endpoint over TLS, so the signature check can be skipped
      // (OIDC Core 3.1.3.7).
      return parseGoogleClaims(decodeIdToken(tokens.idToken()) as Record<string, unknown>);
    },
  };
}

function microsoftAdapter(clientId: string, clientSecret: string): SignInProviderAdapter {
  const client = new MicrosoftEntraId("common", clientId, clientSecret, providerCallbackUrl("microsoft"));
  return {
    id: "microsoft",
    authorizationUrl: (state, verifier) => client.createAuthorizationURL(state, verifier, ["openid", "email", "profile"]),
    async exchange(code, verifier) {
      const tokens = await client.validateAuthorizationCode(code, verifier);
      return parseMicrosoftClaims(decodeIdToken(tokens.idToken()) as Record<string, unknown>);
    },
  };
}

function githubAdapter(clientId: string, clientSecret: string): SignInProviderAdapter {
  const client = new GitHub(clientId, clientSecret, providerCallbackUrl("github"));
  return {
    id: "github",
    // GitHub OAuth Apps do not support PKCE; the state + browser-bound cookie carry the CSRF defence.
    authorizationUrl: (state) => client.createAuthorizationURL(state, ["read:user", "user:email"]),
    async exchange(code) {
      const tokens = await client.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();
      const user = await githubJson<{ id?: unknown; login?: unknown; name?: unknown }>("/user", accessToken);
      if (typeof user.id !== "number" && typeof user.id !== "string") throw new Error("github user has no id");
      const email = pickGitHubEmail(await githubJson<GitHubEmail[]>("/user/emails", accessToken));
      return {
        subject: String(user.id),
        email: email?.email ?? null,
        emailVerified: email?.verified ?? false,
        displayName: typeof user.name === "string" && user.name.trim()
          ? user.name.trim()
          : typeof user.login === "string" ? user.login : null,
      };
    },
  };
}

/**
 * E2E/integration stand-in: a stub OAuth server at KANERA_TEST_OAUTH_ISSUER that speaks plain
 * OAuth 2.0 per provider path and answers `/<provider>/profile` with an already-normalised
 * ProviderProfile. It exercises the real begin → provider → callback → complete flow; each real
 * adapter's claim parsing is covered by unit tests instead.
 */
function stubAdapter(issuer: string, provider: SignInProvider): SignInProviderAdapter {
  const base = `${issuer.replace(/\/$/, "")}/${provider}`;
  const client = new OAuth2Client("kanera-test", "kanera-test-secret", providerCallbackUrl(provider));
  return {
    id: provider,
    authorizationUrl: (state, verifier) =>
      client.createAuthorizationURLWithPKCE(`${base}/authorize`, state, CodeChallengeMethod.S256, verifier, ["openid", "email"]),
    async exchange(code, verifier) {
      const tokens = await client.validateAuthorizationCode(`${base}/token`, code, verifier);
      const response = await fetch(`${base}/profile`, { headers: { Authorization: `Bearer ${tokens.accessToken()}` } });
      if (!response.ok) throw new Error(`stub profile failed with ${response.status}`);
      return await response.json() as ProviderProfile;
    },
  };
}

/**
 * The providers this deployment offers. Sign-in providers are a hosted-only feature: self-hosted
 * returns none even when credentials are present. Read per call so tests can flip the mode.
 */
export function configuredSignInProviders(): SignInProviderAdapter[] {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") return [];
  if (env.KANERA_TEST_OAUTH_ISSUER && env.NODE_ENV !== "production") {
    const issuer = env.KANERA_TEST_OAUTH_ISSUER;
    return (["google", "microsoft", "github"] as const).map((provider) => stubAdapter(issuer, provider));
  }
  const adapters: SignInProviderAdapter[] = [];
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) adapters.push(googleAdapter(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET));
  if (env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET) adapters.push(microsoftAdapter(env.MICROSOFT_OAUTH_CLIENT_ID, env.MICROSOFT_OAUTH_CLIENT_SECRET));
  if (env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET) adapters.push(githubAdapter(env.GITHUB_OAUTH_CLIENT_ID, env.GITHUB_OAUTH_CLIENT_SECRET));
  return adapters;
}

export function signInProviderAdapter(provider: SignInProvider): SignInProviderAdapter | null {
  return configuredSignInProviders().find((adapter) => adapter.id === provider) ?? null;
}
