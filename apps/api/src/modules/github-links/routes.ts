import { dto } from "@kanera/shared";
import { githubApp, githubAppInstallations } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertOrgRole, assertWorkspaceAccess } from "../../lib/access.js";
import { badRequest, notFound } from "../../lib/errors.js";
import {
  createInstallationAccessToken,
  convertGitHubManifest,
  envGitHubAppCredentials,
  type GitHubAppCredentials,
  githubApi,
  githubAppConfigured,
  githubAppInstallUrl,
  loadInstallationInfo,
} from "../../lib/github-app.js";
import { decryptSecret, encryptSecret } from "../../lib/secrets.js";

const MAX_URLS = 50;
const REPO_PATH_RE = /^\/([^/]+)\/([^/]+)\/?$/;
const PULL_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
const ISSUE_PATH_RE = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;
const RELEASE_TAG_PATH_RE = /^\/([^/]+)\/([^/]+)\/releases\/tag\/(.+?)\/?$/;
const COMMIT_PATH_RE = /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-fA-F]{7,40})\/?$/;

type ParsedGitHubUrl =
  | { kind: "repo"; owner: string; repo: string; href: string }
  | { kind: "pull"; owner: string; repo: string; number: number; href: string }
  | { kind: "issue"; owner: string; repo: string; number: number; href: string }
  | { kind: "release"; owner: string; repo: string; tag: string; href: string }
  | { kind: "commit"; owner: string; repo: string; sha: string; href: string };

function parseGitHubUrl(raw: string): ParsedGitHubUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;

  const path = url.pathname;
  const pull = PULL_PATH_RE.exec(path);
  if (pull) {
    const [, owner, repo, number] = pull;
    return { kind: "pull", owner: owner!, repo: repo!, number: Number(number), href: url.href };
  }

  const issue = ISSUE_PATH_RE.exec(path);
  if (issue) {
    const [, owner, repo, number] = issue;
    return { kind: "issue", owner: owner!, repo: repo!, number: Number(number), href: url.href };
  }

  const release = RELEASE_TAG_PATH_RE.exec(path);
  if (release) {
    const [, owner, repo, tag] = release;
    return { kind: "release", owner: owner!, repo: repo!, tag: decodeURIComponent(tag!), href: url.href };
  }

  const commit = COMMIT_PATH_RE.exec(path);
  if (commit) {
    const [, owner, repo, sha] = commit;
    return { kind: "commit", owner: owner!, repo: repo!, sha: sha!, href: url.href };
  }

  const repo = REPO_PATH_RE.exec(path);
  if (repo) {
    const [, owner, name] = repo;
    return { kind: "repo", owner: owner!, repo: name!, href: url.href };
  }

  return null;
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

function repoCovered(
  installation: Pick<typeof githubAppInstallations.$inferSelect, "accountLogin" | "repositorySelection" | "repositories">,
  owner: string,
  repo: string,
): boolean {
  if (installation.accountLogin.toLowerCase() === owner.toLowerCase()) return true;
  const fullName = `${owner}/${repo}`.toLowerCase();
  return installation.repositories.some((item) => item.fullName.toLowerCase() === fullName);
}

type GitHubAppRow = typeof githubApp.$inferSelect;

function credentialsForApp(row: GitHubAppRow): GitHubAppCredentials {
  return {
    appId: decryptSecret(row.encryptedAppId),
    appSlug: row.appSlug,
    privateKey: decryptSecret(row.encryptedPrivateKey),
  };
}

async function deploymentApp(): Promise<GitHubAppRow | null> {
  const [row] = await db.select().from(githubApp).limit(1);
  return row ?? null;
}

/**
 * Resolve the deployment's GitHub App credentials. Env vars always win; the manifest
 * bootstrap row is the fallback used by self-hosted deployments. Returns the resolved
 * credentials together with where they came from so the UI can hide the bootstrap form.
 */
async function loadDeploymentCredentials(): Promise<{ credentials: GitHubAppCredentials; source: "env" | "manifest" } | null> {
  const envCredentials = envGitHubAppCredentials();
  if (envCredentials) return { credentials: envCredentials, source: "env" };
  const row = await deploymentApp();
  if (row) return { credentials: credentialsForApp(row), source: "manifest" };
  return null;
}

type GitHubRepoResponse = {
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  owner: { login: string };
};

type GitHubPullResponse = {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at?: string | null;
  changed_files?: number | null;
  additions?: number | null;
  deletions?: number | null;
  html_url: string;
  base?: { repo?: { full_name?: string; owner?: { login?: string }; name?: string } };
};

type GitHubIssueResponse = {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  repository_url?: string;
};

type GitHubReleaseResponse = {
  tag_name: string;
  name: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  html_url: string;
};

type GitHubCommitResponse = {
  sha: string;
  html_url: string;
  commit?: { message?: string };
  stats?: { additions?: number; deletions?: number };
  files?: unknown[];
  repository?: { full_name?: string; owner?: { login?: string }; name?: string };
};

async function resolveGitHubLink(parsed: ParsedGitHubUrl, token?: string): Promise<dto.ResolvedGitHubLink | null> {
  const owner = encodePathPart(parsed.owner);
  const repo = encodePathPart(parsed.repo);

  if (parsed.kind === "repo") {
    const response = await githubApi<GitHubRepoResponse>(`/repos/${owner}/${repo}`, token);
    if (!response) return null;
    return {
      kind: "repo",
      owner: response.owner.login,
      repo: response.name,
      fullName: response.full_name,
      title: response.full_name,
      description: response.description,
      private: response.private,
      href: response.html_url,
    };
  }

  if (parsed.kind === "pull") {
    const response = await githubApi<GitHubPullResponse>(`/repos/${owner}/${repo}/pulls/${parsed.number}`, token);
    if (!response) return null;
    const resolvedOwner = response.base?.repo?.owner?.login ?? parsed.owner;
    const resolvedRepo = response.base?.repo?.name ?? parsed.repo;
    return {
      kind: "pull",
      owner: resolvedOwner,
      repo: resolvedRepo,
      fullName: response.base?.repo?.full_name ?? `${resolvedOwner}/${resolvedRepo}`,
      number: response.number,
      title: response.title,
      state: response.draft ? "draft" : response.merged_at ? "merged" : response.state,
      changedFiles: response.changed_files ?? null,
      additions: response.additions ?? null,
      deletions: response.deletions ?? null,
      href: response.html_url,
    };
  }

  if (parsed.kind === "issue") {
    const response = await githubApi<GitHubIssueResponse>(`/repos/${owner}/${repo}/issues/${parsed.number}`, token);
    if (!response) return null;
    return {
      kind: "issue",
      owner: parsed.owner,
      repo: parsed.repo,
      fullName: `${parsed.owner}/${parsed.repo}`,
      number: response.number,
      title: response.title,
      state: response.state,
      href: response.html_url,
    };
  }

  if (parsed.kind === "release") {
    const response = await githubApi<GitHubReleaseResponse>(`/repos/${owner}/${repo}/releases/tags/${encodePathPart(parsed.tag)}`, token);
    if (!response) return null;
    const title = response.name?.trim() || response.tag_name;
    return {
      kind: "release",
      owner: parsed.owner,
      repo: parsed.repo,
      fullName: `${parsed.owner}/${parsed.repo}`,
      tagName: response.tag_name,
      title,
      state: response.draft ? "draft" : response.prerelease ? "prerelease" : "released",
      publishedAt: response.published_at ?? null,
      href: response.html_url,
    };
  }

  const response = await githubApi<GitHubCommitResponse>(`/repos/${owner}/${repo}/commits/${encodePathPart(parsed.sha)}`, token);
  if (!response) return null;
  const title = (response.commit?.message ?? response.sha).split("\n")[0]?.trim() || response.sha;
  return {
    kind: "commit",
    owner: response.repository?.owner?.login ?? parsed.owner,
    repo: response.repository?.name ?? parsed.repo,
    fullName: response.repository?.full_name ?? `${parsed.owner}/${parsed.repo}`,
    sha: response.sha,
    shortSha: response.sha.slice(0, 7),
    title,
    changedFiles: response.files?.length ?? null,
    additions: response.stats?.additions ?? null,
    deletions: response.stats?.deletions ?? null,
    href: response.html_url,
  };
}

function shapeInstallation(row: typeof githubAppInstallations.$inferSelect): dto.GitHubAppInstallationRow {
  return {
    id: row.id,
    clientId: row.clientId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: row.repositorySelection,
    repositories: row.repositories,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function installationForClient(clientId: string) {
  const [row] = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.clientId, clientId))
    .limit(1);
  return row ?? null;
}

export async function githubLinkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/clients/me/github-app/config", async (req): Promise<dto.GitHubAppConfigResponse> => {
    assertOrgRole(req.auth, "admin");
    const resolved = await loadDeploymentCredentials();
    if (!resolved) {
      return { configured: false, installUrl: null, appSlug: null, source: null };
    }
    const installation = await installationForClient(req.auth.cid);
    return {
      configured: true,
      installUrl: githubAppInstallUrl(resolved.credentials),
      appSlug: resolved.credentials.appSlug,
      source: resolved.source,
      pendingInstallation: !installation,
    };
  });

  app.post("/clients/me/github-app/manifest", async (req): Promise<dto.GitHubManifestResponse> => {
    assertOrgRole(req.auth, "admin");
    if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
      throw badRequest("GitHub App setup is managed by the hosted deployment");
    }
    const body = dto.createGitHubManifestBody.parse(req.body);
    const state = `${req.auth.cid}:${randomUUID()}`;
    const settingsUrl = `${env.WEB_ORIGIN}/settings/org`;
    const manifest = {
      name: `Kanera ${body.accountLogin}`,
      url: env.WEB_ORIGIN,
      redirect_url: settingsUrl,
      setup_url: settingsUrl,
      setup_on_update: true,
      public: false,
      default_permissions: {
        metadata: "read",
        contents: "read",
        pull_requests: "read",
      },
      default_events: [],
    };

    const action = new URL(`https://github.com/organizations/${encodeURIComponent(body.accountLogin)}/settings/apps/new`);
    action.searchParams.set("state", state);

    return {
      actionUrl: action.toString(),
      manifest: JSON.stringify(manifest),
      state,
    };
  });

  app.post("/clients/me/github-app/manifest/complete", async (req): Promise<dto.GitHubAppConfigResponse> => {
    assertOrgRole(req.auth, "admin");
    if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
      throw badRequest("GitHub App setup is managed by the hosted deployment");
    }
    if (githubAppConfigured()) throw badRequest("GitHub App is already configured through the deployment environment");
    const body = dto.completeGitHubManifestBody.parse(req.body);
    if (body.state && !body.state.startsWith(`${req.auth.cid}:`)) throw badRequest("GitHub manifest state did not match this organisation");

    const converted = await convertGitHubManifest(body.code);
    if (!converted?.id || !converted.slug || !converted.pem) throw badRequest("GitHub App manifest could not be completed");

    const now = new Date();
    const values = {
      encryptedAppId: encryptSecret(String(converted.id)),
      appSlug: converted.slug,
      encryptedPrivateKey: encryptSecret(converted.pem),
      encryptedWebhookSecret: converted.webhook_secret ? encryptSecret(converted.webhook_secret) : null,
      updatedAt: now,
    };
    const [row] = await db
      .insert(githubApp)
      .values({ singleton: true, ...values })
      .onConflictDoUpdate({ target: [githubApp.singleton], set: values })
      .returning();
    const credentials = credentialsForApp(row!);
    return {
      configured: true,
      installUrl: githubAppInstallUrl(credentials),
      appSlug: credentials.appSlug,
      source: "manifest",
      pendingInstallation: !(await installationForClient(req.auth.cid)),
    };
  });

  app.get("/clients/me/github-app/installation", async (req): Promise<dto.GitHubAppInstallationRow | null> => {
    assertOrgRole(req.auth, "admin");
    const row = await installationForClient(req.auth.cid);
    return row ? shapeInstallation(row) : null;
  });

  app.post("/clients/me/github-app/installation", async (req): Promise<dto.GitHubAppInstallationRow> => {
    assertOrgRole(req.auth, "admin");
    const resolved = await loadDeploymentCredentials();
    if (!resolved) throw badRequest("GitHub App is not configured");

    const body = dto.completeGitHubInstallationBody.parse(req.body);
    const info = await loadInstallationInfo(body.installationId, resolved.credentials);
    if (!info) throw badRequest("GitHub installation could not be verified");

    const now = new Date();
    const values = {
      installationId: info.installationId,
      accountLogin: info.accountLogin,
      accountType: info.accountType,
      repositorySelection: info.repositorySelection,
      repositories: info.repositories,
      updatedAt: now,
    };
    const [row] = await db
      .insert(githubAppInstallations)
      .values({ clientId: req.auth.cid, ...values })
      .onConflictDoUpdate({ target: [githubAppInstallations.clientId], set: values })
      .returning();
    return shapeInstallation(row!);
  });

  // Disconnect this organisation's installation. The deployment app stays configured.
  app.delete("/clients/me/github-app/installation", async (req, reply) => {
    assertOrgRole(req.auth, "admin");
    const [row] = await db
      .delete(githubAppInstallations)
      .where(eq(githubAppInstallations.clientId, req.auth.cid))
      .returning({ id: githubAppInstallations.id });
    if (!row) throw notFound("GitHub installation not found");
    return reply.status(204).send();
  });

  // Forget the manifest-bootstrapped deployment app. Env-configured deployments cannot
  // forget their app this way; they manage credentials through the environment.
  app.delete("/clients/me/github-app", async (req, reply) => {
    assertOrgRole(req.auth, "admin");
    if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
      throw badRequest("GitHub App setup is managed by the hosted deployment");
    }
    if (githubAppConfigured()) throw badRequest("GitHub App is configured through the deployment environment");
    const [row] = await db.delete(githubApp).returning({ id: githubApp.id });
    if (!row) throw notFound("GitHub App not found");
    return reply.status(204).send();
  });

  app.post("/github-links/resolve", async (req): Promise<dto.ResolveGitHubLinksResponse> => {
    const body = dto.resolveGitHubLinksBody.parse(req.body);
    const uniqueUrls = [...new Set(body.urls)].slice(0, MAX_URLS);
    const links: Record<string, dto.ResolvedGitHubLink> = {};

    let installation: typeof githubAppInstallations.$inferSelect | null = null;
    let credentials: GitHubAppCredentials | null = null;
    if (body.workspaceId) {
      const access = await assertWorkspaceAccess(req.auth, body.workspaceId);
      installation = await installationForClient(access.clientId);
      credentials = (await loadDeploymentCredentials())?.credentials ?? null;
    }

    await Promise.all(uniqueUrls.map(async (raw) => {
      const parsed = parseGitHubUrl(raw);
      if (!parsed) return;

      try {
        let token: string | undefined;
        if (installation && credentials && repoCovered(installation, parsed.owner, parsed.repo)) {
          token = await createInstallationAccessToken(installation.installationId, credentials) ?? undefined;
        }
        const resolved = await resolveGitHubLink(parsed, token) ?? await resolveGitHubLink(parsed);
        if (resolved) links[raw] = resolved;
      } catch {
        // Do not reveal whether private, deleted, rate-limited, or malformed GitHub targets exist.
      }
    }));

    return { links };
  });
}
