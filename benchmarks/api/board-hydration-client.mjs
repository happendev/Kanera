// Separate process so response consumption cannot inflate the API's event-loop measurement.
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { assertEquivalentBoardResponses } from './board-hydration-query.mjs';
const config = JSON.parse(process.env.HYDRATION_CLIENT);
const boardId = '70000000-0000-4000-8000-000000000200';
for (const base of [...config.bases, ...config.controls]) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Only the isolated loopback servers are allowed');
}
const headers = { authorization: `Bearer ${config.token}` };
let next = 0;
const baseUrl = () => config.bases[next++ % config.bases.length];
async function getBoard(query = '', base = baseUrl(), consumeOnly = false) {
  const response = await fetch(`${base}/boards/${boardId}/open${query}`, { method: 'POST', headers, signal: AbortSignal.timeout(60_000) });
  if (consumeOnly) {
    const body = await response.arrayBuffer(); assert.equal(response.status, 200);
    return { bytes: body.byteLength };
  }
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 300));
  return { bytes: Buffer.byteLength(text), body: text };
}
const baseline = JSON.parse(readFileSync(config.baseline, 'utf8'));
const query = config.scenario === 'page100' ? '?cardLimit=100' : config.scenario === 'metadata' ? '?includeCards=false' : '';
// Validate every transformed SQL/server variant before timing. JSON key order is immaterial.
const checked = JSON.parse((await getBoard(query)).body);
if (config.scenario === 'full') assertEquivalentBoardResponses(checked, baseline);
if (config.scenario === 'page100') {
  assert.deepEqual(checked.cards, baseline.cards.slice(0, 100));
  assert.deepEqual(checked.cardPage, { offset: 0, limit: 100, hasMore: true });
}
if (config.scenario === 'metadata') { const { cards: _cards, ...meta } = baseline; assert.deepEqual(checked, meta); }

async function operation() {
  if (config.scenario !== 'all-pages100') return { bytes: (await getBoard(query, baseUrl(), true)).bytes, requests: 1 };
  let bytes = 0, requests = 0;
  for (let offset = 0; offset < baseline.cards.length; offset += 100) {
    const result = await getBoard(`?cardLimit=100&cardOffset=${offset}`, baseUrl(), true); bytes += result.bytes; requests++;
  }
  return { bytes, requests };
}
if (config.scenario === 'all-pages100') {
  const cards = [];
  for (let offset = 0; offset < baseline.cards.length; offset += 100) {
    const body = JSON.parse((await getBoard(`?cardLimit=100&cardOffset=${offset}`)).body);
    cards.push(...body.cards);
    assert.equal(body.cardPage.hasMore, offset + 100 < baseline.cards.length);
  }
  assert.deepEqual(cards, baseline.cards, 'Complete pagination must contain the exact same cards');
}
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.ceil(values.length*p)-1)] ?? 0;
async function exercise(duration, record) {
  const start = performance.now(), deadline = start + duration;
  const latencies = [], health = [];
  let bytes = 0, requests = 0, running = true;
  const probe = (async () => {
    while (running) {
      const t = performance.now();
      const response = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(60_000) });
      await response.arrayBuffer(); assert.equal(response.status, 200);
      health.push(performance.now() - t); await delay(50);
    }
  })();
  await Promise.all(Array.from({ length: config.connections }, async () => {
    while (performance.now() < deadline) {
      const t = performance.now(), result = await operation();
      if (record) { latencies.push(performance.now() - t); bytes += result.bytes; requests += result.requests; }
    }
  }));
  const elapsedMs = performance.now() - start; running = false; await probe;
  return { elapsedMs, operations: latencies.length, requests, bytes, operationsPerSecond: latencies.length*1000/elapsedMs,
    p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), maxMs: Math.max(0, ...latencies),
    healthP95Ms: percentile(health, .95), healthMaxMs: Math.max(0, ...health), healthSamples: health.length };
}
await exercise(config.warmupMs, false);
for (const base of config.controls) assert.equal((await fetch(`${base}/reset${config.profile ? '?profile=1' : ''}`)).status, 200);
const clientCpu = process.cpuUsage();
const result = await exercise(config.durationMs, true);
const delta = process.cpuUsage(clientCpu);
result.clientCpuMs = (delta.user + delta.system) / 1000;
result.servers = [];
for (const base of config.controls) {
  const response = await fetch(`${base}/snapshot`); assert.equal(response.status, 200);
  const server = await response.json();
  if (server.profile) { writeFileSync(`${config.output}.cpuprofile`, JSON.stringify(server.profile)); delete server.profile; }
  result.servers.push(server);
}
result.apiCpuMsPerOperation = result.servers.reduce((sum, server) => sum + server.cpuMs, 0) / result.operations;
result.meanResponseKiB = result.bytes / result.operations / 1024;
writeFileSync(config.output, JSON.stringify({ ...config, token: undefined, result }, null, 2));
console.log(JSON.stringify({ sample: config.label, ...result, servers: result.servers.map(s => ({ ...s, elu: s.elu.utilization })) }));
