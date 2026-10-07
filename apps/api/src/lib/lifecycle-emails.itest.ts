/**
 * Lifecycle emails are time-driven (organisation age, milestone age, weeks of inactivity), which an
 * E2E run cannot reach without faking weeks of history, and they only run in hosted mode. These
 * tests backdate rows directly and run the sweep against Postgres.
 *
 * Failure modes this file guards:
 * - mail sent outside hosted mode (self-hosted operators never opted into Kanera's marketing);
 * - the same moment sent twice across sweeps or restarts (claim ledger);
 * - the wrong audience: admins/members instead of owners, opted-out users, users with email off,
 *   analytics-excluded (staff/demo/seed) orgs, and a board-invite guest's silent home org;
 * - window errors: nudging an org that is too new, already set up, or long abandoned;
 * - two lifecycle emails landing within days of each other when an org qualifies for both;
 * - repeated inactivity mail inside the repeat window;
 * - an unsubscribe link that can be forged, or that touches more than the lifecycle flag.
 */
import "../test/setup.integration.js";
import {
  activityEvents,
  boardMembers,
  boards,
  clients,
  emailQueue,
  inviteTokens,
  lifecycleEmailSends,
  notificationSettings,
  users,
  workspaceAnalyticsMilestones,
  workspaces,
  type LifecycleEmailQueueData,
} from "@kanera/shared/schema";
import { eq, like } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildIntegrationServer } from "../test/integration.js";
import { insertTestUsers } from "../test/user-fixtures.js";
import { lifecycleUnsubscribeToken, runLifecycleEmailSweep, verifyLifecycleUnsubscribeToken } from "./lifecycle-emails.js";
import { emailHeaders } from "./mailer.js";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function inHostedMode<T>(fn: () => Promise<T>): Promise<T> {
  const prev = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    return await fn();
  } finally {
    env.KANERA_DEPLOYMENT_MODE = prev;
  }
}

async function createOrg(options: { slug: string; ageDays: number; analyticsExcluded?: boolean; plan?: "free" | "paid"; billingStatus?: "none" | "active" }) {
  const [client] = await db.insert(clients).values({
    name: `Org ${options.slug}`,
    createdAt: ago(options.ageDays),
    analyticsExcluded: options.analyticsExcluded ?? false,
    plan: options.plan ?? "free",
    billingStatus: options.billingStatus ?? "none",
  }).returning();
  const [owner] = await insertTestUsers(db, {
    clientId: client!.id,
    clientRole: "owner",
    email: `${options.slug}-owner@example.com`,
    passwordHash: "x",
    displayName: `Owner ${options.slug}`,
  });
  await db.update(clients).set({ createdByUserId: owner!.id }).where(eq(clients.id, client!.id));
  return { clientId: client!.id, ownerId: owner!.id, ownerEmail: owner!.email };
}

async function addBoard(clientId: string, options: { ageDays: number; kind?: "standard" | "board" }) {
  const [workspace] = await db.insert(workspaces).values({ clientId, name: "Delivery", kind: options.kind ?? "standard" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Launch", position: "1000.0000000000", createdAt: ago(options.ageDays) }).returning();
  return { workspaceId: workspace!.id, boardId: board!.id };
}

async function addActivity(clientId: string, actorId: string, ageDays: number) {
  await db.insert(activityEvents).values({ clientId, actorId, entityType: "card", entityId: actorId, action: "created", createdAt: ago(ageDays) });
}

async function lifecycleRows(type?: string) {
  const rows = await db.select().from(emailQueue).where(like(emailQueue.type, type ?? "lifecycle_%"));
  return rows.map((row) => ({ to: row.toEmail, type: row.type, data: row.data as LifecycleEmailQueueData }));
}

void test("lifecycle sweep is a no-op outside hosted mode", async () => {
  const app = await buildIntegrationServer();
  await createOrg({ slug: "selfhosted", ageDays: 3 });
  assert.equal(await runLifecycleEmailSweep(app.mailer), 0);
  assert.equal((await lifecycleRows()).length, 0);
  assert.equal(await db.$count(lifecycleEmailSends), 0);
});

void test("no-board nudge reaches only owners of new, real, unconfigured orgs, once", async () => {
  await inHostedMode(async () => {
    const app = await buildIntegrationServer();
    const eligible = await createOrg({ slug: "noboard", ageDays: 3 });
    await insertTestUsers(db, { clientId: eligible.clientId, clientRole: "admin", email: "noboard-admin@example.com", passwordHash: "x", displayName: "Admin" });
    await createOrg({ slug: "tooyoung", ageDays: 1 });
    await createOrg({ slug: "tooold", ageDays: 20 });
    await createOrg({ slug: "staff", ageDays: 3, analyticsExcluded: true });
    const configured = await createOrg({ slug: "configured", ageDays: 3 });
    await addBoard(configured.clientId, { ageDays: 2 });

    // A board-invite guest's silent home org: its creator is a guest on someone else's board.
    const host = await createOrg({ slug: "host", ageDays: 40 });
    const hostBoard = await addBoard(host.clientId, { ageDays: 30 });
    const guestHome = await createOrg({ slug: "guesthome", ageDays: 3 });
    await db.insert(boardMembers).values({ boardId: hostBoard.boardId, userId: guestHome.ownerId });

    // Owner who unsubscribed: the moment is still claimed so it is not retried, but nothing is sent.
    const optedOut = await createOrg({ slug: "optedout", ageDays: 3 });
    await db.insert(notificationSettings).values({ userId: optedOut.ownerId, lifecycleEmail: false });

    await runLifecycleEmailSweep(app.mailer);
    await runLifecycleEmailSweep(app.mailer);

    const rows = await lifecycleRows("lifecycle_no_board");
    assert.deepEqual(rows.map((row) => row.to), ["noboard-owner@example.com"]);
    assert.equal(rows[0]!.data.ctaUrl, "http://web.test/");
    assert.equal(rows[0]!.data.orgName, "Org noboard");
    assert.equal(verifyLifecycleUnsubscribeToken(new URL(rows[0]!.data.unsubscribeUrl).searchParams.get("token")!), eligible.ownerId);
    // Mail providers' own unsubscribe control: RFC 8058 one-click POST to the API, then the page.
    const [queued] = await db.select().from(emailQueue).where(eq(emailQueue.type, "lifecycle_no_board"));
    const headers = emailHeaders(queued!);
    const token = encodeURIComponent(lifecycleUnsubscribeToken(eligible.ownerId));
    assert.equal(headers?.["List-Unsubscribe"], `<http://api.test/api/email/unsubscribe/one-click?token=${token}>, <http://web.test/email/unsubscribe?token=${token}>`);
    assert.equal(headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    const claims = await db.select({ clientId: lifecycleEmailSends.clientId }).from(lifecycleEmailSends).where(eq(lifecycleEmailSends.kind, "no_board"));
    assert.deepEqual(claims.map((c) => c.clientId).sort(), [eligible.clientId, optedOut.clientId].sort());
  });
});

void test("users who turned email off entirely get no lifecycle email", async () => {
  await inHostedMode(async () => {
    const app = await buildIntegrationServer();
    const org = await createOrg({ slug: "emailoff", ageDays: 3 });
    await db.insert(notificationSettings).values({ userId: org.ownerId, emailEnabled: false });
    await runLifecycleEmailSweep(app.mailer);
    assert.equal((await lifecycleRows()).length, 0);
  });
});

void test("invite nudge needs a day-old live board, a team of one, and no invites ever", async () => {
  await inHostedMode(async () => {
    const app = await buildIntegrationServer();
    const solo = await createOrg({ slug: "solo", ageDays: 5 });
    await addBoard(solo.clientId, { ageDays: 2 });
    const invited = await createOrg({ slug: "invited", ageDays: 5 });
    await addBoard(invited.clientId, { ageDays: 2 });
    await db.insert(inviteTokens).values({ clientId: invited.clientId, tokenHash: "lifecycle-invite-token", createdById: invited.ownerId });
    const team = await createOrg({ slug: "team", ageDays: 5 });
    await addBoard(team.clientId, { ageDays: 2 });
    await insertTestUsers(db, { clientId: team.clientId, email: "team-member@example.com", passwordHash: "x", displayName: "Member" });
    const freshBoard = await createOrg({ slug: "freshboard", ageDays: 5 });
    await addBoard(freshBoard.clientId, { ageDays: 0 });

    await runLifecycleEmailSweep(app.mailer);

    const rows = await lifecycleRows("lifecycle_invite_team");
    assert.deepEqual(rows.map((row) => row.to), ["solo-owner@example.com"]);
    assert.equal(rows[0]!.data.ctaUrl, "http://web.test/settings/users");
  });
});

void test("an org qualifying for two moments gets one email, and the next only after the gap", async () => {
  await inHostedMode(async () => {
    const app = await buildIntegrationServer();
    const org = await createOrg({ slug: "both", ageDays: 5 });
    const { workspaceId } = await addBoard(org.clientId, { ageDays: 2 });
    await db.insert(workspaceAnalyticsMilestones).values({ workspaceId, meaningfulWorkCreatedAt: ago(2) });

    await runLifecycleEmailSweep(app.mailer);
    assert.deepEqual((await lifecycleRows()).map((row) => row.type), ["lifecycle_invite_team"]);

    // Age the claim past the three-day gap; early success is still inside its own window.
    await db.update(lifecycleEmailSends).set({ createdAt: ago(4) }).where(eq(lifecycleEmailSends.clientId, org.clientId));
    await runLifecycleEmailSweep(app.mailer);
    const rows = await lifecycleRows();
    assert.deepEqual(rows.map((row) => row.type).sort(), ["lifecycle_early_success", "lifecycle_invite_team"]);
    const early = rows.find((row) => row.type === "lifecycle_early_success")!;
    assert.equal(early.data.nextStep, "automations");
    assert.equal(early.data.ctaUrl, `http://web.test/w/${workspaceId}/settings/automations`);
  });
});

void test("early success on a standalone board points to My Cards, not workspace settings", async () => {
  await inHostedMode(async () => {
    const app = await buildIntegrationServer();
    const org = await createOrg({ slug: "standalone", ageDays: 25 });
    const { workspaceId } = await addBoard(org.clientId, { ageDays: 20, kind: "board" });
    await db.insert(workspaceAnalyticsMilestones).values({ workspaceId, meaningfulWorkCreatedAt: ago(3) });
    // Keep the org out of the inactivity and invite windows.
    await addActivity(org.clientId, org.ownerId, 1);
    await insertTestUsers(db, { clientId: org.clientId, email: "standalone-member@example.com", passwordHash: "x", displayName: "Member" });

    await runLifecycleEmailSweep(app.mailer);

    const rows = await lifecycleRows();
    assert.deepEqual(rows.map((row) => row.type), ["lifecycle_early_success"]);
    assert.equal(rows[0]!.data.nextStep, "my_cards");
    assert.equal(rows[0]!.data.ctaUrl, "http://web.test/my-cards");
  });
});

void test("inactive email fires once per quiet episode and never for abandoned or active orgs", async () => {
  await inHostedMode(async () => {
    const app = await buildIntegrationServer();
    const quiet = await createOrg({ slug: "quiet", ageDays: 40 });
    await addBoard(quiet.clientId, { ageDays: 39 });
    await addActivity(quiet.clientId, quiet.ownerId, 20);
    await db.update(users).set({ lastOnlineAt: ago(18) }).where(eq(users.id, quiet.ownerId));
    const active = await createOrg({ slug: "busy", ageDays: 40 });
    await addBoard(active.clientId, { ageDays: 39 });
    await addActivity(active.clientId, active.ownerId, 20);
    // Read-only use still counts: a recent realtime session keeps the org out of the window.
    await db.update(users).set({ lastOnlineAt: ago(2) }).where(eq(users.id, active.ownerId));
    const abandoned = await createOrg({ slug: "abandoned", ageDays: 200 });
    await addBoard(abandoned.clientId, { ageDays: 199 });
    await addActivity(abandoned.clientId, abandoned.ownerId, 90);
    const neverUsed = await createOrg({ slug: "neverused", ageDays: 40 });
    await addBoard(neverUsed.clientId, { ageDays: 39 });

    await runLifecycleEmailSweep(app.mailer);
    await runLifecycleEmailSweep(app.mailer);

    const rows = await lifecycleRows("lifecycle_inactive");
    assert.deepEqual(rows.map((row) => row.to), ["quiet-owner@example.com"]);
    const [claim] = await db.select().from(lifecycleEmailSends).where(eq(lifecycleEmailSends.clientId, quiet.clientId));
    assert.equal(claim!.dedupeKey, `since:${ago(18).toISOString().slice(0, 10)}`);

    // A later quiet episode inside the repeat window is not mailed again.
    await db.update(lifecycleEmailSends).set({ createdAt: ago(30) }).where(eq(lifecycleEmailSends.clientId, quiet.clientId));
    await db.update(users).set({ lastOnlineAt: ago(15) }).where(eq(users.id, quiet.ownerId));
    await runLifecycleEmailSweep(app.mailer);
    assert.equal((await lifecycleRows("lifecycle_inactive")).length, 1);
  });
});

void test("active check-in goes to paying or collaborating teams active this week, with plan-aware copy", async () => {
  await inHostedMode(async () => {
    const app = await buildIntegrationServer();
    const paid = await createOrg({ slug: "paid", ageDays: 45, plan: "paid", billingStatus: "active" });
    await addBoard(paid.clientId, { ageDays: 44 });
    await addActivity(paid.clientId, paid.ownerId, 1);
    const collaborating = await createOrg({ slug: "collab", ageDays: 45 });
    const { workspaceId } = await addBoard(collaborating.clientId, { ageDays: 44 });
    await db.insert(workspaceAnalyticsMilestones).values({ workspaceId, collaborationStartedAt: ago(25) });
    await addActivity(collaborating.clientId, collaborating.ownerId, 2);
    const soloFree = await createOrg({ slug: "solofree", ageDays: 45 });
    await addBoard(soloFree.clientId, { ageDays: 44 });
    await addActivity(soloFree.clientId, soloFree.ownerId, 1);

    await runLifecycleEmailSweep(app.mailer);

    const rows = await lifecycleRows("lifecycle_active_checkin");
    const byTo = new Map(rows.map((row) => [row.to, row.data]));
    assert.deepEqual([...byTo.keys()].sort(), ["collab-owner@example.com", "paid-owner@example.com"]);
    assert.equal(byTo.get("paid-owner@example.com")!.onFreePlan, false);
    assert.equal(byTo.get("collab-owner@example.com")!.onFreePlan, true);
    assert.equal(byTo.get("paid-owner@example.com")!.ctaUrl, "http://web.test/team-cards");
    assert.equal(byTo.get("paid-owner@example.com")!.feedbackEmail, "support@kanera.app", "feedback address defaults when unset");
  });
});

void test("unsubscribe link only clears the lifecycle flag of the user it was signed for", async () => {
  const app = await buildIntegrationServer();
  const org = await createOrg({ slug: "unsub", ageDays: 3 });
  const other = await createOrg({ slug: "unsubother", ageDays: 3 });
  const token = lifecycleUnsubscribeToken(org.ownerId);

  const forged = `${other.ownerId}.${token.split(".")[1]}`;
  const rejected = await app.inject({ method: "POST", url: "/email/unsubscribe", payload: { token: forged } });
  assert.equal(rejected.statusCode, 400);
  const garbage = await app.inject({ method: "POST", url: "/email/unsubscribe", payload: { token: "not-a-token" } });
  assert.equal(garbage.statusCode, 400);

  const ok = await app.inject({ method: "POST", url: "/email/unsubscribe", payload: { token } });
  assert.equal(ok.statusCode, 204);
  const again = await app.inject({ method: "POST", url: "/email/unsubscribe", payload: { token } });
  assert.equal(again.statusCode, 204);

  const settings = await db.select().from(notificationSettings);
  assert.equal(settings.length, 1, "the other user's settings were not touched");
  assert.equal(settings[0]!.userId, org.ownerId);
  assert.equal(settings[0]!.lifecycleEmail, false);
  assert.equal(settings[0]!.emailEnabled, true, "card notification email stays on");
});

void test("RFC 8058 one-click unsubscribe accepts the provider's form post and rejects forged tokens", async () => {
  const app = await buildIntegrationServer();
  const org = await createOrg({ slug: "oneclick", ageDays: 3 });
  const token = encodeURIComponent(lifecycleUnsubscribeToken(org.ownerId));
  const form = { "content-type": "application/x-www-form-urlencoded" };

  const forged = await app.inject({ method: "POST", url: `/email/unsubscribe/one-click?token=${org.ownerId}.forged`, headers: form, payload: "List-Unsubscribe=One-Click" });
  assert.equal(forged.statusCode, 400);
  // A GET (link scanner or prefetch) is not an unsubscribe.
  const get = await app.inject({ method: "GET", url: `/email/unsubscribe/one-click?token=${token}` });
  assert.equal(get.statusCode, 404);
  assert.equal(await db.$count(notificationSettings), 0);

  const ok = await app.inject({ method: "POST", url: `/email/unsubscribe/one-click?token=${token}`, headers: form, payload: "List-Unsubscribe=One-Click" });
  assert.equal(ok.statusCode, 200);
  const [settings] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, org.ownerId));
  assert.equal(settings?.lifecycleEmail, false);

  // Transactional mail never carries list headers.
  assert.equal(emailHeaders({ type: "import_completed", data: {} } as Parameters<typeof emailHeaders>[0]), undefined);
});
