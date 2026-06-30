import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

const DEFAULT_TTL_MS = 10 * 24 * 60 * 60 * 1000; // 10 days
const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
type MediaTokenKind = "session" | "share";

function signature(clientId: string, key: string, exp: number, kind: MediaTokenKind): string {
  // Bind the token to exactly one tenant, object key, and expiry so copied
  // tokens cannot be replayed against neighbouring media paths.
  return createHmac("sha256", env.MEDIA_SIGNING_SECRET)
    .update(`${clientId}\n${key}\n${exp}\n${kind}`)
    .digest()
    .subarray(0, 24)
    .toString("base64url");
}

export function mediaPathFor(clientId: string, key: string): string {
  return `/api/media/${encodeURIComponent(clientId)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function signMediaUrl(params: { clientId: string; key: string; ttlMs?: number; kind?: MediaTokenKind }): string {
  const kind = params.kind ?? "session";
  const ttlMs = params.ttlMs ?? (kind === "share" ? SHARE_TTL_MS : DEFAULT_TTL_MS);
  // Deterministic per-window expiry: the same key yields the SAME signed URL
  // for every caller (board, list, assigned-work, card detail) until the window
  // rolls, so Cloudflare/browser cache one object. floor()+2 (not ceil) guarantees
  // every URL is valid for at least one full ttlMs and overlaps the next window,
  // so a freshly issued URL never strands the still-cached previous one.
  // (Math.ceil produced near-zero lifetimes near a boundary -> mass 404s 2026-06-26.)
  const exp = (Math.floor(Date.now() / ttlMs) + 2) * ttlMs;
  const token = signature(params.clientId, params.key, exp, kind);
  const kindParam = kind === "share" ? "&s=share" : "";
  return `${env.API_PUBLIC_URL}${mediaPathFor(params.clientId, params.key)}?t=${encodeURIComponent(token)}&e=${exp}${kindParam}`;
}

export function mediaCacheMaxAge(exp: string | number, kind: MediaTokenKind = "session"): number {
  const expiry = typeof exp === "number" ? exp : Number(exp);
  if (!Number.isFinite(expiry)) return 0;
  return Math.max(0, Math.min(kind === "share" ? SHARE_TTL_MS : DEFAULT_TTL_MS, expiry - Date.now()));
}

export function verifyMediaToken(params: { clientId: string; key: string; t: string; e: string | number; s?: string }): boolean {
  const exp = typeof params.e === "number" ? params.e : Number(params.e);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const kind = params.s === "share" ? "share" : "session";
  const expected = Buffer.from(signature(params.clientId, params.key, exp, kind), "base64url");
  const actual = Buffer.from(params.t, "base64url");
  if (actual.length !== expected.length) return false;
  // Avoid leaking token correctness through byte-by-byte timing differences.
  return timingSafeEqual(actual, expected);
}
