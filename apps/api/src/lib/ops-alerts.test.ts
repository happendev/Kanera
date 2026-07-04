import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./../test/setup.js";
import { configureOpsAlertsForTests, resetOpsAlertThrottleForTests, sendOpsAlert } from "./ops-alerts.js";

const baseEnv = {
  NODE_ENV: "test" as const,
  OPS_ALERTS_ENABLED: true,
  OPS_ALERT_THROTTLE_MS: 300_000,
  ALERT_WEBHOOK_URL: undefined as string | undefined,
};

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function parseJsonBody(body: RequestInit["body"] | null | undefined): unknown {
  return typeof body === "string" ? JSON.parse(body) : null;
}

function createFetchRecorder(status = 200) {
  const calls: Array<{ url: string; body: unknown; headers: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: inputUrl(input),
      body: parseJsonBody(init?.body),
      headers: init?.headers,
    });
    return new Response("ok", { status });
  };
  return { calls, fetchImpl };
}

type AttachmentPayload = {
  text: string;
  attachments: Array<{ color: string; title: string; fallback: string; fields: Array<{ title: string; value: string }> }>;
};

afterEach(() => {
  configureOpsAlertsForTests(null);
  resetOpsAlertThrottleForTests();
});

void test("sends a Slack-compatible attachment payload to the configured webhook", async () => {
  const recorder = createFetchRecorder();

  await sendOpsAlert(
    { service: "api", type: "startup", port: 3000 },
    { env: { ...baseEnv, ALERT_WEBHOOK_URL: "https://hooks.slack.test/services/secret" }, fetch: recorder.fetchImpl },
  );

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0]!.url, "https://hooks.slack.test/services/secret");
  const body = recorder.calls[0]!.body as AttachmentPayload;
  assert.match(body.text, /^🔵 INFO — Kanera service started/);
  const attachment = body.attachments[0]!;
  assert.equal(attachment.color, "#0f766e");
  assert.equal(attachment.title, "🔵 INFO — Kanera service started (api)");
  assert.ok(Array.isArray(attachment.fields));
  assert.deepEqual(attachment.fields[0], { title: "🔵 INFO", value: "service started", short: true });
  assert.ok(!attachment.fields.some((field) => field.title === "Severity"));
  assert.ok(attachment.fields.some((field) => field.title === "Service" && field.value === "api"));
});

void test("the payload is Slack-compatible so it works for Slack, Zulip, etc.", async () => {
  const recorder = createFetchRecorder();

  // A Zulip slack_incoming URL is just another Slack-compatible endpoint; the same payload is sent.
  await sendOpsAlert(
    { service: "api", type: "startup", port: 3000 },
    { env: { ...baseEnv, ALERT_WEBHOOK_URL: "https://zulip.test/api/v1/external/slack_incoming?api_key=secret" }, fetch: recorder.fetchImpl },
  );

  assert.equal(recorder.calls.length, 1);
  assert.equal(new URL(recorder.calls[0]!.url).hostname, "zulip.test");
  const body = recorder.calls[0]!.body as AttachmentPayload;
  assert.ok(Array.isArray(body.attachments[0]!.fields));
  assert.deepEqual(body.attachments[0]!.fields[0], { title: "🔵 INFO", value: "service started", short: true });
});

void test("keeps the error identity in rendered attachment content", async () => {
  const recorder = createFetchRecorder();

  await sendOpsAlert(
    {
      service: "public-api",
      type: "error",
      requestId: "req-1",
      method: "GET",
      url: "/metrics",
      statusCode: 500,
      error: new Error("Cannot write headers after they are sent to the client"),
    },
    { env: { ...baseEnv, ALERT_WEBHOOK_URL: "https://zulip.test/api/v1/external/slack_incoming" }, fetch: recorder.fetchImpl },
  );

  const body = recorder.calls[0]!.body as AttachmentPayload;
  const attachment = body.attachments[0]!;
  assert.equal(attachment.title, "🔴 ERROR — Kanera Unhandled API error (public-api)");
  assert.deepEqual(attachment.fields[0], { title: "🔴 ERROR", value: "Unhandled API error", short: true });
  assert.ok(attachment.fields.some((field) => field.title === "Error" && field.value.includes("Cannot write headers")));
});

void test("encodes severity via the attachment color", async () => {
  const recorder = createFetchRecorder();
  const env = { ...baseEnv, ALERT_WEBHOOK_URL: "https://hooks.slack.test/services/secret" };

  await sendOpsAlert(
    { service: "api", type: "startup", port: 3000 },
    { env, fetch: recorder.fetchImpl },
  );
  await sendOpsAlert(
    { service: "api", type: "error", method: "GET", url: "/boom", statusCode: 500, error: new Error("boom") },
    { env, fetch: recorder.fetchImpl },
  );

  const info = recorder.calls[0]!.body as AttachmentPayload;
  const error = recorder.calls[1]!.body as AttachmentPayload;
  assert.match(info.text, /^🔵 INFO/);
  assert.equal(info.attachments[0]!.color, "#0f766e");
  assert.match(error.text, /^🔴 ERROR/);
  assert.equal(error.attachments[0]!.color, "#dc2626");
});

void test("does nothing when disabled or no webhook URL is configured", async () => {
  const recorder = createFetchRecorder();

  await sendOpsAlert({ service: "api", type: "startup", port: 3000 }, { env: baseEnv, fetch: recorder.fetchImpl });
  await sendOpsAlert(
    { service: "api", type: "startup", port: 3000 },
    { env: { ...baseEnv, OPS_ALERTS_ENABLED: false, ALERT_WEBHOOK_URL: "https://hooks.slack.test/services/secret" }, fetch: recorder.fetchImpl },
  );

  assert.equal(recorder.calls.length, 0);
});

void test("throttles repeated equivalent alerts but allows distinct keys", async () => {
  const recorder = createFetchRecorder();
  const options = {
    env: { ...baseEnv, ALERT_WEBHOOK_URL: "https://hooks.slack.test/services/secret" },
    fetch: recorder.fetchImpl,
    now: () => 1_000,
  };

  await sendOpsAlert({ service: "api", type: "error", method: "GET", url: "/slow", statusCode: 500, error: new Error("boom") }, options);
  await sendOpsAlert({ service: "api", type: "error", method: "GET", url: "/slow", statusCode: 500, error: new Error("boom") }, options);
  await sendOpsAlert({ service: "api", type: "error", method: "GET", url: "/other", statusCode: 500, error: new Error("boom") }, options);

  assert.equal(recorder.calls.length, 2);
});

void test("payloads omit sensitive request headers and webhook URLs", async () => {
  const recorder = createFetchRecorder();

  await sendOpsAlert(
    {
      service: "api",
      type: "error",
      requestId: "req-1",
      method: "POST",
      url: "/auth/login",
      statusCode: 500,
      error: new Error("database unavailable"),
    },
    { env: { ...baseEnv, ALERT_WEBHOOK_URL: "https://hooks.slack.test/services/secret-token" }, fetch: recorder.fetchImpl },
  );

  const serialized = JSON.stringify(recorder.calls[0]!.body);
  assert.match(serialized, /database unavailable/);
  assert.doesNotMatch(serialized, /secret-token/);
  assert.doesNotMatch(serialized, /authorization/i);
  assert.doesNotMatch(serialized, /cookie/i);
});

void test("delivery failures are swallowed and logged without the full webhook URL", async () => {
  const warnings: unknown[] = [];
  const failingFetch: typeof fetch = async () => {
    throw new Error("network down");
  };
  const log = { warn: (...args: unknown[]) => warnings.push(args) };

  await assert.doesNotReject(() => sendOpsAlert(
    { service: "api", type: "startup", port: 3000 },
    {
      env: { ...baseEnv, ALERT_WEBHOOK_URL: "https://hooks.slack.test/services/secret-token" },
      fetch: failingFetch,
      log: log as never,
    },
  ));

  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /secret-token/);
});
