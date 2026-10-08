import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { test } from "node:test";
import type { StorageConfig } from "@kanera/shared/schema";
import { createS3Storage } from "./s3.js";

// Browser media flows cannot count SDK TCP pools, rotate fake credentials, or hold an S3 response
// open during LRU eviction. These loopback-only tests cover those concrete tenancy/lifetime races.
// Reuse can lose tenant/bucket/range scoping, ignore credential rotation, retain unbounded idle
// clients, or close an active download during eviction. Assertions inspect real HTTP requests
// and connections, so provider wrappers alone cannot make a broken pool look correct.
type S3Config = Extract<StorageConfig, { kind: "s3" }>;
async function withS3Server(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (config: S3Config, connections: () => number) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    await run({
      kind: "s3", region: "us-east-1", endpoint: `http://127.0.0.1:${address.port}`,
      bucket: "audit", accessKeyId: "fixture-access", secretAccessKey: "fixture-secret",
    }, () => connections);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

void test("S3 pools reuse connections while tenant paths, ranges and rotated credentials remain request-scoped", async () => {
  const requests: { path: string; authorization: string; range: string | undefined }[] = [];
  await withS3Server((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization!, range: request.headers.range });
    response.writeHead(200, { "Content-Length": "4" });
    response.end("data");
  }, async (config, connections) => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await createS3Storage(`tenant-${i}`, config).get("image.png")).toString(), "data");
    }
    assert.equal(connections(), 1, "new provider wrappers must reuse the same SDK connection pool");
    assert.ok(requests.every((request, index) => request.path.startsWith(`/audit/tenant-${index}/image.png`)));
    const ranged = await createS3Storage("tenant-b", { ...config, bucket: "other-bucket" }).getObject("clip.mp4", { start: 4, end: 7 });
    for await (const _chunk of ranged.body) { /* Drain the response before checking reuse. */ }
    assert.equal(requests.at(-1)?.range, "bytes=4-7");
    assert.ok(requests.at(-1)?.path.startsWith("/other-bucket/tenant-b/clip.mp4"));
    assert.equal(connections(), 1, "bucket selection belongs to each command, not to the cached client");
    await createS3Storage("tenant-b", { ...config, accessKeyId: "rotated-access" }).get("image.png");
    assert.match(requests.at(-1)!.authorization, /Credential=rotated-access\//);
    assert.equal(connections(), 2);
    await createS3Storage("tenant-b", { ...config, secretAccessKey: "rotated-secret" }).get("image.png");
    assert.equal(connections(), 3, "rotating only the secret must also select a fresh client");
  });
});

void test("S3 idle pools are bounded and eviction never interrupts an active stream", async () => {
  let finishDownload: (() => void) | undefined;
  await withS3Server((request, response) => {
    if (request.url?.includes("slow.bin")) {
      response.writeHead(200, { "Content-Length": "8" });
      response.write("first");
      finishDownload = () => response.end("end");
    } else {
      response.writeHead(200, { "Content-Length": "4" });
      response.end("data");
    }
  }, async (config, connections) => {
    const active = await createS3Storage("active-tenant", config).getObject("slow.bin");
    const body = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of active.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    })();
    for (let i = 0; i < 40; i++) {
      await createS3Storage("idle-tenant", { ...config, accessKeyId: `idle-${i}` }).get("small.bin");
    }
    const before = connections();
    await createS3Storage("idle-tenant", { ...config, accessKeyId: "idle-0" }).get("small.bin");
    assert.equal(connections(), before + 1, "the least recently used idle client must have been evicted");
    finishDownload!();
    assert.equal(await body, "firstend", "the pinned client survives more than a cache capacity of churn");
    const afterStream = connections();
    await createS3Storage("active-tenant", config).get("small.bin");
    assert.equal(connections(), afterStream, "a completed active client remains reusable");
  });
});
