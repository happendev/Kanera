import { spawn } from "node:child_process";
import path from "node:path";
import { expect, test } from "./support/fixtures";
import { TEST_PASSWORD, users } from "./support/env";

// Each child owns its HTTP port and a TCP proxy to the isolated E2E Valkey. Cutting that
// proxy simulates a reboot without stopping dependencies used by the rest of the suite.
const childScript = String.raw`
  import assert from "node:assert/strict";
  import net from "node:net";
  import { once } from "node:events";
  import pg from "pg";
  import { io as connect } from "socket.io-client";

  const dbUrl = new URL(process.env.DATABASE_URL);
  const redisUrl = new URL(process.env.REDIS_URL);
  assert.equal(dbUrl.hostname, "localhost");
  assert.equal(dbUrl.port, "55434");
  assert.equal(dbUrl.pathname, "/kanera_test_e2e");
  assert.equal(redisUrl.hostname, "localhost");
  assert.equal(redisUrl.port, "56380");
  const connections = new Set();
  const proxy = net.createServer(downstream => {
    const upstream = net.connect(Number(redisUrl.port), redisUrl.hostname);
    for (const socket of [upstream, downstream]) {
      connections.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => connections.delete(socket));
    }
    downstream.pipe(upstream).pipe(downstream);
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  process.env.REDIS_URL = "redis://127.0.0.1:" + proxy.address().port + "/0";
  // The proxy is test infrastructure; it must not keep an otherwise-drained service alive.
  proxy.unref();

  const { pool } = await import("./src/db.ts");
  const { closeServiceResources } = await import("./src/lib/close-service-resources.ts");
  const { installGracefulShutdown } = await import("./src/lib/graceful-shutdown.ts");
  const builders = {
    api: ["./src/server.ts", "buildServer"],
    worker: ["./src/worker-server.ts", "buildWorkerServer"],
    "public-api": ["./src/public-api-server.ts", "buildPublicApiServer"],
    "admin-api": ["./src/admin-server.ts", "buildAdminServer"],
  };
  const [module, name] = builders[process.env.SHUTDOWN_SERVICE];
  const app = await (await import(module))[name]({ logger: { level: "info" } });
  installGracefulShutdown({ app, closeResources: closeServiceResources, service: process.env.SHUTDOWN_SERVICE });
  await app.listen({ port: 0, host: "127.0.0.1" });

  if (process.env.SHUTDOWN_SERVICE === "api") {
    const origin = "http://127.0.0.1:" + app.server.address().port;
    const response = await fetch(origin + "/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: process.env.SHUTDOWN_EMAIL, password: process.env.SHUTDOWN_PASSWORD }),
    });
    assert.equal(response.status, 200);
    const { accessToken } = await response.json();
    const socket = connect(origin, { auth: { token: accessToken }, transports: ["websocket"], reconnection: false });
    await once(socket, "connect");
    // Acknowledged workspace join ensures there is actual presence to clean up.
    const workspaces = await fetch(origin + "/workspaces", { headers: { authorization: "Bearer " + accessToken } }).then(r => r.json());
    assert.equal(await socket.emitWithAck("workspace:join", workspaces[0].id), true);
  }

  if (process.env.SHUTDOWN_FAILURE === "postgres") {
    const client = await pool.connect();
    const { rows: [{ pid }] } = await client.query("select pg_backend_pid() as pid");
    client.release();
    const failed = once(pool, "error");
    // Listen without consuming the event for the application: an absent production listener
    // must still fail this test, even though once() itself would prevent an uncaught event.
    assert.ok(pool.listenerCount("error") > 1, "pool must handle idle errors itself");
    const killer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await killer.connect();
    await killer.query("select pg_terminate_backend($1)", [pid]);
    await failed;
    await killer.end();
    await pool.query("select 1");
    console.log("IDLE_POOL_RECOVERED");
  }

  console.log("SHUTDOWN_READY");
  process.stdin.once("data", () => {
    if (process.env.SHUTDOWN_FAILURE === "valkey") {
      proxy.close();
      for (const socket of connections) socket.destroy();
    }
    process.stdin.destroy();
    process.kill(process.pid, "SIGTERM");
  });
`;

for (const service of ["api", "worker", "public-api", "admin-api"] as const) {
  for (const failure of ["none", "valkey", ...(service === "worker" ? ["postgres"] : [])]) {
    test(`${service} shutdown exits after ${failure === "none" ? "healthy drain" : `${failure} connection loss`}`, async ({}, testInfo) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], {
        cwd: path.resolve(__dirname, "../apps/api"),
        env: {
          ...process.env, SHUTDOWN_SERVICE: service, SHUTDOWN_FAILURE: failure,
          SHUTDOWN_EMAIL: users.amelia.email, SHUTDOWN_PASSWORD: TEST_PASSWORD,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { output += String(chunk); });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      try {
        await expect.poll(() => output, { timeout: 30_000 }).toContain("SHUTDOWN_READY");
        child.stdin.end("shutdown\n");
        // A leaked Valkey client/reconnect loop used to keep the process alive indefinitely.
        const result = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`shutdown did not exit:\n${output}`)), 15_000);
            timer.unref();
            void exited.then(() => clearTimeout(timer));
          }),
        ]);
        expect(result.signal, output).toBeNull();
        // Presence cleanup remains an observable failure if Valkey has already stopped; all
        // sockets and pools must still close, and the failure must not become an unhandled one.
        expect(result.code, output).toBe(service === "api" && failure === "valkey" ? 1 : 0);
        expect(output).toContain(service === "api" && failure === "valkey" ? "graceful shutdown failed" : "graceful shutdown complete");
        expect(output).not.toMatch(/UnhandledPromiseRejection|triggerUncaughtException|Unhandled 'error' event/);
        if (failure === "postgres") {
          expect(output).toContain("idle PostgreSQL client failed");
          expect(output).toContain("IDLE_POOL_RECOVERED");
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        await testInfo.attach("shutdown.log", { body: output, contentType: "text/plain" });
      }
    });
  }
}
