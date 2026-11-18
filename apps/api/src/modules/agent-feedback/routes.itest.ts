import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../../env.js";
import type { InternalAgentFeedbackNotification } from "../../lib/internal-notification-emails.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";

const report = { kind: "error", summary: "cards.move rejected a valid list", details: "Moving PROJ-1 to Done returned 400.", tool: "cards.move" };

async function setup(sent: InternalAgentFeedbackNotification[], delivered = 1) {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { orgName: "Acme", email: "feedback-owner@example.com", displayName: "Fey Owner" });
  const publicApi = await buildPublicApiServer({
    logger: false,
    uploadsDir: testUploadsDir("test-agent-feedback-uploads"),
    rateLimit: { enabled: false },
    sendAgentFeedback: async (notification) => {
      sent.push(notification);
      return delivered;
    },
  });
  const post = (payload: unknown) => publicApi.inject({ method: "POST", url: "/api/v1/feedback", headers: owner.auth, payload: payload as Record<string, unknown> });
  const session = () => publicApi.inject({ method: "GET", url: "/api/v1/session", headers: owner.auth });
  return { publicApi, owner, post, session };
}

async function inMode<T>(mode: "hosted" | "self_hosted", run: () => Promise<T>): Promise<T> {
  const previous = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = mode;
  try {
    return await run();
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previous;
  }
}

void test("agent feedback is emailed to the team on hosted with the reporter's identity", async () => {
  const sent: InternalAgentFeedbackNotification[] = [];
  const { publicApi, owner, post } = await setup(sent);
  try {
    await inMode("hosted", async () => {
      const response = await post(report);
      assert.equal(response.statusCode, 202, response.body);
      assert.deepEqual(response.json(), { received: true });
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.kind, "error");
    assert.equal(sent[0]!.tool, "cards.move");
    assert.equal(sent[0]!.orgName, "Acme");
    assert.deepEqual(sent[0]!.reporter, { userId: owner.user.id, displayName: "Fey Owner", email: "feedback-owner@example.com" });
  } finally {
    await publicApi.close();
  }
});

void test("agent feedback does not exist on self-hosted installs", async () => {
  const sent: InternalAgentFeedbackNotification[] = [];
  const { publicApi, post, session } = await setup(sent);
  try {
    // The self-hosted operator is not the Kanera team; nothing may be sent anywhere.
    const response = await inMode("self_hosted", () => post(report));
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(sent.length, 0);
    // MCP reads this to leave feedback.report out of a self-hosted catalog.
    assert.equal((await inMode("self_hosted", session)).json<{ deploymentMode: string }>().deploymentMode, "self_hosted");
    assert.equal((await inMode("hosted", session)).json<{ deploymentMode: string }>().deploymentMode, "hosted");
  } finally {
    await publicApi.close();
  }
});

void test("agent feedback reports undelivered email, rejects bad input and caps volume per user", async () => {
  const sent: InternalAgentFeedbackNotification[] = [];
  const { publicApi, post } = await setup(sent, 0);
  try {
    await inMode("hosted", async () => {
      assert.equal((await post({ ...report, kind: "praise" })).statusCode, 400);
      assert.equal((await post({ ...report, summary: "" })).statusCode, 400);
      // A lost report must not look delivered, or the agent never retries or tells the user.
      const undelivered = await post(report);
      assert.equal(undelivered.statusCode, 503, undelivered.body);
      assert.equal(undelivered.json<{ code: string }>().code, "FEEDBACK_UNAVAILABLE");
      for (let index = 1; index < 10; index += 1) await post(report);
      // A looping agent must not flood the team inbox: the eleventh report in the hour is refused.
      assert.equal((await post(report)).statusCode, 429);
    });
    assert.equal(sent.length, 10);
  } finally {
    await publicApi.close();
  }
});
