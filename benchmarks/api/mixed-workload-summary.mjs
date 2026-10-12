#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = resolve(process.argv[2] ?? 'benchmarks/api/results/compact-projection/mixed');
const environment = JSON.parse(readFileSync(`${directory}/environment.json`, 'utf8'));
const median = values => { const sorted = [...values].sort((a,b) => a-b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const rows = environment.variants.map(variant => {
  const samples = Array.from({ length: environment.rounds }, (_, i) => JSON.parse(readFileSync(`${directory}/${variant}-r${i + 1}.json`, 'utf8')));
  for (const sample of samples) {
    assert.deepEqual(sample.outboxPending, { board: 0, direct: 0 });
    assert.equal(sample.realtime.missing, 0); assert.ok(sample.realtime.deliveries > 0 && (sample.transportVerified ?? sample.gzipVerified) && sample.privateCoversVerified === 1500);
  }
  const value = fn => median(samples.map(fn));
  return { variant, runs: samples.length,
    boardTargetRps: environment.boardRps ?? 0,
    allScheduledStartsIssued: environment.boardRps ? samples.every(s => s.boardSchedule.actualStarts === s.boardSchedule.expectedStarts) : null,
    boardStartLagP95Ms: environment.boardRps ? value(s => s.boardSchedule.startLag.p95Ms) : null,
    boardScheduledP95Ms: environment.boardRps ? value(s => s.boardSchedule.scheduledLatency.p95Ms) : null,
    boardsPerSecond: value(s => s.boardReadsPerSecond), throughputRange: [Math.min(...samples.map(s => s.boardReadsPerSecond)), Math.max(...samples.map(s => s.boardReadsPerSecond))],
    boardP95Ms: value(s => s.latency.board.p95Ms), detailP95Ms: value(s => s.latency.detail.p95Ms), healthP95Ms: value(s => s.latency.health.p95Ms),
    nodeCpuMsPerBoardRead: value(s => s.aggregateNodeCpuMsPerBoardRead), proxyCpuMsPerBoardRead: value(s => s.containerCpuMs.proxy / s.latency.board.count),
    redisCpuMsPerBoardRead: value(s => s.containerCpuMs.redis / s.latency.board.count), meanBoardWireKiB: value(s => s.meanBoardWireKiB),
    mutationHttpP95Ms: Object.fromEntries(['appEdit', 'publicEdit', 'publicWatch'].map(name => [name, value(s => s.mutationHttp[name].p95Ms)])),
    realtimeP95Ms: Object.fromEntries(['appEdit', 'publicEdit', 'publicWatch'].map(name => [name, value(s => s.realtime.latency[name].p95Ms)])),
    processes: environment.services.map(service => ({ name: service.name,
      cpuMsPerSecond: value(s => { const process = s.servers.find(p => p.name === service.name); return process.cpuMs / (process.elapsedMs / 1000); }),
      elu: value(s => s.servers.find(p => p.name === service.name).elu.utilization),
      loopP99Ms: value(s => s.servers.find(p => p.name === service.name).loop.p99Ms),
    })),
    totalBoardReads: samples.reduce((n,s) => n + s.latency.board.count,0), totalDeliveries: samples.reduce((n,s) => n + s.realtime.deliveries,0),
    totalMutations: Object.fromEntries(['appEdit', 'publicEdit', 'publicWatch'].map(name => [name, samples.reduce((n,s) => n + s.mutationHttp[name].count,0)])),
  };
});
writeFileSync(`${directory}/summary.json`, JSON.stringify({ method: 'Medians of per-run metrics, not pooled percentiles. All Node CPU includes the mixed workload; CPU per board read is an amortized mixed-workload metric, not isolated board CPU. Container CPU counters include small reset/snapshot overhead. PostgreSQL CPU is not included.', environment, rows }, null, 2));
console.table(rows.map(r => ({ variant: r.variant, 'boards/s': r.boardsPerSecond.toFixed(2), 'board p95 ms': r.boardP95Ms.toFixed(1), 'Node CPU ms/read': r.nodeCpuMsPerBoardRead.toFixed(1), 'proxy CPU ms/read': r.proxyCpuMsPerBoardRead.toFixed(1), 'public edit HTTP p95': r.mutationHttpP95Ms.publicEdit.toFixed(1), 'public edit delivery p95': r.realtimeP95Ms.publicEdit.toFixed(1), 'worker watch delivery p95': r.realtimeP95Ms.publicWatch.toFixed(1), deliveries: r.totalDeliveries })));
