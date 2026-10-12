// Instrument only disposable copies. No benchmark routes or transport exceptions enter product code.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
export function instrumentSystemSource(source) {
  function edit(file, from, to) {
    const path = `${source}/${file}`, text = readFileSync(path, 'utf8');
    assert.ok(text.includes(from), `System benchmark anchor missing: ${file}: ${from}`);
    writeFileSync(path, text.replace(from, to));
  }
  for (const name of ['applyTriggeredAutomations', 'applyAutomationActionsAndRecordStats', 'emitAutomationEffectsInScope']) {
    const path = `${source}/lib/automations.ts`, content = readFileSync(path, 'utf8');
    assert.ok(content.includes(`async function ${name}(`));
    writeFileSync(path, content.replace(`async function ${name}(`, `async function ${name}Impl(`) + `\nasync function ${name}(...args: Parameters<typeof ${name}Impl>) { return globalThis.__systemMeasure('automation.${name}', () => ${name}Impl(...args)); }\n`);
  }
  edit('modules/cards/routes.ts', 'const { position, finalPosition, finalListId, rebalancedPositions, laneRebalanced, activity, completedCard, completionActivity, automationEffects, noOp } = await db.transaction(async (tx) => {', "const { position, finalPosition, finalListId, rebalancedPositions, laneRebalanced, activity, completedCard, completionActivity, automationEffects, noOp } = await globalThis.__systemMeasure('move.transaction', () => db.transaction(async (tx) => {");
  edit('modules/cards/routes.ts', '    });\n\n    if (noOp) return', '    }));\n\n    if (noOp) return');
  edit('lib/sweep-scheduler.ts', '  return {\n    stop:', '  (globalThis.__systemTriggers ??= {})[name] = trigger;\n  return {\n    stop:');
  if (readFileSync(`${source}/lib/notifications.ts`, 'utf8').includes('const pending = fanoutTail')) {
  edit('lib/notifications.ts', '  const pending = fanoutTail', `  const benchmarkQueuedAt = Date.now(), benchmarkMarker = Symbol();
  const benchmarkFanout = globalThis.__systemFanout ??= { pending: new Map(), waitMs: [], totalMs: [] };
  benchmarkFanout.pending.set(benchmarkMarker, benchmarkQueuedAt);
  const pending = fanoutTail`);
  edit('lib/notifications.ts', '.then(() => runWithNotificationFanoutRetry(', '.then(() => (benchmarkFanout.waitMs.push(Date.now() - benchmarkQueuedAt), runWithNotificationFanoutRetry(');
  edit('lib/notifications.ts', 'fanoutNotificationsForActivity(activity, options)))', 'fanoutNotificationsForActivity(activity, options))))');
  edit('lib/notifications.ts', '.finally(() => pendingFanout.delete(pending))', '.finally(() => { pendingFanout.delete(pending); benchmarkFanout.pending.delete(benchmarkMarker); benchmarkFanout.totalMs.push(Date.now() - benchmarkQueuedAt); })');
  } else {
    edit('lib/keyed-task-queue.ts', 'enqueue(key: string, value: T): void { pending.set(key, value); drain(); }', `enqueue(key: string, value: T): void {
      const bench = globalThis.__systemFanout ??= { pending: new Map(), waitMs: [], totalMs: [] };
      const previous = pending.get(key); if (previous) bench.pending.delete(previous.__benchmarkMarker);
      value.__benchmarkMarker = Symbol(); value.__benchmarkQueuedAt = Date.now();
      bench.pending.set(value.__benchmarkMarker, value.__benchmarkQueuedAt);
      pending.set(key, value); drain();
    }`);
    edit('lib/keyed-task-queue.ts', '.then(() => run(value))', '.then(() => { globalThis.__systemFanout.waitMs.push(Date.now() - value.__benchmarkQueuedAt); return run(value); })');
    edit('lib/keyed-task-queue.ts', '        active.delete(next);', '        globalThis.__systemFanout.pending.delete(value.__benchmarkMarker); globalThis.__systemFanout.totalMs.push(Date.now() - value.__benchmarkQueuedAt);\n        active.delete(next);');
  }
  edit('worker-server.ts', '  registerMetrics(app);', `  registerMetrics(app);
  app.post('/benchmark/trigger/:name', async (req) => {
    const trigger = globalThis.__systemTriggers[req.params.name];
    if (!trigger) throw new Error('Unknown benchmark scheduler');
    trigger(); return { ok: true };
  });
  app.post('/benchmark/digest', async () => {
    const { runDailyDigestSweep } = await import('./lib/daily-digest.js');
    const now = new Date(); now.setUTCHours(8, 0, 0, 0);
    return { enqueued: await runDailyDigestSweep({ db, log: app.log, webOrigin: 'http://127.0.0.1:3180', resolveSmtpConfig: async () => null }, now) };
  });
  app.post('/benchmark/email', async () => {
    const { runEmailQueueSweep } = await import('./lib/email-queue.js');
    return { processed: await runEmailQueueSweep({ db, log: app.log, resolveSmtpConfig: async () => ({ host: '127.0.0.1', port: 3194, security: 'none', fromEmail: 'bench@example.test' }) }) };
  });`);
  // Workspace webhooks disallow private hosts in production. Only this exact local receiver is
  // allowed in the disposable source; signature construction, HTTP, retries and queue logic run.
  edit('lib/ssrf.ts', 'export async function assertResolvedHostAllowed(url: string): Promise<void> {', "export async function assertResolvedHostAllowed(url: string): Promise<void> {\n  if (new URL(url).origin === 'http://127.0.0.1:3195') return;");
}
