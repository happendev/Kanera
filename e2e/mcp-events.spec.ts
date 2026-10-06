import { randomBytes, randomUUID } from "node:crypto";
import ports from "./ports.json";
import { expect, test } from "./support/fixtures";
import { boardHref, openBoard, workspaceSettingsHref } from "./support/ui";

const mcpUrl = `http://localhost:${ports.mcp}/mcp`;

test("MCP 2 discovers events, executes tools, rejects private callbacks and respects revoked credentials", async ({ page, signIn, playwright, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const boardId = (await boardHref(page, "Platform Delivery")).split("/")[2]!;
  const settings = await workspaceSettingsHref(page, "Platform Delivery");
  await page.goto(`${settings}/api`);
  const keyName = uniqueName("MCP events key");
  await page.locator('input[name="apiKeyName"]').fill(keyName);
  await page.locator('select[name="apiKeyScope"]').selectOption("write");
  await page.getByRole("button", { name: "Create API key" }).click();
  const reveal = page.locator(".secret-reveal").filter({ has: page.getByRole("button", { name: "Copy API key" }) });
  await expect(reveal).toBeVisible();
  const key = (await reveal.locator("code").innerText()).trim();
  const client = await playwright.request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${key}`, "MCP-Protocol-Version": "2026-07-28" } });
  const evidence: unknown[] = [];
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  // 2026-07-28 requires Mcp-Method on every POST and Mcp-Name for tools/call; `headers` overrides
  // them so the spec's server-validation failures can be exercised against the real endpoint.
  const send = async <T = unknown>(method: string, params: Record<string, unknown>, options: { headers?: Record<string, string>; notification?: boolean; version?: string } = {}) => {
    const headers: Record<string, string> = { "Mcp-Method": method, ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}), ...options.headers };
    const _meta = options.version ? { ...meta, "io.modelcontextprotocol/protocolVersion": options.version } : meta;
    const data = { jsonrpc: "2.0", ...(options.notification ? {} : { id: 1 }), method, params: { ...params, _meta } };
    const response = await client.post(mcpUrl, { data, headers });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : null) as { result: T; error?: { code: number; data?: { reason: string } } };
    // Retain protocol responses and statuses; bearer tokens and callback secrets stay out of artifacts.
    evidence.push({ method, status: response.status(), body });
    return { response, body };
  };
  const rpc = <T = unknown>(method: string, params: Record<string, unknown> = {}) => send<T>(method, params);
  try {
    const discover = await rpc<{ resultType: string; supportedVersions: string[]; capabilities: Record<string, unknown> }>("server/discover");
    expect(discover.response.status()).toBe(200);
    expect(discover.body.result).toMatchObject({
      resultType: "complete", supportedVersions: ["2026-07-28"], ttlMs: expect.any(Number), cacheScope: "public",
      capabilities: { tools: {}, events: {}, extensions: { "io.modelcontextprotocol/events": {} } },
    });
    // Server validation: headers that disagree with the body are rejected, not trusted.
    const missingMethod = await send("server/discover", {}, { headers: { "Mcp-Method": "" } });
    expect(missingMethod.response.status()).toBe(400);
    expect(missingMethod.body.error!.code).toBe(-32020);
    const wrongName = await send("tools/call", { name: "session.get", arguments: {} }, { headers: { "Mcp-Name": "cards.create" } });
    expect(wrongName.response.status()).toBe(400);
    expect(wrongName.body.error!.code).toBe(-32020);
    // A future client names its version in both the header and _meta; a disagreement is -32020.
    const futureVersion = await send("server/discover", {}, { headers: { "MCP-Protocol-Version": "2099-01-01" }, version: "2099-01-01" });
    expect(futureVersion.response.status()).toBe(400);
    expect(futureVersion.body.error).toMatchObject({ code: -32022, data: { supported: ["2026-07-28"] } });
    // 2026-07-28 removed ping; unknown methods are HTTP 404 with -32601.
    const ping = await rpc("ping");
    expect(ping.response.status()).toBe(404);
    expect(ping.body.error!.code).toBe(-32601);
    const cancelled = await send("notifications/cancelled", { requestId: 1 }, { notification: true });
    expect(cancelled.response.status()).toBe(202);
    expect(cancelled.body).toBeNull();
    const catalog = await rpc<{ events: Array<{ name: string; delivery: string[]; payloadSchema: { required: string[] } }> }>("events/list");
    expect(catalog.body.result.events.every((event) => event.payloadSchema.required.includes("actor"))).toBe(true);
    expect(catalog.body.result.events.map((event: { name: string }) => event.name)).toEqual(["card.created", "card.updated", "card.moved", "comment.created"]);
    expect(catalog.body.result.events.every((event: { delivery: string[] }) => event.delivery.join() === "webhook")).toBe(true);
    const tools = await rpc<{ tools: Array<{ name: string }>; ttlMs: number; cacheScope: string }>("tools/list");
    expect(tools.body.result).toMatchObject({ resultType: "complete", ttlMs: expect.any(Number), cacheScope: "public" });
    expect(tools.body.result.tools.some((tool: { name: string }) => tool.name === "cards.create")).toBe(true);
    const board = await rpc<{ isError?: boolean; structuredContent: { board: { workspaceId: string }; lists: Array<{ id: string }> } }>("tools/call", { name: "boards.get", arguments: { boardId } });
    expect(board.body.result.isError).not.toBe(true);
    const detail = board.body.result.structuredContent;
    const workspaceId = detail.board.workspaceId;
    const listId = detail.lists[0]!.id;
    const title = uniqueName("MCP 2 card");
    const write = { name: "cards.create", arguments: { boardId, listId, title, idempotencyKey: randomUUID() } };
    const created = await rpc<{ isError?: boolean }>("tools/call", write);
    const duplicate = await rpc<{ isError?: boolean }>("tools/call", write);
    expect(duplicate.body.result.isError).not.toBe(true);
    expect(created.body.result.isError).not.toBe(true);
    await openBoard(page, "Platform Delivery");
    await expect(page.locator("k-card").filter({ hasText: title })).toHaveCount(1);
    const callback = await rpc("events/subscribe", { name: "comment.created", arguments: { workspaceId, boardId }, delivery: { mode: "webhook", url: "https://127.0.0.1/callback", secret: `whsec_${randomBytes(32).toString("base64")}` } });
    expect(callback.body.error).toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
    const invalid = await rpc("events/subscribe", { name: "comment.created", arguments: { workspaceId, boardId }, delivery: { mode: "webhook", url: "http://localhost/callback", secret: "whsec_bad" } });
    expect(invalid.body.error!.code).toBe(-32602);
    const appApi = await apiAs("amelia");
    const keysResponse = await appApi.get(`/api/workspaces/${workspaceId}/api-keys`);
    expect(keysResponse.ok()).toBe(true);
    const keys = await keysResponse.json() as Array<{ id: string; name: string }>;
    const owned = keys.find((item) => item.name === keyName)!;
    expect(owned).toBeDefined();
    const revoke = await appApi.delete(`/api/workspaces/${workspaceId}/api-keys/${owned.id}`);
    expect(revoke.ok()).toBe(true);
    const denied = await rpc<{ resultType: string; supportedVersions: string[]; capabilities: Record<string, unknown> }>("server/discover");
    expect(denied.response.status()).toBe(401);
  } finally {
    await testInfo.attach("mcp-events-protocol.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    await client.dispose();
  }
});
