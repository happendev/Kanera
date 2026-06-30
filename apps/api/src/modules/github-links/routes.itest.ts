import "../../test/setup.integration.js";
import { githubAppInstallations } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, test } from "node:test";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { buildIntegrationServer } from "../../test/integration.js";

type GitHubInstallationResponse = {
  accountLogin: string;
  repositorySelection: string;
  repositories: Array<{ owner: string; name: string; fullName: string; private: boolean }>;
};

const originalEnv = {
  mode: env.KANERA_DEPLOYMENT_MODE,
  appId: env.GITHUB_APP_ID,
  appSlug: env.GITHUB_APP_SLUG,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  env.KANERA_DEPLOYMENT_MODE = originalEnv.mode;
  env.GITHUB_APP_ID = originalEnv.appId;
  env.GITHUB_APP_SLUG = originalEnv.appSlug;
  env.GITHUB_APP_PRIVATE_KEY = originalEnv.privateKey;
  globalThis.fetch = originalFetch;
});

async function signupOwner(app: Awaited<ReturnType<typeof buildIntegrationServer>>, email: string) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "GitHub Org",
      email,
      password: "Abc12345",
      displayName: "GitHub Owner",
    },
  });

  assert.equal(signup.statusCode, 200);
  return signup.json() as { accessToken: string; user: { clientId: string } };
}

function configureHostedGitHubApp() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.GITHUB_APP_ID = "3906152";
  env.GITHUB_APP_SLUG = "kanera-board";
  env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

void test("hosted GitHub App config uses deployment env credentials", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, "hosted-github-config@example.com");
  configureHostedGitHubApp();

  const response = await app.inject({
    method: "GET",
    url: "/clients/me/github-app/config",
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    configured: true,
    installUrl: "https://github.com/apps/kanera-board/installations/new",
    appSlug: "kanera-board",
    source: "env",
    pendingInstallation: true,
  });
});

void test("GitHub link resolver fetches public repositories and issues without an installation token", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, "github-link-resolve-public@example.com");
  const repoUrl = "https://github.com/acme/kanera";
  const issueUrl = "https://github.com/EPPlusSoftware/EPPlus/issues/2392";
  const releaseUrl = "https://github.com/EPPlusSoftware/EPPlus/releases/tag/v8.6.1";

  const requestedPaths: string[] = [];
  const authorizationHeaders: Array<string | null> = [];
  globalThis.fetch = (async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(rawUrl);
    requestedPaths.push(url.pathname + url.search);
    const headers = new Headers(init?.headers);
    authorizationHeaders.push(headers.get("Authorization"));

    if (url.pathname === "/repos/acme/kanera") {
      return Response.json({
        full_name: "acme/kanera",
        name: "kanera",
        private: false,
        description: "Project work, neatly arranged",
        html_url: repoUrl,
        owner: { login: "acme" },
      });
    }
    if (url.pathname === "/repos/EPPlusSoftware/EPPlus/issues/2392") {
      return Response.json({
        number: 2392,
        title: "Support workbook metadata",
        state: "open",
        html_url: issueUrl,
      });
    }
    if (url.pathname === "/repos/EPPlusSoftware/EPPlus/releases/tags/v8.6.1") {
      return Response.json({
        tag_name: "v8.6.1",
        name: "EPPlus 8.6.1",
        draft: false,
        prerelease: false,
        published_at: "2026-06-01T12:00:00Z",
        html_url: releaseUrl,
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const response = await app.inject({
    method: "POST",
    url: "/github-links/resolve",
    headers: { authorization: `Bearer ${owner.accessToken}` },
    payload: { urls: [repoUrl, issueUrl, releaseUrl] },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual([...requestedPaths].sort(), [
    "/repos/EPPlusSoftware/EPPlus/issues/2392",
    "/repos/EPPlusSoftware/EPPlus/releases/tags/v8.6.1",
    "/repos/acme/kanera",
  ]);
  assert.deepEqual(authorizationHeaders, [null, null, null]);
  assert.deepEqual(response.json(), {
    links: {
      [repoUrl]: {
        kind: "repo",
        owner: "acme",
        repo: "kanera",
        fullName: "acme/kanera",
        title: "acme/kanera",
        description: "Project work, neatly arranged",
        private: false,
        href: repoUrl,
      },
      [issueUrl]: {
        kind: "issue",
        owner: "EPPlusSoftware",
        repo: "EPPlus",
        fullName: "EPPlusSoftware/EPPlus",
        number: 2392,
        title: "Support workbook metadata",
        state: "open",
        href: issueUrl,
      },
      [releaseUrl]: {
        kind: "release",
        owner: "EPPlusSoftware",
        repo: "EPPlus",
        fullName: "EPPlusSoftware/EPPlus",
        tagName: "v8.6.1",
        title: "EPPlus 8.6.1",
        state: "released",
        publishedAt: "2026-06-01T12:00:00Z",
        href: releaseUrl,
      },
    },
  });
});

void test("hosted org admins can complete and disconnect their GitHub App installation", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, "hosted-github-install@example.com");
  configureHostedGitHubApp();

  const requestedPaths: string[] = [];
  globalThis.fetch = (async (input) => {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(rawUrl);
    requestedPaths.push(url.pathname + url.search);
    if (url.pathname === "/app/installations/12345") {
      return Response.json({
        id: 12345,
        account: { login: "acme", type: "Organization" },
        repository_selection: "selected",
      });
    }
    if (url.pathname === "/app/installations/12345/access_tokens") {
      return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.pathname === "/installation/repositories") {
      return Response.json({
        repositories: [
          { name: "private-repo", full_name: "acme/private-repo", private: true, owner: { login: "acme" } },
        ],
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const complete = await app.inject({
    method: "POST",
    url: "/clients/me/github-app/installation",
    headers: { authorization: `Bearer ${owner.accessToken}` },
    payload: { installationId: "12345" },
  });

  assert.equal(complete.statusCode, 200);
  const completedInstallation = complete.json<GitHubInstallationResponse>();
  assert.equal(completedInstallation.accountLogin, "acme");
  assert.equal(completedInstallation.repositorySelection, "selected");
  assert.deepEqual(completedInstallation.repositories, [
    { owner: "acme", name: "private-repo", fullName: "acme/private-repo", private: true },
  ]);
  assert.deepEqual(requestedPaths, [
    "/app/installations/12345",
    "/app/installations/12345/access_tokens",
    "/installation/repositories?per_page=100",
  ]);

  const [stored] = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.clientId, owner.user.clientId))
    .limit(1);
  assert.equal(stored?.installationId, "12345");

  const installation = await app.inject({
    method: "GET",
    url: "/clients/me/github-app/installation",
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(installation.statusCode, 200);
  assert.equal(installation.json<GitHubInstallationResponse>().accountLogin, "acme");

  const disconnect = await app.inject({
    method: "DELETE",
    url: "/clients/me/github-app/installation",
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(disconnect.statusCode, 204);

  const rows = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.clientId, owner.user.clientId));
  assert.equal(rows.length, 0);
});

void test("hosted mode still blocks GitHub App credential bootstrap routes", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, "hosted-github-manifest@example.com");
  configureHostedGitHubApp();

  const createManifest = await app.inject({
    method: "POST",
    url: "/clients/me/github-app/manifest",
    headers: { authorization: `Bearer ${owner.accessToken}` },
    payload: { accountLogin: "acme" },
  });
  assert.equal(createManifest.statusCode, 400);

  const completeManifest = await app.inject({
    method: "POST",
    url: "/clients/me/github-app/manifest/complete",
    headers: { authorization: `Bearer ${owner.accessToken}` },
    payload: { code: "manifest-code", state: `${owner.user.clientId}:state` },
  });
  assert.equal(completeManifest.statusCode, 400);

  const forgetApp = await app.inject({
    method: "DELETE",
    url: "/clients/me/github-app",
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(forgetApp.statusCode, 400);
});
