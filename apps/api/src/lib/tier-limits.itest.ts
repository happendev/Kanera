import "../test/setup.integration.js";
import { clients, inviteTokens, lists, users } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../db.js";
import { env } from "../env.js";
import { hashOpaqueToken } from "./tokens.js";
import { buildIntegrationServer } from "../test/integration.js";

type SignupResponse = { accessToken: string; user: { id: string; clientId: string } };
type WorkspaceResponse = { id: string };
type BoardResponse = { id: string };

// Signs a brand-new org up. In hosted mode signup seeds a trialing (paid) org, so callers that want
// to exercise free-tier limits must downgrade the client afterwards via setFreeTier.
async function signupOrg(app: Awaited<ReturnType<typeof buildIntegrationServer>>, name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: name, email: `owner-${slug}@example.com`, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(res.statusCode, 200);
  return res.json<SignupResponse>();
}

async function setBilling(clientId: string, plan: "free" | "paid", billingStatus: string) {
  await db.update(clients).set({ plan, billingStatus: billingStatus as never }).where(eq(clients.id, clientId));
}

async function createWorkspace(app: Awaited<ReturnType<typeof buildIntegrationServer>>, token: string, name: string) {
  const res = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  return res;
}

async function withHosted<T>(fn: () => Promise<T>): Promise<T> {
  const previous = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    return await fn();
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previous;
  }
}

void test("hosted free org can create multiple workspaces", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const { accessToken, user } = await signupOrg(app, "Free WS Org");
    await setBilling(user.clientId, "free", "none");

    const first = await createWorkspace(app, accessToken, "First");
    assert.equal(first.statusCode, 201);
    const second = await createWorkspace(app, accessToken, "Second");
    assert.equal(second.statusCode, 201);

    // Paid orgs are also unlimited.
    await setBilling(user.clientId, "paid", "active");
    const third = await createWorkspace(app, accessToken, "Third");
    assert.equal(third.statusCode, 201);
  });

  // Self-hosted mode never enforces tier limits.
  const app = await buildIntegrationServer();
  const { accessToken } = await signupOrg(app, "Self Hosted WS Org");
  assert.equal((await createWorkspace(app, accessToken, "A")).statusCode, 201);
  assert.equal((await createWorkspace(app, accessToken, "B")).statusCode, 201);
});

void test("hosted signup starts a trial and returns trial entitlements", async () => {
  await withHosted(async () => {
    const previousTrialDays = env.HOSTED_TRIAL_DAYS;
    env.HOSTED_TRIAL_DAYS = 14;
    try {
      const app = await buildIntegrationServer();
      const before = Date.now();
      const signup = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: {
          orgName: "Trial Signup Org",
          email: "trial-signup@example.com",
          password: "Abc12345",
          displayName: "Trial Owner",
        },
      });
      assert.equal(signup.statusCode, 200);
      const body = signup.json<SignupResponse & { user: { entitlements: { tier: string; limited: boolean; trialEndsAt: string | null } } }>();
      const [client] = await db.select().from(clients).where(eq(clients.id, body.user.clientId)).limit(1);
      assert.equal(client?.plan, "paid");
      assert.equal(client?.billingStatus, "trialing");
      assert.ok(client?.currentPeriodEnd);
      assert.ok(client!.currentPeriodEnd!.getTime() >= before + 13 * 86_400_000);
      assert.equal(body.user.entitlements.tier, "trial");
      assert.equal(body.user.entitlements.limited, false);
      assert.equal(body.user.entitlements.trialEndsAt, client!.currentPeriodEnd!.toISOString());
    } finally {
      env.HOSTED_TRIAL_DAYS = previousTrialDays;
    }
  });
});

void test("auth account payload returns free, paid, trial, and self-hosted entitlement shapes", async () => {
  await withHosted(async () => {
    const previous = {
      boards: env.HOSTED_FREE_MAX_BOARDS,
      members: env.HOSTED_FREE_MAX_ORG_MEMBERS,
      automations: env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS,
    };
    env.HOSTED_FREE_MAX_BOARDS = 5;
    env.HOSTED_FREE_MAX_ORG_MEMBERS = 7;
    env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS = 3;
    try {
      const app = await buildIntegrationServer();
      const { accessToken, user } = await signupOrg(app, "Entitlements Free Org");
      await setBilling(user.clientId, "free", "none");

      const freeMe = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${accessToken}` } });
      assert.equal(freeMe.statusCode, 200);
      assert.deepEqual(freeMe.json<{ entitlements: unknown }>().entitlements, {
        tier: "free",
        trialEndsAt: null,
        limited: true,
        maxBoards: 5,
        maxOrgMembers: 7,
        maxEnabledAutomations: 3,
        guestsAllowed: false,
        apiAllowed: false,
        webhooksAllowed: false,
      });

      await setBilling(user.clientId, "paid", "active");
      const paidMe = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${accessToken}` } });
      assert.equal(paidMe.json<{ entitlements: { tier: string; limited: boolean; guestsAllowed: boolean } }>().entitlements.tier, "paid");
      assert.equal(paidMe.json<{ entitlements: { limited: boolean } }>().entitlements.limited, false);
      assert.equal(paidMe.json<{ entitlements: { guestsAllowed: boolean } }>().entitlements.guestsAllowed, true);

      const trialEnd = new Date("2026-07-01T00:00:00.000Z");
      await db.update(clients).set({ plan: "paid", billingStatus: "trialing", currentPeriodEnd: trialEnd }).where(eq(clients.id, user.clientId));
      const trialMe = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${accessToken}` } });
      assert.equal(trialMe.json<{ entitlements: { tier: string; trialEndsAt: string | null } }>().entitlements.tier, "trial");
      assert.equal(trialMe.json<{ entitlements: { trialEndsAt: string | null } }>().entitlements.trialEndsAt, trialEnd.toISOString());
    } finally {
      env.HOSTED_FREE_MAX_BOARDS = previous.boards;
      env.HOSTED_FREE_MAX_ORG_MEMBERS = previous.members;
      env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS = previous.automations;
    }
  });

  const app = await buildIntegrationServer();
  const { accessToken } = await signupOrg(app, "Self Hosted Entitlements Org");
  const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json<{ entitlements: { limited: boolean; guestsAllowed: boolean } }>().entitlements.limited, false);
  assert.equal(me.json<{ entitlements: { guestsAllowed: boolean } }>().entitlements.guestsAllowed, true);
});

void test("hosted free org is capped at three boards across the organisation", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const { accessToken, user } = await signupOrg(app, "Free Board Org");
    await setBilling(user.clientId, "free", "none");
    const workspaces = [
      (await createWorkspace(app, accessToken, "Boards A")).json<WorkspaceResponse>(),
      (await createWorkspace(app, accessToken, "Boards B")).json<WorkspaceResponse>(),
      (await createWorkspace(app, accessToken, "Boards C")).json<WorkspaceResponse>(),
      (await createWorkspace(app, accessToken, "Boards D")).json<WorkspaceResponse>(),
    ];

    for (let i = 1; i <= 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaces[i - 1]!.id}/boards`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: `Board ${i}` },
      });
      assert.equal(res.statusCode, 201);
    }

    const fourth = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaces[3]!.id}/boards`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Board 4" },
    });
    assert.equal(fourth.statusCode, 403);
    assert.equal(fourth.json<{ code: string }>().code, "PLAN_LIMIT");
  });
});

void test("hosted free org cannot create API keys, webhooks, or guests", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const { accessToken, user } = await signupOrg(app, "Free Integrations Org");
    await setBilling(user.clientId, "free", "none");
    const ws = (await createWorkspace(app, accessToken, "Integrations")).json<WorkspaceResponse>();
    const board = (await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/boards`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Board" },
    })).json<BoardResponse>();

    const apiKey = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/api-keys`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Key", scope: "read" },
    });
    assert.equal(apiKey.statusCode, 403);

    const webhook = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/webhooks`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Hook", url: "https://example.com/hook", eventTypes: [], enabled: true },
    });
    assert.equal(webhook.statusCode, 403);

    const guest = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/guests/invitations`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { boardId: board.id, email: "guest@external.com", role: "editor" },
    });
    assert.equal(guest.statusCode, 403);

    // Upgrading unlocks API keys.
    await setBilling(user.clientId, "paid", "active");
    const apiKeyPaid = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/api-keys`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Key", scope: "read" },
    });
    assert.equal(apiKeyPaid.statusCode, 201);
  });
});

void test("hosted free org may only enable one automation at a time", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const { accessToken, user } = await signupOrg(app, "Free Automation Org");
    await setBilling(user.clientId, "free", "none");
    const ws = (await createWorkspace(app, accessToken, "Automations")).json<WorkspaceResponse>();
    const [list] = await db.select().from(lists).where(eq(lists.workspaceId, ws.id)).limit(1);

    const makeAutomation = (enabled: boolean) =>
      app.inject({
        method: "POST",
        url: `/workspaces/${ws.id}/automations`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          triggerType: "card_enters_list",
          triggerListId: list!.id,
          applyOnCreate: true,
          applyOnMove: true,
          enabled,
          actions: [{ type: "set_completion", config: { completed: true } }],
        },
      });

    assert.equal((await makeAutomation(true)).statusCode, 201);
    // A second enabled automation is rejected, but a disabled one is fine.
    assert.equal((await makeAutomation(true)).statusCode, 403);
    assert.equal((await makeAutomation(false)).statusCode, 201);
  });
});

void test("hosted free org member cap is enforced on invite acceptance", async () => {
  await withHosted(async () => {
    const previousMax = env.HOSTED_FREE_MAX_ORG_MEMBERS;
    env.HOSTED_FREE_MAX_ORG_MEMBERS = 1;
    try {
      const app = await buildIntegrationServer();
      const { user } = await signupOrg(app, "Free Member Org");
      await setBilling(user.clientId, "free", "none");

      // Seed an invite token directly so we exercise the acceptance gate rather than the creation gate.
      const rawToken = "member-cap-seeded-token";
      await db.insert(inviteTokens).values({
        clientId: user.clientId,
        tokenHash: hashOpaqueToken(rawToken),
        orgRole: "member",
        email: null,
        createdById: user.id,
      });

      // The org already has its one allowed member (the owner), so accepting must fail.
      const accept = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: {
          inviteToken: rawToken,
          email: "joiner@example.com",
          password: "Abc12345",
          displayName: "Joiner",
        },
      });
      assert.equal(accept.statusCode, 403);
      assert.equal(accept.json<{ code: string }>().code, "PLAN_LIMIT");
    } finally {
      env.HOSTED_FREE_MAX_ORG_MEMBERS = previousMax;
    }
  });
});

void test("hosted paid org cannot create a member invite when its purchased seat pool is full", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const { accessToken, user } = await signupOrg(app, "Full Paid Member Org");
    await db
      .update(clients)
      .set({ plan: "paid", billingStatus: "active", seatLimit: 1 })
      .where(eq(clients.id, user.clientId));

    const invite = await app.inject({
      method: "POST",
      url: "/clients/me/invites",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { orgRole: "member", workspaces: [] },
    });
    assert.equal(invite.statusCode, 402);
    assert.equal(invite.json<{ code: string }>().code, "SEAT_LIMIT_REACHED");
    assert.equal(await db.$count(inviteTokens, eq(inviteTokens.clientId, user.clientId)), 0);
  });
});

void test("hosted trial org can accept more than five members without seat blocking", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const { user } = await signupOrg(app, "Trial Member Org");
    // Keep the stored paid capacity tiny to prove trial invites do not consult clients.seat_limit.
    await db.update(clients).set({ seatLimit: 1 }).where(eq(clients.id, user.clientId));

    for (let index = 0; index < 6; index += 1) {
      const rawToken = `trial-member-${index}-seeded-token`;
      await db.insert(inviteTokens).values({
        clientId: user.clientId,
        tokenHash: hashOpaqueToken(rawToken),
        orgRole: "member",
        email: null,
        createdById: user.id,
      });

      const accept = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: {
          inviteToken: rawToken,
          email: `trial-joiner-${index}@example.com`,
          password: "Abc12345",
          displayName: `Trial Joiner ${index}`,
        },
      });
      assert.equal(accept.statusCode, 200, accept.body);
    }

    assert.equal(await db.$count(users, eq(users.clientId, user.clientId)), 7);
  });
});
