#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = resolve(process.argv[2] ?? 'benchmarks/api/results/event-loop-20261012');
const groups = new Map();
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const samples = readdirSync(directory).filter(name => /-r\d+\.json$/.test(name)).map(name => JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')));
for (const sample of samples.filter(sample => sample.connections === 25)) {
  const key = `${sample.variant}/${sample.scenario}/${sample.replicas}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(sample);
}
const rows = [...groups].map(([name, group]) => {
  assert.equal(group.length, 3, `Expected three warmed samples for ${name}`);
  const results = group.map(sample => sample.result);
  return { name, runs: group.length, operations: results.reduce((n,r) => n+r.operations,0),
    operationsPerSecond: median(results.map(r => r.operationsPerSecond)),
    throughputRange: [Math.min(...results.map(r => r.operationsPerSecond)), Math.max(...results.map(r => r.operationsPerSecond))],
    p95Ms: median(results.map(r => r.p95Ms)), healthP95Ms: median(results.map(r => r.healthP95Ms)),
    apiCpuMsPerOperation: median(results.map(r => r.apiCpuMsPerOperation)),
    apiActiveMsPerOperation: median(results.map(r => r.servers.reduce((n,s) => n+s.elu.active,0)/r.operations)),
    maxServerElu: median(results.map(r => Math.max(...r.servers.map(s => s.elu.utilization)))),
    maxServerLoopP99Ms: median(results.map(r => Math.max(...r.servers.map(s => s.loop.p99Ms)))),
    totalApiRssMiB: median(results.map(r => r.servers.reduce((n,s) => n+s.rssMiB,0))),
    clientCpuCores: median(results.map(r => r.clientCpuMs/r.elapsedMs)),
    responseKiB: median(results.map(r => r.meanResponseKiB)), requestsPerOperation: median(results.map(r => r.requests/r.operations)) };
});
const baseline = rows.find(row => row.name === 'baseline/full/1');
assert.ok(baseline, 'Missing full-board baseline');
for (const row of rows) {
  row.throughputChangePercent = (row.operationsPerSecond / baseline.operationsPerSecond - 1) * 100;
  row.cpuChangePercent = (row.apiCpuMsPerOperation / baseline.apiCpuMsPerOperation - 1) * 100;
}
writeFileSync(`${directory}/http-summary.json`, JSON.stringify({ method: 'Medians of three runs; latency values are medians of per-run percentiles, not pooled percentiles.',
  samples: samples.length, measuredOperations: samples.reduce((n,s) => n+s.result.operations,0), measuredRequests: samples.reduce((n,s) => n+s.result.requests,0), rows }, null, 2));
console.table(rows.map(row => ({ experiment: row.name, 'boards/s': row.operationsPerSecond.toFixed(2), 'range': row.throughputRange.map(n=>n.toFixed(2)).join('–'),
  'p95 ms': row.p95Ms.toFixed(1), 'CPU ms/board': row.apiCpuMsPerOperation.toFixed(1), 'active ms/board': row.apiActiveMsPerOperation.toFixed(1),
  'ELU': row.maxServerElu.toFixed(3), 'loop p99 ms': row.maxServerLoopP99Ms.toFixed(1), 'health p95 ms': row.healthP95Ms.toFixed(1), 'KiB': row.responseKiB.toFixed(1) })));
