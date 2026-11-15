import assert from "node:assert/strict";
import { createServer, type Server, type RequestListener } from "node:http";
import { mock, test } from "node:test";
import { outboundHttpClient } from "./outbound-http.js";
import { assertPushEndpointAllowed, outboundDns, resolveOutboundTarget } from "./ssrf.js";
import { env } from "../env.js";

async function serve(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://receiver.test:${address.port}/callback` };
}

// Real DNS cannot reliably force the check/use race in E2E. These tests use a
// real HTTP socket and controlled resolver to prove only the validated address is used.
test("outbound connection pins the first checked DNS answer and preserves Host", async () => {
  let hits = 0;
  const { server, url } = await serve((req, res) => {
    hits += 1;
    assert.match(req.headers.host ?? "", /^receiver\.test:/);
    res.end("accepted");
  });
  let resolutions = 0;
  const resolver = mock.method(outboundDns, "lookup", async () => {
    resolutions += 1;
    return [{ address: resolutions === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }];
  });
  try {
    const response = await outboundHttpClient.fetch(url);
    assert.equal(await response.text(), "accepted");
    assert.equal(hits, 1);
    assert.equal(resolutions, 1, "the connection must not resolve the checked hostname again");
  } finally { resolver.mock.restore(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("blocked DNS and capability URL targets never open a connection", async () => {
  const resolver = mock.method(outboundDns, "lookup", async () => [{ address: "169.254.169.254", family: 4 }]);
  try {
    await assert.rejects(outboundHttpClient.fetch("https://receiver.test/secret"), /blocked address/);
    for (const endpoint of ["https://169.254.169.254/latest/meta-data", "https://[::ffff:a9fe:a9fe]/", "http://push.example/", "https://user:password@push.example/", "https://push.example/#fragment"]) {
      assert.throws(() => assertPushEndpointAllowed(endpoint));
    }
  } finally { resolver.mock.restore(); }
});

test("production private targets require the explicit self-host notification policy", async () => {
  const previous = { node: env.NODE_ENV, mode: env.KANERA_DEPLOYMENT_MODE, private: env.KANERA_ALLOW_PRIVATE_NOTIFICATION_DESTINATIONS };
  env.NODE_ENV = "production";
  env.KANERA_DEPLOYMENT_MODE = "self_hosted";
  env.KANERA_ALLOW_PRIVATE_NOTIFICATION_DESTINATIONS = false;
  const resolver = mock.method(outboundDns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    for (const policy of ["webhook", "notification", "push"] as const) {
      await assert.rejects(resolveOutboundTarget("https://receiver.test/", policy, AbortSignal.timeout(1000)), /blocked address/);
    }
    env.KANERA_ALLOW_PRIVATE_NOTIFICATION_DESTINATIONS = true;
    assert.equal((await resolveOutboundTarget("https://receiver.test/", "notification", AbortSignal.timeout(1000))).address.address, "127.0.0.1");
    env.KANERA_DEPLOYMENT_MODE = "hosted";
    await assert.rejects(resolveOutboundTarget("https://receiver.test/", "notification", AbortSignal.timeout(1000)), /blocked address/);
  } finally {
    resolver.mock.restore();
    env.NODE_ENV = previous.node;
    env.KANERA_DEPLOYMENT_MODE = previous.mode;
    env.KANERA_ALLOW_PRIVATE_NOTIFICATION_DESTINATIONS = previous.private;
  }
});

test("redirects cannot forward webhook credentials to another endpoint", async () => {
  let redirectedHits = 0;
  const { server, url } = await serve((req, res) => {
    if (req.url === "/secret-target") { redirectedHits += 1; res.end("bad"); return; }
    res.writeHead(307, { location: "/secret-target" }); res.end();
  });
  const resolver = mock.method(outboundDns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    await assert.rejects(outboundHttpClient.fetch(url, { method: "POST", headers: { authorization: "Bearer test-only-secret" }, body: "private payload" }), /redirects/);
    assert.equal(redirectedHits, 0);
  } finally { resolver.mock.restore(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("outbound responses are bounded even when Content-Length is absent", async () => {
  const { server, url } = await serve((_req, res) => { res.write("x".repeat(1024)); res.end("x".repeat(1024)); });
  const resolver = mock.method(outboundDns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    await assert.rejects(outboundHttpClient.fetch(url, {}, { maxResponseBytes: 1024 }), /too large/);
  } finally { resolver.mock.restore(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("an unsolicited protocol upgrade cannot leave delivery pending past its deadline", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(101, { connection: "upgrade", upgrade: "websocket" }); res.end();
  });
  const resolver = mock.method(outboundDns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    const result = await Promise.race([
      outboundHttpClient.fetch(url, {}, { timeoutMs: 100 }).then(() => "accepted", (error: unknown) => error),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 300)),
    ]);
    assert.ok(result instanceof Error, "the old implementation remained pending beyond its abort deadline");
    assert.match(result.message, /protocol upgrades/);
  } finally { resolver.mock.restore(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

// A receiver that accepted a delivery and answered at length must not have it retried (and
// processed again); the declared Content-Length must not reject it either.
test("truncated responses keep an accepted delivery's status and first bytes", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(200, { "content-length": String(4096) });
    res.write("y".repeat(2048)); res.end("z".repeat(2048));
  });
  const resolver = mock.method(outboundDns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    const response = await outboundHttpClient.fetch(url, {}, { maxResponseBytes: 1024, oversizedResponse: "truncate" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "y".repeat(1024));
  } finally { resolver.mock.restore(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

// Saving a webhook rejects fragments, but endpoints stored before that still deliver.
test("a stored webhook URL with a fragment still resolves for delivery", async () => {
  const resolver = mock.method(outboundDns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    const { target } = await resolveOutboundTarget("http://receiver.test/hook#team", "webhook", AbortSignal.timeout(1000));
    assert.equal(target.href, "http://receiver.test/hook");
    await assert.rejects(resolveOutboundTarget("https://push.example/#fragment", "push", AbortSignal.timeout(1000)), /fragment/);
  } finally { resolver.mock.restore(); }
});
