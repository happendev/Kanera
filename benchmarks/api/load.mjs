#!/usr/bin/env node
// Opt-in concurrent load test for the read paths that dominate Kanera's server cost. It is not part
// of CI and never writes application data: every scenario is a read.
//
// The web benchmark in ../web measures one browser doing one thing at a time, so it cannot see the
// costs that only appear under connection pressure: pool contention (PG_POOL_MAX defaults to 10),
// fire-and-forget background work competing with foreground requests, and per-request query fan-out.
// Those are exactly what the backend phases of the performance plan change, so they need a
// concurrent client to be measurable at all.
//
// Deliberately dependency-free (global fetch + a small worker pool) rather than autocannon: these
// scenarios need an authenticated session, per-endpoint request bodies, and a card id discovered at
// startup, none of which a single-URL CLI expresses well. It also keeps the lockfile untouched, the
// same property the web harness gets from pinning Playwright through npx.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.PERF_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const EMAIL = process.env.PERF_EMAIL ?? "perf@kanera.local";
const PASSWORD = process.env.PERF_PASSWORD ?? "Perf12345";
const BOARD_ID = process.env.PERF_BOARD_ID ?? "70000000-0000-4000-8000-000000000200";
const CONNECTIONS = intEnv("PERF_CONNECTIONS", 10, 1, 500);
const DURATION_MS = intEnv("PERF_DURATION_MS", 10_000, 500, 600_000);
const WARMUP_MS = intEnv("PERF_WARMUP_MS", 1_000, 0, 60_000);
const CARD_SAMPLE = intEnv("PERF_CARD_SAMPLE", 25, 1, 500);
const LABEL = process.env.PERF_LABEL ?? "local-baseline";
const ONLY = (process.env.PERF_SCENARIOS ?? "").split(",").map((name) => name.trim()).filter(Boolean);

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

// The harness hammers endpoints with concurrent traffic. Refuse anything that is not obviously a
// local development stack unless the operator opts in explicitly.
function assertLocalOnly() {
  if (process.env.PERF_ALLOW_REMOTE === "1") return;
  const host = new URL(BASE_URL).hostname;
  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(host)) {
    throw new Error(`Refusing to load test ${BASE_URL}. Set PERF_ALLOW_REMOTE=1 to override.`);
  }
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

async function login() {
  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status} ${await response.text()}`);
  const body = await response.json();
  if (body.status !== "authenticated") throw new Error(`login returned status=${body.status}; MFA-enabled accounts cannot be used here`);
  return body.accessToken;
}

/** Cards to request detail for. Reading them up front keeps the measured loop free of setup work. */
async function discoverCardIds(token) {
  const response = await fetch(`${BASE_URL}/work/cards/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ lens: "my", limit: Math.min(100, CARD_SAMPLE), sort: "dueAsc" }),
  });
  if (!response.ok) throw new Error(`card discovery failed: ${response.status} ${await response.text()}`);
  const body = await response.json();
  const ids = (body.cards ?? []).map((card) => card.id).filter(Boolean).slice(0, CARD_SAMPLE);
  if (ids.length === 0) throw new Error("no cards visible to the benchmark login; run `pnpm perf:web:seed` first");
  return ids;
}

const SCENARIOS = [
  {
    name: "board-open",
    // The single hottest interactive read: nine parallel queries plus per-card payload compaction.
    request: () => ({ url: `${BASE_URL}/boards/${BOARD_ID}/open`, init: { method: "POST" } }),
  },
  {
    name: "work-cards-query",
    // Global Work's first page: loadAccessibleBoards fan-out, then the keyset card query.
    request: () => ({
      url: `${BASE_URL}/work/cards/query`,
      init: { method: "POST", body: JSON.stringify({ lens: "my", limit: 50, sort: "dueAsc" }) },
    }),
  },
  {
    name: "work-cards-query-team",
    // The team lens widens the scope to every accessible board, so it is the fan-out worst case.
    request: () => ({
      url: `${BASE_URL}/work/cards/query`,
      init: { method: "POST", body: JSON.stringify({ lens: "team", limit: 50, sort: "dueAsc" }) },
    }),
  },
  {
    name: "card-detail",
    // Card detail is where the fire-and-forget internal-link repair and the OR-shaped link joins run.
    request: (context, iteration) => ({
      url: `${BASE_URL}/cards/${context.cardIds[iteration % context.cardIds.length]}/detail`,
      init: { method: "GET" },
    }),
  },
  {
    name: "work-catalog",
    request: () => ({ url: `${BASE_URL}/work/catalog`, init: { method: "GET" } }),
  },
];

async function runScenario(scenario, context) {
  const latencies = [];
  const statuses = new Map();
  let bytes = 0;
  let errors = 0;
  let iteration = 0;

  const authorization = `Bearer ${context.token}`;

  const runUntil = async (deadline, record) => {
    while (performance.now() < deadline) {
      const index = iteration++;
      const { url, init } = scenario.request(context, index);
      // Only declare a JSON body when there is one: Fastify rejects an empty body under
      // `content-type: application/json` with a 400, which would silently benchmark the error path.
      const headers = init.body === undefined
        ? { authorization }
        : { authorization, "content-type": "application/json" };
      const startedAt = performance.now();
      try {
        const response = await fetch(url, { ...init, headers });
        const body = await response.arrayBuffer();
        const elapsed = performance.now() - startedAt;
        if (!record) continue;
        latencies.push(elapsed);
        bytes += body.byteLength;
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        if (!response.ok) errors += 1;
      } catch (error) {
        if (!record) continue;
        errors += 1;
        statuses.set(String(error.code ?? "network-error"), (statuses.get(String(error.code ?? "network-error")) ?? 0) + 1);
      }
    }
  };

  if (WARMUP_MS > 0) {
    const warmupDeadline = performance.now() + WARMUP_MS;
    await Promise.all(Array.from({ length: CONNECTIONS }, () => runUntil(warmupDeadline, false)));
  }

  const startedAt = performance.now();
  const deadline = startedAt + DURATION_MS;
  await Promise.all(Array.from({ length: CONNECTIONS }, () => runUntil(deadline, true)));
  const elapsedMs = performance.now() - startedAt;

  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    scenario: scenario.name,
    requests: latencies.length,
    errors,
    elapsedMs: round(elapsedMs),
    requestsPerSecond: round((latencies.length / elapsedMs) * 1_000, 2),
    meanMs: round(sorted.reduce((total, value) => total + value, 0) / (sorted.length || 1), 2),
    p50Ms: round(percentile(sorted, 0.5), 2),
    p90Ms: round(percentile(sorted, 0.9), 2),
    p95Ms: round(percentile(sorted, 0.95), 2),
    p99Ms: round(percentile(sorted, 0.99), 2),
    maxMs: round(sorted.at(-1) ?? 0, 2),
    meanResponseKiB: round(bytes / (latencies.length || 1) / 1024, 2),
    totalResponseMiB: round(bytes / 1024 / 1024, 2),
    statuses: Object.fromEntries([...statuses.entries()].map(([key, value]) => [String(key), value])),
  };
}

assertLocalOnly();

const token = await login();
const cardIds = await discoverCardIds(token);
const context = { token, cardIds };

const selected = ONLY.length > 0 ? SCENARIOS.filter((scenario) => ONLY.includes(scenario.name)) : SCENARIOS;
if (selected.length === 0) throw new Error(`PERF_SCENARIOS matched nothing; known scenarios: ${SCENARIOS.map((s) => s.name).join(", ")}`);

const results = [];
for (const scenario of selected) {
  process.stdout.write(`running ${scenario.name} (${CONNECTIONS} connections, ${DURATION_MS}ms)...\n`);
  results.push(await runScenario(scenario, context));
}

const capturedAt = new Date().toISOString();
const result = {
  schemaVersion: 1,
  label: LABEL,
  capturedAt,
  baseUrl: BASE_URL,
  options: { connections: CONNECTIONS, durationMs: DURATION_MS, warmupMs: WARMUP_MS, cardSample: cardIds.length },
  environment: { nodeVersion: process.version, platform: process.platform, cpus: (await import("node:os")).cpus().length },
  scenarios: results,
};

console.log("\nKanera API load test");
console.table(results.map((row) => ({
  scenario: row.scenario,
  rps: row.requestsPerSecond,
  "p50 ms": row.p50Ms,
  "p95 ms": row.p95Ms,
  "p99 ms": row.p99Ms,
  "max ms": row.maxMs,
  requests: row.requests,
  errors: row.errors,
  "resp KiB": row.meanResponseKiB,
})));
console.log("KANERA_API_PERF_RESULT=" + JSON.stringify(result));

const safeTimestamp = capturedAt.replaceAll(":", "-");
const safeLabel = LABEL.replaceAll(/[^a-zA-Z0-9_-]+/g, "-").replaceAll(/^-|-$/g, "") || "benchmark";
const outputPath = process.env.PERF_OUTPUT ?? join(HERE, "results", `${safeTimestamp}-${safeLabel}.json`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(`Saved timestamped result: ${outputPath}`);

const failed = results.filter((row) => row.errors > 0);
if (failed.length > 0) {
  console.error(`\nScenarios returned errors: ${failed.map((row) => `${row.scenario} (${row.errors})`).join(", ")}`);
  process.exitCode = 1;
}
