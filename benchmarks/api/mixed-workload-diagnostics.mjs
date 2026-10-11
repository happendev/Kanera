// Opt-in instrumentation for temporary benchmark source copies only.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import http from 'node:http';
import { performance, PerformanceObserver } from 'node:perf_hooks';
const require = createRequire(`${process.env.HYDRATION_ROOT}/apps/api/package.json`);
const pg = require(`${process.env.HYDRATION_ROOT}/apps/api/node_modules/pg`);
const context = new AsyncLocalStorage();
const epoch = () => performance.timeOrigin + performance.now();
let enabled = false, requests = [], events = [], gc = [];
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (name, ...args) {
  const id = name === 'request' && args[0].headers['x-benchmark-id'];
  if (!enabled || !id) return emit.call(this, name, ...args);
  const record = { id, method: args[0].method, path: args[0].url, received: epoch(), queries: [], pool: [] };
  requests.push(record);
  args[1].once('finish', () => { record.finished = epoch(); });
  return context.run(record, () => emit.call(this, name, ...args));
};
const connect = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function (...args) {
  const record = enabled && context.getStore(), started = epoch();
  const finish = () => { if (record) record.pool.push(epoch() - started); };
  if (typeof args[0] === 'function') {
    const callback = args[0];
    args[0] = (...values) => { finish(); return context.run(record, () => callback(...values)); };
    return connect.apply(this, args);
  }
  return connect.apply(this, args).then(client => { finish(); return client; });
};
const query = pg.Client.prototype.query;
const active = new WeakMap();
pg.Client.prototype.query = function (...args) {
  const record = enabled && context.getStore();
  if (!record) return query.apply(this, args);
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
  const stage = { kind: sql.includes('with filtered_cards as materialized') ? 'board-summary' : sql.trim().split(/\s+/)[0].toLowerCase(), started: epoch(), decodeMs: 0, rows: 0 };
  record.queries.push(stage);
  // Each checked-out pool client executes one query at a time in this workload.
  active.set(this, stage);
  const finish = () => { stage.finished = epoch(); if (active.get(this) === stage) active.delete(this); };
  const index = args.findLastIndex(arg => typeof arg === 'function');
  if (index >= 0) {
    const callback = args[index];
    args[index] = (...values) => { finish(); return context.run(record, () => callback(...values)); };
    return query.apply(this, args);
  }
  return query.apply(this, args).then(value => { finish(); return value; }, error => { finish(); throw error; });
};
const row = pg.Client.prototype._handleDataRow;
pg.Client.prototype._handleDataRow = function (...args) {
  const stage = active.get(this);
  if (!stage) return row.apply(this, args);
  const start = performance.now();
  try { return row.apply(this, args); }
  finally { stage.decodeMs += performance.now() - start; stage.rows++; }
};
new PerformanceObserver(list => {
  if (enabled) for (const entry of list.getEntries()) gc.push({ started: performance.timeOrigin + entry.startTime, durationMs: entry.duration, kind: entry.detail.kind });
}).observe({ entryTypes: ['gc'] });
globalThis.__mixedDiagnostics = {
  reset() { requests = []; events = []; gc = []; enabled = true; },
  snapshot() { enabled = false; return { requests, events, gc }; },
  install(app) {
    app.addHook('preSerialization', (req, reply, payload, done) => {
      const record = context.getStore(); if (record) record.serializationStarted = epoch(); done(null, payload);
    });
    app.addHook('onSend', (req, reply, payload, done) => {
      const record = context.getStore(); if (record) record.serializationFinished = epoch(); done(null, payload);
    });
  },
  event(stage, event) {
    if (!enabled || !event) return;
    const key = event.payload?.card?.title;
    if (!key?.startsWith('mixed-') && event.eventType !== 'watch:changed') return;
    events.push({ stage, at: epoch(), id: event.id, type: event.eventType, key, watching: event.payload?.watching, requestId: context.getStore()?.id, dispatched: event.realtimeDispatched });
  },
};
