import "../test/setup.integration.js";
import "../test/integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { pool } from "../db.js";
import { env } from "../env.js";
import { createNotifyListenerHub } from "./notify-listener.js";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "notification condition timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// These tests force pool/connect/shutdown interleavings that browser E2E cannot schedule reliably.
void test("listeners share one session and releasing one callback preserves other channel subscribers", async () => {
  const connections = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const hub = createNotifyListenerHub(connections);
  const calls = [0, 0, 0];
  const listeners = ["test_outbox", "test_outbox", "test_direct"].map((channel, index) => hub.subscribe({
    channel, label: channel, onNotify: () => { calls[index]! += 1; },
  }));
  try {
    await Promise.all(listeners.map(listener => listener.ready));
    assert.equal(connections.totalCount, 1);
    assert.equal(connections.idleCount, 0);
    await pool.query("select pg_notify('test_outbox', ''), pg_notify('test_direct', '')");
    await until(() => calls.every(value => value === 1));
    await listeners[0]!.release();
    await pool.query("select pg_notify('test_outbox', '')");
    await until(() => calls[1] === 2);
    assert.equal(calls[0], 1);
    await listeners[1]!.release();
    await pool.query("select pg_notify('test_outbox', ''), pg_notify('test_direct', '')");
    await until(() => calls[2] === 2);
    assert.deepEqual(calls, [1, 2, 2]);
    await listeners[2]!.release();
    await listeners[2]!.release();
    assert.equal(connections.idleCount, 1);
    const client = await connections.connect();
    try {
      assert.deepEqual((await client.query("select pg_listening_channels()")).rows, []);
      assert.equal(client.listenerCount("notification"), 0);
    } finally { client.release(); }
  } finally {
    for (const listener of listeners) await listener.release();
    await connections.end();
  }
});

void test("releasing while the shared listener waits for a connection returns the late client", async () => {
  const connections = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const occupied = await connections.connect();
  const hub = createNotifyListenerHub(connections);
  const listener = hub.subscribe({ channel: "test_late", label: "late", onNotify: () => assert.fail("stopped callback") });
  await until(() => connections.waitingCount === 1);
  const released = listener.release();
  occupied.release();
  try {
    await released;
    assert.equal(connections.waitingCount, 0);
    assert.equal(connections.idleCount, 1);
    assert.deepEqual((await connections.query("select pg_listening_channels()")).rows, []);
  } finally {
    await listener.release();
    await connections.end();
  }
});

void test("a disconnected shared listener resubscribes both channels and stops without a retry leak", async () => {
  const connections = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  let pid = 0;
  connections.on("connect", client => {
    void client.query<{ pid: number }>("select pg_backend_pid() as pid").then(result => { pid = result.rows[0]!.pid; });
  });
  const hub = createNotifyListenerHub(connections);
  const calls = [0, 0];
  const listeners = ["test_reconnect_one", "test_reconnect_two"].map((channel, index) => hub.subscribe({
    channel, label: channel, onNotify: () => { calls[index]! += 1; },
  }));
  try {
    await Promise.all(listeners.map(listener => listener.ready));
    const originalPid = pid;
    assert.ok(originalPid > 0);
    await pool.query("select pg_terminate_backend($1)", [originalPid]);
    await until(() => pid !== originalPid);
    await until(async () => {
      await pool.query("select pg_notify('test_reconnect_one', ''), pg_notify('test_reconnect_two', '')");
      return calls.every(value => value > 0);
    });
    assert.equal(connections.totalCount, 1);
  } finally {
    for (const listener of listeners) await listener.release();
    await connections.end();
  }
});
