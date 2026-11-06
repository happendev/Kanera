// Prometheus target staleness and rollout overlap cannot be exercised by the app's E2E suite.
// Check the actual provisioned query against overlap, failed scrapes, DNS disappearance, long
// outages, and intentional scale changes. Requires Docker; no application services are started.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = await readFile(new URL('../docker/monitoring/grafana/provisioning/alerting/rules.yml', import.meta.url), 'utf8');
const rule = source.split('      - uid: kanera-target-down\n')[1].split('          - refId: C')[0];
const template = rule.split('              expr: |\n')[1].split('\n').map((line) => line.slice(16)).join('\n').trim();
assert.ok(template.includes('__API_REPLICAS__'));
const render = (api, publicApi) => template.replaceAll('__API_REPLICAS__', String(api)).replaceAll('__PUBLIC_API_REPLICAS__', String(publicApi));
const series = (job, instance, values) => ({ series: `up{job="${job}",instance="${instance}"}`, values });
const healthy = [series('kanera-api', 'a', '1+0x90'), series('kanera-api', 'b', '1+0x90'), series('kanera-api', 'c', '1+0x90'), series('kanera-public-api', 'p', '1+0x90'), series('kanera-worker', 'w', '1+0x90')];
const results = (api, publicApi = 0, worker = 0) => [
  { labels: '{job="kanera-api"}', value: api },
  { labels: '{job="kanera-public-api"}', value: publicApi },
  { labels: '{job="kanera-worker"}', value: worker },
];
const check = (expr, evalTime, expected) => ({ expr, eval_time: evalTime, exp_samples: expected });
const expr = render(3, 1);
const fixture = {
  evaluation_interval: '1m',
  tests: [
    { name: 'rollout overlap returns to three without a missing replica', interval: '1m', input_series: [...healthy, series('kanera-api', 'old', '1+0x3 stale')], promql_expr_test: [check(expr, '2m', results(-1)), check(expr, '5m', results(0))] },
    { name: 'a failed scrape still reports a missing replica', interval: '1m', input_series: healthy.map((s, i) => i === 2 ? { ...s, values: '1 0+0x89' } : s), promql_expr_test: [check(expr, '5m', results(1))] },
    { name: 'DNS disappearance still reports a missing replica', interval: '1m', input_series: healthy.map((s, i) => i === 2 ? { ...s, values: '1 stale' } : s), promql_expr_test: [check(expr, '5m', results(1)), check(expr, '80m', results(1))] },
    { name: 'all targets absent, even beyond the former peak window', interval: '1m', input_series: [], promql_expr_test: [check(expr, '80m', results(3, 1, 1))] },
    { name: 'public API and worker outages retain their job labels', interval: '1m', input_series: healthy.slice(0, 3), promql_expr_test: [check(expr, '5m', results(0, 1, 1))] },
    { name: 'intentional scale down changes the desired count immediately', interval: '1m', input_series: healthy.filter((_, i) => i !== 2), promql_expr_test: [check(render(2, 1), '5m', results(0))] },
    { name: 'public API scaling and intentional zero replicas', interval: '1m', input_series: healthy.slice(3), promql_expr_test: [check(render(0, 2), '5m', results(0, 1))] },
  ],
};
const dir = await mkdtemp(join(tmpdir(), 'kanera-replica-alert-'));
try {
  await chmod(dir, 0o755);
  await writeFile(join(dir, 'tests.yml'), JSON.stringify(fixture));
  const run = spawnSync('docker', ['run', '--rm', '--entrypoint', '/bin/promtool', '-v', `${dir}:/tests:ro,Z`, 'prom/prometheus:v3.15.1', 'test', 'rules', '/tests/tests.yml'], { stdio: 'inherit' });
  assert.equal(run.status, 0, 'Prometheus replica alert regressions');
} finally {
  await rm(dir, { recursive: true, force: true });
}
