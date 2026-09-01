import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  boardInvitations,
  boardMembers,
  boards,
  clientMembers,
  clients,
  emailQueue,
  eventOutbox,
  users,
} from "@kanera/shared/schema";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildIntegrationServer } from "../test/integration.js";
import { signupOwner } from "../test/api-fixtures.js";

async function createBoardInvite(
  app: Awaited<ReturnType<typeof buildIntegrationServer>>,
  options: { email: string; assignedItemsOnly?: boolean; boardCount?: number; seed: string },
) {
  const host = await signupOwner(app, {
    orgName: `Board Invite Host ${options.seed}`,
    email: `board-invite-host-${options.seed}@example.com`,
    displayName: "Host Owner",
  });
  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: host.auth,
    payload: { name: "Host Workspace" },
  });
  assert.equal(workspaceResponse.statusCode, 201, workspaceResponse.body);
  const workspace = workspaceResponse.json<{ id: string }>();
  const [initialBoard] = await db.insert(boards).values({
    workspaceId: workspace.id,
    name: "Guest Board 1",
    position: "1000.0000000000",
  }).returning();
  assert.ok(initialBoard);
  const inviteResponse = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: host.auth,
    payload: {
      boardId: initialBoard.id,
      email: options.email,
      role: "editor",
      assignedItemsOnly: options.assignedItemsOnly ?? false,
    },
  });
  assert.equal(inviteResponse.statusCode, 201, inviteResponse.body);
  let inviteBody = inviteResponse.json<{ token: string; invite: { id: string } }>();

  for (let index = 1; index < (options.boardCount ?? 1); index += 1) {
    const [board] = await db.insert(boards).values({
      workspaceId: workspace.id,
      name: `Guest Board ${index + 1}`,
      position: `${(index + 1) * 1000}.0000000000`,
    }).returning();
    assert.ok(board);
    const bundled = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/guests/invitations`,
      headers: host.auth,
      payload: { boardId: board.id, email: options.email, role: "observer" },
    });
    assert.equal(bundled.statusCode, 201, bundled.body);
    inviteBody = bundled.json<{ token: string; invite: { id: string } }>();
  }

  return { host, workspace, initialBoard, token: inviteBody.token, invitationId: inviteBody.invite.id };
}

void test("board invite signup rejects an email mismatch before creating an account", async () => {
  const app = await buildIntegrationServer();
  const invite = await createBoardInvite(app, { email: "invited-mismatch@example.com", seed: "mismatch" });

  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Should Not Exist",
      email: "different@example.com",
      password: "Abc12345",
      displayName: "Wrong Recipient",
      boardInviteToken: invite.token,
    },
  });

  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json<{ code: string }>().code, "BOARD_INVITE_EMAIL_MISMATCH");
  assert.equal(await db.$count(users, eq(users.email, "different@example.com")), 0);
});

void test("closed public signups allow a valid board invite and reject missing or invalid intent", async () => {
  const app = await buildIntegrationServer();
  const email = "closed-board-invite@example.com";
  const invite = await createBoardInvite(app, { email, seed: "closed" });
  const previous = env.SIGNUPS_ENABLED;
  env.SIGNUPS_ENABLED = false;
  try {
    const missing = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "missing-intent@example.com", password: "Abc12345", displayName: "Missing" },
    });
    assert.equal(missing.statusCode, 403);

    const invalid = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "invalid-intent@example.com", password: "Abc12345", displayName: "Invalid", boardInviteToken: "invalid" },
    });
    assert.equal(invalid.statusCode, 401);

    const valid = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: "Abc12345", displayName: "Invited Guest", boardInviteToken: invite.token },
    });
    assert.equal(valid.statusCode, 200, valid.body);
  } finally {
    env.SIGNUPS_ENABLED = previous;
  }
});

void test("board invite signup keeps restricted grants, uses a private home org, and lands on the board", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const app = await buildIntegrationServer();
    const email = "restricted-board-invite@example.com";
    const invite = await createBoardInvite(app, { email, assignedItemsOnly: true, seed: "restricted" });
    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        orgName: "Ignored Name",
        email,
        password: "Abc12345",
        displayName: "Restricted Guest",
        boardInviteToken: invite.token,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<{ user: { id: string; clientId: string; boardInviteRedirect: string | null } }>();
    assert.equal(body.user.boardInviteRedirect, `/b/${invite.initialBoard.id}`);

    const [homeClient] = await db
      .select({ name: clients.name, plan: clients.plan, billingStatus: clients.billingStatus, currentPeriodEnd: clients.currentPeriodEnd })
      .from(clients)
      .where(eq(clients.id, body.user.clientId));
    assert.equal(homeClient?.name, "Private");
    // The silent home org must never enter the hosted trial lifecycle: the trial-expiry sweeps
    // select on billingStatus='trialing' and would email warnings for a trial never announced.
    assert.equal(homeClient?.plan, "free");
    assert.equal(homeClient?.billingStatus, "none");
    assert.equal(homeClient?.currentPeriodEnd, null);
    const [membership] = await db.select({ assignedItemsOnly: boardMembers.assignedItemsOnly })
      .from(boardMembers)
      .where(and(eq(boardMembers.boardId, invite.initialBoard.id), eq(boardMembers.userId, body.user.id)));
    assert.equal(membership?.assignedItemsOnly, true);
    const guestEmails = await db.select({ type: emailQueue.type }).from(emailQueue).where(eq(emailQueue.toEmail, email));
    assert.equal(guestEmails.some((row) => row.type === "welcome"), true);
    assert.equal(guestEmails.some((row) => row.type === "pro_trial_started"), false);
    assert.equal(await db.$count(eventOutbox, and(
      eq(eventOutbox.scopeId, invite.initialBoard.id),
      eq(eventOutbox.eventType, "board:member:added"),
    )), 1);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("a full host seat pool rolls back the guest account and private client", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const app = await buildIntegrationServer();
    const email = "atomic-board-invite@example.com";
    const invite = await createBoardInvite(app, { email, boardCount: 2, seed: "atomic" });
    await db.update(clients).set({ billingStatus: "active", seatLimit: 1 }).where(eq(clients.id, invite.host.user.clientId));
    const clientCountBefore = await db.$count(clients);

    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: "Abc12345", displayName: "Atomic Guest", boardInviteToken: invite.token },
    });
    assert.equal(response.statusCode, 402, response.body);
    assert.equal(response.json<{ code: string }>().code, "SEAT_LIMIT_REACHED");
    assert.equal(await db.$count(users, eq(users.email, email)), 0);
    assert.equal(await db.$count(clients), clientCountBefore);
    assert.equal(await db.$count(boardMembers), 0);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("a board invite from the org being joined via org invite is skipped, not redeemed", async () => {
  const app = await buildIntegrationServer();
  const email = "combined-invite@example.com";
  const invite = await createBoardInvite(app, { email, seed: "combined" });
  const orgInviteResponse = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: invite.host.auth,
    payload: { orgRole: "member", workspaces: [] },
  });
  assert.equal(orgInviteResponse.statusCode, 201, orgInviteResponse.body);
  const orgToken = orgInviteResponse.json<{ token: string }>().token;

  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      email,
      password: "Abc12345",
      displayName: "Combined Invitee",
      inviteToken: orgToken,
      boardInviteToken: invite.token,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ user: { id: string; clientId: string; boardInviteRedirect: string | null } }>();
  // Joined the host org as a member; the guest invitation must not also create board_members rows.
  assert.equal(body.user.clientId, invite.host.user.clientId);
  assert.equal(body.user.boardInviteRedirect, null);
  assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, body.user.id)), 0);
  assert.equal(await db.$count(clientMembers, and(
    eq(clientMembers.clientId, invite.host.user.clientId),
    eq(clientMembers.userId, body.user.id),
  )), 1);
  const [invitation] = await db.select({ acceptedAt: boardInvitations.acceptedAt })
    .from(boardInvitations)
    .where(eq(boardInvitations.id, invite.invitationId));
  assert.equal(invitation?.acceptedAt, null);
});

void test("an invitation whose every board is archived is dead on lookup and signup", async () => {
  const app = await buildIntegrationServer();
  const email = "archived-board-invite@example.com";
  const invite = await createBoardInvite(app, { email, seed: "archived" });
  await db.update(boards).set({ archivedAt: new Date() }).where(eq(boards.id, invite.initialBoard.id));

  const lookup = await app.inject({ method: "GET", url: `/board-invitations/lookup?token=${encodeURIComponent(invite.token)}` });
  assert.equal(lookup.statusCode, 404, lookup.body);

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password: "Abc12345", displayName: "Archived Guest", boardInviteToken: invite.token },
  });
  assert.equal(signup.statusCode, 400, signup.body);
  assert.equal(await db.$count(users, eq(users.email, email)), 0);
});

void test("existing accounts get board-aware conflicts and pending invitations on home", async () => {
  const app = await buildIntegrationServer();
  const email = "existing-board-invite@example.com";
  const invite = await createBoardInvite(app, { email, seed: "existing" });
  const existing = await signupOwner(app, { orgName: "Existing Home", email, displayName: "Existing User" });

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password: "Abc12345", displayName: "Existing User", boardInviteToken: invite.token },
  });
  assert.equal(signup.statusCode, 409, signup.body);
  assert.deepEqual(signup.json<{ code: string; boardInvite: boolean; orgName: string }>(), {
    code: "ACCOUNT_EXISTS",
    message: "An account already exists for this email. Sign in to accept the invite.",
    boardInvite: true,
    orgName: `Board Invite Host existing`,
  });

  const previousVerification = env.EMAIL_VERIFICATION_ENABLED;
  env.EMAIL_VERIFICATION_ENABLED = true;
  try {
    const verification = await app.inject({
      method: "POST",
      url: "/auth/request-email-verification",
      payload: { email, boardInviteToken: invite.token },
    });
    assert.equal(verification.statusCode, 409, verification.body);
    assert.equal(verification.json<{ code: string; boardInvite: boolean }>().code, "ACCOUNT_EXISTS");
    assert.equal(verification.json<{ code: string; boardInvite: boolean }>().boardInvite, true);
  } finally {
    env.EMAIL_VERIFICATION_ENABLED = previousVerification;
  }

  const lookup = await app.inject({ method: "GET", url: `/board-invitations/lookup?token=${encodeURIComponent(invite.token)}` });
  assert.equal(lookup.statusCode, 200, lookup.body);
  assert.equal(lookup.json<{ email: string }>().email, email);

  const home = await app.inject({ method: "GET", url: "/home/boards", headers: existing.auth });
  assert.equal(home.statusCode, 200, home.body);
  const pending = home.json<{ pendingBoardInvitations: Array<{ id: string; orgName: string; boards: Array<{ boardId: string }> }> }>().pendingBoardInvitations;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, invite.invitationId);
  assert.equal(pending[0]?.orgName, "Board Invite Host existing");
  assert.equal(pending[0]?.boards[0]?.boardId, invite.initialBoard.id);
});
