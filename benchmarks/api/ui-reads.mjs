#!/usr/bin/env node
// Local-only, read-only endpoint benchmark. Login creates a session; measured requests are reads.
// Run before and after with identical seed data, pool size and concurrency. Raw samples are saved.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import assert from "node:assert/strict";

const base = process.env.PERF_API_URL ?? "http://localhost:3000";
const compare = process.env.PERF_COMPARE_URL;
const targets = [{ variant: "before", origin: base }, ...(compare ? [{ variant: "after", origin: compare }] : [])];
for (const { origin } of targets) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Local API required");
}
const count = Number(process.env.PERF_SAMPLES ?? 200);
const concurrency = Number(process.env.PERF_CONNECTIONS ?? 1);
const rounds = Number(process.env.PERF_ROUNDS ?? 1);
if (![count, concurrency, rounds].every((n) => Number.isInteger(n) && n > 0)) throw new Error("Positive integer samples/connections required");
const label = process.env.PERF_LABEL ?? "local";
const email = process.env.PERF_EMAIL ?? "amelia@kanera.test";
const login = await fetch(`${base}/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: process.env.PERF_PASSWORD ?? "Abc12345" }),
});
const session = await login.json();
if (!login.ok || !session.accessToken) throw new Error(`Login failed: ${login.status}`);
const headers = { authorization: `Bearer ${session.accessToken}` };
async function request(path, body, origin = base) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { ...headers, "content-type": "application/json" } : headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`);
  return text;
}
const home = JSON.parse(await request("/home/boards"));
const workspace = home.groups.find((g) => g.workspace.name === "Development Team") ?? home.groups.find((g) => g.workspace.kind === "workspace") ?? home.groups[0];
if (!workspace) throw new Error("No accessible workspace");
const id = workspace.workspace.id;
const scenarios = [
  ["home-boards", "/home/boards"],
  ["portfolio", "/work/portfolio/query", { days: 30, timeZone: "UTC" }],
  ["workspace-members", `/workspaces/${id}/members`],
  ["notifications", "/notifications?includeRead=true&limit=50"],
  ["search", "/search?q=card"],
  ["work-catalog", "/work/catalog"],
  ["workspace-detail", `/workspaces/${id}`],
];
const results = [];
for (const [name, path, body] of scenarios) {
  // Both processes must use the same JWT secret and data. Comparing complete responses also
  // prevents a fast error/empty response from masquerading as an improvement.
  if (compare) {
    const snapshots = await Promise.all(targets.map(({ origin }) => request(path, body, origin).then(JSON.parse)));
    assert.deepStrictEqual(snapshots[1], snapshots[0], `${name}: before/after response mismatch`);
  }
  for (const { origin } of targets) {
    for (let i = 0; i < 20; i++) await request(path, body, origin);
  }
  for (let round = 0; round < rounds; round++) {
    // Alternate AB / BA to reduce bias from drifting machine load and database caches.
    for (const { variant, origin } of round % 2 ? [...targets].reverse() : targets) {
      let next = 0;
      let bytes = 0;
      const samples = [];
      const start = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next++ < count) {
          const before = performance.now();
          const text = await request(path, body, origin);
          samples.push(performance.now() - before);
          bytes += Buffer.byteLength(text);
        }
      }));
      const elapsedMs = performance.now() - start;
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
      results.push({ name, path, variant, round: round + 1, count, concurrency, p50Ms: percentile(0.5), p95Ms: percentile(0.95), meanMs: samples.reduce((a, b) => a + b, 0) / count, rps: count * 1000 / elapsedMs, meanBytes: bytes / count, samples });
      console.log(`${name} ${variant} round ${round + 1}: p50=${percentile(0.5).toFixed(2)}ms p95=${percentile(0.95).toFixed(2)}ms`);
    }
  }
}
const output = process.env.PERF_OUTPUT ?? `benchmarks/api/results/ui-reads/${label}-c${concurrency}.json`;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ label, base, compare, rounds, email, workspaceId: id, capturedAt: new Date().toISOString(), node: process.version, results }, null, 2) + "\n");
console.log(`Saved ${output}`);
