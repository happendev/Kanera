import "../test/setup.integration.js";
import { clients, emailQueue, users, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../db.js";
import { env } from "../env.js";
import { runTrialExpirySweep, runTrialWarningSweep } from "./trial-expiry.js";
import { hashPassword } from "../auth/password.js";
import { buildIntegrationServer } from "../test/integration.js";

const DAY = 86_400_000;

async function insertTrial(name: string, currentPeriodEnd: Date | null): Promise<string> {
  const [row] = await db
    .insert(clients)
    .values({ name, plan: "paid", billingStatus: "trialing", currentPeriodEnd })
    .returning({ id: clients.id });
  return row!.id;
}

async function insertTrialWithOwner(name: string, email: string, currentPeriodEnd: Date | null): Promise<string> {
  const id = await insertTrial(name, currentPeriodEnd);
  await db.insert(users).values({
    clientId: id,
    clientRole: "owner",
    email,
    passwordHash: await hashPassword("Abc12345"),
    displayName: name,
  });
  return id;
}

async function planOf(clientId: string) {
  const [row] = await db
    .select({ plan: clients.plan, billingStatus: clients.billingStatus, currentPeriodEnd: clients.currentPeriodEnd })
    .from(clients)
    .where(eq(clients.id, clientId));
  return row!;
}

async function inHostedMode<T>(fn: () => Promise<T>): Promise<T> {
  const prev = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    return await fn();
  } finally {
    env.KANERA_DEPLOYMENT_MODE = prev;
  }
}

void test("expired trials revert to free; future trials are untouched", async () => {
  await inHostedMode(async () => {
    const expired = await insertTrialWithOwner("Expired Trial", "expired-trial@example.com", new Date(Date.now() - DAY));
    await db.insert(workspaces).values([
      { clientId: expired, name: "Keep", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { clientId: expired, name: "Archive", createdAt: new Date("2026-01-02T00:00:00.000Z") },
    ]);
    const active = await insertTrial("Active Trial", new Date(Date.now() + DAY));
    const app = await buildIntegrationServer();

    const converted = await runTrialExpirySweep(undefined, app.mailer);
    assert.ok(converted >= 1, "at least the expired trial was converted");

    const expiredRow = await planOf(expired);
    assert.equal(expiredRow.plan, "free", "expired trial is now free");
    assert.equal(expiredRow.billingStatus, "none", "expired trial billing status cleared");
    assert.equal(expiredRow.currentPeriodEnd, null, "expired trial period end cleared");

    const activeRow = await planOf(active);
    assert.equal(activeRow.billingStatus, "trialing", "future trial stays trialing");

    const [email] = await db.select().from(emailQueue).where(eq(emailQueue.type, "downgraded_to_free")).limit(1);
    assert.equal(email?.toEmail, "expired-trial@example.com");
  });
});

void test("trial expiry sweep is a no-op in self-hosted mode", async () => {
  // env defaults to self_hosted in tests.
  const id = await insertTrial("Self Hosted Trial", new Date(Date.now() - DAY));
  const converted = await runTrialExpirySweep();
  assert.equal(converted, 0, "no conversions outside hosted mode");
  const row = await planOf(id);
  assert.equal(row.billingStatus, "trialing", "trial left untouched self-hosted");
});

void test("trial warning sweep sends 10-day and 1-day warnings with dedupe and ignores nonmatching trials", async () => {
  await inHostedMode(async () => {
    const app = await buildIntegrationServer();
    const now = new Date("2026-06-06T12:00:00.000Z");
    await insertTrialWithOwner("Ten Day Trial", "trial-10@example.com", new Date("2026-06-16T09:00:00.000Z"));
    await insertTrialWithOwner("One Day Trial", "trial-1@example.com", new Date("2026-06-07T12:00:00.000Z"));
    await insertTrialWithOwner("Other Trial", "trial-other@example.com", new Date("2026-06-12T00:00:00.000Z"));
    const free = await insertTrialWithOwner("Free Org", "trial-free@example.com", new Date("2026-06-16T09:00:00.000Z"));
    await db.update(clients).set({ plan: "free", billingStatus: "none" }).where(eq(clients.id, free));

    assert.equal(await runTrialWarningSweep(undefined, undefined, now), 0);
    const sent = await runTrialWarningSweep(undefined, app.mailer, now);
    const deduped = await runTrialWarningSweep(undefined, app.mailer, now);

    assert.equal(sent, 2);
    assert.equal(deduped, 0);
    const warnings = await db.select().from(emailQueue).where(eq(emailQueue.type, "pro_trial_warning"));
    assert.deepEqual(warnings.map((row) => row.toEmail).sort(), ["trial-10@example.com", "trial-1@example.com"]);
    assert.deepEqual(warnings.map((row) => (row.data as { daysRemaining: number; dedupeKey: string }).daysRemaining).sort((a, b) => a - b), [1, 10]);
    assert.ok(warnings.every((row) => (row.data as { dedupeKey: string }).dedupeKey.startsWith("pro_trial_warning:")));
  });
});

void test("trial warning sweep is a no-op in self-hosted mode", async () => {
  const app = await buildIntegrationServer();
  await insertTrialWithOwner("Self Hosted Warning", "self-hosted-warning@example.com", new Date(Date.now() + 10 * DAY));
  const sent = await runTrialWarningSweep(undefined, app.mailer);
  assert.equal(sent, 0);
  assert.equal(await db.$count(emailQueue, eq(emailQueue.type, "pro_trial_warning")), 0);
});
