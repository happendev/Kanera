import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { isBlockedAddress } from "./ssrf.js";

// Conservatively exclude transition, special-purpose and documentation IPv6 ranges as well as
// the shared private-address guard. IPv6 callbacks must use global unicast (2000::/3).
const callbackSpecialRanges = new BlockList();
callbackSpecialRanges.addSubnet("2001::", 23, "ipv6");
callbackSpecialRanges.addSubnet("2002::", 16, "ipv6");
callbackSpecialRanges.addSubnet("3fff::", 20, "ipv6");
callbackSpecialRanges.addSubnet("192.88.99.0", 24, "ipv4");
function callbackAddressBlocked(address: string) {
  const family = isIP(address);
  if (isBlockedAddress(address)) return true;
  if (family === 6 && !/^[23][0-9a-f]{3}:/iu.test(address)) return true;
  return callbackSpecialRanges.check(address, family === 6 ? "ipv6" : "ipv4");
}

export class McpCallbackError extends Error {
  constructor(readonly reason: string) { super("callback verification failed"); }
}
export function mcpWebhookHeaders(id: string, subscriptionId: string, body: string, secrets: string[], now = new Date()) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": secrets.map((secret) => `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`).join(" "),
    "X-MCP-Subscription-Id": subscriptionId,
  };
}
export interface McpWebhookResponse { status: number; body: string }
export type McpWebhookRequest = (url: string, body: string, headers: Record<string, string>) => Promise<McpWebhookResponse>;

// Resolve once per connection and feed that validated address to HTTPS's lookup callback. A second
// implicit DNS lookup after validation would let a rebinding host reach the private network.
export const postMcpWebhook: McpWebhookRequest = async (url, body, headers) => {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || target.hash) throw new McpCallbackError("invalid_url");
  const hostname = target.hostname.replace(/^\[|\]$/gu, "");
  const deadline = AbortSignal.timeout(10_000);
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const abort = () => reject(new McpCallbackError("timeout"));
    deadline.addEventListener("abort", abort, { once: true });
    void lookup(hostname, { all: true }).then(resolve, () => reject(new McpCallbackError("connection_refused"))).finally(() => deadline.removeEventListener("abort", abort));
  });
  if (!addresses.length || addresses.some((entry) => callbackAddressBlocked(entry.address))) throw new McpCallbackError("blocked_address");
  if (deadline.aborted) throw new McpCallbackError("timeout");
  const pinned = addresses[0]!;
  return new Promise((resolve, reject) => {
    // No redirect handling: 3xx responses are returned as failures. Node keeps the URL hostname
    // for Host and TLS certificate verification while lookup supplies only the pinned address.
    const req = request(target, {
      method: "POST", headers, signal: deadline, agent: false,
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      },
    }, (res) => {
      let responseBody = "";
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        // Only a verification echo needs the body. A larger body cannot be a valid echo, but its
        // status still decides delivery success, so report the status with an empty body rather
        // than failing (and endlessly retrying) a delivery the endpoint already acknowledged.
        if (bytes > 4096) { res.destroy(); resolve({ status: res.statusCode ?? 0, body: "" }); }
        else responseBody += chunk.toString("utf8");
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      res.on("error", reject);
    });
    req.on("error", (error: NodeJS.ErrnoException) => reject(new McpCallbackError(
      deadline.aborted ? "timeout" : error.code === "ECONNREFUSED" ? "connection_refused" : error.code?.includes("CERT") || error.code?.includes("TLS") ? "tls_error" : "connection_refused",
    )));
    req.end(body);
  });
};

export async function verifyMcpCallback(url: string, secret: string, subscriptionId: string, send: McpWebhookRequest = postMcpWebhook) {
  const challenge = randomBytes(32).toString("base64url");
  const id = `msg_verification_${randomBytes(16).toString("hex")}`;
  const body = JSON.stringify({ type: "verification", challenge });
  let response: McpWebhookResponse;
  try { response = await send(url, body, mcpWebhookHeaders(id, subscriptionId, body, [secret])); }
  catch (error) { throw error instanceof McpCallbackError ? error : new McpCallbackError("connection_refused"); }
  if (response.status < 200 || response.status >= 300) throw new McpCallbackError(response.status >= 500 ? "http_5xx" : response.status >= 400 ? "http_4xx" : "challenge_failed");
  let echoed: unknown;
  try { echoed = (JSON.parse(response.body) as { challenge?: unknown }).challenge; }
  catch { throw new McpCallbackError("challenge_failed"); }
  if (typeof echoed !== "string" || Buffer.byteLength(echoed) !== Buffer.byteLength(challenge)
    || !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) throw new McpCallbackError("challenge_failed");
}
