import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveClientIp } from "@kanera/shared/client-ip";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { env } from "./env.js";
import { McpDistributedRateLimiter, type DistributedRateLimitResult } from "./distributed-rate-limit.js";
import { mcpAuthFailures, mcpMetricsResponse, observeMcpHttpRequest, trackActiveMcpRequest } from "./metrics.js";
import { createKaneraMcpServer } from "./server.js";

const require = createRequire(import.meta.url);
const mcpPackage = require("../package.json") as { version: string };

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

type McpTokenExchange = (token: string, resource: string) => Promise<string>;

export class McpTokenExchangeError extends Error {
  constructor(readonly retryable: boolean) {
    super(retryable ? "MCP token exchange temporarily unavailable" : "invalid or expired MCP access token");
  }
}

const MCP_RESOURCE_SCOPES = ["kanera:read", "kanera:write"] as const;

export function mcpAuthorizationChallenge(resource: string, error?: "invalid_token") {
  const metadata = new URL("/.well-known/oauth-protected-resource", resource);
  // The MCP endpoint exposes both read and mutation tools. Advertising only the read scope here
  // causes clients that derive their authorization request from the challenge to mint a valid but
  // read-only connection, even when the user later permits write actions in the client UI.
  return `Bearer resource_metadata="${metadata.toString()}", scope="${MCP_RESOURCE_SCOPES.join(" ")}"${error ? `, error="${error}"` : ""}`;
}

async function exchangeMcpToken(token: string, resource: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(new URL("/oauth/mcp/delegate", env.KANERA_PUBLIC_API_URL), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-kanera-mcp-secret": env.MCP_INTERNAL_SECRET,
      },
      body: JSON.stringify({ token, resource }),
      signal: AbortSignal.timeout(env.MCP_UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new McpTokenExchangeError(true);
  }
  if (!response.ok) throw new McpTokenExchangeError(response.status === 429 || response.status >= 500);
  const payload = await response.json() as { accessToken?: unknown };
  if (typeof payload.accessToken !== "string" || !payload.accessToken.startsWith("kanera_delegate_")) {
    throw new Error("invalid MCP token exchange response");
  }
  return payload.accessToken;
}

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
  tokenExchange?: McpTokenExchange;
  rateLimitCheck?: (key: string, limit: number, windowMs: number, now: number) => Promise<DistributedRateLimitResult | null>;
} = {}) {
  const bodyMaxBytes = options.bodyMaxBytes ?? env.MCP_BODY_MAX_BYTES;
  const ipRateLimitPerMinute = options.ipRateLimitPerMinute ?? env.PUBLIC_API_IP_RATE_LIMIT_PER_MINUTE;
  const keyRateLimitPerMinute = options.keyRateLimitPerMinute ?? env.PUBLIC_API_KEY_RATE_LIMIT_PER_MINUTE;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? env.PUBLIC_API_RATE_LIMIT_WINDOW_MS;
  const trustProxy = options.trustProxy ?? env.MCP_TRUST_PROXY;
  const tokenExchange = options.tokenExchange ?? exchangeMcpToken;
  const requestBuckets = new Map<string, RateLimitEntry>();
  let nextBucketSweepAt = 0;

  const localRateLimit = (bucketKey: string, limit: number, now: number) => {
    if (now >= nextBucketSweepAt) {
      for (const [key, entry] of requestBuckets) if (entry.resetAt <= now) requestBuckets.delete(key);
      nextBucketSweepAt = now + rateLimitWindowMs;
    }
    const current = requestBuckets.get(bucketKey);
    const rate = !current || current.resetAt <= now ? { count: 1, resetAt: now + rateLimitWindowMs } : { ...current, count: current.count + 1 };
    if (!current && requestBuckets.size >= 10_000) {
      const oldestKey = requestBuckets.keys().next().value as string | undefined;
      if (oldestKey) requestBuckets.delete(oldestKey);
    }
    requestBuckets.set(bucketKey, rate);
    return rate;
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const startedAt = performance.now();
    const finishActiveRequest = trackActiveMcpRequest();
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-kanera-mcp-version", mcpPackage.version);
    const pathname = mcpRequestPathname(req.url);
    const metricRoute = pathname === "/mcp" || pathname === "/health" || pathname === "/metrics"
      ? pathname
      : pathname.startsWith("/.well-known/") ? "/.well-known/*" : "unmatched";
    res.once("finish", () => {
      finishActiveRequest();
      if (metricRoute !== "/metrics") observeMcpHttpRequest(req.method ?? "UNKNOWN", metricRoute, res.statusCode, performance.now() - startedAt);
    });
    res.once("close", finishActiveRequest);
    if (pathname === "/metrics") {
      const metrics = await mcpMetricsResponse(req.headers.authorization);
      if (!metrics) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "content-type": metrics.contentType });
      res.end(metrics.body);
      return;
    }
    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "mcp", version: mcpPackage.version }));
      return;
    }
    const resource = env.MCP_SERVER_PUBLIC_URL ?? `http://${req.headers.host ?? `localhost:${env.MCP_PORT}`}/mcp`;
    const resourceMetadataPath = `/.well-known/oauth-protected-resource${new URL(resource).pathname === "/" ? "" : new URL(resource).pathname}`;
    if (pathname === "/.well-known/oauth-protected-resource" || pathname === resourceMetadataPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        resource,
        authorization_servers: [env.OAUTH_ISSUER_URL],
        // offline_access belongs to the authorization server's refresh flow, not the protected
        // resource's own capability set.
        scopes_supported: [...MCP_RESOURCE_SCOPES],
        bearer_methods_supported: ["header"],
      }));
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
    const authorization = req.headers.authorization;
    const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
    const isStaticApiKey = !!bearerToken && /^kanera_(?:(?:u_)?(?:live|stg|dev|test))_[A-Za-z0-9_-]{43}$/u.test(bearerToken);
    const isMcpToken = !!bearerToken && /^kanera_mcp_[A-Za-z0-9_-]{43}$/u.test(bearerToken);
    const isBearerCredential = isStaticApiKey || isMcpToken;
    // Match the public API policy: malformed/missing auth is IP-bucketed, while key-shaped auth gets
    // the higher per-key allowance. The downstream public API remains authoritative and applies its
    // separate 10/minute failed-key IP bucket when a shaped token does not authenticate.
    const bucketKey = isBearerCredential
      ? `apiKey:${createHash("sha256").update(bearerToken!).digest("base64url")}`
      : `ip:${clientIp}`;
    const rateLimit = isBearerCredential ? keyRateLimitPerMinute : ipRateLimitPerMinute;
    const rate = await options.rateLimitCheck?.(bucketKey, rateLimit, rateLimitWindowMs, now)
      ?? localRateLimit(bucketKey, rateLimit, now);
    if (rate.count > rateLimit) {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((rate.resetAt - now) / 1_000))));
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "too many requests" }));
      return;
    }
    // Generated keys contain a known environment prefix and a 32-byte base64url secret. Rejecting
    // prefix-only fakes before reading the body prevents unauthenticated streams consuming memory.
    if (!authorization || !bearerToken || !isBearerCredential) {
      mcpAuthFailures.inc({ reason: authorization ? "invalid_token_shape" : "missing_token" });
      if (env.MCP_SERVER_PUBLIC_URL) {
        res.setHeader("www-authenticate", mcpAuthorizationChallenge(env.MCP_SERVER_PUBLIC_URL, authorization ? "invalid_token" : undefined));
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing or invalid Kanera bearer token" }));
      return;
    }
    let downstreamToken = bearerToken;
    if (isMcpToken) {
      try {
        downstreamToken = await tokenExchange(bearerToken, resource);
      } catch (error) {
        const unavailable = error instanceof McpTokenExchangeError && error.retryable;
        mcpAuthFailures.inc({ reason: unavailable ? "token_exchange_unavailable" : "token_exchange" });
        if (unavailable) {
          res.setHeader("retry-after", "1");
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "MCP authentication is temporarily unavailable" }));
          return;
        }
        if (env.MCP_SERVER_PUBLIC_URL) {
          res.setHeader("www-authenticate", mcpAuthorizationChallenge(env.MCP_SERVER_PUBLIC_URL, "invalid_token"));
        }
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid or expired MCP access token" }));
        return;
      }
    }
    const mcp = createKaneraMcpServer({ apiKey: downstreamToken });
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
  const distributedRateLimiter = new McpDistributedRateLimiter(env.REDIS_URL);
  const httpServer = createServer(createMcpHttpHandler({
    rateLimitCheck: (key, limit, windowMs, now) => distributedRateLimiter.check(key, limit, windowMs, now),
  }));
  httpServer.requestTimeout = env.MCP_REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = env.MCP_HEADERS_TIMEOUT_MS;
  httpServer.keepAliveTimeout = env.MCP_KEEP_ALIVE_TIMEOUT_MS;
  httpServer.listen(env.MCP_PORT, () => {
    console.log(`Kanera MCP server listening on http://localhost:${env.MCP_PORT}/mcp`);
  });
  httpServer.once("close", () => distributedRateLimiter.close());
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
