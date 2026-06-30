import type { GitHubInstalledRepository } from "@kanera/shared/schema";
import { createPrivateKey, sign } from "node:crypto";
import { env } from "../env.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const TOKEN_REFRESH_SKEW_MS = 60_000; // 60 seconds

type TokenCacheEntry = { token: string; expiresAtMs: number };
const installationTokenCache = new Map<string, TokenCacheEntry>();

export type GitHubAppCredentials = {
  appId: string;
  appSlug: string;
  privateKey: string;
};

export type GitHubInstallationInfo = {
  installationId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  repositories: GitHubInstalledRepository[];
};

export function githubAppConfigured(): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_PRIVATE_KEY);
}

export function envGitHubAppCredentials(): GitHubAppCredentials | null {
  if (!githubAppConfigured()) return null;
  return {
    appId: env.GITHUB_APP_ID!,
    appSlug: env.GITHUB_APP_SLUG!,
    privateKey: env.GITHUB_APP_PRIVATE_KEY!,
  };
}

export function githubAppInstallUrl(credentials: Pick<GitHubAppCredentials, "appSlug"> | null = envGitHubAppCredentials()): string | null {
  return credentials?.appSlug ? `https://github.com/apps/${encodeURIComponent(credentials.appSlug)}/installations/new` : null;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function githubPrivateKey(credentials: GitHubAppCredentials): string {
  return credentials.privateKey.replace(/\\n/g, "\n");
}

export function createGitHubAppJwt(credentials = envGitHubAppCredentials(), nowMs = Date.now()): string {
  if (!credentials) {
    throw new Error("GitHub App is not configured");
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: credentials.appId,
  });
  const body = `${header}.${payload}`;
  const key = createPrivateKey(githubPrivateKey(credentials));
  const signature = sign("RSA-SHA256", Buffer.from(body), key).toString("base64url");
  return `${body}.${signature}`;
}

async function githubJson<T>(path: string, token?: string, init: RequestInit = {}): Promise<T | null> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);
  headers.set("User-Agent", "Kanera");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${GITHUB_API}${path}`, { ...init, headers });
  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

export async function createInstallationAccessToken(installationId: string, credentials = envGitHubAppCredentials()): Promise<string | null> {
  if (!credentials) return null;

  const cacheKey = `${credentials.appId}:${installationId}`;
  const cached = installationTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) return cached.token;

  const jwt = createGitHubAppJwt(credentials);
  const response = await githubJson<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: "POST" },
  );
  if (!response?.token) return null;

  installationTokenCache.set(cacheKey, {
    token: response.token,
    expiresAtMs: new Date(response.expires_at).getTime(),
  });
  return response.token;
}

type GitHubInstallationApiResponse = {
  id: number;
  account?: { login?: string; type?: string };
  repository_selection?: string;
};

type GitHubInstallationRepositoriesResponse = {
  repositories?: Array<{
    name: string;
    full_name: string;
    private: boolean;
    owner?: { login?: string };
  }>;
};

export async function loadInstallationInfo(installationId: string, credentials = envGitHubAppCredentials()): Promise<GitHubInstallationInfo | null> {
  if (!credentials) return null;
  const appJwt = createGitHubAppJwt(credentials);
  const installation = await githubJson<GitHubInstallationApiResponse>(`/app/installations/${installationId}`, appJwt);
  if (!installation?.account?.login) return null;

  const token = await createInstallationAccessToken(installationId, credentials);
  const reposResponse = token
    ? await githubJson<GitHubInstallationRepositoriesResponse>("/installation/repositories?per_page=100", token)
    : null;
  const repositories = (reposResponse?.repositories ?? []).map((repo) => ({
    owner: repo.owner?.login ?? repo.full_name.split("/")[0] ?? installation.account!.login!,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
  }));

  return {
    installationId: String(installation.id),
    accountLogin: installation.account.login,
    accountType: installation.account.type ?? "Organization",
    repositorySelection: installation.repository_selection ?? "selected",
    repositories,
  };
}

export async function githubApi<T>(path: string, token?: string): Promise<T | null> {
  return githubJson<T>(path, token);
}

export type GitHubManifestConversionResponse = {
  id: number;
  slug: string;
  pem: string;
  webhook_secret?: string;
  html_url?: string;
};

export async function convertGitHubManifest(code: string): Promise<GitHubManifestConversionResponse | null> {
  return githubJson<GitHubManifestConversionResponse>(`/app-manifests/${encodeURIComponent(code)}/conversions`, undefined, {
    method: "POST",
  });
}
