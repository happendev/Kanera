#!/usr/bin/env node
/** Summarize a V8 CPU sample profile; categories are stack-based heuristics, not instrumented timers. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const out = resolve(process.env.HYDRATION_OUTPUT ?? `${import.meta.dirname}/results/event-loop-20261012`);
const path = process.argv[2] ?? `${out}/baseline-full-1-r0.json.cpuprofile`;
const profile = JSON.parse(readFileSync(path, 'utf8'));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
const self = new Map(), inclusive = new Map(), categories = new Map(), files = new Map();
const stackFor = (id) => { const stack = []; while (id !== undefined) { stack.push(nodes.get(id)); id = parents.get(id); } return stack; };
function classify(stack) {
  const frames = stack.map((node) => `${node?.callFrame.url ?? ''}#${node?.callFrame.functionName ?? ''}`);
  const own = stack[0]?.callFrame.functionName ?? '';
  if (own === '(idle)') return 'idle';
  if (own === '(garbage collector)') return 'garbage collection';
  if (frames.some(frame => /node:inspector/.test(frame))) return 'profiler control overhead';
  if (frames.some(frame => /postgres-array|pg-protocol|pg\/lib\/(?:result|type-overrides)|pg-types/.test(frame))) return 'PostgreSQL receive/decode';
  if (frames.some(frame => /media-keys|attachment-media/.test(frame))) return 'media URL work';
  if (frames.some(frame => /#(?:compactCardSummary|compactCardCustomFieldValue|toWireCardSummary)$/.test(frame))) return 'card summary mapping/compaction';
  if (frames.some(frame => /fastify\/lib\/reply.*#(?:serialize|preSerializationHookEnd|onSendHook)$|#defaultSerializer$/.test(frame))) return 'HTTP response serialization/send';
  if (frames.some(frame => /drizzle-orm|board-hydration-query/.test(frame))) return 'SQL construction/ORM/query transform';
  if (frames.some(frame => /node:(?:buffer|internal\/buffer|_http_outgoing|internal\/stream|net)|pg\/lib\/connection/.test(frame))) return 'buffer/socket/stream';
  if (frames.some(frame => /fastify|find-my-way|fast-jwt|fastify-request-context|prom-client/.test(frame))) return 'HTTP framework/auth/metrics';
  if (own === '(program)') return 'unattributed V8/native';
  return 'other';
}
let sampledUs = 0;
for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
  const id = profile.samples[index], delta = profile.timeDeltas[index] ?? 0;
  sampledUs += delta;
  self.set(id, (self.get(id) ?? 0) + delta);
  const stack = stackFor(id);
  for (const node of stack) if (node) inclusive.set(node.id, (inclusive.get(node.id) ?? 0) + delta);
  const category = classify(stack);
  categories.set(category, (categories.get(category) ?? 0) + delta);
  const file = nodes.get(id)?.callFrame.url || `[${nodes.get(id)?.callFrame.functionName ?? 'unknown'}]`;
  files.set(file, (files.get(file) ?? 0) + delta);
}
const activeUs = sampledUs - (categories.get('idle') ?? 0) - (categories.get('profiler control overhead') ?? 0);
const rounded = number => Math.round(number * 100) / 100;
const measures = (us, excluded = false) => ({ sampleMs: rounded(us / 1000), percentOfWallSamples: rounded(us * 100 / sampledUs), percentOfActiveWorkSamples: excluded || us > activeUs ? null : rounded(us * 100 / activeUs) });
function topFunctions(metric) {
  const groups = new Map();
  for (const [id, us] of metric) {
    const frame = nodes.get(id).callFrame;
    const key = `${frame.url}:${frame.lineNumber}:${frame.functionName}`;
    const item = groups.get(key) ?? { function: frame.functionName || '(anonymous)', file: frame.url, line: frame.lineNumber + 1, us: 0 };
    item.us += us; groups.set(key, item);
  }
  return [...groups.values()].sort((a,b) => b.us-a.us).slice(0, 50).map(({ us, ...item }) => ({ ...item, ...measures(us, item.function === '(idle)' || item.file === 'node:inspector') }));
}
const report = {
  profile: path, durationMs: rounded((profile.endTime-profile.startTime)/1000), samples: profile.samples.length,
  sampledMs: rounded(sampledUs/1000), activeWorkSampledMs: rounded(activeUs/1000),
  method: 'V8 sampling profile with each timeDelta attributed to its sample; idle and inspector control overhead removed only for active-work percentages. Categories use nearest recognizable workload on the sampled call stack. Inclusive times overlap and must not be summed. Native JSON/buffer work may be charged to its JS caller. CPU profiles have sampling overhead and are diagnostic; compare unprofiled runs for capacity and latency.',
  categories: [...categories.entries()].sort((a,b) => b[1]-a[1]).map(([category,us]) => ({ category, ...measures(us, ['idle', 'profiler control overhead'].includes(category)) })),
  topSelfFunctions: topFunctions(self), topInclusiveFunctions: topFunctions(inclusive),
  topSelfFiles: [...files.entries()].sort((a,b) => b[1]-a[1]).slice(0,30).map(([file,us]) => ({file,...measures(us, file === '[(idle)]' || file === 'node:inspector')})),
};
const output = process.argv[3] ?? `${out}/cpu-profile-summary.json`;
writeFileSync(output, JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,categories:report.categories,topSelf:report.topSelfFunctions.slice(0,15)},null,2));
