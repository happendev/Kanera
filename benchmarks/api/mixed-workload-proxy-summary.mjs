#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = resolve(process.argv[2]);
const matrix = JSON.parse(readFileSync(`${directory}/matrix.json`, 'utf8'));
const groups = new Map();
let fixtureHash;
for (const item of matrix.schedule) {
  const environment = JSON.parse(readFileSync(`${item.directory}/environment.json`, 'utf8'));
  assert.ok(environment.fixtureSha256, 'Matrix must use a saved common fixture');
  fixtureHash ??= environment.fixtureSha256;
  assert.equal(environment.fixtureSha256, fixtureHash, 'Every condition must restore the same fixture');
  assert.equal(environment.proxyCpuQuota, 2);
  const sample = JSON.parse(readFileSync(`${item.directory}/baseline-r1.json`, 'utf8'));
  assert.equal(sample.realtime.missing,0); assert.deepEqual(sample.outboxPending,{ board: 0, direct: 0 });
  execFileSync(process.execPath,[`${import.meta.dirname}/mixed-workload-diagnostic-summary.mjs`,item.directory], { stdio: 'ignore' });
  const diagnostic = JSON.parse(readFileSync(`${item.directory}/diagnostic-summary.json`,'utf8')).samples[0];
  const samples = groups.get(item.name) ?? []; samples.push({ ...sample, diagnostic }); groups.set(item.name,samples);
}
const median = values => { const sorted = values.sort((a,b) => a-b), mid = Math.floor(sorted.length/2); return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2; };
const rows = [...groups].map(([name,samples]) => {
  const value = fn => median(samples.map(fn));
  return { name, samples: samples.length, boardsPerSecond: value(s=>s.boardReadsPerSecond), boardP95Ms: value(s=>s.latency.board.p95Ms),
    allScheduledStartsIssued: samples.every(s=>!s.boardSchedule || s.boardSchedule.actualStarts===s.boardSchedule.expectedStarts),
    boardStartLagP95Ms: value(s=>s.boardSchedule?.startLag.p95Ms ?? 0),
    publicHttpP95Ms: value(s=>s.mutationHttp.publicEdit.p95Ms), publicDeliveryP95Ms: value(s=>s.realtime.latency.publicEdit.p95Ms),
    appHttpP95Ms: value(s=>s.mutationHttp.appEdit.p95Ms), watchDeliveryP95Ms: value(s=>s.realtime.latency.publicWatch.p95Ms),
    nodeCpuMsPerBoardRead: value(s=>s.aggregateNodeCpuMsPerBoardRead), proxyCpuMsPerBoardRead: value(s=>s.containerCpuMs.proxy/s.latency.board.count),
    proxyCores: value(s=>s.containerCpuMs.proxy/s.elapsedMs), wireKiB: value(s=>s.meanBoardWireKiB),
    appElu: value(s=>s.servers.filter(p=>p.name.startsWith('app')).reduce((n,p)=>n+p.elu.utilization,0)/2),
    appLoopP99Ms: value(s=>Math.max(...s.servers.filter(p=>p.name.startsWith('app')).map(p=>p.loop.p99Ms))),
    boardStageP95Ms: Object.fromEntries(Object.keys(samples[0].diagnostic.stages.board).map(key=>[key,value(s=>s.diagnostic.stages.board[key].p95)])),
    publicDeliveryStageP95Ms: Object.fromEntries(Object.keys(samples[0].diagnostic.deliveryStages.publicEdit).map(key=>[key,value(s=>s.diagnostic.deliveryStages.publicEdit[key].p95)])),
    totalBoardReads: samples.reduce((n,s)=>n+s.latency.board.count,0), totalDeliveries: samples.reduce((n,s)=>n+s.realtime.deliveries,0),
    boardP95Range: samples.map(s=>s.latency.board.p95Ms), throughputRange: samples.map(s=>s.boardReadsPerSecond),
  };
});
writeFileSync(`${directory}/summary.json`,JSON.stringify({ method: 'Medians of per-run metrics from interleaved conditions on an identical saved fixture. Profile runs must not be mixed into this matrix. Stage percentiles are independent and must not be summed.', matrix, rows },null,2));
console.table(rows.map(r=>({case:r.name,'boards/s':r.boardsPerSecond.toFixed(2),'board p95':r.boardP95Ms.toFixed(1),'public HTTP p95':r.publicHttpP95Ms.toFixed(1),'public delivery p95':r.publicDeliveryP95Ms.toFixed(1),'Node CPU/read':r.nodeCpuMsPerBoardRead.toFixed(1),'nginx CPU/read':r.proxyCpuMsPerBoardRead.toFixed(1),'wire KiB':r.wireKiB.toFixed(1)})));
