#!/usr/bin/env node
// Summarize paired batches without treating a noisy individual run as representative.
import { readFileSync } from "node:fs";
const path = process.argv[2];
if (!path) throw new Error("Usage: node benchmarks/api/ui-reads-summary.mjs <paired-result.json>");
const input = JSON.parse(readFileSync(path, "utf8"));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const rows = [...new Set(input.results.map((r) => r.name))].map((name) => {
  const before = input.results.filter((r) => r.name === name && r.variant === "before");
  const after = input.results.filter((r) => r.name === name && r.variant === "after");
  if (!before.length || before.length !== after.length) throw new Error(`${name}: unpaired results`);
  const beforeP50 = median(before.map((r) => r.p50Ms));
  const afterP50 = median(after.map((r) => r.p50Ms));
  return { name, beforeP50, afterP50, improvementPercent: (1 - afterP50 / beforeP50) * 100,
    beforeP95: median(before.map((r) => r.p95Ms)), afterP95: median(after.map((r) => r.p95Ms)),
    beforeRps: median(before.map((r) => r.rps)), afterRps: median(after.map((r) => r.rps)),
    rounds: before.length, samplesPerVariant: before.reduce((sum, r) => sum + r.count, 0),
    afterFasterRounds: before.filter((r) => after.find((a) => a.round === r.round).p50Ms < r.p50Ms).length };
});
console.log(JSON.stringify(rows, null, 2));
