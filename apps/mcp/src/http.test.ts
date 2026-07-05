import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { createMcpHttpHandler, mcpClientIp, mcpRequestPathname } from "./http.js";

void test("MCP route parsing ignores query strings", () => {
  assert.equal(mcpRequestPathname("/mcp?session=abc"), "/mcp");
});

void test("health route parsing ignores query strings", () => {
  assert.equal(mcpRequestPathname("/health?probe=1"), "/health");
});

void test("unrelated route parsing stays unrelated", () => {
  assert.equal(mcpRequestPathname("/elsewhere?probe=1"), "/elsewhere");
});

void test("MCP trusts CF-Connecting-IP only from a Cloudflare peer", () => {
  const request = (remoteAddress: string) => ({
    headers: { "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.30" },
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;

  assert.equal(mcpClientIp(request("173.245.48.5"), true), "203.0.113.10");
  assert.equal(mcpClientIp(request("192.0.2.20"), true), "198.51.100.30");
});

async function withHttpServer(callback: (baseUrl: string) => Promise<void>) {
  const server = createServer(createMcpHttpHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

void test("HTTP handler serves health and not-found responses", async () => {
  await withHttpServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health?probe=1`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "mcp" });
    const missing = await fetch(`${baseUrl}/elsewhere`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not found" });
  });
});

void test("HTTP MCP endpoint rejects missing and malformed API key authorization", async () => {
  await withHttpServer(async (baseUrl) => {
    for (const authorization of [undefined, "Basic abc", "Bearer wrong", "Bearer kanera_"]) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: authorization ? { authorization } : undefined,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "missing Kanera API key bearer token" });
    }
  });
});

void test("HTTP MCP endpoint completes protocol initialization with a Kanera API key", async () => {
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer kanera_test_${"A".repeat(43)}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "kanera-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(response.status, 200);
    const responseText = await response.text();
    const dataLine = responseText.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine);
    const payload = JSON.parse(dataLine.slice("data: ".length)) as { result?: { serverInfo?: { name?: string }; capabilities?: Record<string, unknown> } };
    assert.equal(payload.result?.serverInfo?.name, "kanera");
    assert.ok(payload.result?.capabilities?.tools);
    assert.ok(payload.result?.capabilities?.resources);
    assert.ok(payload.result?.capabilities?.prompts);
  });
});

void test("HTTP MCP endpoint caps request bodies and sends security headers", async () => {
  const server = createServer(createMcpHttpHandler({ bodyMaxBytes: 32 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer kanera_test_${"A".repeat(43)}` },
      body: "x".repeat(33),
    });
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), { error: "request body too large" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

void test("HTTP MCP endpoint rate limits unauthenticated requests", async () => {
  const server = createServer(createMcpHttpHandler({ ipRateLimitPerMinute: 1, rateLimitWindowMs: 60_000 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const url = `http://127.0.0.1:${address.port}/mcp`;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const limited = await fetch(url, { method: "POST" });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

void test("HTTP MCP endpoint gives bearer keys the public API key allowance", async () => {
  const server = createServer(createMcpHttpHandler({ ipRateLimitPerMinute: 1, keyRateLimitPerMinute: 2, rateLimitWindowMs: 60_000 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const headers = {
      authorization: `Bearer kanera_test_${"A".repeat(43)}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    for (let request = 0; request < 2; request += 1) {
      const response = await fetch(url, { method: "POST", headers, body: "{}" });
      assert.notEqual(response.status, 429);
    }
    assert.equal((await fetch(url, { method: "POST", headers, body: "{}" })).status, 429);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
