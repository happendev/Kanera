// Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
const CLOUDFLARE_CIDRS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

interface CidrRange {
  family: 4 | 6;
  network: bigint;
  mask: number;
}

const CLOUDFLARE_RANGES = CLOUDFLARE_CIDRS.map(parseCidr);

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeIp(ip: string | undefined) {
  if (!ip) return "";
  const trimmed = ip.trim();
  // Node may expose IPv4 peers as IPv4-mapped IPv6 addresses.
  if (trimmed.startsWith("::ffff:") && parseIpv4(trimmed.slice("::ffff:".length)) !== null) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}

function parseIpv4(ip: string) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    value = (value << 8n) + BigInt(byte);
  }
  return value;
}

function parseIpv6(ip: string) {
  const [withoutZone] = ip.split("%", 1);
  if (!withoutZone || withoutZone.split("::").length > 2) return null;
  const [left, right = ""] = withoutZone.split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const missing = 8 - leftParts.length - rightParts.length;
  if (missing < 0 || (withoutZone.includes("::") ? missing < 1 : missing !== 0)) return null;
  const parts = [...leftParts, ...Array<string>(missing).fill("0"), ...rightParts];
  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    value = (value << 16n) + BigInt(Number.parseInt(part, 16));
  }
  return value;
}

function parseIp(ip: string) {
  const normalized = normalizeIp(ip);
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== null) return { family: 4 as const, value: ipv4 };
  const ipv6 = parseIpv6(normalized);
  if (ipv6 !== null) return { family: 6 as const, value: ipv6 };
  return null;
}

function parseCidr(cidr: string): CidrRange {
  const [ip, maskString] = cidr.split("/");
  const parsed = parseIp(ip!);
  if (!parsed) throw new Error(`invalid CIDR range: ${cidr}`);
  return { family: parsed.family, network: parsed.value, mask: Number(maskString) };
}

function ipInRange(ip: string, range: CidrRange) {
  const parsed = parseIp(ip);
  if (!parsed || parsed.family !== range.family) return false;
  const bits = range.family === 4 ? 32 : 128;
  const shift = BigInt(bits - range.mask);
  return (parsed.value >> shift) === (range.network >> shift);
}

export function isCloudflarePeer(remoteAddress: string | undefined) {
  const ip = normalizeIp(remoteAddress);
  return CLOUDFLARE_RANGES.some((range) => ipInRange(ip, range));
}

export function resolveClientIp(input: {
  headers: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  fallbackIp: string;
}) {
  const cfConnectingIp = normalizeIp(firstHeaderValue(input.headers["cf-connecting-ip"]));
  // CF-Connecting-IP is only trustworthy when the immediate peer is Cloudflare;
  // otherwise a client could spoof someone else's IP and dodge the rate bucket.
  if (cfConnectingIp && parseIp(cfConnectingIp) && isCloudflarePeer(input.remoteAddress)) {
    return cfConnectingIp;
  }

  // The caller supplies its framework/server-specific trusted-proxy result.
  return input.fallbackIp;
}
