import type { WebhookPayload } from "./types.js";

/** Headers Kanera sends with every generic webhook delivery. */
export const WEBHOOK_SIGNATURE_HEADER = "x-kanera-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-kanera-timestamp";
export const WEBHOOK_EVENT_ID_HEADER = "x-kanera-event-id";

const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookInput {
  /** The endpoint's signing secret (`whsec_…`). */
  secret: string;
  /**
   * The exact bytes of the request body. Verify before parsing — re-serialising JSON changes key
   * order and whitespace, and the signature is over the original text.
   */
  payload: string;
  /** `X-Kanera-Signature`, in the form `sha256=<hex>`. */
  signature: string;
  /** `X-Kanera-Timestamp`, unix seconds. */
  timestamp: string;
  /** How far the timestamp may drift from now. Default 300s. Pass `Infinity` to skip the check. */
  toleranceSeconds?: number;
  nowMs?: number;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Comparing lengths first is safe: the signature length is fixed and public. The loop then runs
  // over every character so a partially correct signature takes the same time as a wrong one.
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a Kanera webhook delivery.
 *
 * The signature covers `{timestamp}.{body}`, so an attacker cannot replay a captured body under a
 * fresh timestamp — the timestamp is inside what is signed. The tolerance window then bounds how
 * long a captured *whole* delivery stays replayable, which is why it is checked here rather than
 * left to the caller to remember.
 *
 * Uses Web Crypto, so it runs on Node 18+, Bun, Deno, Cloudflare Workers, and browsers alike.
 */
export async function verifyWebhookSignature(input: VerifyWebhookInput): Promise<boolean> {
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const sentAt = Number(input.timestamp);
  if (!Number.isFinite(sentAt)) return false;
  if (Number.isFinite(tolerance)) {
    const skewSeconds = Math.abs((input.nowMs ?? Date.now()) / 1000 - sentAt);
    if (skewSeconds > tolerance) return false;
  }
  const expected = `sha256=${await hmacSha256Hex(input.secret, `${input.timestamp}.${input.payload}`)}`;
  return constantTimeEqual(expected, input.signature.trim());
}

export class WebhookVerificationError extends Error {
  readonly name = "WebhookVerificationError";
}

export interface ParseWebhookInput extends Omit<VerifyWebhookInput, "signature" | "timestamp"> {
  /** Request headers. Accepts a `Headers` object or a plain object with any casing. */
  headers: Headers | Record<string, string | string[] | undefined>;
}

function header(headers: ParseWebhookInput["headers"], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Verify and parse a delivery in one step. Throws {@link WebhookVerificationError} rather than
 * returning a boolean, so a handler cannot forget to check the result before using the payload.
 */
export async function parseWebhook(input: ParseWebhookInput): Promise<WebhookPayload> {
  const signature = header(input.headers, WEBHOOK_SIGNATURE_HEADER);
  const timestamp = header(input.headers, WEBHOOK_TIMESTAMP_HEADER);
  if (!signature || !timestamp) throw new WebhookVerificationError("missing Kanera webhook signature headers");
  const valid = await verifyWebhookSignature({ ...input, signature, timestamp });
  if (!valid) throw new WebhookVerificationError("webhook signature did not verify");
  try {
    return JSON.parse(input.payload) as WebhookPayload;
  } catch {
    throw new WebhookVerificationError("webhook body was not valid JSON");
  }
}
