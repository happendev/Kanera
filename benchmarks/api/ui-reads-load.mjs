#!/usr/bin/env node
// Local mixed-read load test. Fixed-duration AB/BA pairs expose pool contention;
// closed-loop concurrency models in-flight requests, not a count of logged-in users.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const targets = [
  { variant: "before", origin: process.env.PERF_API_URL ?? "http://localhost:3100" },
  { variant: "after", origin: process.env.PERF_COMPARE_URL ?? "http://localhost:3101" },
];
for (const { origin } of targets) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Local API required");
}
const rounds = Number(process.env.PERF_ROUNDS ?? 6);
const durationMs = Number(process.env.PERF_DURATION_MS ?? 5000);
const levels = (process.env.PERF_LEVELS ?? "1,10,20,50,100").split(",").map(Number);
if (![rounds, durationMs, ...levels].every((n) => Number.isInteger(n) && n > 0)) throw new Error("Positive integer configuration required");
const metricsToken = process.env.PERF_METRICS_TOKEN;
if (!metricsToken) throw new Error("PERF_METRICS_TOKEN required; configure the same METRICS_TOKEN on both APIs");
const output = process.env.PERF_OUTPUT ?? "benchmarks/api/results/ui-reads/pool20-mixed.json";
const emails = (process.env.PERF_EMAILS ?? "amelia@kanera.test,priya@kanera.test,ben@kanera.test").split(",");
const scenarios = [];
async function request(origin, path, headers, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { ...headers, "content-type": "application/json" } : headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, text: await response.text() };
}
async function json(origin, path, headers, body) {
  const result = await request(origin, path, headers, body);
  assert.equal(result.status, 200, `${path}: HTTP ${result.status}`);
  return JSON.parse(result.text);
}
for (const email of emails) {
  const session = await json(targets[0].origin, "/auth/login", {}, {
    email, password: process.env.PERF_PASSWORD ?? "Abc12345",
  });
  assert.ok(session.accessToken, "Login token missing");
  const headers = { authorization: `Bearer ${session.accessToken}` };
  const home = await json(targets[0].origin, "/home/boards", headers);
  const workspace = home.groups.find((g) => g.workspace.name === "Development Team");
  assert.ok(workspace, `${email}: Development Team access required`);
  const id = workspace.workspace.id;
  for (const [name, path, body] of [
    ["home-boards", "/home/boards"],
    ["portfolio", "/work/portfolio/query", { days: 30, timeZone: "UTC" }],
    ["workspace-members", `/workspaces/${id}/members`],
    ["notifications", "/notifications?includeRead=true&limit=50"],
    ["search", "/search?q=card"],
    ["work-catalog", "/work/catalog"],
    ["workspace-detail", `/workspaces/${id}`],
  ]) {
    const responses = await Promise.all(targets.map(({ origin }) => json(origin, path, headers, body)));
    assert.deepStrictEqual(responses[0], responses[1], `${email}/${name}: response mismatch`);
    scenarios.push({ email, name, path, body, headers });
  }
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
};
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function distribution(values) {
  return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: values.length ? Math.max(...values) : null };
}
async function poolSample(origin) {
  const result = await request(origin, "/metrics", { authorization: `Bearer ${metricsToken}` });
  assert.equal(result.status, 200, "Metrics unavailable");
  const states = {};
  for (const state of ["total", "idle", "waiting"]) {
    const match = result.text.match(new RegExp(`^kanera_pg_pool_connections\\{state="${state}"\\} (\\d+)$`, "m"));
    assert.ok(match, `Missing pool metric: ${state}`);
    states[state] = Number(match[1]);
  }
  return states;
}
for (const { origin } of targets) await poolSample(origin);
const results = [];
function save() {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version,
    targets, rounds, durationMs, levels, emails, metricIntervalMs: 100,
    workload: "Equal endpoint and account weights; closed loop; sequential variants; AB/BA pairs",
    responseParityChecks: scenarios.length,
    scenarios: scenarios.map(({ email, name, path, body }) => ({ email, name, path, body })), results,
  }, null, 2) + "\n");
}
async function batch(target, concurrency, round, measureMs, record) {
  let next = 0;
  let active = true;
  const samples = [];
  const metrics = [];
  const metricsErrors = [];
  const started = performance.now();
  // Scrape only the active API. Sampling may miss brief queue peaks; retain raw values.
  const sampler = (async () => {
    while (active) {
      try { metrics.push({ atMs: performance.now() - started, ...await poolSample(target.origin) }); }
      catch (error) { metricsErrors.push(String(error)); }
      await delay(100);
    }
  })();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() - started < measureMs) {
      const index = next++ % scenarios.length;
      const scenario = scenarios[index];
      const start = performance.now();
      try {
        const response = await request(target.origin, scenario.path, scenario.headers, scenario.body);
        samples.push({ index, ms: performance.now() - start, status: response.status,
          ...(response.status !== 200 ? { error: response.text.slice(0, 200) } : {}) });
      } catch (error) {
        samples.push({ index, ms: performance.now() - start, status: 0, error: String(error) });
      }
    }
  }));
  const elapsedMs = performance.now() - started;
  active = false;
  await sampler;
  if (!record) {
    assert.equal(samples.filter((s) => s.status !== 200).length, 0, "Warmup request failed");
    assert.equal(metricsErrors.length, 0, "Warmup metrics failed");
    return;
  }
  const ok = samples.filter((s) => s.status === 200);
  const result = { variant: target.variant, concurrency, round, elapsedMs,
    requests: samples.length, errors: samples.length - ok.length,
    rps: ok.length * 1000 / elapsedMs, ...distribution(ok.map((s) => s.ms)),
    pool: { sampleCount: metrics.length, maxTotal: Math.max(...metrics.map((m) => m.total)),
      meanWaiting: mean(metrics.map((m) => m.waiting)), p95Waiting: percentile(metrics.map((m) => m.waiting), 0.95),
      maxWaiting: Math.max(...metrics.map((m) => m.waiting)),
      waitingSamplePercent: 100 * metrics.filter((m) => m.waiting > 0).length / metrics.length },
    endpoints: [...new Set(scenarios.map((s) => s.name))].map((name) => {
      const rows = samples.filter((s) => scenarios[s.index].name === name);
      return { name, requests: rows.length, errors: rows.filter((s) => s.status !== 200).length,
        ...distribution(rows.filter((s) => s.status === 200).map((s) => s.ms)) };
    }),
    metricsErrors, metrics, samples,
  };
  results.push(result);
  save();
  console.log(JSON.stringify({ ...result, metrics: undefined, samples: undefined, endpoints: undefined }));
}
console.log(`Parity passed: ${scenarios.length} responses; starting mixed traffic`);
for (const concurrency of levels) {
  // Access tokens expire after five minutes by default. Renew outside measured batches
  // so a long sweep cannot turn into a misleading benchmark of cheap 401 responses.
  for (const email of emails) {
    const session = await json(targets[0].origin, "/auth/login", {}, {
      email, password: process.env.PERF_PASSWORD ?? "Abc12345",
    });
    assert.ok(session.accessToken, "Login token missing");
    for (const scenario of scenarios.filter((s) => s.email === email)) {
      scenario.headers.authorization = `Bearer ${session.accessToken}`;
    }
  }
  for (const target of targets) await batch(target, concurrency, 0, 2000, false);
  for (let round = 1; round <= rounds; round++) {
    for (const target of round % 2 ? targets : [...targets].reverse()) {
      await batch(target, concurrency, round, durationMs, true);
    }
  }
}
console.log(`Saved ${output}`);
if (results.some((r) => r.errors > 0 || r.metricsErrors.length > 0)) {
  console.error("Load test contained request or metrics failures; inspect the saved errors before comparing performance.");
  process.exitCode = 1;
}
