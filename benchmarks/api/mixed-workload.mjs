#!/usr/bin/env node
// Local-only, destructive only to this run's newly created database and containers.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, loadavg, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = resolve(import.meta.dirname, '../..');
const count = (name, fallback, minimum, maximum) => {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isInteger(value) && value >= minimum && value <= maximum, `${name} must be ${minimum}..${maximum}`);
  return value;
};
const systemWorkload = process.env.MIXED_WORKLOAD === 'system';
const beforeSource = process.env.MIXED_SOURCE_BEFORE;
if (systemWorkload) assert.ok(beforeSource && existsSync(`${beforeSource}/worker-server.ts`), 'System comparison requires MIXED_SOURCE_BEFORE API source snapshot');
const systemMembers = count('MIXED_SYSTEM_MEMBERS', 40, 8, 200);
const systemPageSize = count('MIXED_SYSTEM_PAGE_SIZE', 100, 1, 500);
const systemFocus = process.env.MIXED_SYSTEM_FOCUS === '1';
const rounds = count('MIXED_ROUNDS', 3, 1, 10);
const durationMs = count('MIXED_DURATION_MS', 20000, 2000, 120000);
const readers = count('MIXED_READERS', 25, 1, 100);
const boardRps = count('MIXED_BOARD_RPS', 0, 0, 100);
const warmupMs = count('MIXED_WARMUP_MS', 15000, 0, 120000);
const proxyWorkers = count('MIXED_PROXY_WORKERS', 1, 1, 8);
const gzipLevel = count('MIXED_GZIP_LEVEL', 5, 0, 9);
const direct = process.env.MIXED_DIRECT === '1';
const diagnostics = process.env.MIXED_DIAGNOSTICS === '1';
const profile = process.env.MIXED_PROFILE === '1';
assert.ok(!systemWorkload || !diagnostics, 'System workload uses its own SQL/fanout counters');
const observers = count('MIXED_OBSERVERS', 8, 2, 40);
const variants = (process.env.MIXED_VARIANTS ?? (systemWorkload ? 'before,after' : 'p1,baseline')).split(',');
assert.ok(variants.length > 0 && new Set(variants).size === variants.length && variants.every(v => (systemWorkload ? ['before', 'after'] : ['p1', 'baseline']).includes(v)), 'MIXED_VARIANTS must select p1 and/or baseline');
const out = resolve(process.env.MIXED_OUTPUT ?? `${root}/benchmarks/api/results/mixed-${Date.now()}`);
const ports = { app0: 3100, app1: 3101, public: 3120, worker: 3121, proxy: 3180, app0Control: 3198, app1Control: 3199, publicControl: 3196, workerControl: 3197, redis: 56389 };
if (systemWorkload) Object.assign(ports, { smtp: 3194, receiver: 3195 });
for (const port of Object.values(ports)) await new Promise((accept, reject) => {
  const probe = createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(accept));
});
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const images = { proxy: 'nginx:1.30.4-alpine', redis: 'valkey/valkey:9.1.2-alpine' };
// No implicit downloads or replacements of the user's running infrastructure.
for (const image of Object.values(images)) docker(['image', 'inspect', image]);
assert.ok(!existsSync(out), 'Use a fresh MIXED_OUTPUT directory; existing results are never overwritten');
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'kanera-mixed-'));
const fixtureFile = process.env.MIXED_FIXTURE_FILE ? resolve(process.env.MIXED_FIXTURE_FILE) : undefined;
const database = `kanera_mixed_${process.pid}`;
const template = `${database}_seed`;
let templateCreated = false;
const names = { proxy: `kanera-mixed-proxy-${process.pid}`, redis: `kanera-mixed-valkey-${process.pid}` };
const origin = `http://127.0.0.1:${ports.proxy}`;
const tsxPackage = `${root}/apps/api/node_modules/tsx`;
const tsx = resolve(tsxPackage, JSON.parse(readFileSync(`${tsxPackage}/package.json`, 'utf8')).exports['.']);
symlinkSync(`${root}/apps/api/node_modules`, `${scratch}/node_modules`);
symlinkSync(`${root}/apps/api/drizzle`, `${scratch}/drizzle`);
writeFileSync(`${scratch}/package.json`, '{"type":"module"}');
const env = { ...process.env, NODE_ENV: 'production', KANERA_ENVIRONMENT: 'test', KANERA_DEPLOYMENT_MODE: 'self_hosted',
  DATABASE_URL: `postgres://kanera:kanera@127.0.0.1:5433/${database}?options=-c+work_mem%3D16MB`,
  REDIS_URL: `redis://127.0.0.1:${ports.redis}/0`, WEB_ORIGIN: origin, API_PUBLIC_URL: origin,
  JWT_SECRET: `mixed-local-jwt-secret-${process.pid}`, MCP_INTERNAL_SECRET: 'mixed-local-mcp-internal-secret-32-chars', MFA_ENCRYPTION_KEY: 'mixed-local-mfa-encryption-secret-32-chars',
  MEDIA_SIGNING_SECRET: 'mixed-local-media-signing-secret', SECRETS_ENCRYPTION_KEY: 'mixed-local-secrets-encryption-key', ADMIN_JWT_SECRET: 'mixed-local-admin-jwt-secret',
  AUTH_RATE_LIMIT_ENABLED: 'false', PUBLIC_API_RATE_LIMIT_ENABLED: 'false', ANALYTICS_ENABLED: 'false', METRICS_ENABLED: 'true',
  ...(systemWorkload ? { KANERA_ALLOW_PRIVATE_NOTIFICATION_DESTINATIONS: 'true' } : {}),
  SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', INTERNAL_NOTIFICATION_EMAILS: '',
  REALTIME_WEBSOCKET_COMPRESSION_ENABLED: 'false', JWT_ACCESS_TTL: '2h', UPLOADS_DIR: `${scratch}/uploads`, HYDRATION_ROOT: root };
const running = [], containers = [];
let created = false, cleanupPromise;
const pg = args => docker(['exec', 'kanera-postgres', ...args]);
const sql = statement => pg(['psql', '-U', 'kanera', '-d', database, '-v', 'ON_ERROR_STOP=1', '-Atc', statement]);
function launch(args, label, extra = {}) {
  const fd = openSync(`${out}/${label}.log`, 'w');
  const child = spawn(process.execPath, args, { cwd: scratch, env: { ...env, ...extra }, stdio: ['ignore', fd, fd] });
  closeSync(fd); running.push(child); return child;
}
async function run(args, label, extra) {
  const [code] = await once(launch(args, label, extra), 'exit');
  assert.equal(code, 0, `${label} failed; see ${out}/${label}.log`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await done; clearTimeout(timer);
}
async function ready(port, child) {
  for (let n = 0; n < 300; n++) {
    if (child) assert.ok(child.exitCode === null && child.signalCode === null, `Service exited at ${port}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.ok) return; } catch { /* booting */ }
    await delay(100);
  }
  throw new Error(`Readiness timeout at ${port}`);
}
function cleanup() {
  return cleanupPromise ??= (async () => {
    for (const child of [...running].reverse()) await stop(child);
    for (const name of containers.reverse()) { try { docker(['rm', '-f', name]); } catch { /* already removed */ } }
    if (templateCreated) { pg(['dropdb', '-U', 'kanera', template]); templateCreated = false; }
    if (created) { pg(['dropdb', '-U', 'kanera', database]); created = false; }
    rmSync(scratch, { recursive: true, force: true });
    console.log('Removed isolated database, Valkey, proxy and temporary sources');
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().then(() => process.exit(130)); });
try {
  pg(['createdb', '-U', 'kanera', database]); created = true;
  if (fixtureFile && existsSync(fixtureFile)) {
    execFileSync('docker', ['exec', '-i', 'kanera-postgres', 'pg_restore', '-U', 'kanera', '-d', database, '--exit-on-error'], { input: readFileSync(fixtureFile), maxBuffer: 256 * 1024 * 1024 });
  } else {
    await run(['--import', tsx, `${root}/apps/api/src/scripts/migrate.ts`], 'migrate');
    await run(['--import', tsx, `${root}/apps/api/src/scripts/seed-web-performance.ts`], 'seed', { NODE_ENV: 'development', PERF_CARD_COUNT: '3000', PERF_WORKSPACE_COUNT: '6', PERF_MEMBER_COUNT: String(systemWorkload ? systemMembers : 40) });
    // Private references are unique per covered card: signing cannot collapse to three cached URLs.
    sql(`update card_attachment set url='/api/media/70000000-0000-4000-8000-000000000001/bench/'||id||'/original.jpg', thumbnail_url='/api/media/70000000-0000-4000-8000-000000000001/bench/'||id||'/thumb.jpg', cover_image_url='/api/media/70000000-0000-4000-8000-000000000001/bench/'||id||'/cover.jpg'; ANALYZE`);
    if (fixtureFile) writeFileSync(fixtureFile, execFileSync('docker', ['exec', 'kanera-postgres', 'pg_dump', '-U', 'kanera', '-Fc', database], { maxBuffer: 256 * 1024 * 1024 }));
  }
  if (systemWorkload) {
    sql("update card set created_at=now()-interval '1 day', due_date_local_date=null, due_date_slot=null, due_date_timezone=null, completed_at=null, archived_at=null; update card_checklist_item set due_date_local_date=null, due_date_slot=null, due_date_timezone=null; insert into notification_settings(user_id,email_enabled,lifecycle_email) select id,false,false from \"user\" on conflict(user_id) do update set email_enabled=false,lifecycle_email=false");
  }
  // pg_dump does not preserve planner statistics. Every restored fixture needs the same analysis.
  sql('ANALYZE');
  pg(['createdb', '-U', 'kanera', '-T', database, template]); templateCreated = true;
  docker(['create', '--name', names.redis, '--network', 'host', images.redis, 'valkey-server', '--bind', '127.0.0.1', '--port', String(ports.redis), '--save', '', '--appendonly', 'no']); containers.push(names.redis);
  docker(['start', names.redis]);
  let proxy = readFileSync(`${root}/apps/web/nginx.conf`, 'utf8')
    .replace('gzip_comp_level 5;', `gzip_comp_level ${gzipLevel || 1};`)
    .replaceAll('gzip on;', gzipLevel ? 'gzip on;' : 'gzip off;')
    .replace('access_log off;', diagnostics ? 'access_log /tmp/benchmark-access.log benchmark;' : 'access_log off;')
    .replace('listen 80;', `listen 127.0.0.1:${ports.proxy};`)
    .replace('set $api_upstream api:3000;', 'set $api_upstream mixed_app;')
    .replace('http://public-api:3001/', `http://127.0.0.1:${ports.public}/`);
  proxy = `worker_processes ${proxyWorkers};\nerror_log /dev/stderr warn;\npid /tmp/nginx.pid;\nevents { worker_connections 2048; }\nhttp { log_format benchmark escape=json '{"id":"$http_x_benchmark_id","at":"$msec","request":"$request_time","connect":"$upstream_connect_time","header":"$upstream_header_time","upstream":"$upstream_response_time","bytes":"$body_bytes_sent"}'; include /etc/nginx/mime.types; upstream mixed_app { server 127.0.0.1:${ports.app0}; server 127.0.0.1:${ports.app1}; }\n${proxy}\n}`;
  writeFileSync(`${out}/nginx.conf`, proxy);
  docker(['create', '--name', names.proxy, '--cpus', '2', '--network', 'host', images.proxy]); containers.push(names.proxy);
  docker(['cp', `${out}/nginx.conf`, `${names.proxy}:/etc/nginx/nginx.conf`]); docker(['start', names.proxy]); await ready(ports.proxy);
  const services = [
    { name: 'app0', entry: 'index.ts', port: ports.app0, control: ports.app0Control, pool: 10, key: 'API_PORT' },
    { name: 'app1', entry: 'index.ts', port: ports.app1, control: ports.app1Control, pool: 10, key: 'API_PORT' },
    { name: 'public', entry: 'public-api-index.ts', port: ports.public, control: ports.publicControl, pool: 5, key: 'PUBLIC_API_PORT' },
    { name: 'worker', entry: 'worker-index.ts', port: ports.worker, control: ports.workerControl, pool: 5, key: 'WORKER_PORT' },
  ];
  writeFileSync(`${out}/environment.json`, JSON.stringify({ node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, systemMembers, systemPageSize, systemFocus, rounds, durationMs, readers, boardRps, observers, variants, warmupMs, diagnostics, profile, direct, proxyWorkers, gzipLevel, proxyCpuQuota: 2,
    database, fixtureFile, fixtureSha256: fixtureFile ? createHash('sha256').update(readFileSync(fixtureFile)).digest('hex') : undefined, scratch, names, ports, services, workMem: '16MB', mode: 'self_hosted', images: Object.fromEntries(Object.entries(images).map(([name, image]) => [name, JSON.parse(docker(['image', 'inspect', image]))[0].Id])),
    postgres: sql('select version()'), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workload: systemWorkload ? 'Fixed-work Global Work, notification fanout, triggered/scheduled automations, SMTP, personal push and workspace webhook delivery/retry phases; see system-workload.README.md.' : `Two app APIs, public API, worker; total pool 30; private cover signing; ${direct ? 'direct HTTP/WebSocket' : `nginx with ${proxyWorkers} worker(s), gzip level ${gzipLevel}`}; board readers plus sequential app/public title writers and public watch toggles at target 1/s each, detail reads at 2/s, app health at 1/s; observers on WebSocket.` }, null, 2));
  writeFileSync(`${out}/worktree.patch`, execFileSync('git', ['diff', 'HEAD'], { cwd: root, encoding: 'utf8' }));
  mkdirSync(`${out}/harness`);
  for (const file of ['system-workload-summary.mjs', 'system-workload.README.md', 'system-workload-preload.mjs', 'system-workload-hooks.mjs', 'system-workload-client.mjs', 'mixed-workload.mjs', 'mixed-workload-client.mjs', 'mixed-workload-summary.mjs', 'board-hydration-preload.mjs', 'board-hydration-query.mjs', 'mixed-workload-diagnostics.mjs', 'mixed-workload-diagnostic-summary.mjs', 'mixed-workload-proxy-matrix.mjs', 'mixed-workload-proxy-summary.mjs', 'board-hydration-cpu-summary.mjs']) cpSync(`${root}/benchmarks/api/${file}`, `${out}/harness/${file}`);
  for (let round = 1; round <= rounds; round++) for (const variant of round % 2 ? variants : [...variants].reverse()) {
    const label = `${variant}-r${round}`, current = [];
    console.log(`Running ${label}`);
    // Clone the same complete fixture: activity, outbox and reminder history cannot leak between samples.
    pg(['dropdb', '-U', 'kanera', database]); created = false;
    pg(['createdb', '-U', 'kanera', '-T', template, database]); created = true;
    const source = `${scratch}/${label}`; cpSync(`${root}/apps/api/src`, source, { recursive: true });
    if (systemWorkload) {
      if (variant === 'before') cpSync(beforeSource, source, { recursive: true });
      const { instrumentSystemSource } = await import('./system-workload-hooks.mjs');
      const archive = `${out}/api-source-${variant}.tar.gz`;
      if (!existsSync(archive)) execFileSync('tar', ['-czf', archive, '-C', source, '.']);
      instrumentSystemSource(source);
    }
    try {
      // Explicit completion is needed: a CPU-quiet window can occur while a sweep awaits I/O.
      const scheduler = `${source}/lib/sweep-scheduler.ts`;
      let schedulerText = readFileSync(scheduler, 'utf8');
      assert.ok(schedulerText.includes('    running = true;') && schedulerText.includes('.then(({ result }) => {'));
      schedulerText = schedulerText.replace('    running = true;', '    running = true;\n    globalThis.__mixedStartup.start(name);')
        .replace('.then(({ result }) => {', '.then(({ result, ok }) => {\n        globalThis.__mixedStartup.finish(name, ok);');
      writeFileSync(scheduler, schedulerText);
      if (diagnostics) {
        for (const file of ['server.ts', 'public-api-server.ts']) {
          const path = `${source}/${file}`, text = readFileSync(path, 'utf8');
          assert.ok(text.includes('  registerSecurityHeaderFallbacks(app);'));
          writeFileSync(path, text.replace('  registerSecurityHeaderFallbacks(app);', '  globalThis.__mixedDiagnostics.install(app);\n  registerSecurityHeaderFallbacks(app);'));
        }
        const path = `${source}/realtime/outbox.ts`;
        let text = readFileSync(path, 'utf8');
        for (const [from, to] of [
          ['  if (event) void notifyOutbox', '  globalThis.__mixedDiagnostics.event("insert-ack", event);\n  if (event) void notifyOutbox'],
          ['  if (event) void notifyDirectOutbox', '  globalThis.__mixedDiagnostics.event("insert-ack", event);\n  if (event) void notifyDirectOutbox'],
          ['  if (events.length === 0)', '  for (const event of events) globalThis.__mixedDiagnostics.event("claimed", event);\n  if (events.length === 0)'],
          ['    if (event.scope === "board")', '    globalThis.__mixedDiagnostics.event("broadcast", event);\n    if (event.scope === "board")'],
          ['  if (event.scope === "user")', '  globalThis.__mixedDiagnostics.event("broadcast", event);\n  if (event.scope === "user")'],
        ]) { assert.ok(text.includes(from), `Missing diagnostic anchor: ${from}`); text = text.replaceAll(from, to); }
        writeFileSync(path, text);
      }
      for (const service of services) {
        const entry = `${source}/${service.entry}`;
        writeFileSync(entry, readFileSync(entry, 'utf8').replace('host: "0.0.0.0"', 'host: "127.0.0.1"'));
        const child = launch(['--import', `${root}/benchmarks/api/board-hydration-preload.mjs`, ...(systemWorkload ? ['--import', `${root}/benchmarks/api/system-workload-preload.mjs`] : []), ...(diagnostics ? ['--import', `${root}/benchmarks/api/mixed-workload-diagnostics.mjs`] : []), '--import', tsx, entry], `${label}-${service.name}`, {
          [service.key]: String(service.port), PG_POOL_MAX: String(service.pool), HYDRATION_VARIANT: systemWorkload ? 'baseline' : variant, HYDRATION_CONTROL_PORT: String(service.control),
        }); current.push(child); await ready(service.port, child);
      }
      // Require three quiet one-second worker windows after the minimum startup warm-up.
      await delay(warmupMs);
      let quiet = 0; const warmStarted = Date.now(); const warmWindows = [];
      let startup;
      do {
        assert.ok(Date.now() - warmStarted < 120000, 'Initial overdue sweep failed to complete');
        startup = await (await fetch(`http://127.0.0.1:${ports.workerControl}/startup`)).json();
        assert.equal(startup['overdue-notification']?.failed ?? 0, 0, 'Initial overdue sweep failed');
        if (!startup['overdue-notification']?.completed) await delay(500);
      } while (!startup['overdue-notification']?.completed);
      while (quiet < 3) {
        assert.ok(Date.now() - warmStarted < 120000, 'Background worker failed to settle');
        await fetch(`http://127.0.0.1:${ports.workerControl}/reset`); await delay(1000);
        const snapshot = await (await fetch(`http://127.0.0.1:${ports.workerControl}/snapshot`)).json();
        const pending = Number(sql('select (select count(*) from event_outbox where realtime_dispatched=false) + (select count(*) from direct_realtime_outbox where realtime_dispatched=false)'));
        const idle = snapshot.cpuMs / snapshot.elapsedMs < 0.1 && pending === 0;
        warmWindows.push({ cpuMs: snapshot.cpuMs, elapsedMs: snapshot.elapsedMs, pending }); quiet = idle ? quiet + 1 : 0;
      }
      const loadBefore = loadavg();
      await run([`${root}/benchmarks/api/${systemWorkload ? 'system-workload-client' : 'mixed-workload-client'}.mjs`], `${label}-client`, { MIXED_CLIENT: JSON.stringify({ root, origin, variant, round, label, systemWorkload, systemMembers, systemPageSize, systemFocus, durationMs, readers, boardRps, observers, services, diagnostics, profile, direct, gzipLevel, warmupMs, containers: names, mediaSecret: env.MEDIA_SIGNING_SECRET, output: `${out}/${label}.json` }) });
      const result = JSON.parse(readFileSync(`${out}/${label}.json`, 'utf8'));
      result.warmup = { minimumMs: warmupMs, startupJobs: startup, quietWindows: warmWindows };
      if (diagnostics) {
        docker(['cp', `${names.proxy}:/tmp/benchmark-access.log`, `${out}/${label}-nginx.jsonl`]);
      }
      for (const server of result.servers) if (server.profile) { writeFileSync(`${out}/${label}-${server.name}.cpuprofile`, JSON.stringify(server.profile)); delete server.profile; }
      result.hostLoadAverage = { before: loadBefore, after: loadavg() };
      const drainStarted = Date.now();
      const backlog = () => JSON.parse(sql(`select json_build_object('board', (select count(*) from event_outbox where realtime_dispatched=false), 'direct', (select count(*) from direct_realtime_outbox where realtime_dispatched=false))`));
      let pending = backlog();
      result.outboxBeforeDrain = pending;
      while ((pending.board || pending.direct) && Date.now() - drainStarted < 15000) { await delay(100); pending = backlog(); }
      assert.deepEqual(pending, { board: 0, direct: 0 }, 'Undelivered durable events after client drain');
      result.outboxPending = pending; result.outboxDrainMs = Date.now() - drainStarted;
      writeFileSync(`${out}/${label}.json`, JSON.stringify(result, null, 2));
      console.log(systemWorkload ? `${label}: system phases complete` : `${label}: ${result.boardReadsPerSecond.toFixed(2)} boards/s, ${result.realtime.deliveries} verified realtime deliveries`);
    } finally { for (const child of current.reverse()) await stop(child); rmSync(source, { recursive: true }); }
  }
} finally { await cleanup(); }
