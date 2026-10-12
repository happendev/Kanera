// Local-only transport experiment. No application code, database rows, or dependencies change.
// Run: node benchmarks/api/realtime-benchmark.mjs
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const api = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const wsRequire = createRequire(createRequire(api.resolve('socket.io')).resolve('engine.io'));
const here = fileURLToPath(import.meta.url);
const clock = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)] ?? 0;
const stats = a => ({ p50: percentile(a, .5), p95: percentile(a, .95), p99: percentile(a, .99), max: a.reduce((m, x) => Math.max(m, x), 0) });
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixtures = [
  ['presence:changed', { workspaceId: uuid(1), userId: uuid(2), online: true }],
  ['card:moved', { boardId: uuid(3), cardId: uuid(4), fromListId: uuid(5), toListId: uuid(7), position: '2048.0000000000', prevPosition: '1024.0000000000' }],
  ['card:updated', { boardId: uuid(3), card: { id: uuid(4), workspaceId: uuid(1), organisationKey: 'BENCH', number: 42, key: 'BENCH-42', listId: uuid(5), boardId: uuid(3), title: 'Review realtime delivery and reconnect behavior', position: '2048.0000000000', createdById: uuid(2), createdAt: '2026-10-11T12:00:00.000Z', updatedAt: '2026-10-11T12:01:00.000Z' } }],
  ['note:updated', { note: { id: uuid(6), workspaceId: uuid(1), boardId: uuid(3), parentNoteId: null, scope: 'team', ownerId: uuid(2), lastEditedById: uuid(2), lastEditedByName: 'Benchmark user', lastEditedByAvatarUrl: null, lastEditedAt: '2026-10-11T12:01:00.000Z', title: 'Release notes', content: Array.from({ length: 80 }, (_, i) => `- Item ${i}: Verify room authorization, ordered delivery, and reconnect behavior for board ${i % 7}.\n`).join(''), icon: 'file-text', color: null, position: '1024.0000000000', editingUserId: null, editingExpiresAt: null, createdAt: '2026-10-11T12:00:00.000Z', updatedAt: '2026-10-11T12:01:00.000Z' } }],
];

async function worker(cfg) {
  const http = createServer();
  let io, wss, pub, sub;
  const sockets = new Set();
  const rooms = new Map();
  const compression = cfg.compression ? {
    threshold: 1024,
    ...(cfg.noContextTakeover ? { serverNoContextTakeover: true } : {}),
    ...(cfg.deflateLevel !== undefined ? { zlibDeflateOptions: { level: cfg.deflateLevel } } : {}),
  } : false;
  let deliver;
  if (cfg.transport === 'socket.io') {
    const { Server } = api('socket.io');
    io = cfg.role === 'gateway' ? new Server(http, { transports: ['websocket'], perMessageDeflate: compression, maxHttpBufferSize: 1e4 }) : new Server();
    io.engine?.on('connection', raw => { raw.request = null; });
    io.on('connection', socket => {
      sockets.add(socket.conn.transport.socket);
      socket.on('join', (index, ack) => {
        socket.join([`room:${index}`, `alias:${index}`, 'all', `user:${socket.id}`, 'client:bench']);
        ack(true);
      });
    });
    deliver = (targets, event, payload) => {
      let target = io.to(targets);
      // Optional comparison: enforce the intended small-packet threshold explicitly while keeping
      // context takeover for larger notes. This does not change Kanera's production configuration.
      if (cfg.selectiveCompression) target = target.compress(Buffer.byteLength(JSON.stringify([event, payload])) >= 1024);
      target.emit(event, payload);
    };
  } else {
    const { WebSocketServer } = wsRequire('ws');
    if (cfg.role === 'gateway') {
      wss = new WebSocketServer({ server: http, perMessageDeflate: compression, maxPayload: 1e4 });
      wss.on('connection', socket => {
        sockets.add(socket);
        socket.on('message', data => {
          const [event, index] = JSON.parse(data.toString());
          if (event !== 'join') throw new Error('Unexpected benchmark control');
          socket.rooms = [`room:${index}`, `alias:${index}`, 'all', `user:${randomUUID()}`, 'client:bench'];
          for (const room of socket.rooms) {
            if (!rooms.has(room)) rooms.set(room, new Set());
            rooms.get(room).add(socket);
          }
          socket.send('["joined",true]');
        });
        socket.on('close', () => {
          sockets.delete(socket);
          for (const room of socket.rooms ?? []) {
            rooms.get(room)?.delete(socket);
            if (!rooms.get(room)?.size) rooms.delete(room);
          }
        });
      });
    }
    deliver = (targets, event, payload) => {
      // Serialize once, then union rooms so overlapping grants never double-deliver.
      const data = JSON.stringify([event, payload]);
      const recipients = new Set();
      for (const room of targets) for (const socket of rooms.get(room) ?? []) recipients.add(socket);
      const compress = !cfg.selectiveCompression || Buffer.byteLength(data) >= 1024;
      for (const socket of recipients) socket.send(data, { compress });
    };
  }
  if (cfg.path === 'redis') {
    const Redis = api('ioredis');
    // A unique Pub/Sub prefix avoids all application channels; no Redis keys are written.
    pub = new Redis('redis://127.0.0.1:6379', { lazyConnect: true });
    sub = pub.duplicate({ lazyConnect: true });
    await Promise.all([pub.connect(), sub.connect()]);
    if (io) {
      io.adapter(api('@socket.io/redis-adapter').createAdapter(pub, sub, { key: cfg.channel }));
      // Confirm adapter subscriptions before the first measured publish.
      await sub.ping();
    } else if (cfg.role === 'gateway') {
      sub.on('message', (_channel, message) => deliver(...JSON.parse(message)));
      await sub.subscribe(cfg.channel);
    } else {
      deliver = (targets, event, payload) => { void pub.publish(cfg.channel, JSON.stringify([targets, event, payload])); };
    }
  }
  let heartbeat;
  if (wss) heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (socket.alive === false) { socket.terminate(); continue; }
      socket.alive = false;
      socket.once('pong', () => { socket.alive = true; });
      socket.ping();
    }
  }, 25_000);
  const memory = () => { global.gc(); return process.memoryUsage(); };
  const bytes = () => [...sockets].reduce((n, socket) => n + (socket._socket?.bytesWritten ?? 0), 0);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let initialCpu, initialBytes, started;
  const begin = () => { initialCpu = process.cpuUsage(); initialBytes = bytes(); started = clock(); loop.reset(); loop.enable(); };
  const finish = () => {
    loop.disable();
    const cpu = process.cpuUsage(initialCpu);
    return { cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs: clock() - started, wireBytes: bytes() - initialBytes, eventLoopP99Ms: loop.percentile(99) / 1e6, memory: memory() };
  };
  process.on('message', async ({ id, action, args }) => {
    try {
      let result;
      if (action === 'memory') result = memory();
      if (action === 'begin') begin();
      if (action === 'finish') result = finish();
      if (action === 'emit') {
        const { phase, durationMs } = args;
        const start = clock();
        const count = Math.round(cfg.rate * durationMs / 1000);
        let emitted = 0;
        while (emitted < count) {
          const due = Math.min(count, Math.floor((clock() - start) * cfg.rate / 1000));
          while (emitted < due) {
            const room = emitted % cfg.rooms;
            // 40% cards, 30% moves, 20% presence, 10% larger notes; no production sample claimed.
            const mix = [2, 1, 2, 0, 2, 1, 2, 0, 1, 3];
            const [event, fixture] = fixtures[mix[Math.floor(emitted / cfg.rooms) % mix.length]];
            deliver([`room:${room}`, `alias:${room}`], event, { ...fixture, _bench: { phase, seq: emitted, room, sent: clock() } });
            emitted++;
          }
          await sleep(2);
        }
        deliver(['all'], 'done', { phase, emitted });
        result = { emitted, emissionMs: clock() - start };
      }
      if (action === 'close') {
        clearInterval(heartbeat);
        if (io?.engine) await new Promise(resolve => io.close(resolve));
        if (wss) {
          for (const socket of sockets) socket.terminate();
          await new Promise(resolve => wss.close(resolve));
          http.close();
        }
        pub?.disconnect(); sub?.disconnect();
      }
      process.send({ id, result });
    } catch (error) { process.send({ id, error: error.stack }); }
  });
  let port;
  if (cfg.role === 'gateway') {
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    port = http.address().port;
  }
  process.send({ ready: true, port, baseline: memory() });
}

async function spawn(cfg) {
  const child = fork(here, ['worker', JSON.stringify(cfg)], { execArgv: ['--expose-gc'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let counter = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message.ready) resolve(message);
      else if (pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        clearTimeout(timer); pending.delete(message.id);
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
      }
    });
    child.on('exit', code => {
      const error = new Error(`Benchmark child exited (${code})`);
      reject(error);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear();
    });
  });
  return {
    child, ready: await ready,
    call(action, args) {
      const id = ++counter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${action}`)); }, 60_000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, action, args });
      });
    },
  };
}

async function trial(cfg) {
  const gateway = await spawn({ ...cfg, role: 'gateway' });
  let publisher;
  const clients = [];
  try {
    publisher = cfg.path === 'redis' ? await spawn({ ...cfg, role: 'publisher' }) : gateway;
    const connectMs = [], latencies = [];
    let received = 0, invalid = 0, done = 0, warmupDone = 0;
    const closed = [];
    const url = `http://127.0.0.1:${gateway.ready.port}`;
    const sio = cfg.transport === 'socket.io' ? api('socket.io-client').io : null;
    const WS = !sio ? wsRequire('ws') : null;
    for (let batch = 0; batch < cfg.clients; batch += 50) {
      await Promise.all(Array.from({ length: Math.min(50, cfg.clients - batch) }, (_, i) => new Promise((resolve, reject) => {
        const room = (batch + i) % cfg.rooms;
        let last = room - cfg.rooms;
        const started = clock();
        const timer = setTimeout(() => reject(new Error('Connect/join timeout')), 15_000);
        const joined = () => { clearTimeout(timer); connectMs.push(clock() - started); resolve(); };
        const onEvent = (event, payload) => {
          if (event === 'done') { if (payload.phase === 'run') done++; else warmupDone++; return; }
          const b = payload?._bench;
          if (b?.phase !== 'run') return;
          if (b.room !== room || b.seq !== last + cfg.rooms) invalid++;
          last = b.seq;
          received++;
          latencies.push(clock() - b.sent);
        };
        if (sio) {
          const socket = sio(url, { transports: ['websocket'], forceNew: true, reconnection: false });
          socket.on('connect', () => socket.emit('join', room, joined));
          socket.onAny(onEvent);
          socket.on('connect_error', reject);
          socket.on('disconnect', reason => closed.push(reason));
          clients.push(() => socket.disconnect());
        } else {
          const socket = new WS(url.replace('http:', 'ws:'), { perMessageDeflate: cfg.compression });
          socket.on('open', () => socket.send(JSON.stringify(['join', room])));
          socket.on('message', data => {
            const [event, payload] = JSON.parse(data.toString());
            if (event === 'joined') joined(); else onEvent(event, payload);
          });
          socket.on('error', reject);
          socket.on('close', code => closed.push(code));
          clients.push(() => socket.close());
        }
      })));
    }
    const connectedMemory = await gateway.call('memory');
    await publisher.call('emit', { phase: 'warmup', durationMs: 1000 });
    const warmupDeadline = clock() + 60_000;
    while (warmupDone < cfg.clients && clock() < warmupDeadline) await sleep(5);
    if (warmupDone !== cfg.clients) throw new Error('Warmup failed to drain');
    await sleep(100);
    await gateway.call('begin');
    if (publisher !== gateway) await publisher.call('begin');
    const clientCpuStart = process.cpuUsage();
    const started = clock();
    const emission = await publisher.call('emit', { phase: 'run', durationMs: cfg.durationMs });
    while (done < cfg.clients && clock() - started < 60_000) await sleep(5);
    const elapsedMs = clock() - started;
    const clientCpu = process.cpuUsage(clientCpuStart);
    const gatewayResult = await gateway.call('finish');
    const publisherResult = publisher !== gateway ? await publisher.call('finish') : null;
    const expected = emission.emitted * cfg.clients / cfg.rooms;
    if (done !== cfg.clients || received !== expected || invalid || closed.length) {
      throw new Error(JSON.stringify({ done, received, expected, invalid, closed }));
    }
    const result = {
      ...cfg, received, invalid, elapsedMs, ...emission, latencyMs: stats(latencies), connectJoinMs: stats(connectMs),
      serverCpuMs: gatewayResult.cpuMs + (publisherResult?.cpuMs ?? 0), clientCpuMs: (clientCpu.user + clientCpu.system) / 1000,
      wireBytesPerDelivery: gatewayResult.wireBytes / received,
      idleHeapBytesPerClient: (connectedMemory.heapUsed - gateway.ready.baseline.heapUsed) / cfg.clients,
      idleRssBytesPerClient: (connectedMemory.rss - gateway.ready.baseline.rss) / cfg.clients,
      gateway: gatewayResult, publisher: publisherResult, baseline: gateway.ready.baseline, connectedMemory,
    };
    return result;
  } finally {
    for (const close of clients) close();
    for (const proc of new Set([gateway, publisher].filter(Boolean))) {
      try { await proc.call('close'); } finally { proc.child.kill(); }
    }
  }
}

async function main() {
  const output = process.env.PERF_OUTPUT ?? fileURLToPath(new URL(`results/realtime-${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url));
  mkdirSync(output, { recursive: true });
  const repeats = Number(process.env.PERF_REPEATS ?? 3);
  const durationMs = Number(process.env.PERF_DURATION_MS ?? 4000);
  const profiles = [
    { name: 'collaboration', clients: 100, rooms: 10, rate: 100 },
    { name: 'busy', clients: 500, rooms: 10, rate: 1000 },
    { name: 'hot-room', clients: 500, rooms: 1, rate: 200 },
  ].filter(p => !process.env.PERF_PROFILES || process.env.PERF_PROFILES.split(',').includes(p.name));
  const results = [];
  const environment = {
    node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0].model, logicalCpus: cpus().length,
    socketIo: api('socket.io/package.json').version, socketIoClient: api('socket.io-client/package.json').version,
    ws: wsRequire('ws/package.json').version, redisAdapter: api('@socket.io/redis-adapter/package.json').version,
    at: new Date().toISOString(), repeats, durationMs,
    fixtures: fixtures.map(([event, payload]) => ({ event, jsonBytes: Buffer.byteLength(JSON.stringify([event, payload])), socketIoBytes: Buffer.byteLength('42' + JSON.stringify([event, payload])) })),
  };
  writeFileSync(`${output}/environment.json`, JSON.stringify(environment, null, 2));
  for (const profile of profiles) for (const path of (process.env.PERF_PATHS ?? 'local,redis').split(',')) for (const compression of (process.env.PERF_COMPRESSION ?? 'on,off').split(',').map(x => x === 'on')) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Alternate order to reduce thermal/load/order bias; each trial gets fresh processes.
      const order = repeat % 2 ? ['ws', 'socket.io'] : ['socket.io', 'ws'];
      for (const transport of order.filter(t => !process.env.PERF_TRANSPORTS || process.env.PERF_TRANSPORTS.split(',').includes(t))) {
        const cfg = { ...profile, path, compression, selectiveCompression: process.env.PERF_SELECTIVE_COMPRESSION === '1', noContextTakeover: process.env.PERF_NO_CONTEXT_TAKEOVER === '1', ...(process.env.PERF_DEFLATE_LEVEL ? { deflateLevel: Number(process.env.PERF_DEFLATE_LEVEL) } : {}), repeat, transport, durationMs, channel: `kanera-benchmark:${randomUUID()}` };
        const result = await trial(cfg);
        results.push(result);
        writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ profile: profile.name, path, compression, repeat, transport, p95Ms: result.latencyMs.p95, cpuMs: result.serverCpuMs, delivered: result.received, heapKiB: result.idleHeapBytesPerClient / 1024 }));
      }
    }
  }
  console.log(`Results: ${output}`);
}

if (process.argv[2] === 'worker') await worker(JSON.parse(process.argv[3]));
else await main();
