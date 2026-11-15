import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "../env.js";
import { badRequest } from "./errors.js";

// One resolver is shared by validation and the actual connection. Callers must use
// the returned address, rather than validate DNS and let a second lookup choose it.
export const outboundDns = { lookup };
export type OutboundPolicy = "webhook" | "notification" | "push" | "public";

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
  "2001::/23", // transition/special-purpose allocations
  "2002::/16", // 6to4 can embed a forbidden IPv4 destination
  "3fff::/20",
] as const;

// Even an operator who explicitly allows private notification receivers does not need access to
// link-local metadata, documentation/benchmark ranges, multicast, or otherwise reserved targets.
// Keep these blocked while allowing ordinary loopback, RFC1918, CGNAT, and IPv6 ULA receivers.
const ALWAYS_BLOCKED_NOTIFICATION_CIDRS = [
  "0.0.0.0/8",
  "169.254.0.0/16",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
  "::/128",
  "fe80::/10",
  "ff00::/8",
  "2001:db8::/32",
  "2001::/23",
  "2002::/16",
  "3fff::/20",
] as const;

function parseIpToBigInt(ip: string): { family: 4 | 6; value: bigint } | null {
  // Normalize IPv4-mapped IPv6 (::ffff:a.b.c.d) down to its IPv4 form so a mapped
  // private address can't slip past the IPv4 range checks.
  let candidate = ip.trim();
  if (candidate.startsWith("[") && candidate.endsWith("]")) candidate = candidate.slice(1, -1);
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
    // URL.hostname serialises mapped literals such as ::ffff:169.254.169.254 in
    // hexadecimal form. Fold the whole mapped range back to IPv4 before CIDR checks.
    if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
    return { family: 6, value };
  }
  return null;
}

const BLOCKED_RANGES: BlockedRange[] = BLOCKED_CIDRS.map((cidr) => {
  const [ip, maskString] = cidr.split("/");
  const parsed = parseIpToBigInt(ip!)!;
  return { family: parsed.family, network: parsed.value, mask: Number(maskString) };
});

const ALWAYS_BLOCKED_NOTIFICATION_RANGES: BlockedRange[] = ALWAYS_BLOCKED_NOTIFICATION_CIDRS.map((cidr) => {
  const [ip, maskString] = cidr.split("/");
  const parsed = parseIpToBigInt(ip!)!;
  return { family: parsed.family, network: parsed.value, mask: Number(maskString) };
});

function matchesRange(ip: string, ranges: BlockedRange[]): boolean {
  const parsed = parseIpToBigInt(ip);
  if (!parsed) return true;
  return ranges.some((range) => {
    if (range.family !== parsed.family) return false;
    const bits = range.family === 4 ? 32 : 128;
    const shift = BigInt(bits - range.mask);
    return parsed.value >> shift === range.network >> shift;
  });
}

export function isBlockedAddress(ip: string): boolean {
  const parsed = parseIpToBigInt(ip);
  // Public IPv6 destinations must be global unicast. In particular, NAT64 and
  // compatible-address forms must not tunnel around the IPv4 metadata checks.
  if (parsed?.family === 6 && parsed.value >> 125n !== 1n) return true;
  return matchesRange(ip, BLOCKED_RANGES);
}

export function isAlwaysBlockedNotificationAddress(ip: string): boolean {
  const parsed = parseIpToBigInt(ip);
  // The explicit private-receiver policy permits ULA and loopback, but not
  // transition/reserved forms that can conceal a second destination address.
  if (parsed?.family === 6 && parsed.value !== 1n && parsed.value >> 121n !== 0x7en && parsed.value >> 125n !== 1n) return true;
  return matchesRange(ip, ALWAYS_BLOCKED_NOTIFICATION_RANGES);
}

function privateNotificationDestinationsAllowed(): boolean {
  return env.NODE_ENV !== "production"
    || (env.KANERA_DEPLOYMENT_MODE === "self_hosted" && env.KANERA_ALLOW_PRIVATE_NOTIFICATION_DESTINATIONS);
}

export function notificationDestinationPolicy(): "public-https" | "private-network-allowed" {
  return privateNotificationDestinationsAllowed() ? "private-network-allowed" : "public-https";
}

// Synchronous create/update-time validation: require https and reject obviously-internal hosts
// (IP literals in blocked ranges, and the localhost name). DNS-name targets are fully checked at
// delivery time by resolveOutboundTarget. In non-production the guard is relaxed so local
// integrations can point at http://localhost during development and tests.
export function assertWebhookUrlAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("invalid webhook url");
  }
  if (parsed.username || parsed.password) throw badRequest("notification destination url must not contain credentials");
  if (parsed.hash) throw badRequest("notification destination url must not contain a fragment");

  const host = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const isLocalName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");

  if (isIP(host) && isAlwaysBlockedNotificationAddress(host)) throw badRequest("webhook url host is not allowed");
  if (env.NODE_ENV !== "production") {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw badRequest("webhook url must use http(s)");
    return;
  }

  if (parsed.protocol !== "https:") throw badRequest("webhook url must use https");
  if (isLocalName) throw badRequest("webhook url host is not allowed");
  if (isIP(host) && isBlockedAddress(host)) throw badRequest("webhook url host is not allowed");
}

/** Browser push endpoints are capability URLs, but still user-controlled network targets. */
export function assertPushEndpointAllowed(url: string): void {
  const parsed = parseNotificationDestination(url);
  if (parsed.protocol !== "https:") throw badRequest("notification destination url must use https");
  if (parsed.hash) throw badRequest("notification destination url must not contain a fragment");
  const host = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isIP(host) && !notificationAddressAllowed(host)) throw badRequest("notification destination host is not allowed");
  if (!privateNotificationDestinationsAllowed() && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))) {
    throw badRequest("notification destination host is not allowed");
  }
}

export async function resolveOutboundTarget(rawUrl: string, policy: OutboundPolicy, signal: AbortSignal) {
  // A fragment is never sent on the wire. Saving a webhook now rejects one, but endpoints saved
  // before that must keep delivering, so drop it here rather than failing every delivery.
  const url = policy === "push" ? rawUrl : withoutFragment(rawUrl);
  if (policy === "push") assertPushEndpointAllowed(url);
  else if (policy === "notification") parseNotificationDestination(url);
  else assertWebhookUrlAllowed(url);
  const target = new URL(url);
  if (policy === "public" && target.protocol !== "https:") throw badRequest("notification destination url must use https");
  const host = target.hostname.replace(/^\[|\]$/gu, "");
  signal.throwIfAborted();
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("outbound request aborted"));
      signal.addEventListener("abort", abort, { once: true });
      void outboundDns.lookup(host, { all: true }).then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  const allowed = (address: string) => policy === "notification" || policy === "push"
    ? notificationAddressAllowed(address)
    : policy === "public" || env.NODE_ENV === "production" ? !isBlockedAddress(address) : !isAlwaysBlockedNotificationAddress(address);
  if (addresses.length === 0 || addresses.some(({ address }) => !allowed(address))) {
    throw badRequest("notification destination host resolves to a blocked address");
  }
  signal.throwIfAborted();
  return { target, address: addresses[0]! };
}

function withoutFragment(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hash && !url.endsWith("#")) return url;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Left for the policy check below to reject with its translated error.
    return url;
  }
}

function parseNotificationDestination(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("invalid notification destination url");
  }
  if (parsed.username || parsed.password) throw badRequest("notification destination url must not contain credentials");
  const privateAllowed = privateNotificationDestinationsAllowed();
  if (parsed.protocol !== "https:" && !(privateAllowed && parsed.protocol === "http:")) {
    throw badRequest(privateAllowed ? "notification destination url must use http(s)" : "notification destination url must use https");
  }
  return parsed;
}

function notificationAddressAllowed(address: string): boolean {
  return privateNotificationDestinationsAllowed()
    ? !isAlwaysBlockedNotificationAddress(address)
    : !isBlockedAddress(address);
}

// Personal notification targets deliberately have a narrower private-network escape hatch than
// workspace webhooks. Only a self-host operator can enable it, and metadata/reserved ranges remain
// unreachable. Validation happens both when saving and immediately before each request.
export async function assertNotificationDestinationAllowed(url: string): Promise<void> {
  const parsed = parseNotificationDestination(url);
  const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  if (isIP(hostname)) {
    if (!notificationAddressAllowed(hostname)) throw badRequest("notification destination host is not allowed");
    return;
  }
  const results = await lookup(hostname, { all: true });
  if (results.length === 0 || results.some((result) => !notificationAddressAllowed(result.address))) {
    throw badRequest("notification destination host resolves to a blocked address");
  }
}
