// Heap proof for the actual before/after resolver functions. UUID processing must retain no
// per-card promises; human references must stay bounded. No network, database or user data.
// node --expose-gc benchmarks/performance/sdk-memory.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const ts = createRequire(path.join(root, 'apps/cli/package.json'))('typescript');
const sourcePath = 'packages/sdk/src/card-reference.ts';
if (process.argv[2] === '--sample') {
  assert.ok(global.gc, 'run Node with --expose-gc');
  const ref = process.argv[3];
  const kind = process.argv[4];
  const source = ref === 'current' ? fs.readFileSync(path.join(root, sourcePath), 'utf8') : execFileSync('git', ['show', ref + ':' + sourcePath], { cwd: root, encoding: 'utf8' });
  const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(parsed)).join('\n');
  const code = ts.transpileModule(declarations, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ exports: {}, URL, Promise, Map, Set, KaneraApiError: Error });
  vm.runInContext(code, context);
  let calls = 0;
  const resolver = context.exports.createCardReferenceResolver({ get: async () => { calls++; return { id: '00000000-0000-4000-8000-000000000001' }; } });
  global.auditResolver = resolver;
  const memory = () => { global.gc(); return process.memoryUsage().heapUsed; };
  const baseline = memory();
  (async () => {
    for (let n = 0; n < 100_000; n++) {
      const reference = kind === 'uuid' ? `00000000-0000-4000-8000-${String(n).padStart(12,'0')}` : `https://kanera.example/o/FC6CC2BA92EE24ED/c/MKT-${n + 1}`;
      await resolver(reference);
    }
    const retainedBytes = memory() - baseline;
    if (kind === 'uuid') assert.equal(calls, 0);
    console.log(JSON.stringify({ source: ref, kind, references: 100000, retainedBytes, lookupRequests: calls }));
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const baseline = process.env.KANERA_PERF_REF ?? '59147bba';
  const results = [];
  for (const ref of [baseline, 'current']) for (const kind of ['uuid','key']) {
    const run = spawnSync(process.execPath, ['--expose-gc', __filename, '--sample', ref, kind], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    results.push(JSON.parse(run.stdout));
  }
  const result = { baseline, results };
  if (process.env.KANERA_PERF_OUTPUT) fs.writeFileSync(process.env.KANERA_PERF_OUTPUT, JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}
