#!/usr/bin/env node
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Usage: node benchmarks/api/ui-reads-load-summary.mjs <mixed-result.json>");
const input = JSON.parse(readFileSync(path, "utf8"));
const median = (values) => {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const rows = input.levels.map((concurrency) => {
  const batches = input.results.filter((r) => r.concurrency === concurrency);
  const variants = Object.fromEntries(["before", "after"].map((variant) => {
    const selected = batches.filter((r) => r.variant === variant);
    if (selected.length !== input.rounds) throw new Error(`Incomplete ${variant} c${concurrency}`);
    return [variant, {
      requests: selected.reduce((sum, r) => sum + r.requests, 0),
      errors: selected.reduce((sum, r) => sum + r.errors, 0),
      metricsErrors: selected.reduce((sum, r) => sum + r.metricsErrors.length, 0),
      p50Ms: median(selected.map((r) => r.p50Ms)),
      p95Ms: median(selected.map((r) => r.p95Ms)),
      p99Ms: median(selected.map((r) => r.p99Ms)),
      maxMs: selected.some((r) => r.maxMs !== null) ? Math.max(...selected.map((r) => r.maxMs ?? 0)) : null,
      rps: median(selected.map((r) => r.rps)),
      maxConnections: Math.max(...selected.map((r) => r.pool.maxTotal)),
      meanWaiting: median(selected.map((r) => r.pool.meanWaiting)),
      p95Waiting: median(selected.map((r) => r.pool.p95Waiting)),
      maxWaiting: Math.max(...selected.map((r) => r.pool.maxWaiting)),
      waitingSamplePercent: median(selected.map((r) => r.pool.waitingSamplePercent)),
      endpoints: selected[0].endpoints.map(({ name }) => {
        const endpoints = selected.map((r) => r.endpoints.find((e) => e.name === name));
        return { name, p50Ms: median(endpoints.map((r) => r.p50Ms)),
          p95Ms: median(endpoints.map((r) => r.p95Ms)), p99Ms: median(endpoints.map((r) => r.p99Ms)) };
      }),
    }];
  }));
  // Fast rejection responses must never be reported as a performance improvement.
  const validComparison = batches.every((r) => r.errors === 0 && r.metricsErrors.length === 0 && r.requests > 0);
  return { concurrency, ...variants, validComparison,
    throughputChangePercent: validComparison ? (variants.after.rps / variants.before.rps - 1) * 100 : null,
    p95ImprovementPercent: validComparison ? (1 - variants.after.p95Ms / variants.before.p95Ms) * 100 : null,
    fasterP95Rounds: validComparison ? batches.filter((r) => r.variant === "after" && r.p95Ms < batches.find((b) => b.variant === "before" && b.round === r.round).p95Ms).length : null,
  };
});
console.log(JSON.stringify({ rounds: input.rounds, durationMs: input.durationMs, rows }, null, 2));
