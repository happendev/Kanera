import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import ports from "./ports.json";
import { expect, test } from "./support/fixtures";
import { boardHref, cardTile, expectBoardLoaded } from "./support/ui";

// The bundled executable npm ships (built by scripts/test-e2e.sh), not the TypeScript sources.
const cli = path.join(__dirname, "..", "apps", "cli", "dist", "kanera.mjs");
const mcpUrl = `http://localhost:${ports.mcp}/mcp`;
const publicApiOrigin = `http://localhost:${ports.publicApi}`;

type Run = { code: number | null; stdout: string; stderr: string };
type StoredProfile = {
  apiKey?: string;
  oauth?: { accessToken: string; accessTokenExpiresAt: string; refreshToken: string; mcpUrl: string };
};

/**
 * Each test gets its own XDG config directory, so the CLI's stored sign-in and refresh lock are
 * isolated from the developer's real ~/.config/kanera and from other tests.
 */
function cliHome() {
  const home = mkdtempSync(path.join(tmpdir(), "kanera-cli-e2e-"));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: home };
  // A credential in the developer's shell would take precedence over the OAuth profile under test.
  delete env.KANERA_API_KEY;
  delete env.KANERA_PROFILE;
  delete env.KANERA_PUBLIC_API_URL;
  delete env.KANERA_MCP_URL;
  const configFile = path.join(home, "kanera", "config.json");
  const rpcLog = path.join(home, "rpc-methods.jsonl");
  const rpcCapture = path.join(home, "capture-rpc.mjs");
  writeFileSync(rpcLog, "");
  // Observe the bundled process's actual HTTP calls without replacing its transport or server.
  // Method names alone prove catalogue reuse and keep credentials/payloads out of the artifact.
  writeFileSync(rpcCapture, `
    import { appendFileSync } from "node:fs";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (typeof init?.body === "string") {
        try {
          const request = JSON.parse(init.body);
          if (typeof request.method === "string") appendFileSync(${JSON.stringify(rpcLog)}, JSON.stringify(request.method) + "\\n");
        } catch { /* Non-RPC request bodies are irrelevant to the catalogue assertion. */ }
      }
      return originalFetch(input, init);
    };
  `);
  return {
    home,
    configFile,
    startMcp: () => spawn(process.execPath, [cli, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] }),
    start: (args: string[]) => spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] }),
    run: (args: string[], captureRpc = false) => finished(spawn(process.execPath, [...(captureRpc ? ["--import", rpcCapture] : []), cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] })),
    rpcMethods: () => readFileSync(rpcLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string),
    profile: (): StoredProfile => (JSON.parse(readFileSync(configFile, "utf8")) as { profiles: Record<string, StoredProfile> }).profiles.default!,
    expireAccessToken: () => {
      // Simulate the 15-minute access token lapsing without waiting for it.
      const config = JSON.parse(readFileSync(configFile, "utf8")) as { profiles: Record<string, StoredProfile> };
      config.profiles.default!.oauth!.accessTokenExpiresAt = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(configFile, JSON.stringify(config));
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function finished(child: ChildProcess): Promise<Run> {
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

/** Wait for `kanera auth login` to print the verification link and code a person would follow. */
async function deviceInstructions(child: ChildProcess): Promise<{ url: string; code: string }> {
  let stderr = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no sign-in instructions; stderr so far:\n${stderr}`)), 30_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const url = /(http\S+\/oauth\/device\?user_code=\S+)/u.exec(stderr)?.[1];
      const code = /code:\s*\n\s*([A-Z0-9]{4}-[A-Z0-9]{4})/u.exec(stderr)?.[1];
      if (url && code) {
        clearTimeout(timer);
        resolve({ url, code });
      }
    });
    child.on("close", (exit) => {
      clearTimeout(timer);
      reject(new Error(`kanera auth login exited (${exit}) before printing instructions:\n${stderr}`));
    });
  });
}

/** Approve or deny on the web consent page, after checking it shows the terminal's code. */
async function decide(page: Page, url: string, code: string, decision: "Allow access" | "Deny") {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: /^Connect Kanera CLI \(/u })).toBeVisible();
  await expect(page.locator(".code")).toHaveText(code);
  await page.getByRole("button", { name: decision }).click();
  await expect(page.getByRole("heading", { name: decision === "Allow access" ? "Device connected" : "Request denied" })).toBeVisible();
}

function json<T>(run: Run): T {
  expect(run.code, `exit ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
  return (JSON.parse(run.stdout) as { data: T }).data;
}

/** Exercise the published stdio bridge as an MCP host, keeping the same process across refresh/login. */
async function mcpRequest(child: ChildProcess, id: number, method: string, params: Record<string, unknown>) {
  return await new Promise<{ result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message: string } }>((resolve, reject) => {
    let buffered = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout!.off("data", receive);
      child.off("close", closed);
    };
    const closed = () => { cleanup(); reject(new Error("MCP bridge exited before responding")); };
    const receive = (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const response = JSON.parse(line) as { id?: number; result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message: string } };
        if (response.id === id) { cleanup(); resolve(response); return; }
      }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`MCP request ${method} timed out`)); }, 15_000);
    child.stdout!.on("data", receive);
    child.on("close", closed);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

test("the CLI signs in with the browser device flow, works on the board, refreshes, and signs out", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const cliEnv = cliHome();
  let bridge: ChildProcess | undefined;
  try {
    await signIn(page, "amelia");
    const boardPath = await boardHref(page, "Platform Delivery");
    const boardId = boardPath.split("/")[2]!;

    const login = cliEnv.start(["auth", "login", "--mcp-url", mcpUrl, "--no-browser", "--json"]);
    const loginDone = finished(login);
    const { url, code } = await deviceInstructions(login);
    expect(url).toContain(`user_code=${code}`);
    await decide(page, url, code, "Allow access");

    const signedIn = json<{ kind: string; mcpUrl: string }>(await loginDone);
    expect(signedIn.kind).toBe("oauth");
    expect(signedIn.mcpUrl).toBe(mcpUrl);
    // The stored sign-in is a refreshable OAuth token, never an API key, and the file is owner-only.
    const stored = cliEnv.profile();
    expect(stored.apiKey).toBeUndefined();
    expect(stored.oauth?.accessToken).toMatch(/^kanera_mcp_/u);
    expect(stored.oauth?.refreshToken).toMatch(/^kanera_refresh_/u);
    expect(statSync(cliEnv.configFile).mode & 0o777).toBe(0o600);

    // The connection is visible to the user under their AI agent connections, named for the machine.
    const app = await apiAs("amelia");
    const connections = async () => (await (await app.get("/api/me/oauth-connections")).json() as { id: string; clientName: string }[])
      .filter((connection) => connection.clientName.startsWith("Kanera CLI ("));
    expect(await connections()).toHaveLength(1);

    bridge = cliEnv.startMcp();
    const initialized = await mcpRequest(bridge, 1, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kanera-e2e", version: "1" },
    });
    expect(initialized.error).toBeUndefined();
    bridge.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const identity = await mcpRequest(bridge, 2, "tools/call", { name: "session.get", arguments: {} });
    expect(identity.error).toBeUndefined();
    expect(identity.result?.isError).not.toBe(true);

    // An OAuth profile has no API key to hand out; printing the MCP token would mislead callers.
    const token = await cliEnv.run(["auth", "token"]);
    expect(token.code).toBe(2);
    expect(token.stdout).toBe("");

    // A write made through the CLI reaches a board a person has open, live.
    // The page is still on the consent screen; open the board directly.
    await page.goto(boardPath);
    await expectBoardLoaded(page, "Platform Delivery");
    const catalogDirectory = path.join(cliEnv.home, "kanera", "tool-cache");
    // OAuth login validates its token with a real tool session, which already warms this cache.
    // Clear only this test's temporary catalogue so the captured command really is a cold read.
    rmSync(catalogDirectory, { recursive: true, force: true });
    const board = json<{ lists: { id: string; name: string }[] }>(await cliEnv.run(["board", boardId, "--json"], true));
    const coldMethods = cliEnv.rpcMethods();
    expect(coldMethods.filter((method) => method === "tools/list")).toHaveLength(1);
    // A second CLI process can reuse the public catalogue, while the live discovery below still
    // enforces token revocation. Inspect wire methods rather than file modification times: a
    // redundant catalogue request is a regression even if a future store skips identical writes.
    // The isolated store tests cover expiry/version/corruption.
    const catalogFiles = readdirSync(catalogDirectory).filter((name) => name.endsWith(".json"));
    expect(catalogFiles).toHaveLength(1);
    const catalogFile = path.join(catalogDirectory, catalogFiles[0]!);
    const catalogText = readFileSync(catalogFile, "utf8");
    expect(catalogText).not.toContain(stored.oauth!.accessToken);
    expect(catalogText).not.toContain(stored.oauth!.refreshToken);
    const listId = board.lists[0]!.id;
    const title = uniqueName("E2E CLI OAuth card");
    json(await cliEnv.run(["card", "create", title, "--boardId", boardId, "--listId", listId, "--json"], true));
    const warmMethods = cliEnv.rpcMethods().slice(coldMethods.length);
    expect(warmMethods.filter((method) => method === "tools/list")).toHaveLength(0);
    expect(warmMethods.filter((method) => method === "server/discover")).toHaveLength(1);
    expect(warmMethods.filter((method) => method === "tools/call")).toHaveLength(1);
    await testInfo.attach("cli-catalogue-wire.json", {
      body: JSON.stringify({ reproduce: "pnpm test:e2e -- cli-oauth.spec.ts", coldMethods, warmMethods, catalogueBytes: Buffer.byteLength(catalogText) }, null, 2),
      contentType: "application/json",
    });
    await expect(cardTile(page, title)).toBeVisible();
    // The same for a write an MCP host makes through the stdio bridge, relayed to the remote server.
    const bridgeTitle = uniqueName("E2E MCP bridge card");
    const bridgeWrite = await mcpRequest(bridge, 10, "tools/call", { name: "cards.create", arguments: { boardId, listId, title: bridgeTitle } });
    expect(bridgeWrite.error).toBeUndefined();
    expect(bridgeWrite.result?.isError).not.toBe(true);
    await expect(cardTile(page, bridgeTitle)).toBeVisible();

    // An expired access token is refreshed transparently, and the rotated refresh token is saved:
    // presenting the spent one later would make Kanera revoke the whole sign-in.
    const beforeRefresh = cliEnv.profile().oauth!.refreshToken;
    cliEnv.expireAccessToken();
    json(await cliEnv.run(["whoami", "--json"]));
    const afterRefresh = cliEnv.profile().oauth!;
    expect(afterRefresh.refreshToken).not.toBe(beforeRefresh);
    expect(Date.parse(afterRefresh.accessTokenExpiresAt)).toBeGreaterThan(Date.now());

    // Agents run commands in parallel. Concurrent refreshes must not present the same refresh token
    // twice, which Kanera treats as theft; every command succeeds and the sign-in survives.
    cliEnv.expireAccessToken();
    const parallel = await Promise.all([1, 2, 3, 4].map(() => cliEnv.run(["whoami", "--json"])));
    for (const run of parallel) json(run);
    json(await cliEnv.run(["whoami", "--json"]));

    // The same bridge accepts ordinary token rotation, but must stop when a new login replaces
    // its connection, even on the same server: that login may represent a different person.
    const refreshedIdentity = await mcpRequest(bridge, 3, "tools/call", { name: "session.get", arguments: {} });
    expect(refreshedIdentity.error).toBeUndefined();
    expect(refreshedIdentity.result?.isError).not.toBe(true);
    const replacement = cliEnv.start(["auth", "login", "--mcp-url", mcpUrl, "--no-browser", "--json"]);
    const replacementDone = finished(replacement);
    const replacementInstructions = await deviceInstructions(replacement);
    await decide(page, replacementInstructions.url, replacementInstructions.code, "Allow access");
    json(await replacementDone);
    expect(await connections()).toHaveLength(1);
    const staleBridge = await mcpRequest(bridge, 4, "tools/call", { name: "session.get", arguments: {} });
    expect(staleBridge.error?.message).toContain("connection for profile");
    expect(staleBridge.error?.message).toContain("changed");
    json(await cliEnv.run(["whoami", "--json"]));

    // Revoking the connection under Settings -> AI agents ends it server-side: the stored access
    // token is rejected, and the refresh token cannot bring the sign-in back.
    const [connection] = await connections();
    expect((await app.delete(`/api/me/oauth-connections/${connection!.id}`)).status()).toBe(204);
    expect(await connections()).toHaveLength(0);
    const revoked = await cliEnv.run(["whoami", "--json"]);
    expect(revoked.code, `stdout:\n${revoked.stdout}\nstderr:\n${revoked.stderr}`).toBe(3);
    cliEnv.expireAccessToken();
    const revokedRefresh = await cliEnv.run(["whoami", "--json"]);
    expect(revokedRefresh.code, `stdout:\n${revokedRefresh.stdout}\nstderr:\n${revokedRefresh.stderr}`).toBe(3);
    expect(revokedRefresh.stderr).toMatch(/revoked|rejected the stored sign-in/u);

    // A fresh sign-in recovers, so logout below exercises a live connection.
    const recovery = cliEnv.start(["auth", "login", "--mcp-url", mcpUrl, "--no-browser", "--json"]);
    const recoveryDone = finished(recovery);
    const recoveryInstructions = await deviceInstructions(recovery);
    await decide(page, recoveryInstructions.url, recoveryInstructions.code, "Allow access");
    json(await recoveryDone);
    expect(await connections()).toHaveLength(1);
    json(await cliEnv.run(["whoami", "--json"]));

    // Signing out ends the sign-in on the server and removes the connection from the user's list.
    const logout = json<{ revoked: boolean; removed: boolean }>(await cliEnv.run(["auth", "logout", "--json"]));
    expect(logout).toMatchObject({ revoked: true, removed: true });
    expect(await connections()).toHaveLength(0);
    const after = await cliEnv.run(["whoami", "--json"]);
    expect(after.code).toBe(3);
  } finally {
    if (bridge && bridge.exitCode === null) {
      const closed = once(bridge, "close");
      bridge.kill();
      await closed;
    }
    cliEnv.cleanup();
  }
});

test("denying the CLI sign-in in the browser stores nothing and exits unauthenticated", async ({ page, signIn }) => {
  const cliEnv = cliHome();
  try {
    await signIn(page, "amelia");
    const login = cliEnv.start(["auth", "login", "--mcp-url", mcpUrl, "--no-browser", "--json"]);
    const loginDone = finished(login);
    const { url, code } = await deviceInstructions(login);
    await decide(page, url, code, "Deny");

    const result = await loginDone;
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("denied");
    expect(() => statSync(cliEnv.configFile)).toThrow();
  } finally {
    cliEnv.cleanup();
  }
});

test("a read-only API key profile reads through the CLI and MCP bridge but is refused every write", async ({ page, signIn, apiAs, uniqueName }) => {
  const cliEnv = cliHome();
  let bridge: ChildProcess | undefined;
  try {
    await signIn(page, "amelia");
    const boardPath = await boardHref(page, "Platform Delivery");
    const boardId = boardPath.split("/")[2]!;
    const app = await apiAs("amelia");
    const minted = await app.post("/api/me/api-keys", { data: { label: uniqueName("E2E read-only key"), scope: "read" } });
    expect(minted.status(), await minted.text()).toBe(201);
    const { secret } = await minted.json() as { secret: string };
    json(await cliEnv.run(["auth", "login", "--with-api-key", "--api-key", secret, "--url", publicApiOrigin, "--json"]));
    const stored = cliEnv.profile();
    expect(stored.oauth).toBeUndefined();
    expect(stored.apiKey).toBe(secret);

    // Reads succeed; the write is refused with the forbidden exit code an agent can branch on.
    const board = json<{ lists: { id: string }[] }>(await cliEnv.run(["board", boardId, "--json"]));
    const listId = board.lists[0]!.id;
    const title = uniqueName("E2E read-only card");
    const write = await cliEnv.run(["card", "create", title, "--boardId", boardId, "--listId", listId, "--json"]);
    expect(write.code, `stdout:\n${write.stdout}\nstderr:\n${write.stderr}`).toBe(4);

    // The stdio bridge never offers a read-only key's host a write tool, so the host cannot plan
    // around a write it would only be refused; a forced call is an unknown tool, not a transport failure.
    bridge = cliEnv.startMcp();
    const initialized = await mcpRequest(bridge, 1, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kanera-e2e", version: "1" },
    });
    expect(initialized.error).toBeUndefined();
    bridge.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const read = await mcpRequest(bridge, 2, "tools/call", { name: "boards.get", arguments: { boardId } });
    expect(read.error).toBeUndefined();
    expect(read.result?.isError).not.toBe(true);
    const listed = await mcpRequest(bridge, 3, "tools/list", {});
    const names = (listed.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(names).toContain("boards.get");
    expect(names).not.toContain("cards.create");
    const refused = await mcpRequest(bridge, 4, "tools/call", { name: "cards.create", arguments: { boardId, listId, title } });
    expect(refused.error?.message).toContain("Tool cards.create not found");

    await page.goto(boardPath);
    await expectBoardLoaded(page, "Platform Delivery");
    await expect(cardTile(page, title)).toHaveCount(0);
  } finally {
    if (bridge && bridge.exitCode === null) {
      const closed = once(bridge, "close");
      bridge.kill();
      await closed;
    }
    cliEnv.cleanup();
  }
});
