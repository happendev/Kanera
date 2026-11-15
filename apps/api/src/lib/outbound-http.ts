import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveOutboundTarget, type OutboundPolicy } from "./ssrf.js";

interface OutboundOptions {
  policy?: OutboundPolicy;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * "truncate" keeps the first maxResponseBytes and stops reading instead of failing. For
   * deliveries the request has already been accepted; a large answer must not turn it into a retry.
   */
  oversizedResponse?: "reject" | "truncate";
}

/** Bounded responses, no redirects, and no second DNS lookup after checking the destination. */
async function fetchOutbound(input: string | URL, init: RequestInit = {}, options: OutboundOptions = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const { target, address } = await resolveOutboundTarget(input.toString(), options.policy ?? "webhook", signal);
  const limit = options.maxResponseBytes ?? 256 * 1024;
  // These integration requests carry JSON strings or no body. Refuse unsupported
  // bodies before opening a socket instead of silently sending a different payload.
  if (init.body != null && typeof init.body !== "string" && !Buffer.isBuffer(init.body)) throw new TypeError("unsupported outbound request body");
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  return new Promise<Response>((resolve, reject) => {
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(target, {
      method: init.method ?? "GET", headers, signal, agent: false,
      lookup: (_host, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (res) => {
      void (async () => {
        // Credentials and capability URLs must never be forwarded to a redirect target.
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && init.redirect !== "manual") throw new Error("outbound redirects are not allowed");
        const truncate = options.oversizedResponse === "truncate";
        const declared = Number(res.headers["content-length"]);
        if (!truncate && Number.isFinite(declared) && declared > limit) throw new Error("outbound response is too large");
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of res) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          if (bytes + buffer.length > limit) {
            if (!truncate) throw new Error("outbound response is too large");
            chunks.push(buffer.subarray(0, limit - bytes));
            bytes = limit;
            res.destroy();
            break;
          }
          bytes += buffer.length;
          chunks.push(buffer);
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        if (truncate && bytes >= limit) responseHeaders.delete("content-length");
        const status = res.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
      })().catch((error: unknown) => { res.destroy(); reject(error instanceof Error ? error : new Error("outbound request failed")); });
    });
    req.once("error", reject);
    // An unsolicited 101 bypasses Node's ordinary response callback. Reject it
    // explicitly: otherwise the request closes, removes its abort listener and
    // leaves this promise pending even after the delivery deadline.
    req.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("outbound protocol upgrades are not allowed"));
    });
    req.end(init.body ?? undefined);
  });
}

// Delivery tests can replace the transport while keeping queue/retry semantics
// deterministic. Dedicated transport tests exercise the real pinned connection.
export const outboundHttpClient = { fetch: fetchOutbound };
