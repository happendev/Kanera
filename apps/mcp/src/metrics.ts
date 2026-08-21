import { timingSafeEqual } from "node:crypto";
import client from "prom-client";
import { env } from "./env.js";

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const httpDuration = new client.Histogram({
  name: "kanera_mcp_http_request_duration_seconds",
  help: "MCP HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const mcpToolDuration = new client.Histogram({
  name: "kanera_mcp_tool_duration_seconds",
  help: "MCP tool execution duration in seconds",
  labelNames: ["tool", "outcome", "error_code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const mcpAuthFailures = new client.Counter({
  name: "kanera_mcp_auth_failures_total",
  help: "Rejected MCP authentication attempts by reason",
  labelNames: ["reason"],
  registers: [registry],
});

const activeRequests = new client.Gauge({
  name: "kanera_mcp_active_http_requests",
  help: "Currently active MCP HTTP requests",
  registers: [registry],
});

export function observeMcpHttpRequest(method: string, route: string, statusCode: number, durationMs: number) {
  httpDuration.observe({ method, route, status_code: statusCode }, durationMs / 1_000);
}

export function trackActiveMcpRequest() {
  activeRequests.inc();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeRequests.dec();
  };
}

function tokenMatches(authorization: string | undefined) {
  if (!env.METRICS_TOKEN || !authorization) return false;
  const expected = Buffer.from(`Bearer ${env.METRICS_TOKEN}`);
  const supplied = Buffer.from(authorization);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function mcpMetricsResponse(authorization: string | undefined) {
  if (!env.METRICS_ENABLED || !tokenMatches(authorization)) return null;
  return { contentType: registry.contentType, body: await registry.metrics() };
}
