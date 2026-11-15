import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createServer, request as httpRequest, type RequestOptions, type IncomingMessage } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
import { McpCallbackError, postMcpWebhook } from "./mcp-event-webhooks.js";

// Failure: an unsolicited 101 bypasses response/error handlers, leaving the shared delivery sweep
// pending even after its deadline. E2E cannot serve a controlled public HTTPS endpoint; keep the
// destination policy intact and route only the actual socket to a local HTTP fixture here.
test("MCP callbacks reject protocol upgrades promptly and subsequent deliveries still complete", async () => {
  let attempts = 0;
  const server = createServer((_req, res) => {
    if (++attempts === 1) res.writeHead(101, { connection: "upgrade", upgrade: "websocket" });
    else res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const resolver = mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  const transport = mock.method(https, "request", (_target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) =>
    httpRequest(`http://127.0.0.1:${address.port}/`, { ...options, lookup: undefined }, callback));
  syncBuiltinESMExports();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      postMcpWebhook("https://receiver.example/callback", "{}", {}).then(() => "accepted", (error: unknown) => error),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still pending"), 1000); }),
    ]);
    assert.ok(outcome instanceof McpCallbackError, "101 must reject instead of leaving the delivery sweep pending");
    assert.equal(outcome.reason, "challenge_failed");
    assert.deepEqual(await postMcpWebhook("https://receiver.example/callback", "{}", {}), { status: 204, body: "" });
    assert.equal(attempts, 2);
  } finally {
    clearTimeout(timer);
    resolver.mock.restore();
    transport.mock.restore();
    syncBuiltinESMExports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
