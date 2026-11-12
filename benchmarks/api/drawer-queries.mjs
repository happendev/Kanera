// Local-only query experiment runner. Creates and removes its own database.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(process.env.DRAWER_OUTPUT ?? 'benchmarks/api/results/drawer-queries');
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(`${tmpdir()}/kanera-drawer-`);
const database = `kanera_drawer_${process.pid}`;
const docker = args => execFileSync('docker', ['exec', 'kanera-postgres', ...args], { encoding: 'utf8' });
const env = { ...process.env, NODE_ENV: 'development', KANERA_ENVIRONMENT: 'test', KANERA_DEPLOYMENT_MODE: 'self_hosted',
 DATABASE_URL: `postgres://kanera:kanera@127.0.0.1:5433/${database}`, DATABASE_SSL: 'false',
 REDIS_URL: 'redis://127.0.0.1:6379/15', JWT_SECRET: 'drawer-local-benchmark-jwt-secret',
 MCP_INTERNAL_SECRET: 'drawer-local-benchmark-mcp-secret', ADMIN_JWT_SECRET: 'drawer-local-benchmark-admin-secret',
 MFA_ENCRYPTION_KEY: 'drawer-local-benchmark-mfa-secret', MEDIA_SIGNING_SECRET: 'drawer-local-benchmark-media-secret',
 SECRETS_ENCRYPTION_KEY: 'drawer-local-benchmark-secrets-key', METRICS_ENABLED: 'false', SLOW_QUERY_LOG_MS: '0',
 PGOPTIONS: '-c max_parallel_workers_per_gather=0', PG_POOL_MAX: '1', PG_CONNECTION_TIMEOUT_MS: '120000', PG_STATEMENT_TIMEOUT_MS: '60000', DRAWER_OUTPUT: out,
 PERF_CARD_COUNT: '3000', PERF_BOARD_COUNT: '20', PERF_WORKSPACE_COUNT: '3', PERF_MEMBER_COUNT: '20' };
symlinkSync(`${root}/apps/api/drizzle`, `${scratch}/drizzle`);
function run(path, name) {
 const result = spawnSync(process.execPath, ['--import', `${root}/apps/api/node_modules/tsx/dist/loader.mjs`, `${root}/${path}`], { cwd: scratch, env, encoding: 'utf8', maxBuffer: 20*1024*1024 });
 writeFileSync(`${out}/${name}.log`, result.stdout + result.stderr);
 if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr.slice(-4000)}`);
 console.log(result.stdout);
}
let created = false;
try {
 docker(['createdb', '-U', 'kanera', database]); created = true;
 run('apps/api/src/scripts/migrate.ts', 'migrate');
 run('apps/api/src/scripts/seed-web-performance.ts', 'seed');
 writeFileSync(`${out}/environment.json`, JSON.stringify({ node: process.version, cpu: cpus()[0].model, postgres: docker(['psql','-U','kanera','-d',database,'-Atc','select version()']), commit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), pool: 1, parallelWorkersPerGather: 0, notificationCount: Number(process.env.DRAWER_NOTIFICATIONS ?? 5000), worktree: execFileSync('git',['status','--short'],{cwd:root,encoding:'utf8'}) }, null, 2));
 mkdirSync(`${out}/harness`, {recursive:true});
 for (const file of ['drawer-queries.mjs','drawer-queries.mts','drawer-query-variants.mjs']) cpSync(`${root}/benchmarks/api/${file}`,`${out}/harness/${file}`);
 run('benchmarks/api/drawer-queries.mts', 'benchmark');
} finally {
 if (created) docker(['dropdb','-U','kanera','--force',database]);
 rmSync(scratch, {recursive:true,force:true});
}
