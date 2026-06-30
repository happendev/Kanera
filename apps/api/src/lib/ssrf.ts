import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "../env.js";
import { badRequest } from "./errors.js";

// SSRF guard for outbound requests to user/admin-configured URLs (currently webhook
// endpoints). Workspace admins can set a webhook target URL; without these checks a target
// resolving to a loopback/private/link-local/metadata address could be used to reach internal
// services from the API host. We block those ranges, and re-resolve at delivery time so DNS
// rebinding (host validated at create time, repointed to a private IP later) is also caught.

interface BlockedRange {
  family: 4 | 6;
  network: bigint;
  mask: number;
}

// Loopback, private, CGNAT, link-local (incl. 169.254.169.254 cloud metadata), reserved/doc
// ranges, multicast, and IPv6 ULA/link-local. IPv4-mapped IPv6 is normalized before matching.
const BLOCKED_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
  "::1/128",
  "::/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "2001:db8::/32",
] as const;

function parseIpToBigInt(ip: string): { family: 4 | 6; value: bigint } | null {
  // Normalize IPv4-mapped IPv6 (::ffff:a.b.c.d) down to its IPv4 form so a mapped
  // private address can't slip past the IPv4 range checks.
  let candidate = ip.trim();
  const mappedPrefix = "::ffff:";
  if (candidate.toLowerCase().startsWith(mappedPrefix) && isIP(candidate.slice(mappedPrefix.length)) === 4) {
    candidate = candidate.slice(mappedPrefix.length);
  }
  const family = isIP(candidate);
  if (family === 4) {
    const parts = candidate.split(".");
    let value = 0n;
    for (const part of parts) value = (value << 8n) + BigInt(Number(part));
    return { family: 4, value };
  }
  if (family === 6) {
    const [left, right = ""] = candidate.split("::");
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const parts = [...leftParts, ...Array<string>(Math.max(0, missing)).fill("0"), ...rightParts];
    let value = 0n;
    for (const part of parts) value = (value << 16n) + BigInt(Number.parseInt(part || "0", 16));
    return { family: 6, value };
  }
  return null;
}

const BLOCKED_RANGES: BlockedRange[] = BLOCKED_CIDRS.map((cidr) => {
  const [ip, maskString] = cidr.split("/");
  const parsed = parseIpToBigInt(ip!)!;
  return { family: parsed.family, network: parsed.value, mask: Number(maskString) };
});

export function isBlockedAddress(ip: string): boolean {
  const parsed = parseIpToBigInt(ip);
  if (!parsed) return true; // fail closed on anything we can't parse
  return BLOCKED_RANGES.some((range) => {
    if (range.family !== parsed.family) return false;
    const bits = range.family === 4 ? 32 : 128;
    const shift = BigInt(bits - range.mask);
    return parsed.value >> shift === range.network >> shift;
  });
}

// Synchronous create/update-time validation: require https and reject obviously-internal hosts
// (IP literals in blocked ranges, and the localhost name). DNS-name targets are fully checked at
// delivery time by assertResolvedHostAllowed. In non-production the guard is relaxed so local
// integrations can point at http://localhost during development and tests.
export function assertWebhookUrlAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("invalid webhook url");
  }

  const host = parsed.hostname.toLowerCase();
  const isLocalName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");

  if (env.NODE_ENV !== "production") {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw badRequest("webhook url must use http(s)");
    return;
  }

  if (parsed.protocol !== "https:") throw badRequest("webhook url must use https");
  if (isLocalName) throw badRequest("webhook url host is not allowed");
  if (isIP(host) && isBlockedAddress(host)) throw badRequest("webhook url host is not allowed");
}

// Delivery-time check: resolve the host and reject if any resolved address is in a blocked
// range. This defeats DNS rebinding where a public hostname is later repointed at a private IP.
// Skipped outside production so dev/test webhooks to localhost keep working.
export async function assertResolvedHostAllowed(url: string): Promise<void> {
  if (env.NODE_ENV !== "production") return;
  const { hostname } = new URL(url);
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw badRequest("webhook url host resolves to a blocked address");
    return;
  }
  const results = await lookup(hostname, { all: true });
  if (results.length === 0 || results.some((r) => isBlockedAddress(r.address))) {
    throw badRequest("webhook url host resolves to a blocked address");
  }
}
