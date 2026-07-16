import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { desc, eq, and } from "drizzle-orm";
import { clients, emailQueue, emailVerificationCodes, users } from "@kanera/shared/schema";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildIntegrationServer } from "../test/integration.js";

// The shared harness disables verification so legacy direct-signup fixtures keep working
// (see setup.integration.ts). These tests opt back in per-test and restore the flag.
async function withVerification<T>(fn: () => Promise<T>): Promise<T> {
  const prev = env.EMAIL_VERIFICATION_ENABLED;
  env.EMAIL_VERIFICATION_ENABLED = true;
  try {
    return await fn();
  } finally {
    env.EMAIL_VERIFICATION_ENABLED = prev;
  }
}

async function withSignupsDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const prev = env.SIGNUPS_ENABLED;
  env.SIGNUPS_ENABLED = false;
  try {
    return await fn();
  } finally {
    env.SIGNUPS_ENABLED = prev;
  }
}

// The raw code is recorded in the email_queue row (the audit trail of what we sent),
// while only its hash lives in email_verification_code. Tests read it from the queue.
async function latestCodeFor(email: string): Promise<string> {
  const [row] = await db
    .select({ data: emailQueue.data })
    .from(emailQueue)
    .where(and(eq(emailQueue.type, "email_verification"), eq(emailQueue.toEmail, email)))
    .orderBy(desc(emailQueue.createdAt))
    .limit(1);
  assert.ok(row, `expected a verification email for ${email}`);
  return (row.data as { code: string }).code;
}

void test("auth config exposes whether email verification is enabled", async () => {
  const app = await buildIntegrationServer();
  const prevVerification = env.EMAIL_VERIFICATION_ENABLED;
  const prevSiteKey = env.CLOUDFLARE_TURNSTILE_SITE_KEY;
  const prevSecretKey = env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  const prevMode = env.KANERA_DEPLOYMENT_MODE;
  const prevSignups = env.SIGNUPS_ENABLED;
  env.EMAIL_VERIFICATION_ENABLED = false;
  env.SIGNUPS_ENABLED = true;
  try {
    const disabled = await app.inject({ method: "GET", url: "/auth/config" });
    assert.equal(disabled.statusCode, 200);
    assert.deepEqual(disabled.json(), { emailVerificationEnabled: false, signupsEnabled: true, turnstileSiteKey: null, kaneraEnvironment: env.KANERA_ENVIRONMENT, deploymentMode: env.KANERA_DEPLOYMENT_MODE });

    env.EMAIL_VERIFICATION_ENABLED = true;
    env.SIGNUPS_ENABLED = false;
    const enabled = await app.inject({ method: "GET", url: "/auth/config" });
    assert.equal(enabled.statusCode, 200);
    assert.deepEqual(enabled.json(), { emailVerificationEnabled: true, signupsEnabled: false, turnstileSiteKey: null, kaneraEnvironment: env.KANERA_ENVIRONMENT, deploymentMode: env.KANERA_DEPLOYMENT_MODE });

    env.SIGNUPS_ENABLED = true;
    env.CLOUDFLARE_TURNSTILE_SITE_KEY = "site-key";
    env.CLOUDFLARE_TURNSTILE_SECRET_KEY = "secret-key";
    env.KANERA_DEPLOYMENT_MODE = "self_hosted";
    const selfHosted = await app.inject({ method: "GET", url: "/auth/config" });
    assert.equal(selfHosted.statusCode, 200);
    assert.deepEqual(selfHosted.json(), { emailVerificationEnabled: true, signupsEnabled: true, turnstileSiteKey: null, kaneraEnvironment: env.KANERA_ENVIRONMENT, deploymentMode: "self_hosted" });

    env.KANERA_DEPLOYMENT_MODE = "hosted";
    const hosted = await app.inject({ method: "GET", url: "/auth/config" });
    assert.equal(hosted.statusCode, 200);
    assert.deepEqual(hosted.json(), { emailVerificationEnabled: true, signupsEnabled: true, turnstileSiteKey: "site-key", kaneraEnvironment: env.KANERA_ENVIRONMENT, deploymentMode: "hosted" });
  } finally {
    env.EMAIL_VERIFICATION_ENABLED = prevVerification;
    env.CLOUDFLARE_TURNSTILE_SITE_KEY = prevSiteKey;
    env.CLOUDFLARE_TURNSTILE_SECRET_KEY = prevSecretKey;
    env.KANERA_DEPLOYMENT_MODE = prevMode;
    env.SIGNUPS_ENABLED = prevSignups;
  }
});

void test("signup succeeds without a code when verification is disabled by default", async () => {
  const app = await buildIntegrationServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Acme", email: "disabled-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(res.statusCode, 200);

  const [user] = await db.select().from(users).where(eq(users.email, "disabled-owner@example.com"));
  assert.ok(user);
  assert.equal(user.emailVerifiedAt, null);
});

void test("invite signup succeeds without a code when verification is disabled", async () => {
  const app = await buildIntegrationServer();
  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Invite Org", email: "invite-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const ownerToken = ownerSignup.json<{ accessToken: string }>().accessToken;

  const invite = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { orgRole: "member", expiresInDays: 7, workspaces: [] },
  });
  assert.equal(invite.statusCode, 201);
  const inviteToken = invite.json<{ token: string }>().token;

  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: "invitee@example.com", password: "Abc12345", displayName: "Invitee", inviteToken },
  });
  assert.equal(res.statusCode, 200);

  const [user] = await db.select().from(users).where(eq(users.email, "invitee@example.com"));
  assert.ok(user);
  assert.equal(user.emailVerifiedAt, null);
  assert.equal(user.clientId, ownerSignup.json<{ user: { clientId: string } }>().user.clientId);
});

void test("disabled signups reject public signup without creating rows", async () => {
  await withSignupsDisabled(async () => {
    const app = await buildIntegrationServer();
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Closed Org", email: "closed-owner@example.com", password: "Abc12345", displayName: "Owner" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json<{ message: string }>().message, "Signups are currently disabled.");

    const userRows = await db.select({ id: users.id }).from(users).where(eq(users.email, "closed-owner@example.com"));
    assert.equal(userRows.length, 0);
    const clientRows = await db.select({ id: clients.id }).from(clients).where(eq(clients.name, "Closed Org"));
    assert.equal(clientRows.length, 0);
  });
});

void test("disabled signups reject public verification requests before sending email", async () => {
  await withVerification(async () => {
    await withSignupsDisabled(async () => {
      const app = await buildIntegrationServer();
      const res = await app.inject({
        method: "POST",
        url: "/auth/request-email-verification",
        payload: { email: "closed-verify@example.com" },
      });
      assert.equal(res.statusCode, 403);

      const queued = await db.select({ id: emailQueue.id }).from(emailQueue).where(eq(emailQueue.toEmail, "closed-verify@example.com"));
      assert.equal(queued.length, 0);
    });
  });
});

void test("disabled signups still allow valid organisation invite signup", async () => {
  const app = await buildIntegrationServer();
  const ownerSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Invite While Closed", email: "closed-invite-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(ownerSignup.statusCode, 200);
  const ownerToken = ownerSignup.json<{ accessToken: string }>().accessToken;

  const invite = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { orgRole: "member", expiresInDays: 7, workspaces: [] },
  });
  assert.equal(invite.statusCode, 201);
  const inviteToken = invite.json<{ token: string }>().token;

  await withSignupsDisabled(async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "closed-invitee@example.com", password: "Abc12345", displayName: "Invitee", inviteToken },
    });
    assert.equal(res.statusCode, 200);

    const [user] = await db.select().from(users).where(eq(users.email, "closed-invitee@example.com"));
    assert.ok(user);
    assert.equal(user.clientId, ownerSignup.json<{ user: { clientId: string } }>().user.clientId);
  });
});

void test("disabled signups reject board-invite-only signup", async () => {
  await withSignupsDisabled(async () => {
    const app = await buildIntegrationServer();
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Board Guest Home",
        email: "closed-board-guest@example.com",
        password: "Abc12345",
        displayName: "Guest",
        boardInviteToken: "board-token",
      },
    });
    assert.equal(res.statusCode, 403);

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, "closed-board-guest@example.com"));
    assert.equal(rows.length, 0);
  });
});

void test("changing email succeeds without a code when verification is disabled", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Email Change Org", email: "change-disabled@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const token = signup.json<{ accessToken: string }>().accessToken;

  const changed = await app.inject({
    method: "POST",
    url: "/auth/me/email",
    headers: { authorization: `Bearer ${token}` },
    payload: { email: "change-disabled-next@example.com" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json<{ email: string }>().email, "change-disabled-next@example.com");

  const [user] = await db.select().from(users).where(eq(users.id, signup.json<{ user: { id: string } }>().user.id));
  assert.equal(user!.email, "change-disabled-next@example.com");
  assert.equal(user!.emailVerifiedAt, null);
});

void test("signup requires a verification code when verification is enabled", async () => {
  await withVerification(async () => {
    const app = await buildIntegrationServer();
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Acme", email: "owner@example.com", password: "Abc12345", displayName: "Owner" },
    });
    assert.equal(res.statusCode, 400);
    // No account should be created without a verified code.
    const rows = await db.select().from(users).where(eq(users.email, "owner@example.com"));
    assert.equal(rows.length, 0);
  });
});

void test("signup rejects a wrong code without consuming the issued one", async () => {
  await withVerification(async () => {
    const app = await buildIntegrationServer();
    const requested = await app.inject({
      method: "POST",
      url: "/auth/request-email-verification",
      payload: { email: "owner@example.com" },
    });
    assert.equal(requested.statusCode, 200);

    const bad = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Acme", email: "owner@example.com", password: "Abc12345", displayName: "Owner", code: "000000" },
    });
    assert.equal(bad.statusCode, 400);

    // The attempt counter persisted (it must survive even though signup threw) and the
    // code is still unconsumed, so the real code can still complete signup.
    const [codeRow] = await db.select().from(emailVerificationCodes).where(eq(emailVerificationCodes.email, "owner@example.com"));
    assert.ok(codeRow);
    assert.equal(codeRow.attempts, 1);
    assert.equal(codeRow.consumedAt, null);
  });
});

void test("signup succeeds with a valid code and marks the email verified", async () => {
  await withVerification(async () => {
    const app = await buildIntegrationServer();
    await app.inject({ method: "POST", url: "/auth/request-email-verification", payload: { email: "owner@example.com" } });
    const code = await latestCodeFor("owner@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Acme", email: "owner@example.com", password: "Abc12345", displayName: "Owner", code },
    });
    assert.equal(res.statusCode, 200);

    const [user] = await db.select().from(users).where(eq(users.email, "owner@example.com"));
    assert.ok(user);
    assert.ok(user.emailVerifiedAt, "expected emailVerifiedAt to be set");

    // The code is single-use: a second signup with the same code is rejected.
    const reuse = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Acme2", email: "other@example.com", password: "Abc12345", displayName: "Other", code },
    });
    assert.equal(reuse.statusCode, 400);
  });
});

void test("request-email-verification refuses an already-registered address", async () => {
  await withVerification(async () => {
    const app = await buildIntegrationServer();
    await app.inject({ method: "POST", url: "/auth/request-email-verification", payload: { email: "owner@example.com" } });
    const code = await latestCodeFor("owner@example.com");
    await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Acme", email: "owner@example.com", password: "Abc12345", displayName: "Owner", code },
    });

    const again = await app.inject({
      method: "POST",
      url: "/auth/request-email-verification",
      payload: { email: "owner@example.com" },
    });
    assert.equal(again.statusCode, 409);
  });
});

void test("changing email requires verifying the new address", async () => {
  await withVerification(async () => {
    const app = await buildIntegrationServer();
    await app.inject({ method: "POST", url: "/auth/request-email-verification", payload: { email: "owner@example.com" } });
    const signupCode = await latestCodeFor("owner@example.com");
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Acme", email: "owner@example.com", password: "Abc12345", displayName: "Owner", code: signupCode },
    });
    assert.equal(signup.statusCode, 200);
    const token = signup.json<{ accessToken: string }>().accessToken;
    const auth = { authorization: `Bearer ${token}` };

    // A wrong code must not move the address.
    const badConfirm = await app.inject({
      method: "POST",
      url: "/auth/me/email",
      headers: auth,
      payload: { email: "new@example.com", code: "000000" },
    });
    assert.equal(badConfirm.statusCode, 400);

    const requested = await app.inject({
      method: "POST",
      url: "/auth/me/email/request-verification",
      headers: auth,
      payload: { email: "new@example.com" },
    });
    assert.equal(requested.statusCode, 200);
    const changeCode = await latestCodeFor("new@example.com");

    const confirmed = await app.inject({
      method: "POST",
      url: "/auth/me/email",
      headers: auth,
      payload: { email: "new@example.com", code: changeCode },
    });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json<{ email: string }>().email, "new@example.com");

    const [user] = await db.select().from(users).where(eq(users.id, signup.json<{ user: { id: string } }>().user.id));
    assert.equal(user!.email, "new@example.com");
  });
});
