import "../test/setup.integration.js";
import { clients } from "@kanera/shared/schema";
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
