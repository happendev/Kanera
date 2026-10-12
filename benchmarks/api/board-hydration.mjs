#!/usr/bin/env node
// Reproducible, local-only experiments. Product sources, dev DB and env files are untouched.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, totalmem, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = resolve(import.meta.dirname, '../..');
const experiments = [
  ['p1', 'full', 1],
  ['pg-arrays', 'full', 1],
  ['baseline', 'full', 1], ['sql-compact', 'full', 1], ['json-arrays', 'full', 1], ['sql-combined', 'full', 1], ['lean-cover', 'full', 1], ['sql-all', 'full', 1],
  ['sql-absent', 'full', 1], ['sql-absent-combined', 'full', 1], ['json-rows', 'full', 1], ['sql-all-json-rows', 'full', 1], ['sql-absent-json-rows', 'full', 1],
  ['yield100', 'full', 1], ['baseline', 'page100', 1], ['baseline', 'metadata', 1], ['baseline', 'all-pages100', 1], ['baseline', 'full', 2],
];
const requested = process.env.HYDRATION_ONLY?.split(',');
if (requested) for (const name of requested) assert.ok(experiments.some(parts => parts.join('-') === name), `Unknown experiment: ${name}`);
const selected = experiments.filter(parts => !requested || requested.includes(parts.join('-')));
const rounds = Number(process.env.HYDRATION_ROUNDS ?? 3);
const durationMs = Number(process.env.HYDRATION_DURATION_MS ?? 5000);
assert.ok(Number.isInteger(rounds) && rounds >= 0, 'HYDRATION_ROUNDS must be a nonnegative integer');
assert.ok(Number.isInteger(durationMs) && durationMs >= 500, 'HYDRATION_DURATION_MS must be an integer >= 500');
if (process.env.HYDRATION_PLANS === '1') assert.ok(selected.some(parts => parts.join('-') === 'baseline-full-1'), 'Plan collection requires baseline-full-1');
// Benchmarks reuse the API's runtime rather than introducing another root dependency.
const tsxPackage = `${root}/apps/api/node_modules/tsx`;
const tsxEntry = JSON.parse(readFileSync(`${tsxPackage}/package.json`, 'utf8')).exports['.'];
assert.equal(typeof tsxEntry, 'string', 'tsx changed its loader export; update the benchmark runner');
const tsx = resolve(tsxPackage, tsxEntry);
const out = resolve(process.env.HYDRATION_OUTPUT ?? `${root}/benchmarks/api/results/event-loop-20261012`);
const scratch = mkdtempSync(join(tmpdir(), 'kanera-hydration-'));
const database = `kanera_hydration_${process.pid}`;
const workMemMb = Number(process.env.HYDRATION_WORK_MEM_MB ?? 4);
assert.ok([4, 16, 64].includes(workMemMb), 'HYDRATION_WORK_MEM_MB must be 4, 16, or 64');
mkdirSync(out, { recursive: true });
symlinkSync(`${root}/apps/api/drizzle`, `${scratch}/drizzle`);
symlinkSync(`${root}/apps/api/node_modules`, `${scratch}/node_modules`);
writeFileSync(`${scratch}/package.json`, '{"type":"module"}');
const env = { ...process.env, NODE_ENV: 'production', KANERA_ENVIRONMENT: 'test', KANERA_DEPLOYMENT_MODE: 'self_hosted',
  DATABASE_URL: `postgres://kanera:kanera@127.0.0.1:5433/${database}?options=-c+work_mem%3D${workMemMb}MB`,
  REDIS_URL: 'redis://127.0.0.1:6379/15', API_PORT: '3100', WEB_ORIGIN: 'http://localhost:4200', API_PUBLIC_URL: 'http://127.0.0.1:3100',
  JWT_SECRET: 'hydration-benchmark-local-jwt-secret', MCP_INTERNAL_SECRET: 'hydration-benchmark-local-mcp-secret',
  MFA_ENCRYPTION_KEY: 'hydration-benchmark-local-mfa-encryption-key', MEDIA_SIGNING_SECRET: 'hydration-benchmark-local-media-signing-key',
  SECRETS_ENCRYPTION_KEY: 'hydration-benchmark-local-secrets-encryption-key', ADMIN_JWT_SECRET: 'hydration-benchmark-local-admin-jwt-secret',
  AUTH_RATE_LIMIT_ENABLED: 'false', ANALYTICS_ENABLED: 'false', METRICS_ENABLED: 'true', PG_POOL_MAX: '20',
  JWT_ACCESS_TTL: '2h', UPLOADS_DIR: `${scratch}/uploads`, HYDRATION_ROOT: root };
const docker = (args) => execFileSync('docker', ['exec', 'kanera-postgres', ...args], { encoding: 'utf8' });
async function run(args, label, extra = {}) {
  const fd = openSync(`${out}/${label}.log`, 'w');
  const child = spawn(process.execPath, args, { cwd: scratch, env: { ...env, ...extra }, stdio: ['ignore', fd, fd] }); closeSync(fd);
  running.push(child);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `${label} failed; see ${out}/${label}.log`);
}
async function stop(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await done; clearTimeout(timer);
}
const running = [];
let created = false;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    for (const child of running) await stop(child);
    if (created) { docker(['dropdb', '-U', 'kanera', database]); created = false; }
    rmSync(scratch, { recursive: true, force: true });
    console.log('Removed isolated database and temporary source copies');
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().then(() => process.exit(130)); });
async function start(variant, index, label, pool = 20) {
  const port = 3100 + index, control = 3198 + index;
  for (const candidate of [port, control]) await new Promise((accept, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(candidate, '127.0.0.1', () => probe.close(accept));
  });
  // Isolated copies let yielding experiments change scheduling without modifying application code.
  const source = `${scratch}/${variant}-${index}`; cpSync(`${root}/apps/api/src`, source, { recursive: true });
  const entry = `${source}/index.ts`;
  writeFileSync(entry, readFileSync(entry, 'utf8').replace('host: "0.0.0.0"', 'host: "127.0.0.1"'));
  if (variant === 'yield100') {
    const path = `${source}/modules/boards/routes.ts`, original = readFileSync(path, 'utf8');
    const needle = 'const hydratedCardSummaries: CompactCardSummary[] = boardCardSummaries.map((card) =>\n    compactCardSummary(toWireCardSummary(card, clientId, shownFieldIds)),\n  );';
    assert.equal(original.split(needle).length, 2, 'Board mapping changed: update yield experiment');
    writeFileSync(path, 'import { setImmediate as yieldTurn } from "node:timers/promises";\n' + original.replace(needle,
      'const hydratedCardSummaries: CompactCardSummary[] = [];\n  for (let offset = 0; offset < boardCardSummaries.length; offset += 100) {\n    if (offset) await yieldTurn();\n    for (const card of boardCardSummaries.slice(offset, offset + 100)) hydratedCardSummaries.push(compactCardSummary(toWireCardSummary(card, clientId, shownFieldIds)));\n  }'));
  }
  const fd = openSync(`${out}/server-${label}-${index}.log`, 'w');
  const child = spawn(process.execPath, ['--import', `${root}/benchmarks/api/board-hydration-preload.mjs`, '--import', tsx, `${source}/index.ts`],
    { cwd: scratch, env: { ...env, PG_POOL_MAX: String(pool), API_PORT: String(port), API_PUBLIC_URL: `http://127.0.0.1:${port}`, HYDRATION_VARIANT: variant, HYDRATION_CONTROL_PORT: String(control) }, stdio: ['ignore', fd, fd] }); closeSync(fd); running.push(child);
  for (let attempt = 0; ; attempt++) {
    assert.equal(child.exitCode, null, `Server exited; see server-${label}-${index}.log`);
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); await response.arrayBuffer(); if (response.ok) break; } catch { /* starting */ }
    assert.ok(attempt < 300, 'Server readiness timeout'); await delay(100);
  }
  return { child, base: `http://127.0.0.1:${port}`, control: `http://127.0.0.1:${control}`, source };
}
try {
  docker(['createdb', '-U', 'kanera', database]); created = true;
  await run(['--import', tsx, `${root}/apps/api/src/scripts/migrate.ts`], 'migrate');
  await run(['--import', tsx, `${root}/apps/api/src/scripts/seed-web-performance.ts`], 'seed', { NODE_ENV: 'development', PERF_CARD_COUNT: '3000', PERF_WORKSPACE_COUNT: '6', PERF_MEMBER_COUNT: '40' });
  docker(['psql', '-U', 'kanera', '-d', database, '-c', 'ANALYZE']);
  writeFileSync(`${out}/environment.json`, JSON.stringify({ node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, memoryGiB: totalmem()/1073741824,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
    totalPool: 20, workMem: `${workMemMb}MB`, fixture: { primaryCards: 3000, workspaces: 6, members: 40 },
    postgres: docker(['psql', '-U', 'kanera', '-d', database, '-Atc', 'select version()']), database, scratch }, null, 2));
  const first = await start('baseline', 0, 'fixture');
  const login = await fetch(`${first.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'perf@kanera.local', password: 'Perf12345' }) });
  assert.equal(login.status, 200); const { accessToken: token } = await login.json(); assert.ok(token);
  const response = await fetch(`${first.base}/boards/70000000-0000-4000-8000-000000000200/open`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); const body = await response.text(); assert.equal(JSON.parse(body).cards.length, 3000);
  const baseline = `${out}/board-payload.json`; writeFileSync(baseline, body);
  await stop(first.child); rmSync(first.source, { recursive: true });
  console.log(`Fixture ready: ${baseline}`);
  writeFileSync(`${out}/worktree.patch`, execFileSync('git', ['diff', 'HEAD'], { cwd: root, encoding: 'utf8' }));
  mkdirSync(`${out}/harness`, { recursive: true });
  for (const file of ['board-hydration.mjs', 'board-hydration-client.mjs', 'board-hydration-preload.mjs', 'board-hydration-query.mjs']) cpSync(`${root}/benchmarks/api/${file}`, `${out}/harness/${file}`);
  // Optional pause gives independent microbenchmarks exclusive use of the machine.
  if (process.env.HYDRATION_PREPARE_ONLY === '1') { console.log('Prepared fixture; waiting for continue file'); while (!await import('node:fs').then(fs => fs.existsSync(`${out}/continue`))) await delay(1000); }
  for (let round = 0; round <= rounds; round++) {
    for (const [variant, scenario, replicas] of round % 2 ? selected : [...selected].reverse()) {
      const label = `${variant}-${scenario}-${replicas}-r${round}`, servers = [];
      console.log(`Running ${label}`);
      try {
        for (let i = 0; i < replicas; i++) servers.push(await start(variant, i, label, 20 / replicas));
        await run([`${root}/benchmarks/api/board-hydration-client.mjs`], label, { HYDRATION_CLIENT: JSON.stringify({ label, variant, scenario, replicas, token, baseline,
          bases: servers.map(s => s.base), controls: servers.map(s => s.control), poolPerProcess: 20/replicas, workMem: `${workMemMb}MB`, connections: round === 0 ? 1 : 25,
          warmupMs: round === 0 ? 500 : 1000, durationMs: round === 0 ? 2000 : durationMs,
          profile: round === 0 && variant === 'baseline' && scenario === 'full' && replicas === 1,
          output: `${out}/${label}.json` }) });
        const result = JSON.parse(readFileSync(`${out}/${label}.json`, 'utf8')).result;
        if (variant === 'baseline' && scenario === 'full' && replicas === 1) {
          const query = await (await fetch(`${servers[0].control}/query`)).json();
          writeFileSync(`${out}/query.json`, JSON.stringify(query, null, 2));
        }
        console.log(`${label}: ${result.operationsPerSecond.toFixed(2)} boards/s; p95 ${result.p95Ms.toFixed(1)}ms; CPU ${result.apiCpuMsPerOperation.toFixed(1)}ms/board`);
      } finally { for (const server of servers) { await stop(server.child); rmSync(server.source, { recursive: true }); } }
    }
  }
  if (process.env.HYDRATION_PLANS === '1') await run([`${root}/benchmarks/api/board-hydration-plans.mjs`], 'plans', { HYDRATION_OUTPUT: out });
} finally {
  await cleanup();
}
