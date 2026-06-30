import "../test/setup.integration.js";
import { clients, EMAIL_QUEUE_STATUS, emailQueue, inviteTokens } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { asc, eq } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../env.js";
import { setStripeClientForTests } from "./billing.js";
import { buildIntegrationServer } from "../test/integration.js";
import { newOpaqueToken } from "./tokens.js";
import { runEmailQueueCleanup, runEmailQueueSweep } from "./email-queue.js";

const smtpConfig = {
  host: "smtp.example.com",
  port: 587,
  security: "none" as const,
  fromEmail: "noreply@example.com",
};

const log = {
  info() { },
  error() { },
  warn() { },
} as never;

test("signup enqueues welcome email", async () => {
  const app = await buildIntegrationServer();

  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      displayName: "Ada",
      email: "ada@example.com",
      password: "Abc12345",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ user: { role: string } }>().user.role, "owner");
  const rows = await db.select().from(emailQueue);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, "welcome");
  assert.equal(rows[0]!.status, EMAIL_QUEUE_STATUS.queued);
  assert.equal(rows[0]!.toEmail, "ada@example.com");
});

void test("invite signup with an existing email returns a conflict instead of a server error", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      displayName: "Ada",
      email: "ada@example.com",
      password: "Abc12345",
    },
  });
  assert.equal(signup.statusCode, 200);

  const duplicateInviteSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Private",
      displayName: "Ada",
      email: "ada@example.com",
      password: "Abc12345",
      boardInviteToken: "invite-link-token",
    },
  });

  assert.equal(duplicateInviteSignup.statusCode, 409);
  assert.equal(duplicateInviteSignup.json<{ message: string }>().message, "An account already exists for this email. Sign in to accept the invite.");
});

void test("invite signup notifies organisation owners and admins for all invited roles", async () => {
  const app = await buildIntegrationServer();

  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      displayName: "Owner",
      email: "owner@example.com",
      password: "Abc12345",
    },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const ownerBody = ownerSignup.json() as { accessToken: string; user: { clientId: string; id: string } };

  for (const role of ["owner", "admin", "member"] as const) {
    let inviteToken: string;
    if (role === "owner") {
      const token = newOpaqueToken();
      await db.insert(inviteTokens).values({
        clientId: ownerBody.user.clientId,
        tokenHash: token.hash,
        orgRole: role,
        createdById: ownerBody.user.id,
      });
      inviteToken = token.raw;
    } else {
      const invite = await app.inject({
        method: "POST",
        url: "/clients/me/invites",
        headers: { authorization: `Bearer ${ownerBody.accessToken}` },
        payload: { orgRole: role, expiresInDays: 7, workspaces: [] },
      });
      assert.equal(invite.statusCode, 201);
      inviteToken = (invite.json() as { token: string }).token;
    }

    const accepted = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        displayName: `Accepted ${role}`,
        email: `accepted-${role}@example.com`,
        password: "Abc12345",
        inviteToken,
      },
    });
    assert.equal(accepted.statusCode, 200);
  }

  const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "invite_accepted")).orderBy(asc(emailQueue.createdAt));
  assert.equal(rows.length, 6);
  const originalOwnerRows = rows.filter((row) => row.toEmail === "owner@example.com");
  assert.equal(originalOwnerRows.length, 3);
  assert.deepEqual(
    originalOwnerRows.map((row) => ({ toEmail: row.toEmail, data: row.data })),
    ["owner", "admin", "member"].map((role) => ({
      toEmail: "owner@example.com",
      data: {
        context: "org",
        displayName: "Owner",
        acceptedByName: `Accepted ${role}`,
        acceptedByEmail: `accepted-${role}@example.com`,
        orgName: "Acme",
        orgRole: role,
        membersUrl: "http://web.test/settings/users",
      },
    })),
  );
});

void test("invite signup for a paid hosted org consumes a pre-purchased member seat without billing again", async () => {
  const previous = {
    mode: env.KANERA_DEPLOYMENT_MODE,
    secret: env.STRIPE_SECRET_KEY,
  };
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.STRIPE_SECRET_KEY = "sk_test_fake";
  let updateCount = 0;
  setStripeClientForTests({
    subscriptionItems: {
      retrieve: async () => ({ id: "si_member_seat", quantity: 1 }),
      update: async () => {
        updateCount += 1;
        return { id: "si_member_seat" };
      },
    },
  } as never);
  const app = await buildIntegrationServer();
  try {
    const ownerSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Paid Org Seats",
        displayName: "Owner",
        email: "paid-seat-owner@example.com",
        password: "Abc12345",
      },
    });
    assert.equal(ownerSignup.statusCode, 200);
    const ownerBody = ownerSignup.json() as { accessToken: string; user: { clientId: string; id: string } };
    await db
      .update(clients)
      .set({ billingStatus: "active", stripeSubscriptionItemId: "si_member_seat", seatLimit: 2 })
      .where(eq(clients.id, ownerBody.user.clientId));

    const invite = await app.inject({
      method: "POST",
      url: "/clients/me/invites",
      headers: { authorization: `Bearer ${ownerBody.accessToken}` },
      payload: { orgRole: "member", expiresInDays: 7, workspaces: [] },
    });
    assert.equal(invite.statusCode, 201);

    const accepted = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        displayName: "Accepted Member",
        email: "accepted-paid-seat@example.com",
        password: "Abc12345",
        inviteToken: (invite.json() as { token: string }).token,
      },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(updateCount, 0);

    const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "seat_billed"));
    assert.equal(rows.length, 0);
  } finally {
    setStripeClientForTests(null);
    env.KANERA_DEPLOYMENT_MODE = previous.mode;
    env.STRIPE_SECRET_KEY = previous.secret;
  }
});

test("forgot-password records immediate reset email and terminal failure without SMTP config", async () => {
  const app = await buildIntegrationServer();

  await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      displayName: "Ada",
      email: "ada@example.com",
      password: "Abc12345",
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/auth/forgot-password",
    payload: { email: "ada@example.com" },
  });

  assert.equal(response.statusCode, 200);
  const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "password_reset"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, EMAIL_QUEUE_STATUS.error);
  assert.equal(rows[0]!.retries, 1);
  assert.match(rows[0]!.lastError ?? "", /SMTP configuration/);
});

test("queue sweep sends queued email and marks success", async () => {
  const [row] = await db
    .insert(emailQueue)
    .values({
      toEmail: "ada@example.com",
      subject: "Welcome to Kanera",
      type: "welcome",
      data: { displayName: "Ada", loginUrl: "https://kanera.example/login" },
      status: EMAIL_QUEUE_STATUS.queued,
    })
    .returning();

  const delivered: string[] = [];
  const processed = await runEmailQueueSweep({
    db,
    log,
    resolveSmtpConfig: async () => smtpConfig,
    sendEmail: async ({ to }) => {
      delivered.push(to);
    },
  });

  assert.equal(processed, 1);
  assert.deepEqual(delivered, ["ada@example.com"]);
  const [updated] = await db.select().from(emailQueue).where(eq(emailQueue.id, row!.id));
  assert.equal(updated!.status, EMAIL_QUEUE_STATUS.success);
  assert.ok(updated!.sentAt);
});

test("queue sweep leaves queued emails untouched without SMTP config", async () => {
  const [row] = await db
    .insert(emailQueue)
    .values({
      toEmail: "ada@example.com",
      subject: "Welcome to Kanera",
      type: "welcome",
      data: { displayName: "Ada", loginUrl: "https://kanera.example/login" },
      status: EMAIL_QUEUE_STATUS.queued,
    })
    .returning();

  const delivered: string[] = [];
  const processed = await runEmailQueueSweep({
    db,
    log,
    resolveSmtpConfig: async () => null,
    sendEmail: async ({ to }) => {
      delivered.push(to);
    },
  });

  assert.equal(processed, 0);
  assert.deepEqual(delivered, []);
  const [updated] = await db.select().from(emailQueue).where(eq(emailQueue.id, row!.id));
  assert.equal(updated!.status, EMAIL_QUEUE_STATUS.queued);
  assert.equal(updated!.retries, 0);
  assert.equal(updated!.lastError, null);
});

test("queue sweep retries failures and marks third failure as error", async () => {
  const [row] = await db
    .insert(emailQueue)
    .values({
      toEmail: "ada@example.com",
      subject: "Welcome to Kanera",
      type: "welcome",
      data: { displayName: "Ada", loginUrl: "https://kanera.example/login" },
      status: EMAIL_QUEUE_STATUS.queued,
      retries: 2,
    })
    .returning();

  const processed = await runEmailQueueSweep({
    db,
    log,
    resolveSmtpConfig: async () => smtpConfig,
    sendEmail: async () => {
      throw new Error("smtp down");
    },
  });

  assert.equal(processed, 1);
  const [updated] = await db.select().from(emailQueue).where(eq(emailQueue.id, row!.id));
  assert.equal(updated!.status, EMAIL_QUEUE_STATUS.error);
  assert.equal(updated!.retries, 3);
  assert.equal(updated!.lastError, "smtp down");
});

test("queue sweep backs off a failed send so the next sweep skips it until due", async () => {
  const [row] = await db
    .insert(emailQueue)
    .values({
      toEmail: "ada@example.com",
      subject: "Welcome to Kanera",
      type: "welcome",
      data: { displayName: "Ada", loginUrl: "https://kanera.example/login" },
      status: EMAIL_QUEUE_STATUS.queued,
    })
    .returning();

  let attempts = 0;
  const deps = {
    db,
    log,
    resolveSmtpConfig: async () => smtpConfig,
    sendEmail: async () => {
      attempts += 1;
      throw new Error("smtp down");
    },
  };

  // First failure schedules a future nextAttemptAt and leaves the row queued for retry.
  const firstProcessed = await runEmailQueueSweep(deps);
  assert.equal(firstProcessed, 1);
  assert.equal(attempts, 1);
  const [afterFailure] = await db.select().from(emailQueue).where(eq(emailQueue.id, row!.id));
  assert.equal(afterFailure!.status, EMAIL_QUEUE_STATUS.queued);
  assert.equal(afterFailure!.retries, 1);
  assert.ok(afterFailure!.nextAttemptAt.getTime() > Date.now(), "nextAttemptAt should be in the future");

  // An immediate second sweep must skip the backed-off row rather than retry it every sweep.
  const secondProcessed = await runEmailQueueSweep(deps);
  assert.equal(secondProcessed, 0);
  assert.equal(attempts, 1);
  const [unchanged] = await db.select().from(emailQueue).where(eq(emailQueue.id, row!.id));
  assert.equal(unchanged!.retries, 1);
});

test("queue cleanup purges rows older than 30 days", async () => {
  await db.insert(emailQueue).values([
    {
      toEmail: "old@example.com",
      subject: "Welcome to Kanera",
      type: "welcome",
      data: { displayName: "Old", loginUrl: "https://kanera.example/login" },
      status: EMAIL_QUEUE_STATUS.error,
      createdAt: new Date("2026-04-01T00:00:00Z"),
    },
    {
      toEmail: "new@example.com",
      subject: "Welcome to Kanera",
      type: "welcome",
      data: { displayName: "New", loginUrl: "https://kanera.example/login" },
      status: EMAIL_QUEUE_STATUS.queued,
      createdAt: new Date("2026-05-10T00:00:00Z"),
    },
  ]);

  const deleted = await runEmailQueueCleanup({ db, log }, new Date("2026-05-25T00:00:00Z"));

  assert.equal(deleted, 1);
  const rows = await db.select().from(emailQueue);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toEmail, "new@example.com");
});
