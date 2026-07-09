import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveClientIp } from "@kanera/shared/client-ip";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { env } from "./env.js";
import { createKaneraMcpServer } from "./server.js";

class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      reject(new RequestBodyError("request body too large", 413));
      return;
    }
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        req.pause();
        reject(new RequestBodyError("request body too large", 413));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(body) as unknown);
      } catch (error) {
        reject(new RequestBodyError(error instanceof Error ? error.message : String(error), 400));
      }
    });
    req.on("error", reject);
  });
}

export function mcpRequestPathname(url: string | undefined) {
  return new URL(url ?? "/", "http://localhost").pathname;
}

type RateLimitEntry = { count: number; resetAt: number };

export function mcpClientIp(req: IncomingMessage, trustProxy: boolean) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const proxyResolvedIp = trustProxy && typeof forwardedFor === "string"
    ? forwardedFor.split(",", 1)[0]!.trim()
    : req.socket.remoteAddress ?? "unknown";
  return resolveClientIp({
    headers: req.headers,
    remoteAddress: req.socket.remoteAddress,
    fallbackIp: proxyResolvedIp,
  });
}

export function createMcpHttpHandler(options: {
  bodyMaxBytes?: number;
  ipRateLimitPerMinute?: number;
  keyRateLimitPerMinute?: number;
  rateLimitWindowMs?: number;
  trustProxy?: boolean;
} = {}) {
  const bodyMaxBytes = options.bodyMaxBytes ?? env.MCP_BODY_MAX_BYTES;
  const ipRateLimitPerMinute = options.ipRateLimitPerMinute ?? env.PUBLIC_API_IP_RATE_LIMIT_PER_MINUTE;
  const keyRateLimitPerMinute = options.keyRateLimitPerMinute ?? env.PUBLIC_API_KEY_RATE_LIMIT_PER_MINUTE;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? env.PUBLIC_API_RATE_LIMIT_WINDOW_MS;
  const trustProxy = options.trustProxy ?? env.MCP_TRUST_PROXY;
  const requestBuckets = new Map<string, RateLimitEntry>();

  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    const pathname = mcpRequestPathname(req.url);
    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "mcp" }));
      return;
    }
    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const now = Date.now();
    // Keep raw-node MCP attribution identical to Fastify: CF-Connecting-IP wins only for a direct
    // Cloudflare peer; otherwise the server's trusted-proxy result is used as the fallback.
    const clientIp = mcpClientIp(req, trustProxy);
    if (requestBuckets.size > 10_000) {
      for (const [key, entry] of requestBuckets) if (entry.resetAt <= now) requestBuckets.delete(key);
    }
    const authorization = req.headers.authorization;
    // Accepts both key shapes: workspace keys are kanera_<env>_…, personal keys add a `u_` marker
    // (kanera_u_<env>_…). Both carry the same 32-byte base64url secret; the downstream API is authoritative.
    const isApiKey = !!authorization && /^Bearer kanera_(?:u_)?(?:live|stg|dev|test)_[A-Za-z0-9_-]{43}$/.test(authorization);
    // Match the public API policy: malformed/missing auth is IP-bucketed, while key-shaped auth gets
    // the higher per-key allowance. The downstream public API remains authoritative and applies its
    // separate 10/minute failed-key IP bucket when a shaped token does not authenticate.
    const bucketKey = isApiKey
      ? `apiKey:${createHash("sha256").update(authorization).digest("base64url")}`
      : `ip:${clientIp}`;
    const rateLimit = isApiKey ? keyRateLimitPerMinute : ipRateLimitPerMinute;
    const current = requestBuckets.get(bucketKey);
    const rate = !current || current.resetAt <= now ? { count: 1, resetAt: now + rateLimitWindowMs } : { ...current, count: current.count + 1 };
    requestBuckets.set(bucketKey, rate);
    if (rate.count > rateLimit) {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((rate.resetAt - now) / 1_000))));
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "too many requests" }));
      return;
    }
    // Generated keys contain a known environment prefix and a 32-byte base64url secret. Rejecting
    // prefix-only fakes before reading the body prevents unauthenticated streams consuming memory.
    if (!authorization || !isApiKey) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing Kanera API key bearer token" }));
      return;
    }
    const mcp = createKaneraMcpServer({ apiKey: authorization.slice("Bearer ".length) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    try {
      const body = req.method === "POST" ? await readBody(req, bodyMaxBytes) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        const statusCode = error instanceof RequestBodyError ? error.statusCode : 500;
        res.writeHead(statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: statusCode === 500 ? "internal server error" : error instanceof Error ? error.message : "invalid request" }));
      }
    } finally {
      await mcp.close();
    }
  };
}

export function startMcpHttpServer() {
  const httpServer = createServer(createMcpHttpHandler());
  httpServer.requestTimeout = env.MCP_REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = env.MCP_HEADERS_TIMEOUT_MS;
  httpServer.keepAliveTimeout = env.MCP_KEEP_ALIVE_TIMEOUT_MS;
  httpServer.listen(env.MCP_PORT, () => {
    console.log(`Kanera MCP server listening on http://localhost:${env.MCP_PORT}/mcp`);
  });
  return httpServer;
}

export function installMcpGracefulShutdown(httpServer: ReturnType<typeof createServer>) {
  let shutdownStarted = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownStarted) {
      console.error(`Received a second ${signal}; forcing MCP server exit`);
      process.exit(1);
    }
    shutdownStarted = true;
    console.log(`Received ${signal}; draining MCP HTTP server`);
    httpServer.close((error) => {
      if (error) {
        console.error("MCP HTTP server shutdown failed", error);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const httpServer = startMcpHttpServer();
  installMcpGracefulShutdown(httpServer);
}
