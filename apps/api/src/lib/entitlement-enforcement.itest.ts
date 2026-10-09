import "../test/setup.integration.js";
import { boards, clientMembers, clients, lists, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildPublicApiServer } from "../public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "../test/integration.js";

type SignupResponse = { accessToken: string; user: { id: string; clientId: string } };
type App = Awaited<ReturnType<typeof buildIntegrationServer>>;

async function signupOrg(app: App, name: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: name, email: `owner-${randomUUID()}@example.com`, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(res.statusCode, 200);
  return res.json<SignupResponse>();
}

// Sets billing directly (not via convertClientPlan), so it does NOT revoke keys or disable webhooks.
// This is exactly the state the request-time gates must defend against.
async function setBilling(clientId: string, plan: "free" | "paid", billingStatus: string) {
  await db.update(clients).set({ plan, billingStatus: billingStatus as never }).where(eq(clients.id, clientId));
}

async function createWorkspace(app: App, token: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${token}` }, payload: { name } });
  assert.equal(res.statusCode, 201);
  return res.json<{ id: string }>().id;
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

void test("an existing API key stops working once its org is on the free tier", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const { accessToken, user } = await signupOrg(app, "Api Key Org"); // trialing => paid-tier
    const wsId = await createWorkspace(app, accessToken, "Sync");
    const keyRes = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/api-keys`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Sync", scope: "read" },
    });
    assert.equal(keyRes.statusCode, 201);
    const secret = keyRes.json<{ secret: string }>().secret;

    const publicApi = await buildPublicApiServer({
      enableWebhookDeliveryScheduler: false,
      logger: false,
      uploadsDir: testUploadsDir("test-public-uploads"),
    });
    try {
      // While trialing the key authenticates.
      const ok = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: { authorization: `Bearer ${secret}` } });
      assert.equal(ok.statusCode, 200);

      // Drop to free WITHOUT revoking the key (simulating a key that slipped past reconciliation).
      await setBilling(user.clientId, "free", "none");
      const blocked = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: { authorization: `Bearer ${secret}` } });
      assert.equal(blocked.statusCode, 401);
    } finally {
      await publicApi.close();
    }
  });
});

void test("a free org cannot re-enable a webhook, but can still disable/rename it", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const { accessToken, user } = await signupOrg(app, "Webhook Org"); // trialing
    const wsId = await createWorkspace(app, accessToken, "Hooks");
    const hookRes = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/webhooks`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Hook", url: "https://example.com/hook", eventTypes: [], enabled: true },
    });
    assert.equal(hookRes.statusCode, 201);
    const hookId = hookRes.json<{ id: string }>().id;

    await setBilling(user.clientId, "free", "none");
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/workspaces/${wsId}/webhooks/${hookId}`, headers: { authorization: `Bearer ${accessToken}` }, payload });

    // Re-enabling is gated.
    assert.equal((await patch({ enabled: true })).statusCode, 403);
    // Disabling and renaming remain allowed so a free org can still manage existing endpoints.
    assert.equal((await patch({ enabled: false })).statusCode, 200);
    assert.equal((await patch({ name: "Renamed" })).statusCode, 200);
  });
});

void test("concurrent board creates cannot race past the free cap", async () => {
  await withHosted(async () => {
    const previousMaxBoards = env.HOSTED_FREE_MAX_BOARDS;
    try {
      env.HOSTED_FREE_MAX_BOARDS = 1;
      const app = await buildIntegrationServer();
      const { accessToken, user } = await signupOrg(app, "Race Org");
      const wsId = await createWorkspace(app, accessToken, "Boards");
      await setBilling(user.clientId, "free", "none"); // max 1 board, currently 0

      // Fire two creates concurrently; the per-tenant FOR UPDATE lock must serialize them so exactly
      // one wins and the other trips the cap.
      const [a, b] = await Promise.all([
        app.inject({ method: "POST", url: `/workspaces/${wsId}/boards`, headers: { authorization: `Bearer ${accessToken}` }, payload: { name: "A" } }),
        app.inject({ method: "POST", url: `/workspaces/${wsId}/boards`, headers: { authorization: `Bearer ${accessToken}` }, payload: { name: "B" } }),
      ]);

      const codes = [a.statusCode, b.statusCode].sort();
      assert.deepEqual(codes, [201, 403], `expected one success and one cap rejection, got ${codes.join(",")}`);
    } finally {
      env.HOSTED_FREE_MAX_BOARDS = previousMaxBoards;
    }
  });
});

// --- Free-plan agent access -------------------------------------------------------------------
// Hosted mode needs a license token, so E2E runs self-hosted and cannot reach the Free tier; these
// in-process tests are the only coverage. Failures they catch: a Free user cannot mint a personal
// key or approve an interactive agent; a personal/OAuth credential on a Free org gets 401 (org
// resolution filtered to paid) or 403 on boards (access check still requiring paid); discovery
// omitting Free workspaces; workspace keys or service agents still creatable on Free; Free limits not
// applied on a Free org's boards, applied per credential instead of per user (extra keys multiply
// them), leaking onto a Pro org's boards for a user in both, ignoring the per-second limit, missing
// their machine-readable details, or still applied after the organisation upgrades.

const MCP_RESOURCE = "http://localhost:3002/mcp";

async function freeOrgWithBoard(app: App, name: string) {
  const signup = await signupOrg(app, name);
  const workspaceId = await createWorkspace(app, signup.accessToken, `${name} workspace`);
  await setBilling(signup.user.clientId, "free", "none");
  const [list] = await db.insert(lists).values({ workspaceId, name: "Todo", position: "1000.0000000000" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId, name: `${name} board`, position: "1000.0000000000" }).returning();
  return { ...signup, workspaceId, listId: list!.id, boardId: board!.id };
}

async function createPersonalKey(app: App, token: string, label: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/me/api-keys", headers: { authorization: `Bearer ${token}` }, payload: { label } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<{ secret: string }>().secret;
}

void test("Free plan: personal keys and interactive agents work on Free boards; unattended agents stay Pro", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const org = await freeOrgWithBoard(app, "Free Agent Org");
    const auth = { authorization: `Bearer ${org.accessToken}` };
    const publicApi = await buildPublicApiServer({ logger: false, rateLimit: { enabled: false }, uploadsDir: testUploadsDir("test-public-uploads") });
    try {
      const key = await createPersonalKey(app, org.accessToken, "Free script");
      const bearer = { authorization: `Bearer ${key}` };

      const discovered = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: bearer });
      assert.equal(discovered.statusCode, 200, discovered.body);
      assert.ok(discovered.json<Array<{ id: string }>>().some((workspace) => workspace.id === org.workspaceId), "Free workspace is discoverable");
      const boardsPage = await publicApi.inject({ method: "GET", url: "/api/v1/boards", headers: bearer });
      assert.equal(boardsPage.statusCode, 200, boardsPage.body);
      assert.ok(boardsPage.body.includes(org.boardId), "Free board is discoverable");
      const boardLists = await publicApi.inject({ method: "GET", url: `/api/v1/boards/${org.boardId}/lists`, headers: bearer });
      assert.equal(boardLists.statusCode, 200, boardLists.body);
      const created = await publicApi.inject({
        method: "POST",
        url: `/api/v1/boards/${org.boardId}/lists/${org.listId}/cards`,
        headers: bearer,
        payload: { title: "Written by an agent on Free" },
      });
      assert.equal(created.statusCode, 201, created.body);

      // Unattended credentials remain a Pro capability.
      for (const url of [`/workspaces/${org.workspaceId}/api-keys`, `/workspaces/${org.workspaceId}/agent-connections`]) {
        const refused = await app.inject({ method: "POST", url, headers: auth, payload: { name: "Nightly sync", scope: "read" } });
        assert.equal(refused.statusCode, 403, url);
        assert.equal(refused.json<{ code: string; limit: string }>().limit, "serviceAgents", url);
      }

      // Interactive device-flow consent (the CLI and headless agents) succeeds on Free, and the
      // delegated MCP credential can write to the Free board.
      const registered = await publicApi.inject({
        method: "POST",
        url: "/oauth/register",
        payload: { client_name: "Free headless agent", grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"], token_endpoint_auth_method: "none" },
      });
      assert.equal(registered.statusCode, 201, registered.body);
      const clientId = registered.json<{ client_id: string }>().client_id;
      const issued = await publicApi.inject({
        method: "POST",
        url: "/oauth/device/code",
        payload: { client_id: clientId, scope: "kanera:read kanera:write offline_access", resource: MCP_RESOURCE },
      });
      assert.equal(issued.statusCode, 200, issued.body);
      const device = issued.json<{ device_code: string; user_code: string }>();
      const context = await app.inject({ method: "GET", url: `/oauth/device/context?${new URLSearchParams({ user_code: device.user_code }).toString()}`, headers: auth });
      assert.equal(context.statusCode, 200, context.body);
      const consent = await app.inject({ method: "POST", url: "/oauth/device/consent", headers: auth, payload: { user_code: device.user_code, decision: "approve" } });
      assert.equal(consent.statusCode, 200, consent.body);
      const exchanged = await publicApi.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: clientId, resource: MCP_RESOURCE }).toString(),
      });
      assert.equal(exchanged.statusCode, 200, exchanged.body);
      const delegated = await publicApi.inject({
        method: "POST",
        url: "/oauth/mcp/delegate",
        headers: { "x-kanera-mcp-secret": process.env.MCP_INTERNAL_SECRET! },
        payload: { token: exchanged.json<{ access_token: string }>().access_token, resource: MCP_RESOURCE },
      });
      assert.equal(delegated.statusCode, 200, delegated.body);
      const agentWrite = await publicApi.inject({
        method: "POST",
        url: `/api/v1/boards/${org.boardId}/lists/${org.listId}/cards`,
        headers: { authorization: `Bearer ${delegated.json<{ accessToken: string }>().accessToken}` },
        payload: { title: "Written through MCP on Free" },
      });
      assert.equal(agentWrite.statusCode, 201, agentWrite.body);
    } finally {
      await publicApi.close();
    }
  });
});

async function proOrganisationFor(userId: string) {
  const [client] = await db.insert(clients).values({ name: "Pro neighbour", plan: "paid", billingStatus: "active" }).returning();
  await db.insert(clientMembers).values({ clientId: client!.id, userId, clientRole: "owner" });
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "Pro workspace", cardKeyPrefix: `PRO${randomUUID().slice(0, 4).toUpperCase()}` }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId, role: "admin" });
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "Pro board", position: "1000.0000000000" }).returning();
  return { clientId: client!.id, boardId: board!.id };
}

void test("agent rate limits follow the plan of the organisation that owns the board", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const freeOrg = await freeOrgWithBoard(app, "Per Org Limits");
    const proOrg = await proOrganisationFor(freeOrg.user.id);
    const publicApi = await buildPublicApiServer({
      logger: false,
      uploadsDir: testUploadsDir("test-public-uploads"),
      // No queue, so the limit shows as an immediate 429; per-second limits out of the way.
      rateLimit: { apiKeyLimitPerSecond: 100, apiKeyLimitPerMinute: 100, freeUserLimitPerSecond: 100, freeUserLimitPerMinute: 3, ipLimitPerMinute: 100, queueSize: 0, windowMs: 60_000 },
    });
    try {
      // Two keys, one allowance per organisation: a second key must not double the budget.
      const first = { authorization: `Bearer ${await createPersonalKey(app, freeOrg.accessToken, "First")}` };
      const second = { authorization: `Bearer ${await createPersonalKey(app, freeOrg.accessToken, "Second")}` };
      const freeBoard = `/api/v1/boards/${freeOrg.boardId}/lists`;
      for (const headers of [first, second, first]) {
        const ok = await publicApi.inject({ method: "GET", url: freeBoard, headers });
        assert.equal(ok.statusCode, 200, ok.body);
      }
      const limited = await publicApi.inject({ method: "GET", url: freeBoard, headers: second });
      assert.equal(limited.statusCode, 429);
      const body = limited.json<{ code: string; message: string; limit: string; max: number; organisationId: string; upgradePlan: string }>();
      assert.equal(body.code, "RATE_LIMITED");
      assert.equal(body.limit, "apiRequestsPerMinute");
      assert.equal(body.max, 3);
      assert.equal(body.organisationId, freeOrg.user.clientId);
      assert.equal(body.upgradePlan, "paid");
      assert.match(body.message, /Free plan/);
      assert.ok(limited.headers["retry-after"], "throttle carries Retry-After");

      // The same user, with the same keys, is still well within limits on the Pro organisation's board.
      for (let i = 0; i < 5; i++) {
        const pro = await publicApi.inject({ method: "GET", url: `/api/v1/boards/${proOrg.boardId}/lists`, headers: first });
        assert.equal(pro.statusCode, 200, `Pro board request ${i + 1}: ${pro.body}`);
      }

      // Listings resolve no board, so they count against the credential's default organisation (the
      // Free one these keys were created in) unless the caller selects another organisation.
      const defaultListing = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: first });
      assert.equal(defaultListing.statusCode, 429);
      const proListing = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: { ...first, "x-kanera-organisation-id": proOrg.clientId } });
      assert.equal(proListing.statusCode, 200, proListing.body);

      // Upgrading the Free organisation lifts its limit on the very next call.
      await setBilling(freeOrg.user.clientId, "paid", "active");
      const lifted = await publicApi.inject({ method: "GET", url: freeBoard, headers: second });
      assert.equal(lifted.statusCode, 200, lifted.body);
    } finally {
      await publicApi.close();
    }
  });
});

void test("Free organisations also cap agent requests per second", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const freeOrg = await freeOrgWithBoard(app, "Per Second Limits");
    const publicApi = await buildPublicApiServer({
      logger: false,
      uploadsDir: testUploadsDir("test-public-uploads"),
      rateLimit: { apiKeyLimitPerSecond: 100, apiKeyLimitPerMinute: 100, freeUserLimitPerSecond: 2, freeUserLimitPerMinute: 100, ipLimitPerMinute: 100, queueSize: 0, windowMs: 60_000 },
    });
    try {
      const headers = { authorization: `Bearer ${await createPersonalKey(app, freeOrg.accessToken, "Burst")}` };
      const burst = await Promise.all(Array.from({ length: 3 }, () => publicApi.inject({ method: "GET", url: `/api/v1/boards/${freeOrg.boardId}/lists`, headers })));
      const statuses = burst.map((response) => response.statusCode).sort();
      assert.deepEqual(statuses, [200, 200, 429]);
      assert.equal(burst.find((response) => response.statusCode === 429)!.json<{ limit: string }>().limit, "apiRequestsPerSecond");
    } finally {
      await publicApi.close();
    }
  });
});
