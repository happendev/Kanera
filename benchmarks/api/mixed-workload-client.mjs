#!/usr/bin/env node
// Separate load generator: its JSON parsing, decompression and CPU never count as API CPU.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const config = JSON.parse(process.env.MIXED_CLIENT);
const { root, origin, readers, boardRps, observers, durationMs, services } = config;
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Local benchmark only');
const require = createRequire(`${root}/apps/web/package.json`);
const { io } = require(`${root}/apps/web/node_modules/socket.io-client`);
const agent = new http.Agent({ keepAlive: true, maxSockets: readers + 20 });
const boardId = '70000000-0000-4000-8000-000000000200';
const clientId = '70000000-0000-4000-8000-000000000001';
let token, secret, keyId, closing = false, watching;
const sockets = [], pending = new Map(), records = [], socketFailures = [];
const latencies = { board: [], appEdit: [], publicEdit: [], publicWatch: [], detail: [], health: [] };
const epoch = () => performance.timeOrigin + performance.now();
let requestSequence = 0, appSequence = 0, measuring = false;
const requests = [];
const compressed = !config.direct && config.gzipLevel !== 0;
let boardWireBytes = 0, expectedDeliveries = 0, duplicateDeliveries = 0;
const realtimeLatency = { appEdit: [], publicEdit: [], publicWatch: [] };
const mutationHttp = { appEdit: [], publicEdit: [], publicWatch: [] };
const boardStartLag = [], boardScheduledLatency = [];
const containerCpu = () => Object.fromEntries(Object.entries(config.containers).map(([name, container]) => {
  const stat = execFileSync('docker', ['exec', container, 'cat', '/sys/fs/cgroup/cpu.stat'], { encoding: 'utf8' });
  const match = stat.match(/^usage_usec (\d+)$/m);
  assert.ok(match, 'Mixed benchmark requires Linux cgroup v2 CPU counters');
  return [name, Number(match[1]) / 1000];
}));
function request(path, { method = 'GET', body, credential = token, collect = true, correlation } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body), chunks = [];
    let bytes = 0;
    const id = correlation ?? `${config.label}-request-${++requestSequence}`;
    const trace = { id, path, method, started: epoch() };
    if (measuring && config.diagnostics) requests.push(trace);
    const target = config.direct
      ? new URL(path.replace(/^\/public-api/, '').replace(/^\/api(?=\/(?!v1))/, ''), `http://127.0.0.1:${path.startsWith('/public-api/') ? 3120 : 3100 + (appSequence++ % 2)}`)
      : new URL(path, origin);
    const req = http.request(target, { method, agent, headers: {
      'accept-encoding': 'gzip', ...(config.diagnostics ? { 'x-benchmark-id': id } : {}), ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
    } }, res => {
      trace.headers = epoch();
      res.on('data', chunk => { bytes += chunk.length; if (collect) chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        trace.finished = epoch();
        try {
          const raw = collect ? Buffer.concat(chunks) : undefined;
          const decoded = raw && res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
          assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${method} ${path}: HTTP ${res.statusCode}: ${decoded?.toString().slice(0, 500) ?? ''}`);
          resolve({ bytes, headers: res.headers, json: decoded?.length && res.headers['content-type']?.includes('json') ? JSON.parse(decoded) : undefined, decodedBytes: decoded?.length });
        } catch (error) { reject(error); }
      });
    });
    req.on('socket', () => { trace.socketAssigned = epoch(); });
    req.setTimeout(60000, () => req.destroy(new Error(`Timeout: ${method} ${path}`)));
    req.on('error', reject); req.end(data);
  });
}
const timeout = async (promise, label, ms = 30000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
};
function receipt(kind, key, payloadCheck) {
  assert.ok(!pending.has(key));
  const record = { kind, key, start: performance.now(), started: epoch(), receipts: [], seen: new Set(), payloadCheck };
  record.done = new Promise(resolve => { record.resolve = resolve; });
  expectedDeliveries += observers; pending.set(key, record); records.push(record); return record;
}
function observe(index, record, payload) {
  record.payloadCheck(payload);
  if (record.seen.has(index)) { duplicateDeliveries++; return; }
  record.receipts.push({ observer: index, at: epoch() });
  record.seen.add(index); realtimeLatency[record.kind].push(performance.now() - record.start);
  if (record.seen.size === observers) { pending.delete(record.key); record.resolve(); }
}
const describe = values => {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a,b) => a-b);
  return { count: values.length, p50Ms: sorted[Math.floor((sorted.length - 1) * .5)], p95Ms: sorted[Math.floor((sorted.length - 1) * .95)], p99Ms: sorted[Math.floor((sorted.length - 1) * .99)], maxMs: sorted.at(-1) };
};
const controls = async endpoint => Promise.all(services.map(async service => {
  const response = await fetch(`http://127.0.0.1:${service.control}/${endpoint}${endpoint === 'reset' && config.profile && service.name.startsWith('app') ? '?profile=1' : ''}`, { signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok); return { name: service.name, ...await response.json() };
}));
try {
  token = (await request('/api/auth/login', { method: 'POST', body: { email: 'perf@kanera.local', password: 'Perf12345' } })).json.accessToken;
  assert.ok(token);
  const minted = (await request('/api/me/api-keys', { method: 'POST', body: { label: 'Mixed benchmark', scope: 'write' } })).json;
  secret = minted.secret; keyId = minted.id; assert.ok(secret && keyId);
  const initial = await request(`/api/boards/${boardId}/open`, { method: 'POST', body: {} });
  assert.equal(initial.headers['content-encoding'] === 'gzip', compressed, 'Expected transport encoding');
  assert.equal(initial.json.cards.length, 3000);
  let signedCovers = 0;
  for (const card of initial.json.cards) if (card.coverUrl) {
    const url = new URL(card.coverUrl);
    assert.equal(url.origin, origin);
    const prefix = `/api/media/${clientId}/`;
    assert.ok(url.pathname.startsWith(prefix) && url.pathname.endsWith('/thumb.jpg'), 'Chosen cover derivative must stay unchanged');
    const key = decodeURIComponent(url.pathname.slice(prefix.length)), expiry = Number(url.searchParams.get('e'));
    const expected = createHmac('sha256', config.mediaSecret).update(`${clientId}\n${key}\n${expiry}\nsession`).digest().subarray(0, 24).toString('base64url');
    assert.ok(expiry > Date.now()); assert.equal(url.searchParams.get('t'), expected); signedCovers++;
  }
  assert.equal(signedCovers, 1500, 'All fixture covers exercise private signing');
  const [appCard, publicCard, watchCard] = initial.json.cards.slice(0, 3);
  for (let i = 0; i < observers; i++) {
    const socket = io(config.direct ? `http://127.0.0.1:${3100 + i % 2}` : origin, { auth: { token }, transports: ['websocket'], reconnection: false, autoConnect: false }); sockets.push(socket);
    socket.on('disconnect', reason => { if (!closing) socketFailures.push(reason); });
    socket.on('card:updated', payload => {
      const record = pending.get(payload.card?.title);
      if (record) { try { observe(i, record, payload); } catch (error) { socketFailures.push(String(error)); } }
    });
    socket.on('watch:changed', payload => {
      if (watching && payload.id === watchCard.id && payload.watching === watching.state) {
        try { observe(i, watching, payload); } catch (error) { socketFailures.push(String(error)); }
      }
    });
    const connected = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    socket.connect(); await timeout(connected, 'WebSocket connect');
    assert.equal(await timeout(new Promise(resolve => socket.emit('board:join', boardId, resolve)), 'board join'), true);
  }
  // Warm the real proxy, both replicas and both credential paths before resetting counters.
  await Promise.all(Array.from({ length: readers }, () => request(`/api/boards/${boardId}/open`, { method: 'POST', body: {}, collect: false })));
  await request(`/public-api/api/v1/cards/${publicCard.id}/detail`, { credential: secret });
  // Continuous read warm-up also allows JIT/connection behavior to settle for every sample.
  const warmDeadline = performance.now() + config.warmupMs;
  while (performance.now() < warmDeadline) {
    const start = performance.now();
    await request(`/api/boards/${boardId}/open`, { method: 'POST', body: {}, collect: false });
    await delay(Math.max(0, 50 - (performance.now() - start)));
  }
  const containerCpuBefore = containerCpu();
  await controls('reset');
  measuring = true;
  const started = performance.now(), cpu = process.cpuUsage(), deadline = started + durationMs;
  const lastTitles = new Map(), scheduling = {};
  async function paced(name, intervalMs, operation) {
    let sequence = 0, next = started, maximumStartLagMs = 0;
    while (performance.now() < deadline) {
      if (next >= deadline) break;
      if (next > performance.now()) await delay(Math.ceil(next - performance.now()));
      if (performance.now() >= deadline) break;
      maximumStartLagMs = Math.max(maximumStartLagMs, performance.now() - next);
      const start = performance.now();
      await operation(sequence++);
      latencies[name].push(performance.now() - start);
      next += intervalMs;
    }
    scheduling[name] = { targetIntervalMs: intervalMs, operations: sequence, maximumStartLagMs, policy: 'Sequential, at most one in flight per lane; lag includes any event-delivery wait. No dropped samples.' };
  }
  async function edit(kind, card, sequence) {
    const title = `mixed-${config.label}-${kind}-${sequence}`;
    const record = receipt(kind, title, payload => { assert.equal(payload.card.id, card.id); assert.equal(payload.card.title, title); });
    const httpStarted = performance.now();
    const result = await request(`${kind === 'appEdit' ? '/api' : '/public-api/api/v1'}/cards/${card.id}`, { method: 'PATCH', body: { title }, credential: kind === 'appEdit' ? token : secret, correlation: title });
    mutationHttp[kind].push(performance.now() - httpStarted);
    assert.equal(result.json.title, title); lastTitles.set(card.id, title);
    // Delivery may precede the HTTP response; listeners and correlation records are installed first.
    await timeout(record.done, `${kind} delivery to all observers`);
  }
  await Promise.all([
    ...Array.from({ length: readers }, async (_, index) => {
      // Stagger starts globally rather than releasing a batch of 25 each second. Each reader
      // retains its schedule if it falls behind; record lag instead of hiding coordinated omission.
      let next = boardRps ? started + index * 1000 / boardRps : started;
      while (performance.now() < deadline) {
        if (boardRps && next >= deadline) break;
        if (boardRps && next > performance.now()) await delay(Math.ceil(next - performance.now()));
        if (performance.now() >= deadline) break;
        const start = performance.now();
        if (boardRps) boardStartLag.push(Math.max(0, start - next));
        const response = await request(`/api/boards/${boardId}/open`, { method: 'POST', body: {}, collect: false });
        assert.equal(response.headers['content-encoding'] === 'gzip', compressed);
        boardWireBytes += response.bytes; latencies.board.push(performance.now() - start);
        if (boardRps) { boardScheduledLatency.push(performance.now() - next); next += readers * 1000 / boardRps; }
      }
    }),
    paced('appEdit', 1000, sequence => edit('appEdit', appCard, sequence)),
    paced('publicEdit', 1000, sequence => edit('publicEdit', publicCard, sequence)),
    paced('publicWatch', 1000, async sequence => {
      const state = sequence % 2 === 0;
      watching = receipt('publicWatch', `${config.label}-watch-${sequence}`, payload => { assert.equal(payload.kind, 'card'); assert.equal(payload.id, watchCard.id); assert.equal(payload.watching, state); });
      watching.state = state;
      const httpStarted = performance.now();
      const result = await request(`/public-api/api/v1/cards/${watchCard.id}/watch`, { method: state ? 'PUT' : 'DELETE', credential: secret, correlation: watching.key });
      mutationHttp.publicWatch.push(performance.now() - httpStarted);
      assert.equal(result.json.watching, state);
      await timeout(watching.done, 'worker direct-outbox watch delivery'); watching = undefined;
    }),
    paced('detail', 500, async () => { const response = await request(`/api/cards/${appCard.id}/detail`); assert.equal(response.json.card.id, appCard.id); }),
    paced('health', 1000, () => request('/api/health')),
  ]);
  measuring = false;
  const elapsedMs = performance.now() - started, clientCpu = process.cpuUsage(cpu);
  const servers = await controls('snapshot');
  const containerCpuAfter = containerCpu();
  assert.deepEqual(socketFailures, [], 'Observers must remain connected and receive valid payloads');
  assert.equal(pending.size, 0, 'Every correlated mutation must reach every observer');
  assert.equal(Object.values(realtimeLatency).reduce((n, values) => n + values.length, 0), expectedDeliveries);
  for (const values of Object.values(realtimeLatency)) assert.ok(values.length > 0);
  for (const [id, title] of lastTitles) assert.equal((await request(`/api/cards/${id}/detail`)).json.card.title, title);
  const final = await request(`/api/boards/${boardId}/open`, { method: 'POST', body: {} });
  assert.equal(final.json.cards.length, 3000);
  for (const [id, title] of lastTitles) assert.equal(final.json.cards.find(card => card.id === id).title, title);
  const result = { label: config.label, variant: config.variant, round: config.round, readers, boardRps, observers, elapsedMs, durationMs,
    boardSchedule: boardRps ? { targetRps: boardRps, expectedStarts: Math.ceil(durationMs * boardRps / 1000), actualStarts: latencies.board.length, startLag: describe(boardStartLag), scheduledLatency: describe(boardScheduledLatency) } : null,
    boardReadsPerSecond: latencies.board.length / (elapsedMs / 1000), meanBoardWireKiB: boardWireBytes / latencies.board.length / 1024,
    initialDecodedMiB: initial.decodedBytes / 1048576, privateCoversVerified: signedCovers, gzipVerified: compressed, transportVerified: true, direct: config.direct, gzipLevel: config.gzipLevel,
    ...(config.diagnostics ? { requests, receipts: records.map(({ kind, key, started, receipts }) => ({ kind, key, started, receipts })) } : {}),
    latency: Object.fromEntries(Object.entries(latencies).map(([name, values]) => [name, describe(values)])), scheduling,
    mutationHttp: Object.fromEntries(Object.entries(mutationHttp).map(([name, values]) => [name, describe(values)])),
    containerCpuMs: Object.fromEntries(Object.entries(containerCpuAfter).map(([name, value]) => [name, value - containerCpuBefore[name]])),
    realtime: { deliveries: expectedDeliveries, duplicates: duplicateDeliveries, missing: 0, latency: Object.fromEntries(Object.entries(realtimeLatency).map(([name, values]) => [name, describe(values)])) },
    servers, aggregateNodeCpuMs: servers.reduce((n,s) => n+s.cpuMs,0),
    aggregateNodeCpuMsPerBoardRead: servers.reduce((n,s) => n+s.cpuMs,0) / latencies.board.length,
    clientCpuMs: (clientCpu.user + clientCpu.system) / 1000, assertions: 'gzip board responses, 3000 complete cards, 1500 valid private cover signatures, every mutation delivered to all observers, persisted titles match final board, no socket failures' };
  writeFileSync(config.output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output: config.output, boardsPerSecond: result.boardReadsPerSecond, deliveries: expectedDeliveries }));
} finally {
  closing = true;
  for (const socket of sockets) socket.disconnect();
  if (keyId) await request(`/api/me/api-keys/${keyId}`, { method: 'DELETE' }).catch(() => {});
  agent.destroy();
}
