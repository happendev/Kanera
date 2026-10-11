#!/usr/bin/env node
// Join individual requests/events before aggregating: never subtract unrelated percentiles.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = resolve(process.argv[2]);
const environment = JSON.parse(readFileSync(`${directory}/environment.json`, 'utf8'));
const describe = values => {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  return sorted.length ? { count: sorted.length, mean: sorted.reduce((a,b) => a+b,0)/sorted.length, p50: sorted[Math.floor((sorted.length-1)*.5)], p95: sorted[Math.floor((sorted.length-1)*.95)], p99: sorted[Math.floor((sorted.length-1)*.99)], max: sorted.at(-1) } : { count: 0 };
};
const samples = [];
for (const variant of environment.variants) for (let round = 1; round <= environment.rounds; round++) {
  const label = `${variant}-r${round}`, sample = JSON.parse(readFileSync(`${directory}/${label}.json`, 'utf8'));
  if (!sample.requests) continue;
  const servers = new Map(sample.servers.flatMap(s => s.diagnostics.requests.map(r => [r.id, { ...r, process: s.name }])));
  const proxyFile = `${directory}/${label}-nginx.jsonl`;
  const proxy = new Map(existsSync(proxyFile) ? readFileSync(proxyFile,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.id).map(r => [r.id,r]) : []);
  const groups = {}, joined = [];
  for (const client of sample.requests) {
    const server = servers.get(client.id), nginx = proxy.get(client.id);
    assert.ok(server?.finished && server.serializationFinished, `Missing complete server trace for ${client.id}`);
    if (!sample.direct) assert.ok(nginx, `Missing nginx trace for ${client.id}`);
    const kind = client.path.endsWith('/open') ? 'board' : client.path.endsWith('/health') ? 'health' : client.path.endsWith('/detail') ? 'detail' : client.path.includes('/watch') ? 'publicWatch' : client.path.startsWith('/public-api') ? 'publicEdit' : 'appEdit';
    const queries = server.queries, summary = queries.find(q => q.kind === 'board-summary');
    const row = { id: client.id, kind, process: server.process,
      httpMs: client.finished-client.started,
      clientSocketWaitMs: client.socketAssigned-client.started,
      arrivalMs: server.received-client.started,
      serverMs: server.finished-server.received,
      beforeSerializationMs: (server.serializationStarted ?? server.serializationFinished)-server.received,
      serializationMs: server.serializationStarted ? server.serializationFinished-server.serializationStarted : 0,
      sendMs: server.finished-server.serializationFinished,
      postServerMs: client.finished-server.finished,
      poolWaitSumMs: server.pool.reduce((a,b) => a+b,0),
      poolWaitMaxMs: Math.max(0,...server.pool),
      querySumMs: queries.reduce((a,q) => a+q.finished-q.started,0),
      decodeMs: queries.reduce((a,q) => a+q.decodeMs,0),
      ...(summary ? { summaryQueryMs: summary.finished-summary.started, summaryDecodeMs: summary.decodeMs } : {}),
      ...(nginx ? { proxyRequestMs: Number(nginx.request)*1000, proxyUpstreamMs: Number(nginx.upstream)*1000, proxyHeaderMs: Number(nginx.header)*1000, proxyConnectMs: Number(nginx.connect)*1000 } : {}),
    };
    joined.push(row); (groups[kind] ??= []).push(row);
  }
  const stages = Object.fromEntries(Object.entries(groups).map(([kind,rows]) => [kind, Object.fromEntries([...new Set(rows.flatMap(Object.keys))].filter(k => k.endsWith('Ms')).map(key => [key,describe(rows.map(row => row[key]))]))]));
  const events = sample.servers.flatMap(s => s.diagnostics.events.map(e => ({ ...e, process: s.name })));
  const deliveries = [];
  for (const receipt of sample.receipts) {
    const inserted = events.find(e => e.stage === 'insert-ack' && e.requestId === receipt.key);
    assert.ok(inserted, `Missing outbox insert acknowledgement for ${receipt.key}`);
    // App edits broadcast inline before the durable record, so only the two public paths
    // have a causal insert -> claim -> outbox broadcast sequence.
    if (receipt.kind === 'appEdit') continue;
    const claimed = events.find(e => e.id === inserted.id && e.stage === 'claimed');
    const broadcast = events.find(e => e.id === inserted.id && e.stage === 'broadcast');
    assert.ok(claimed && broadcast, `Missing dispatch stages for ${receipt.key}`);
    for (const observer of receipt.receipts) deliveries.push({ kind: receipt.kind, key: receipt.key,
      requestToInsertAckMs: inserted.at-receipt.started,
      insertAckToClaimMs: claimed.at-inserted.at,
      claimToBroadcastMs: broadcast.at-claimed.at,
      broadcastToObserverMs: observer.at-broadcast.at,
      totalMs: observer.at-receipt.started });
  }
  const deliveryStages = Object.fromEntries(['publicEdit','publicWatch'].map(kind => [kind, Object.fromEntries(['requestToInsertAckMs','insertAckToClaimMs','claimToBroadcastMs','broadcastToObserverMs','totalMs'].map(key => [key,describe(deliveries.filter(d => d.kind===kind).map(d => d[key]))]))]));
  samples.push({ label, stages, deliveryStages, gc: sample.servers.map(s => ({ process: s.name, pauses: describe(s.diagnostics.gc.map(g => g.durationMs)), totalMs: s.diagnostics.gc.reduce((sum,g) => sum+g.durationMs,0) })) });
  writeFileSync(`${directory}/${label}-joined.json`, JSON.stringify({ requests: joined, deliveries }, null, 2));
}
const result = { method: 'Per-request joins using same-host monotonic epoch timestamps. Query completion includes server execution, transfer, decoding and callback scheduling; decode is a timed subset of query completion. Concurrent query/pool sums overlap and are not additive response stages. Serialization is preSerialization to onSend, including hook overhead. Proxy upstream includes response reading; residuals are not pure compression CPU. Insert acknowledgement is client-observed after autocommit, not the actual commit instant: a fast dispatcher may be observed before the publisher callback. App edits broadcast inline and are excluded from outbox stage decomposition. GC is process-wide, not per-request attribution.', samples };
writeFileSync(`${directory}/diagnostic-summary.json`, JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
