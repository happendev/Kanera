import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, sep } from 'node:path';

// Refresh only from a complete, successful, unsharded run. Partial reports would quietly bias
// balancing toward whichever shard happened to run last.
const reportPath = process.argv[2];
if (!reportPath) throw new Error('Usage: node scripts/update-e2e-timings.mjs e2e/artifacts/<run>/results.json');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (report.stats.unexpected || report.stats.flaky || report.stats.skipped || report.config.shard
  || report.config.projects.some(project => project.repeatEach !== 1)) {
  throw new Error('Timing refresh requires a successful, unsharded, unrepeated run with no skipped/flaky tests');
}
const files = {};
function visit(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      if (test.projectName !== 'behavior') continue;
      if (test.results.length !== 1 || test.results[0].status !== 'passed') throw new Error('Expected one passing result per test');
      files[spec.file] = (files[spec.file] ?? 0) + test.results[0].duration;
    }
  }
  for (const child of suite.suites ?? []) visit(child);
}
for (const suite of report.suites) visit(suite);
const expected = globSync('**/*.spec.ts', { cwd: new URL('../e2e/', import.meta.url), exclude: ['artifacts/**', 'node_modules/**'] })
  .filter(file => !basename(file).startsWith('seed-')).map(file => file.split(sep).join('/')).sort();
if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(expected)) throw new Error('Report must cover every current behavior spec');
writeFileSync(new URL('../e2e/timings.json', import.meta.url), JSON.stringify({
  measuredAt: report.stats.startTime,
  files: Object.fromEntries(expected.map((file) => [file, files[file]])),
}, null, 2) + '\n');
console.log(`Updated timings for ${expected.length} behavior files`);
