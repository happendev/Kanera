// Benchmark-only instrumentation: never imported by application entry points.
import { createRequire } from 'node:module';
import http from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { transformSummaryQuery, transformSummaryResult } from './board-hydration-query.mjs';

const require = createRequire(`${process.env.HYDRATION_ROOT}/apps/api/package.json`);
// Use the API's installed dependency; the root benchmark package does not own pg.
const pg = require(`${process.env.HYDRATION_ROOT}/apps/api/node_modules/pg`);
let summaryQuery;
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const query = args[0];
  const text = typeof query === 'string' ? query : query?.text;
  const variant = process.env.HYDRATION_VARIANT === 'yield100' ? 'baseline' : process.env.HYDRATION_VARIANT;
  if (!text?.includes('with filtered_cards as materialized')) return originalQuery.apply(this, args);
  summaryQuery ??= { text, values: Array.isArray(args[1]) ? args[1] : query?.values ?? [] };
  if (typeof query === 'string') args[0] = transformSummaryQuery(query, variant);
  else args[0] = { ...query, text: transformSummaryQuery(text, variant) };
  const callbackIndex = args.findLastIndex(arg => typeof arg === 'function');
  if (callbackIndex >= 0) {
    const callback = args[callbackIndex];
    args[callbackIndex] = (error, result) => callback(error, error ? result : transformSummaryResult(result, variant));
    return originalQuery.apply(this, args);
  }
  return originalQuery.apply(this, args).then(result => transformSummaryResult(result, variant));
};

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let cpu, wall, elu, session;
const post = (method) => new Promise((resolve, reject) => session.post(method, (error, value) => error ? reject(error) : resolve(value)));
http.createServer(async (req, res) => {
  try {
    let data;
    if (req.url.startsWith('/reset')) {
      if (req.url.includes('profile=1')) {
        session = new Session(); session.connect();
        await post('Profiler.enable'); await post('Profiler.start');
      }
      loop.reset(); cpu = process.cpuUsage(); wall = performance.now(); elu = performance.eventLoopUtilization();
      data = { ok: true };
    } else if (req.url === '/snapshot') {
      const cpuDelta = process.cpuUsage(cpu);
      data = { elapsedMs: performance.now() - wall, cpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
        elu: performance.eventLoopUtilization(elu), rssMiB: process.memoryUsage().rss / 1048576,
        loop: { meanMs: loop.mean / 1e6, p95Ms: loop.percentile(95) / 1e6, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 } };
      if (session) { data.profile = (await post('Profiler.stop')).profile; session.disconnect(); session = undefined; }
    } else if (req.url === '/query') data = summaryQuery ?? null;
    else { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
}).listen(Number(process.env.HYDRATION_CONTROL_PORT), '127.0.0.1');
