import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { boardMembers, boards, clientMembers, clients, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { buildIntegrationServer } from "../../test/integration.js";
import * as OTPAuth from "otpauth";

type Session = { accessToken: string; user: { id: string; clientId: string; email: string } };

async function signup(app: Awaited<ReturnType<typeof buildIntegrationServer>>, email: string, orgName: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName, email, password: "Abc12345", displayName: email.split("@")[0] },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Session>();
}

async function createInvite(
  app: Awaited<ReturnType<typeof buildIntegrationServer>>,
  accessToken: string,
  payload: { orgRole: "admin" | "member"; workspaces?: Array<{ workspaceId: string; role: "admin" | "member" }> },
) {
  const response = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { ...payload, workspaces: payload.workspaces ?? [] },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ token: string }>().token;
}

void test("an existing owner accepts an organisation invite and can create another independently owned organisation", async () => {
  const app = await buildIntegrationServer();
  const existing = await signup(app, "existing-owner@example.com", "Personal Org");
  const host = await signup(app, "host-owner@example.com", "Host Org");
  const [workspace] = await db.insert(workspaces).values({ clientId: host.user.clientId, name: "Granted workspace" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Pinned board", position: "1000.0000000000" }).returning();
  const token = await createInvite(app, host.accessToken, {
    orgRole: "admin",
    workspaces: [{ workspaceId: workspace!.id, role: "admin" }],
  });

  const accepted = await app.inject({
    method: "POST",
    url: "/invites/accept",
    headers: { authorization: `Bearer ${existing.accessToken}` },
    payload: { token },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const acceptedSession = accepted.json<Session>();
  assert.equal(acceptedSession.user.clientId, host.user.clientId);

  const [identity] = await db.select({ email: users.email, homeClientId: users.clientId, activeClientId: users.activeClientId })
    .from(users).where(eq(users.id, existing.user.id)).limit(1);
  assert.equal(identity?.email, "existing-owner@example.com");
  assert.equal(identity?.homeClientId, existing.user.clientId);
  assert.equal(identity?.activeClientId, host.user.clientId);
  assert.equal(await db.$count(clientMembers, and(
    eq(clientMembers.clientId, existing.user.clientId),
    eq(clientMembers.userId, existing.user.id),
    eq(clientMembers.clientRole, "owner"),
    isNull(clientMembers.removedAt),
  )), 1);
  assert.equal(await db.$count(clientMembers, and(
    eq(clientMembers.clientId, host.user.clientId),
    eq(clientMembers.userId, existing.user.id),
    eq(clientMembers.clientRole, "admin"),
  )), 1);
  assert.equal(await db.$count(workspaceMembers, and(
    eq(workspaceMembers.workspaceId, workspace!.id),
    eq(workspaceMembers.userId, existing.user.id),
    eq(workspaceMembers.role, "admin"),
  )), 1);
  const [pinned] = await db.select({ role: boardMembers.role, pinned: boardMembers.pinned }).from(boardMembers).where(and(
    eq(boardMembers.boardId, board!.id),
    eq(boardMembers.userId, existing.user.id),
  )).limit(1);
  assert.deepEqual(pinned, { role: "editor", pinned: true });

  const additionalOrg = await app.inject({
    method: "POST",
    url: "/clients",
    headers: { authorization: `Bearer ${acceptedSession.accessToken}` },
    payload: { name: "Another organisation" },
  });
  assert.equal(additionalOrg.statusCode, 200, additionalOrg.body);
  const additionalSession = additionalOrg.json<Session>();
  assert.notEqual(additionalSession.user.clientId, existing.user.clientId);
  assert.notEqual(additionalSession.user.clientId, host.user.clientId);
  assert.equal(await db.$count(clientMembers, and(
    eq(clientMembers.clientId, additionalSession.user.clientId),
    eq(clientMembers.userId, existing.user.id),
    eq(clientMembers.clientRole, "owner"),
    isNull(clientMembers.removedAt),
  )), 1);
});

void test("parallel invite acceptances serialize at the paid seat cap", async () => {
  const app = await buildIntegrationServer();
  const host = await signup(app, "seat-host@example.com", "Seat Host");
  const first = await signup(app, "seat-first@example.com", "First Personal");
  const second = await signup(app, "seat-second@example.com", "Second Personal");
  await db.update(clients).set({ plan: "paid", billingStatus: "active", seatLimit: 2 }).where(eq(clients.id, host.user.clientId));

  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const token = await createInvite(app, host.accessToken, { orgRole: "member" });
    const responses = await Promise.all([first, second].map((candidate) => app.inject({
      method: "POST",
      url: "/invites/accept",
      headers: { authorization: `Bearer ${candidate.accessToken}` },
      payload: { token },
    })));
    assert.deepEqual(responses.map((response) => response.statusCode).sort((a, b) => a - b), [200, 402]);
    assert.equal(await db.$count(clientMembers, and(
      eq(clientMembers.clientId, host.user.clientId),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    )), 2);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("a reusable invite link cannot lift a suspended membership", async () => {
  const app = await buildIntegrationServer();
  const suspended = await signup(app, "suspended-member@example.com", "Suspended Home Org");
  const host = await signup(app, "suspending-host@example.com", "Suspending Host Org");
  const token = await createInvite(app, host.accessToken, { orgRole: "admin" });

  // Join once through the link, then get suspended by the platform (only staff and plan downgrades
  // set member-level suspendedAt; org admins have no unsuspend endpoint).
  const joined = await app.inject({
    method: "POST",
    url: "/invites/accept",
    headers: { authorization: `Bearer ${suspended.accessToken}` },
    payload: { token },
  });
  assert.equal(joined.statusCode, 200, joined.body);
  await db.update(clientMembers).set({ suspendedAt: new Date(), clientRole: "member" }).where(and(
    eq(clientMembers.clientId, host.user.clientId),
    eq(clientMembers.userId, suspended.user.id),
  ));

  // The still-valid link must not clear the suspension or restore the admin role.
  const retried = await app.inject({
    method: "POST",
    url: "/invites/accept",
    headers: { authorization: `Bearer ${suspended.accessToken}` },
    payload: { token },
  });
  assert.equal(retried.statusCode, 403, retried.body);
  const [membership] = await db.select({ suspendedAt: clientMembers.suspendedAt, clientRole: clientMembers.clientRole })
    .from(clientMembers)
    .where(and(eq(clientMembers.clientId, host.user.clientId), eq(clientMembers.userId, suspended.user.id)))
    .limit(1);
  assert.ok(membership?.suspendedAt);
  assert.equal(membership?.clientRole, "member");

  // A removed (not suspended) member may still re-join through the link.
  await db.update(clientMembers).set({ suspendedAt: null, removedAt: new Date() }).where(and(
    eq(clientMembers.clientId, host.user.clientId),
    eq(clientMembers.userId, suspended.user.id),
  ));
  const rejoined = await app.inject({
    method: "POST",
    url: "/invites/accept",
    headers: { authorization: `Bearer ${suspended.accessToken}` },
    payload: { token },
  });
  assert.equal(rejoined.statusCode, 200, rejoined.body);
});

// --- Organisation MFA policy on invitation paths -------------------------------------------------
// Password login already withholds a session until a mandated factor is enrolled. These tests pin the
// two other ways into an organisation (invite-driven signup and an existing account accepting an
// invite) to the same rule, since either one issuing tokens lets the member read and edit boards
// while unenrolled until a later refresh happens to reject them.

function totp(secret: string, label: string) {
  return new OTPAuth.TOTP({ issuer: "Kanera", label, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}

type EnrollmentChallenge = { status: string; challengeToken?: string; accessToken?: string };

async function completeRequiredEnrollment(app: Awaited<ReturnType<typeof buildIntegrationServer>>, challengeToken: string, email: string) {
  const started = await app.inject({ method: "POST", url: "/auth/mfa/required/enroll", payload: { challengeToken } });
  assert.equal(started.statusCode, 200, started.body);
  const { secret } = started.json<{ secret: string }>();
  const confirmed = await app.inject({ method: "POST", url: "/auth/mfa/required/enroll/confirm", payload: { challengeToken, code: totp(secret, email).generate() } });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const acknowledged = await app.inject({ method: "POST", url: "/auth/mfa/required/enroll/acknowledge", payload: { challengeToken } });
  assert.equal(acknowledged.statusCode, 200, acknowledged.body);
  assert.ok(acknowledged.cookies.find((cookie) => cookie.name === "kanera_rt"), "enrollment completion issues the refresh cookie");
  return acknowledged.json<Session>();
}

async function mfaHostWithBoard(app: Awaited<ReturnType<typeof buildIntegrationServer>>, email: string) {
  const host = await signup(app, email, "Secure Org");
  await db.update(clients).set({ requireMfa: true }).where(eq(clients.id, host.user.clientId));
  const [workspace] = await db.insert(workspaces).values({ clientId: host.user.clientId, name: "Secure workspace" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Secure board", position: "1000.0000000000" }).returning();
  return { host, workspaceId: workspace!.id, boardId: board!.id };
}

void test("an invite-driven signup into an organisation that requires MFA gets an enrollment challenge instead of a session", async () => {
  const app = await buildIntegrationServer();
  const { host, workspaceId, boardId } = await mfaHostWithBoard(app, "secure-host@example.com");
  const token = await createInvite(app, host.accessToken, { orgRole: "admin", workspaces: [{ workspaceId, role: "admin" }] });

  const email = "secure-invitee@example.com";
  const signedUp = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "ignored", email, password: "Abc12345", displayName: "Invitee", inviteToken: token },
  });
  assert.equal(signedUp.statusCode, 200, signedUp.body);
  const challenge = signedUp.json<EnrollmentChallenge>();
  assert.equal(challenge.status, "mfa_enrollment_required");
  assert.ok(challenge.challengeToken);
  assert.equal(challenge.accessToken, undefined, "no access token before enrollment");
  assert.equal(signedUp.cookies.some((cookie) => cookie.name === "kanera_rt"), false, "no refresh cookie before enrollment");

  // The account and membership exist; only the session is withheld.
  const [created] = await db.select({ id: users.id, clientId: users.clientId }).from(users).where(eq(users.email, email)).limit(1);
  assert.equal(created?.clientId, host.user.clientId);
  assert.equal(await db.$count(clientMembers, and(eq(clientMembers.clientId, host.user.clientId), eq(clientMembers.userId, created!.id))), 1);

  const session = await completeRequiredEnrollment(app, challenge.challengeToken!, email);
  assert.equal(session.user.clientId, host.user.clientId);
  const board = await app.inject({ method: "GET", url: `/boards/${boardId}`, headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(board.statusCode, 200, board.body);

  // From here on the account is an enrolled one: password login asks for the code, not enrollment.
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "Abc12345" } });
  assert.equal(login.json<EnrollmentChallenge>().status, "mfa_required");
});

void test("an existing account without MFA that accepts an invite from an organisation requiring MFA must enroll before it receives that organisation's session", async () => {
  const app = await buildIntegrationServer();
  const existingSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Personal Org", email: "existing-no-mfa@example.com", password: "Abc12345", displayName: "Existing" },
  });
  assert.equal(existingSignup.statusCode, 200, existingSignup.body);
  const existing = existingSignup.json<Session>();
  const existingRefreshCookie = existingSignup.cookies.find((cookie) => cookie.name === "kanera_rt")!.value;
  const { host, boardId } = await mfaHostWithBoard(app, "secure-host-2@example.com");
  const token = await createInvite(app, host.accessToken, { orgRole: "admin" });

  const accepted = await app.inject({
    method: "POST",
    url: "/invites/accept",
    headers: { authorization: `Bearer ${existing.accessToken}` },
    payload: { token },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const challenge = accepted.json<EnrollmentChallenge>();
  assert.equal(challenge.status, "mfa_enrollment_required");
  assert.ok(challenge.challengeToken);
  assert.equal(challenge.accessToken, undefined, "no access token for the MFA organisation before enrollment");
  assert.equal(accepted.cookies.some((cookie) => cookie.name === "kanera_rt"), false);

  // Membership moved, but neither the old token nor the old refresh cookie reaches the new organisation.
  assert.equal(await db.$count(clientMembers, and(eq(clientMembers.clientId, host.user.clientId), eq(clientMembers.userId, existing.user.id))), 1);
  const [identity] = await db.select({ activeClientId: users.activeClientId }).from(users).where(eq(users.id, existing.user.id)).limit(1);
  assert.equal(identity?.activeClientId, host.user.clientId);
  const boardWithOldToken = await app.inject({ method: "GET", url: `/boards/${boardId}`, headers: { authorization: `Bearer ${existing.accessToken}` } });
  assert.notEqual(boardWithOldToken.statusCode, 200, "the pre-acceptance token is scoped to the old organisation");
  const refreshed = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { kanera_rt: existingRefreshCookie }, payload: {} });
  assert.equal(refreshed.statusCode, 403, refreshed.body);

  const session = await completeRequiredEnrollment(app, challenge.challengeToken!, "existing-no-mfa@example.com");
  assert.equal(session.user.clientId, host.user.clientId);
  const board = await app.inject({ method: "GET", url: `/boards/${boardId}`, headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(board.statusCode, 200, board.body);
});

void test("an account that already has MFA enabled accepts an invite from an organisation requiring MFA and receives the session directly", async () => {
  const app = await buildIntegrationServer();
  const email = "existing-with-mfa@example.com";
  const enrolled = await signup(app, email, "Enrolled Org");
  const started = await app.inject({ method: "POST", url: "/auth/mfa/enroll", headers: { authorization: `Bearer ${enrolled.accessToken}` }, payload: { currentPassword: "Abc12345" } });
  assert.equal(started.statusCode, 200, started.body);
  const confirmed = await app.inject({
    method: "POST",
    url: "/auth/mfa/enroll/confirm",
    headers: { authorization: `Bearer ${enrolled.accessToken}` },
    payload: { code: totp(started.json<{ secret: string }>().secret, email).generate() },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const { host, boardId } = await mfaHostWithBoard(app, "secure-host-3@example.com");
  const token = await createInvite(app, host.accessToken, { orgRole: "admin" });

  const accepted = await app.inject({ method: "POST", url: "/invites/accept", headers: { authorization: `Bearer ${enrolled.accessToken}` }, payload: { token } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const session = accepted.json<Session>();
  assert.ok(session.accessToken, "an enrolled account is not challenged again");
  assert.equal(session.user.clientId, host.user.clientId);
  assert.ok(accepted.cookies.find((cookie) => cookie.name === "kanera_rt"));
  const board = await app.inject({ method: "GET", url: `/boards/${boardId}`, headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(board.statusCode, 200, board.body);
});
