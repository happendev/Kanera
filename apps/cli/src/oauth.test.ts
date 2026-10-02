import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, removeProfile, resolveCredential, saveProfile, withConfigLock, writeConfig, type OAuthProfile } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { accessTokenFor, defaultDeps, discover, pollForTokens, sessionOptionsFor, type DiscoveredServer, type OAuthDeps } from "./oauth.js";

/*
 * e2e/cli-oauth.spec.ts covers the sign-in end to end against the real server: approval, denial,
 * refresh and rotation persistence, concurrent refresh, and logout. These isolated tests cover the
 * failures a well-behaved local server never produces, so E2E cannot reach them:
 *
 * - Polling ignores `slow_down`: the server keeps answering slow_down and sign-in never completes.
 * - Polling past the code's lifetime: the CLI hangs instead of telling the user to start again.
 * - Metadata names an http:// endpoint off-loopback: device codes and tokens cross the network in
 *   clear text.
 * - Resource metadata describes another origin's server: tokens are minted for the wrong resource.
 * - Authorization server metadata names a different issuer (RFC 8414 §3.3 mix-up defence).
 */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeDeps(handler: (url: string, init?: RequestInit) => Response): OAuthDeps & { slept: number[] } {
  let clock = 0;
  const slept: number[] = [];
  return {
    slept,
    fetch: async (input, init) => handler(String(input), init),
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    now: () => clock,
  };
}

const server: DiscoveredServer = {
  mcpUrl: "https://mcp.example.test/mcp",
  resource: "https://mcp.example.test/mcp",
  issuer: "https://api.example.test",
  deviceAuthorizationEndpoint: "https://api.example.test/oauth/device/code",
  tokenEndpoint: "https://api.example.test/oauth/token",
  registrationEndpoint: "https://api.example.test/oauth/register",
};

const device = { deviceCode: "kanera_device_x", userCode: "ABCD-EFGH", verificationUri: "https://board.example.test/oauth/device", expiresIn: 600, interval: 5 };

void test("device polling backs off permanently on slow_down and completes", async () => {
  const replies = [
    json(400, { error: "authorization_pending" }),
    json(400, { error: "slow_down" }),
    json(400, { error: "authorization_pending" }),
    json(200, { access_token: "kanera_mcp_a", refresh_token: "kanera_refresh_a", expires_in: 900 }),
  ];
  const deps = fakeDeps(() => replies.shift()!);
  const profile = await pollForTokens(server, "client", device, deps);
  assert.equal(profile.refreshToken, "kanera_refresh_a");
  assert.deepEqual(deps.slept, [5000, 5000, 10000, 10000]);
});

void test("device polling stops when the code's lifetime is over", async () => {
  const deps = fakeDeps(() => json(400, { error: "authorization_pending" }));
  await assert.rejects(pollForTokens(server, "client", { ...device, expiresIn: 12 }, deps), (error: unknown) =>
    error instanceof CliError && error.exitCode === EXIT.unauthenticated && error.message.includes("expired"));
});

function metadata(overrides: { resource?: Record<string, unknown>; authorization?: Record<string, unknown> }) {
  return fakeDeps((url) => {
    if (url.includes("oauth-protected-resource")) {
      return json(200, { resource: "https://mcp.example.test/mcp", authorization_servers: ["https://api.example.test"], ...overrides.resource });
    }
    return json(200, {
      issuer: "https://api.example.test",
      device_authorization_endpoint: "https://api.example.test/oauth/device/code",
      token_endpoint: "https://api.example.test/oauth/token",
      registration_endpoint: "https://api.example.test/oauth/register",
      ...overrides.authorization,
    });
  });
}

void test("discovery accepts consistent HTTPS metadata", async () => {
  const found = await discover("https://mcp.example.test/mcp", metadata({}));
  assert.equal(found.resource, "https://mcp.example.test/mcp");
  assert.equal(found.tokenEndpoint, "https://api.example.test/oauth/token");
});

void test("discovery refuses an insecure token endpoint", async () => {
  await assert.rejects(discover("https://mcp.example.test/mcp", metadata({ authorization: { token_endpoint: "http://api.example.test/oauth/token" } })), /insecure/u);
});

void test("discovery refuses metadata for another server's resource", async () => {
  await assert.rejects(discover("https://mcp.example.test/mcp", metadata({ resource: { resource: "https://evil.example.test/mcp" } })), /different server/u);
});

void test("discovery refuses authorization server metadata for another issuer", async () => {
  await assert.rejects(discover("https://mcp.example.test/mcp", metadata({ authorization: { issuer: "https://evil.example.test" } })), /different issuer/u);
});

/* These races need deterministic pauses inside refresh and lock acquisition. Browser E2E covers
 * the real flow but cannot reliably force these schedules. Concrete failures covered here:
 * - Refresh overwrites a concurrent API-key login, profile replacement or logout.
 * - A long-lived session sends a replacement connection's token to its previous endpoint/user.
 * - A profile changes while a refresh waits for the lock and escapes the initial identity check.
 * - Normal rotation is mistaken for a replacement connection, breaking long-lived sessions.
 */
async function withTestConfig(work: () => Promise<void>) {
  const previous = process.env.XDG_CONFIG_HOME;
  const home = mkdtempSync(join(tmpdir(), "kanera-oauth-regression-"));
  process.env.XDG_CONFIG_HOME = home;
  try { await work(); } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

function storedOAuth(): OAuthProfile {
  return { ...server, clientId: "client", accessToken: "old-access", refreshToken: "old-refresh", accessTokenExpiresAt: new Date(0).toISOString() };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

void test("refresh preserves concurrent profile saves and logout revokes the rotated token", async () => {
  await withTestConfig(async () => {
    await saveProfile("default", { oauth: storedOAuth() }, true);
    const session = sessionOptionsFor(resolveCredential({ profileFlag: "default" }));
    assert.ok("mcpUrl" in session);
    const started = gate();
    const release = gate();
    const refreshing = accessTokenFor("default", {}, {
      ...defaultDeps,
      fetch: async () => {
        started.resolve();
        await release.promise;
        return json(200, { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 900 });
      },
    });
    await started.promise;
    const saving = saveProfile("api-key", { apiKey: "kanera_test_key" }, false);
    release.resolve();
    assert.equal(await refreshing, "rotated-access");
    await saving;
    assert.equal(readConfig().profiles["api-key"]?.apiKey, "kanera_test_key");
    assert.equal(await session.accessToken(), "rotated-access", "a normal rotation keeps the session usable");

    const logoutStarted = gate();
    const logoutRelease = gate();
    const removing = removeProfile("default", async (profile) => {
      assert.equal(profile.oauth?.refreshToken, "rotated-refresh");
      logoutStarted.resolve();
      await logoutRelease.promise;
    });
    await logoutStarted.promise;
    const forcedRefresh = session.accessToken({ force: true });
    // Attach the rejection assertion before releasing the lock, avoiding an unhandled rejection.
    const signedOut = assert.rejects(forcedRefresh, /signed out/u);
    logoutRelease.resolve();
    assert.equal(await removing, true);
    await signedOut;
    assert.equal(readConfig().profiles.default, undefined);
    assert.equal(readConfig().profiles["api-key"]?.apiKey, "kanera_test_key");
  });
});

void test("running sessions reject replacement connections before returning any token", async () => {
  await withTestConfig(async () => {
    const original = { ...storedOAuth(), accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString() };
    const changes: Partial<OAuthProfile>[] = [
      { mcpUrl: "https://other.example/mcp" }, { resource: "https://other.example/mcp" },
      { issuer: "https://other.example" }, { clientId: "another-user-login" },
      { tokenEndpoint: "https://other.example/token" }, { revocationEndpoint: "https://other.example/revoke" },
    ];
    for (const change of changes) {
      await saveProfile("default", { oauth: original }, true);
      const session = sessionOptionsFor(resolveCredential({ profileFlag: "default" }));
      assert.ok("mcpUrl" in session);
      await saveProfile("default", { oauth: { ...original, ...change, accessToken: "replacement-secret" } }, true);
      await assert.rejects(session.accessToken(), (error: unknown) =>
        error instanceof CliError && error.exitCode === EXIT.unauthenticated && error.message.includes("changed"));
    }
  });
});

void test("refresh rechecks connection identity after waiting for the config lock", async () => {
  await withTestConfig(async () => {
    await saveProfile("default", { oauth: storedOAuth() }, true);
    const session = sessionOptionsFor(resolveCredential({ profileFlag: "default" }));
    assert.ok("mcpUrl" in session);
    const locked = gate();
    const release = gate();
    const replacing = withConfigLock(async () => {
      locked.resolve();
      await release.promise;
      const config = readConfig();
      config.profiles.default!.oauth = { ...storedOAuth(), clientId: "replacement" };
      writeConfig(config);
    });
    await locked.promise;
    const rejected = assert.rejects(session.accessToken(), /connection.*changed/u);
    release.resolve();
    await replacing;
    await rejected;
  });
});

void test("replacement login and logout wait for an in-flight refresh and keep its latest token", async () => {
  for (const action of ["replace", "logout"] as const) {
    await withTestConfig(async () => {
      await saveProfile("default", { oauth: storedOAuth() }, true);
      const started = gate();
      const release = gate();
      const refreshing = accessTokenFor("default", {}, {
        ...defaultDeps,
        fetch: async () => {
          started.resolve();
          await release.promise;
          return json(200, { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 900 });
        },
      });
      await started.promise;
      let tokenToRevoke: string | undefined;
      const mutation = action === "replace"
        ? saveProfile("default", { apiKey: "replacement-key" }, true).then((previous) => {
          tokenToRevoke = previous?.oauth?.refreshToken;
        })
        : removeProfile("default", async (profile) => { tokenToRevoke = profile.oauth?.refreshToken; });
      release.resolve();
      await refreshing;
      await mutation;
      assert.equal(tokenToRevoke, "rotated-refresh");
      assert.equal(readConfig().profiles.default?.oauth, undefined);
      assert.equal(readConfig().profiles.default?.apiKey, action === "replace" ? "replacement-key" : undefined);
    });
  }
});
