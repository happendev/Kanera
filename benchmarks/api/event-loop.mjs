#!/usr/bin/env node
// Payload/CPU microbenchmark. This intentionally does not measure HTTP throughput or database work.
// Fetches one LOCAL board snapshot or reuses PERF_INPUT; never changes board data.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay, setImmediate as immediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { brotliCompress, brotliCompressSync, constants, deflate, deflateSync, gzip, gzipSync, gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

if (!isMainThread) {
  let cached;
  parentPort.on('message', ({ id, mode, payload }) => {
    if (mode === 'cache') { cached = payload; parentPort.postMessage({ id, result: true }); return; }
    const json = JSON.stringify(mode === 'cached' ? cached : payload);
    if (mode === 'transfer') {
      const buffer = new TextEncoder().encode(json);
      parentPort.postMessage({ id, result: buffer.buffer }, [buffer.buffer]);
    } else parentPort.postMessage({ id, result: json });
  });
} else await main();

function numberOption(name, fallback, minimum = 1) {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isInteger(value) && value >= minimum, `${name} must be an integer >= ${minimum}`);
  return value;
}

async function fetchPayload() {
  const base = new URL(process.env.PERF_API_URL ?? 'http://127.0.0.1:3000');
  assert(['localhost', '127.0.0.1', '[::1]', '::1'].includes(base.hostname), 'Only LOCAL APIs are permitted');
  const login = await fetch(new URL('/auth/login', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.PERF_EMAIL ?? 'perf@kanera.local', password: process.env.PERF_PASSWORD ?? 'Perf12345' }),
  });
  assert(login.ok, `LOCAL login failed: ${login.status}`);
  const { accessToken } = await login.json();
  assert(accessToken, 'LOCAL login did not yield a token');
  const boardId = process.env.PERF_BOARD_ID ?? '70000000-0000-4000-8000-000000000200';
  const response = await fetch(new URL(`/boards/${encodeURIComponent(boardId)}/open`, base), {
    method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert(response.ok, `LOCAL board open failed: ${response.status}`);
  return response.text();
}

// Targets repetition imposed by the board endpoint contract, without generic dictionary scans.
function hoistCardContext(payload) {
  const { cards, ...metadata } = payload;
  const context = Object.fromEntries(['boardId', 'workspaceId', 'organisationKey']
    .filter(key => cards.every(card => Object.hasOwn(card, key))).map(key => [key, cards[0]?.[key]]));
  const inheritCustomFieldCardIds = cards.every(card => card.customFieldValues.every(value => Object.hasOwn(value, 'cardId')));
  return { metadata, context, inheritCustomFieldCardIds, cards: cards.map(card => {
    const { boardId, workspaceId, organisationKey, customFieldValues, ...rest } = card;
    const original = { boardId, workspaceId, organisationKey };
    for (const key of Object.keys(original)) if (Object.hasOwn(card, key) && original[key] !== context[key]) rest[key] = original[key];
    return { ...rest, customFieldValues: inheritCustomFieldCardIds ? customFieldValues.map(value => {
      if (value.cardId !== card.id) return value;
      const { cardId: _cardId, ...fields } = value;
      return fields;
    }) : customFieldValues };
  }) };
}

function expandCardContext({ metadata, context, inheritCustomFieldCardIds, cards }) {
  return { ...metadata, cards: cards.map(card => ({ ...context, ...card,
    customFieldValues: inheritCustomFieldCardIds ? card.customFieldValues.map(value => ({ cardId: card.id, ...value })) : card.customFieldValues })) };
}

// Removes only information that can be recovered exactly: common card values and repeated keys.
function compactCards(payload) {
  const { cards, ...metadata } = payload;
  const sharedKeys = Object.keys(cards[0] ?? {}).filter(key => cards.every(card => Object.hasOwn(card, key)));
  const common = {};
  const columns = [];
  for (const key of sharedKeys) {
    const first = JSON.stringify(cards[0][key]);
    if (cards.every(card => JSON.stringify(card[key]) === first)) common[key] = cards[0][key];
    else columns.push(key);
  }
  const shared = new Set(sharedKeys);
  const extras = cards.map(card => Object.fromEntries(Object.entries(card).filter(([key]) => !shared.has(key))));
  return { metadata, common, columns, rows: cards.map(card => columns.map(key => card[key])),
    ...(extras.some(extra => Object.keys(extra).length) ? { extras } : {}) };
}

function expandCards({ metadata, common, columns, rows, extras }) {
  return { ...metadata, cards: rows.map((row, index) => ({ ...common,
    ...Object.fromEntries(columns.map((key, column) => [key, row[column]])), ...(extras?.[index] ?? {}) })) };
}

// Escapes reserved object keys, making string interning lossless even for arbitrary JSON values.
function dictionaryEncode(payload) {
  const counts = new Map();
  function visit(value) {
    if (typeof value === 'string' && value.length >= 12) counts.set(value, (counts.get(value) ?? 0) + 1);
    else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
  }
  visit(payload);
  const strings = [...counts].filter(([, count]) => count >= 3).map(([value]) => value);
  const indexes = new Map(strings.map((value, index) => [value, index]));
  function encode(value) {
    if (typeof value === 'string' && indexes.has(value)) return { $s: indexes.get(value) };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, child]) => [key, encode(child)]);
      return Object.hasOwn(value, '$s') || Object.hasOwn(value, '$o') ? { $o: entries } : Object.fromEntries(entries);
    }
    return value;
  }
  return { strings, payload: encode(payload) };
}

function dictionaryDecode({ strings, payload }) {
  function decode(value) {
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object') {
      if (Object.hasOwn(value, '$s')) return strings[value.$s];
      return Object.fromEntries((Object.hasOwn(value, '$o') ? value.$o : Object.entries(value)).map(([key, child]) => [key, decode(child)]));
    }
    return value;
  }
  return decode(payload);
}

// An optimistic schema-serializer ceiling, inferred from every fixture value, not a product contract.
function inferSchema(values) {
  if (!values.length) return {};
  const groups = new Map();
  for (const value of values) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(value);
  }
  const schemas = [...groups].map(([type, group]) => {
    if (type === 'array') return { type, items: inferSchema(group.flat()) };
    if (type === 'object') {
      const keys = [...new Set(group.flatMap(value => Object.keys(value)))];
      return { type, properties: Object.fromEntries(keys.map(key => [key, inferSchema(group.filter(value => Object.hasOwn(value, key)).map(value => value[key]))])),
        required: keys.filter(key => group.every(value => Object.hasOwn(value, key))), additionalProperties: false };
    }
    return { type };
  });
  return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { median: at(0.5), p95: at(0.95), min: sorted[0], max: sorted.at(-1) };
}

async function measure(run) {
  // A timer probe captures pauses even when async work yields, unlike wall duration alone. The
  // probe has a ~1 ms scheduling floor. CPU includes all process threads, including libuv/Worker.
  const lags = [];
  let previous = performance.now();
  const timer = setInterval(() => { const now = performance.now(); lags.push(Math.max(0, now - previous - 1)); previous = now; }, 1);
  await delay(3);
  lags.length = 0;
  previous = performance.now();
  const utilization = performance.eventLoopUtilization();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const pending = run();
  const dispatchMs = performance.now() - start;
  const value = await pending;
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const loop = performance.eventLoopUtilization(utilization);
  await delay(3);
  clearInterval(timer);
  // Retain the output until the operation ends, with correctness checked separately outside timing.
  assert(value !== undefined);
  return { wallMs, dispatchMs, processCpuMs: (used.user + used.system) / 1000,
    mainLoopActiveMs: loop.active, maxTimerLagMs: Math.max(0, ...lags) };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const output = resolve(process.env.PERF_OUTPUT_DIR ?? join(here, 'results', 'event-loop-20261012'));
  const rounds = numberOption('PERF_ROUNDS', 31);
  const warmups = numberOption('PERF_WARMUP_ROUNDS', 3, 0);
  const expected = numberOption('PERF_EXPECT_CARDS', 3000);
  const fixture = process.env.PERF_INPUT ? await readFile(process.env.PERF_INPUT, 'utf8') : await fetchPayload();
  const payload = JSON.parse(fixture);
  assert.equal(payload.cards?.length, expected, 'Unexpected card count; seed the intended fixture or set PERF_EXPECT_CARDS explicitly');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'board-open.json'), fixture);
  if (process.argv.includes('--fetch-only')) { console.log(JSON.stringify({ output, cards: payload.cards.length, bytes: Buffer.byteLength(fixture) })); return; }

  const json = JSON.stringify(payload);
  const buffer = Buffer.from(json);
  const hoisted = hoistCardContext(payload);
  const hoistedJson = JSON.stringify(hoisted);
  assert.deepEqual(expandCardContext(JSON.parse(hoistedJson)), payload);
  const compact = compactCards(payload);
  const dictionary = dictionaryEncode(payload);
  const combined = dictionaryEncode(compact);
  const compactJson = JSON.stringify(compact);
  const dictionaryJson = JSON.stringify(dictionary);
  const combinedJson = JSON.stringify(combined);
  assert.deepEqual(expandCards(JSON.parse(compactJson)), payload);
  assert.deepEqual(dictionaryDecode(JSON.parse(dictionaryJson)), payload);
  assert.deepEqual(expandCards(dictionaryDecode(JSON.parse(combinedJson))), payload);
  const adversarial = { $s: 'reserved', nested: { $o: [['a', 1]] }, repeated: ['a long string', 'a long string', 'a long string'], null: null };
  assert.deepEqual(dictionaryDecode(dictionaryEncode(adversarial)), adversarial);

  const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  const fastifyRequire = createRequire(apiRequire.resolve('fastify'));
  const compilerRequire = createRequire(fastifyRequire.resolve('@fastify/fast-json-stringify-compiler'));
  const compile = compilerRequire('fast-json-stringify');
  const schemaStart = performance.now();
  const serialize = compile(inferSchema([payload]));
  const schemaCompileMs = performance.now() - schemaStart;
  assert.deepEqual(JSON.parse(serialize(payload)), payload);

  const worker = new Worker(new URL(import.meta.url));
  let nextId = 0;
  const waiting = new Map();
  worker.on('message', ({ id, result }) => { waiting.get(id)?.resolve(result); waiting.delete(id); });
  worker.on('error', error => { for (const pending of waiting.values()) pending.reject(error); waiting.clear(); });
  function workerCall(mode, data) {
    return new Promise((resolveCall, reject) => { const id = nextId++; waiting.set(id, { resolve: resolveCall, reject }); worker.postMessage({ id, mode, payload: data }); });
  }
  await workerCall('cache', payload);
  assert.equal(await workerCall('clone', payload), json);
  assert.equal(Buffer.from(await workerCall('transfer', payload)).toString(), json);
  assert.equal(await workerCall('cached'), json);

  const gzipAsync = promisify(gzip);
  const deflateAsync = promisify(deflate);
  const brotliAsync = promisify(brotliCompress);
  const brotliOptions = { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } };
  const compressors = [
    ['gzip-6', gzipSync, gzipAsync, { level: 6 }, gunzipSync],
    ['deflate-6', deflateSync, deflateAsync, { level: 6 }, inflateSync],
    ['brotli-4', brotliCompressSync, brotliAsync, brotliOptions, brotliDecompressSync],
  ];
  const pagePayloads = [150, 500].map(size => ({ size, initial: { ...payload, cards: payload.cards.slice(0, size) },
    pages: Array.from({ length: Math.ceil(payload.cards.length / size) }, (_, index) => ({ ...(index === 0 ? payload : {}), cards: payload.cards.slice(index * size, (index + 1) * size) })) }));
  const variants = [
    { name: 'idle-probe', run: () => true },
    { name: 'json-stringify-full', run: () => JSON.stringify(payload) },
    { name: 'json-parse-full', run: () => JSON.parse(json) },
    { name: 'json-stringify-and-utf8-full', run: () => Buffer.from(JSON.stringify(payload)) },
    { name: 'fast-json-stringify-fixture-schema', run: () => serialize(payload) },
    { name: 'structured-clone-full', run: () => structuredClone(payload) },
    { name: 'worker-clone-stringify-string-return', run: () => workerCall('clone', payload) },
    { name: 'worker-clone-stringify-transfer-return', run: () => workerCall('transfer', payload) },
    { name: 'worker-cached-stringify-string-return', run: () => workerCall('cached') },
    { name: 'pre-serialized-cache-hit', run: () => json },
    { name: 'targeted-hoist-encode-stringify', run: () => JSON.stringify(hoistCardContext(payload)) },
    { name: 'targeted-hoist-parse-expand', run: () => expandCardContext(JSON.parse(hoistedJson)) },
    { name: 'compact-encode-stringify', run: () => JSON.stringify(compactCards(payload)) },
    { name: 'compact-parse-expand', run: () => expandCards(JSON.parse(compactJson)) },
    { name: 'dictionary-encode-stringify', run: () => JSON.stringify(dictionaryEncode(payload)) },
    { name: 'dictionary-parse-expand', run: () => dictionaryDecode(JSON.parse(dictionaryJson)) },
    { name: 'compact-dictionary-encode-stringify', run: () => JSON.stringify(dictionaryEncode(compactCards(payload))) },
    { name: 'compact-dictionary-parse-expand', run: () => expandCards(dictionaryDecode(JSON.parse(combinedJson))) },
    ...pagePayloads.flatMap(({ size, initial, pages }) => {
      const pageJson = JSON.stringify(initial);
      assert.deepEqual(pages.flatMap(page => page.cards), payload.cards);
      return [
        { name: `page-${size}-initial-stringify`, run: () => JSON.stringify(initial) },
        { name: `page-${size}-initial-parse`, run: () => JSON.parse(pageJson) },
        { name: `page-${size}-all-stringify-yield-between`, run: async () => { const results = []; for (const page of pages) { results.push(JSON.stringify(page)); await immediate(); } return results; } },
      ];
    }),
    ...compressors.flatMap(([name, sync, asyncCompress, options, decompress]) => {
      const compressed = sync(buffer, options);
      assert.equal(decompress(compressed).toString(), json);
      return [
        { name: `${name}-sync-preencoded`, run: () => sync(buffer, options) },
        { name: `${name}-async-preencoded`, run: () => asyncCompress(buffer, options) },
        { name: `${name}-async-with-stringify`, run: () => asyncCompress(Buffer.from(JSON.stringify(payload)), options) },
      ];
    }),
  ];
  const requested = new Set((process.env.PERF_VARIANTS ?? '').split(',').filter(Boolean));
  const selected = requested.size ? variants.filter(variant => requested.has(variant.name)) : variants;
  assert(selected.length, 'No matching variants');
  const samples = new Map(selected.map(variant => [variant.name, []]));
  try {
    for (let round = -warmups; round < rounds; round++) {
      // Rotate and reverse order to spread thermal/GC drift across alternatives.
      const shift = ((round + warmups) * 7) % selected.length;
      const ordered = [...selected.slice(shift), ...selected.slice(0, shift)];
      if (round % 2) ordered.reverse();
      for (const variant of ordered) {
        const sample = await measure(variant.run);
        if (round >= 0) samples.get(variant.name).push(sample);
      }
      if (round >= 0 && (round + 1) % 10 === 0) console.error(`Completed ${round + 1}/${rounds} interleaved rounds`);
    }
    const representations = [['full', json], ['targeted-hoist', hoistedJson], ['compact', compactJson], ['dictionary', dictionaryJson], ['compact-dictionary', combinedJson],
      ...pagePayloads.map(({ size, initial }) => [`page-${size}-initial`, JSON.stringify(initial)])].map(([name, text]) => ({ name, bytes: Buffer.byteLength(text),
        gzip6Bytes: gzipSync(text, { level: 6 }).length, deflate6Bytes: deflateSync(text, { level: 6 }).length, brotli4Bytes: brotliCompressSync(text, brotliOptions).length }));
    const result = {
      kind: 'LOCAL board payload microbenchmark; NOT HTTP throughput', at: new Date().toISOString(), node: process.version,
      machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
      cards: payload.cards.length, fixtureBytes: Buffer.byteLength(fixture), rounds, warmups, schemaCompileMs,
      correctness: { roundtripChecked: ['targeted-hoist', 'compact', 'dictionary', 'compact-dictionary', 'schema-serializer', 'worker-clone', 'worker-transfer', 'worker-cached', 'gzip', 'deflate', 'brotli'], pagingPreservesEveryCard: true },
      caveats: ['Fixture schema is inferred and is not a complete product response contract.', 'Compression input is pre-encoded unless the name says with-stringify.', 'Worker clone dispatch still blocks the main loop; CPU covers every thread.', 'Cached cases assume a valid permission-aware cache and exclude invalidation/build cost.', 'Paging reuses metadata only on page one, excludes SQL/network and requires client cooperation.', 'Timer lag has an approximately 1 ms scheduling floor; examine idle-probe alongside real cases.'],
      representations,
      pagination: pagePayloads.map(({ size, pages }) => ({ size, pages: pages.length, totalBytes: pages.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify(page)), 0) })),
      variants: [...samples].map(([name, rounds]) => ({ name, metrics: Object.fromEntries(Object.keys(rounds[0]).map(key => [key, summarize(rounds.map(sample => sample[key]))])), samples: rounds })),
    };
    await writeFile(join(output, 'microbenchmark.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.table(result.representations);
    console.table(result.variants.map(({ name, metrics }) => ({ name, wallMedianMs: metrics.wallMs.median.toFixed(3), cpuMedianMs: metrics.processCpuMs.median.toFixed(3), dispatchMedianMs: metrics.dispatchMs.median.toFixed(3), lagP95Ms: metrics.maxTimerLagMs.p95.toFixed(3) })));
    console.log(`Results: ${join(output, 'microbenchmark.json')}`);
  } finally { await worker.terminate(); }
}
