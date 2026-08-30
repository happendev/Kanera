import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { parseWebhook, verifyWebhookSignature, WebhookVerificationError } from "./webhooks.js";

const SECRET = "whsec_test_secret_value";

/**
 * An independent implementation of the server's signing rule (apps/api/src/lib/webhook-signing.ts),
 * written with node:crypto rather than Web Crypto. If the SDK's verifier and this ever disagree,
 * one of them has drifted from `sha256=HMAC(secret, "{timestamp}.{body}")`.
 */
function sign(timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
}

const body = JSON.stringify({ id: "evt_1", type: "card.created", workspaceId: "w1", occurredAt: "2026-01-01T00:00:00Z", data: {} });
const timestamp = "1767225600";
const nowMs = Number(timestamp) * 1000;

void test("a genuine delivery verifies", async () => {
  assert.equal(await verifyWebhookSignature({ secret: SECRET, payload: body, signature: sign(timestamp, body), timestamp, nowMs }), true);
});

void test("a tampered body does not verify", async () => {
  const signature = sign(timestamp, body);
  const tampered = body.replace("card.created", "card.deleted");
  assert.equal(await verifyWebhookSignature({ secret: SECRET, payload: tampered, signature, timestamp, nowMs }), false);
});

void test("the signature is bound to the timestamp, so it cannot be replayed under a new one", async () => {
  const signature = sign(timestamp, body);
  const later = String(Number(timestamp) + 60);
  assert.equal(await verifyWebhookSignature({ secret: SECRET, payload: body, signature, timestamp: later, nowMs }), false);
});

void test("a delivery outside the tolerance window is rejected", async () => {
  const signature = sign(timestamp, body);
  const staleNow = nowMs + 3_600_000;
  assert.equal(await verifyWebhookSignature({ secret: SECRET, payload: body, signature, timestamp, nowMs: staleNow }), false);
  // The same delivery still verifies when the caller opts out of the window.
  assert.equal(
    await verifyWebhookSignature({ secret: SECRET, payload: body, signature, timestamp, nowMs: staleNow, toleranceSeconds: Infinity }),
    true,
  );
});

void test("the wrong secret does not verify", async () => {
  const signature = sign(timestamp, body);
  assert.equal(await verifyWebhookSignature({ secret: "whsec_other", payload: body, signature, timestamp, nowMs }), false);
});

void test("a malformed timestamp is rejected rather than treated as zero", async () => {
  assert.equal(await verifyWebhookSignature({ secret: SECRET, payload: body, signature: sign("x", body), timestamp: "x", nowMs }), false);
});

void test("parseWebhook reads headers case-insensitively and returns the payload", async () => {
  const payload = await parseWebhook({
    secret: SECRET,
    payload: body,
    nowMs,
    headers: { "X-Kanera-Signature": sign(timestamp, body), "X-Kanera-Timestamp": timestamp },
  });
  assert.equal(payload.type, "card.created");
});

void test("parseWebhook accepts a Headers object", async () => {
  const headers = new Headers({ "x-kanera-signature": sign(timestamp, body), "x-kanera-timestamp": timestamp });
  assert.equal((await parseWebhook({ secret: SECRET, payload: body, nowMs, headers })).id, "evt_1");
});

void test("parseWebhook throws rather than returning an unverified payload", async () => {
  // A boolean return is easy to forget to check; a handler that skips the check must not compile
  // into something that still hands back parsed data.
  await assert.rejects(
    parseWebhook({ secret: SECRET, payload: body, nowMs, headers: { "x-kanera-signature": sign(timestamp, "other"), "x-kanera-timestamp": timestamp } }),
    WebhookVerificationError,
  );
  await assert.rejects(parseWebhook({ secret: SECRET, payload: body, nowMs, headers: {} }), WebhookVerificationError);
});
