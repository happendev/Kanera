// Read-only counters shared by before/after copies; SQL bind values are never captured.
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
const require = createRequire(`${process.env.HYDRATION_ROOT}/apps/api/package.json`);
const { Client } = require(`${process.env.HYDRATION_ROOT}/apps/api/node_modules/pg`);
const original = Client.prototype.query;
const scope = new AsyncLocalStorage();
let queries = new Map(), stages = new Map(), transactions = [], activeTransactions = new WeakMap();
globalThis.__systemMeasure = async (name, task) => {
  const record={name,ms:0,queries:0,queryMs:0}, start=performance.now();
  try { return await scope.run(record, task); }
  finally { record.ms=performance.now()-start; const rows=stages.get(name)??[]; rows.push(record); stages.set(name,rows); }
};
globalThis.__mixedDiagnostics = {
  reset() { queries = new Map(); stages = new Map(); transactions=[]; activeTransactions=new WeakMap(); if(globalThis.__systemFanout) { globalThis.__systemFanout.waitMs=[]; globalThis.__systemFanout.totalMs=[]; } },
  snapshot() { return { queries: [...queries].map(([sql,record])=>({sql,...record})).sort((a,b)=>b.count-a.count), stages: Object.fromEntries(stages), transactions, fanout: globalThis.__systemFanout ? { pending: globalThis.__systemFanout.pending.size, oldestAgeMs: Math.max(0,...[...globalThis.__systemFanout.pending.values()].map(at=>Date.now()-at)), waitMs: globalThis.__systemFanout.waitMs, totalMs: globalThis.__systemFanout.totalMs } : null }; },
};
Client.prototype.query = function (...args) {
  const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text;
  if (!statement) return original.apply(this,args);
  const shape=statement.replace(/\$\d+/g,'?').replace(/\s+/g,' ').slice(0,450), start=performance.now(), stage=scope.getStore();
  const record=queries.get(shape)??{count:0,totalMs:0,maxMs:0,errors:0}; record.count++; queries.set(shape,record);
  if(/^begin\b/i.test(statement)) activeTransactions.set(this,{start,queries:0,queryMs:0});
  const tx=activeTransactions.get(this);
  const finish=(failed)=>{
    const ms=performance.now()-start; record.totalMs+=ms; record.maxMs=Math.max(record.maxMs,ms); if(failed) record.errors++;
    if(stage) { stage.queries++; stage.queryMs+=ms; }
    if(tx) { tx.queries++; tx.queryMs+=ms; }
    if(/^(commit|rollback)\b/i.test(statement) && tx) { transactions.push({ms:performance.now()-tx.start,queries:tx.queries,queryMs:tx.queryMs,rollback:/^rollback/i.test(statement)}); activeTransactions.delete(this); }
  };
  const callback=args.at(-1);
  if(typeof callback==='function') { args[args.length-1]=function(error,...rest){finish(Boolean(error)); return callback.call(this,error,...rest);}; return original.apply(this,args); }
  try { const result=original.apply(this,args); if(result?.then) return result.then(value=>{finish(false);return value;},error=>{finish(true);throw error;}); return result; }
  catch(error) { finish(true); throw error; }
};
