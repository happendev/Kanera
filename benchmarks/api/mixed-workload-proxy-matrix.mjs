#!/usr/bin/env node
// Interleave conditions instead of comparing separately timed groups on a shared host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.env.MIXED_OUTPUT ?? `${root}/benchmarks/api/results/proxy-matrix-${Date.now()}`);
const rounds = Number(process.env.MIXED_MATRIX_ROUNDS ?? 3);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
const conditions = {
  gzip5: { MIXED_PROXY_WORKERS: '1', MIXED_GZIP_LEVEL: '5', MIXED_DIRECT: '0' },
  gzip1: { MIXED_PROXY_WORKERS: '1', MIXED_GZIP_LEVEL: '1', MIXED_DIRECT: '0' },
  workers2: { MIXED_PROXY_WORKERS: '2', MIXED_GZIP_LEVEL: '5', MIXED_DIRECT: '0' },
  gzip0: { MIXED_PROXY_WORKERS: '1', MIXED_GZIP_LEVEL: '0', MIXED_DIRECT: '0' },
  direct: { MIXED_PROXY_WORKERS: '1', MIXED_GZIP_LEVEL: '0', MIXED_DIRECT: '1' },
};
const selected = (process.env.MIXED_MATRIX_CASES ?? Object.keys(conditions).join(',')).split(',');
assert.ok(selected.length && new Set(selected).size === selected.length && selected.every(name => conditions[name]));
assert.ok(!existsSync(output), 'Use a fresh MIXED_OUTPUT directory; existing results are never overwritten');
mkdirSync(output, { recursive: true });
const schedule = [];
for (let round = 1; round <= rounds; round++) {
  // Rotate and reverse so one condition is not always tested first or after the same neighbor.
  const shift = (round-1) % selected.length;
  const order = [...selected.slice(shift), ...selected.slice(0,shift)];
  if (round % 2 === 0) order.reverse();
  for (const name of order) schedule.push({ name, round, settings: conditions[name], directory: `${output}/${name}-r${round}` });
}
writeFileSync(`${output}/matrix.json`, JSON.stringify({ rounds, selected, schedule, proxyCpuQuota: 2, nodeTopology: 'Two app APIs, public API, worker; unchanged host scheduling and pool sizes in every condition. Proxy CPU quota is fixed at two cores for both one- and two-worker cases.', durationMs: process.env.MIXED_DURATION_MS ?? 30000, boardRps: process.env.MIXED_BOARD_RPS ?? 0 }, null, 2));
let current;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { current?.kill(signal); process.exitCode = 130; });
for (const item of schedule) {
  if (process.exitCode) break;
  console.log(`Running ${item.name} round ${item.round}/${rounds}`);
  const fd = openSync(`${output}/${item.name}-r${item.round}.log`, 'w');
  current = spawn(process.execPath, [`${root}/benchmarks/api/mixed-workload.mjs`], {
    cwd: root, env: { ...process.env, MIXED_ROUNDS: '1', MIXED_VARIANTS: 'baseline', MIXED_DURATION_MS: process.env.MIXED_DURATION_MS ?? '30000', MIXED_DIAGNOSTICS: '1', MIXED_FIXTURE_FILE: `${output}/fixture.dump`, ...item.settings, MIXED_OUTPUT: item.directory }, stdio: ['ignore',fd,fd],
  }); closeSync(fd);
  const [code] = await once(current,'exit');
  if (process.exitCode) break;
  assert.equal(code,0, `Failed ${item.name}; see ${output}/${item.name}-r${item.round}.log`);
}
