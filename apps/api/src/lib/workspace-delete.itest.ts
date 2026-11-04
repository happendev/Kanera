import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { directRealtimeOutbox, eventOutbox, notifications, workspaces } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../db.js";
import { signupOwner } from "../test/api-fixtures.js";
import { buildIntegrationServer } from "../test/integration.js";
import { insertTestNotifications } from "../test/notification-fixtures.js";
import { publishRealtimeEvent } from "../realtime/outbox.js";

// E2E cleanup exposed this race, but only controlled row locks can reliably make deletion the
// deadlock victim. The retry must commit deletion and notification fanout exactly once.
void test("workspace deletion recovers from an outbox deadlock without duplicating notification deletion", { timeout: 20_000 }, async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { orgName: "Deletion race", email: "owner@example.com", displayName: "Owner" });
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();
  const event = await publishRealtimeEvent("workspace", workspace.id, "workspace:deleted", { workspaceId: workspace.id });
  assert.ok(event);
  const [notification] = await insertTestNotifications(db, {
    userId: owner.user.id, workspaceId: workspace.id, reason: "mentioned",
  }).returning();
  assert.ok(notification);

  const blocker = await pool.connect();
  let deleting: Promise<{ statusCode: number; body: string }> | undefined;
  try {
    await blocker.query("BEGIN");
    // Let the deletion session detect the cycle first, making it the victim every time.
    await blocker.query("SET LOCAL deadlock_timeout = '10s'");
    await blocker.query("UPDATE event_outbox SET updated_at = now() WHERE id = $1", [event.id]);
    const { rows } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const pid = rows[0]!.pid;
    deleting = app.inject({ method: "DELETE", url: `/workspaces/${workspace.id}`, headers: owner.auth,
      payload: { confirmationName: "Delivery" },
    }).then((response) => response);
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE 'delete from%workspace%'",
        [pid],
      );
      if (rows.length > 0) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "workspace cascade must be waiting for the locked outbox row");
    // Deletion holds the workspace row and wants our outbox row; now request its workspace row.
    await blocker.query("UPDATE workspace SET name = name WHERE id = $1", [workspace.id]);
    await blocker.query("COMMIT");
    const response = await deleting;
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(await db.$count(workspaces, eq(workspaces.id, workspace.id)), 0);
    assert.equal(await db.$count(eventOutbox, eq(eventOutbox.workspaceId, workspace.id)), 0);
    assert.equal(await db.$count(notifications, eq(notifications.id, notification.id)), 0);
    const deliveries = await db.select().from(directRealtimeOutbox).where(and(
      eq(directRealtimeOutbox.userId, owner.user.id), eq(directRealtimeOutbox.eventType, "notification:deleted"),
    ));
    assert.equal(deliveries.length, 1);
    assert.deepEqual(deliveries[0]!.payload, { notificationIds: [notification.id] });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await deleting;
    await app.close();
  }
});

// A persistent deadlock must stop after three transactions; unrelated database errors must never
// be retried. Sequences survive transaction rollback, so they count every failed DELETE attempt.
for (const [code, expectedAttempts] of [["40P01", 3], ["23514", 1]] as const) {
  void test(`workspace deletion bounds retries for PostgreSQL ${code}`, async () => {
    const app = await buildIntegrationServer();
    const owner = await signupOwner(app, { orgName: "Deletion failure", email: "owner@example.com", displayName: "Owner" });
    const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery" } });
    assert.equal(created.statusCode, 201);
    const workspace = created.json<{ id: string }>();
    await pool.query("CREATE SEQUENCE test_workspace_delete_attempts");
    await pool.query(`CREATE FUNCTION test_fail_workspace_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('test_workspace_delete_attempts');
        RAISE EXCEPTION 'forced deletion failure' USING ERRCODE = '${code}';
      END $$`);
    await pool.query("CREATE TRIGGER test_fail_workspace_delete BEFORE DELETE ON workspace FOR EACH ROW EXECUTE FUNCTION test_fail_workspace_delete()");
    try {
      const response = await app.inject({ method: "DELETE", url: `/workspaces/${workspace.id}`, headers: owner.auth,
        payload: { confirmationName: "Delivery" },
      });
      assert.equal(response.statusCode, 500);
      const { rows } = await pool.query<{ last_value: string }>("SELECT last_value FROM test_workspace_delete_attempts");
      assert.equal(Number(rows[0]!.last_value), expectedAttempts);
      assert.equal(await db.$count(workspaces, eq(workspaces.id, workspace.id)), 1);
      assert.equal(await db.$count(eventOutbox, and(eq(eventOutbox.workspaceId, workspace.id), eq(eventOutbox.eventType, "workspace:deleted"))), 1);
    } finally {
      await pool.query("DROP TRIGGER test_fail_workspace_delete ON workspace");
      await pool.query("DROP FUNCTION test_fail_workspace_delete()");
      await pool.query("DROP SEQUENCE test_workspace_delete_attempts");
      await app.close();
    }
  });
}
