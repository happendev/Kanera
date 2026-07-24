import "../test/setup.integration.js";
import { activityEvents, clients, EMAIL_QUEUE_STATUS, emailQueue } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.js";

function isCheckViolation(error: unknown): boolean {
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  return cause !== null
    && typeof cause === "object"
    && "code" in cause
    && (cause as { code?: unknown }).code === "23514";
}

test("application-owned value domains are enforced by PostgreSQL", async () => {
  const [client] = await db.insert(clients).values({ name: "Value checks" }).returning();
  assert.ok(client);

  await assert.rejects(
    db.execute(sql`update "client" set "plan" = 'enterprise' where "id" = ${client.id}`),
    isCheckViolation,
  );

  const [queuedEmail] = await db
    .insert(emailQueue)
    .values({
      toEmail: "checks@example.com",
      subject: "Value check",
      type: "welcome",
      data: { displayName: "Checks", loginUrl: "https://example.com/login" },
      status: EMAIL_QUEUE_STATUS.queued,
    })
    .returning();
  assert.equal(queuedEmail?.status, "queued");

  await assert.rejects(
    db.execute(sql`update "email_queue" set "status" = '0' where "id" = ${queuedEmail!.id}`),
    isCheckViolation,
  );
});

test("historical activity vocabulary remains forward compatible", async () => {
  const [client] = await db.insert(clients).values({ name: "Future activity" }).returning();
  assert.ok(client);

  // Audit vocabulary is intentionally open: new deployments must be able to persist a new action
  // before every reader understands it, and old action names must remain restorable indefinitely.
  const [activity] = await db
    .insert(activityEvents)
    .values({
      clientId: client.id,
      actorKind: "system",
      entityType: "futureEntity",
      entityId: "00000000-0000-4000-8000-000000000001",
      action: "futureAction",
      payload: {},
    })
    .returning();

  assert.equal(activity?.entityType, "futureEntity");
  assert.equal(activity?.action, "futureAction");
});
