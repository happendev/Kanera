#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = resolve(process.argv[2]);
const runs = readdirSync(directory).filter(name=>/^(before|after)-r\d+\.json$/.test(name)).map(name=>JSON.parse(readFileSync(`${directory}/${name}`)));
const median = xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const percentile = (xs,p)=>[...xs].sort((a,b)=>a-b)[Math.floor((xs.length-1)*p)] ?? 0;
const phase = (run,name)=>run.phases.find(p=>p.name===name);
const server = (p,name)=>p.servers.find(s=>s.name===name);
const cpu = (p,names)=>p.servers.filter(s=>names.includes(s.name)).reduce((n,s)=>n+s.cpuMs,0);
const queries = (p,names,match)=>p.servers.filter(s=>names.includes(s.name)).flatMap(s=>s.diagnostics.queries).filter(q=>match(q.sql)).reduce((n,q)=>n+q.count,0);
const measurements = [
  ['myFirstPageP95Ms',r=>phase(r,'global-work').firstPages.my.first.p95],
  ['teamFirstPageP95Ms',r=>phase(r,'global-work').firstPages.team.first.p95],
  ['my3000CardWalkMs',r=>phase(r,'global-work').firstPages.my.walk.p50],
  ['team3000CardWalkMs',r=>phase(r,'global-work').firstPages.team.walk.p50],
  ['globalWorkApiCpuMsPerPage',r=>cpu(phase(r,'global-work'),['app0','app1'])/160],
  ['notificationRequestToObserverP95Ms',r=>phase(r,'notification-fanout').requestToObserverMs.p95],
  ['notificationBurstLastObserverMs',r=>phase(r,'notification-fanout').burstToObserverMs.max],
  ['notificationPublicCpuMs',r=>cpu(phase(r,'notification-fanout'),['public'])],
  ['notificationPublicSqlQueries',r=>queries(phase(r,'notification-fanout'),['public'],()=>true)],
  ['notificationDirectOutboxInserts',r=>queries(phase(r,'notification-fanout'),['public'],q=>q.startsWith('insert into "direct_realtime_outbox"'))],
  ['notificationQueueWaitP95Ms',r=>percentile(server(phase(r,'notification-fanout'),'public').diagnostics.fanout.waitMs,.95)],
  ['automationMoveHttpP95Ms',r=>percentile(phase(r,'triggered-automations').requests.filter(q=>q.path.endsWith('/move')).map(q=>q.ms),.95)],
  ['automationTemplateQueries',r=>queries(phase(r,'triggered-automations'),['app0','app1'],q=>q.startsWith('select "list"."id", "list"."name", "board"."name", "workspace"."name"'))],
  ['email100CompletionMs',r=>phase(r,'competing-background-jobs').emailMs],
  ['emailQueueAgeP95Ms',r=>phase(r,'competing-background-jobs').emailQueueAgeMs.p95],
  ['competingJobsCompletionMs',r=>phase(r,'competing-background-jobs').elapsedMs],
  ['competingJobsWorkerLoopP99Ms',r=>server(phase(r,'competing-background-jobs'),'worker').loop.p99Ms],
  ['competingJobsMyCardsP95Ms',r=>phase(r,'competing-background-jobs').readLatency.my.p95],
  ['competingJobsTeamCardsP95Ms',r=>phase(r,'competing-background-jobs').readLatency.team.p95],
  ['competingJobsBoardP95Ms',r=>phase(r,'competing-background-jobs').readLatency.board.p95],
  ['competingJobsHealthP95Ms',r=>phase(r,'competing-background-jobs').readLatency.health.p95],
  ['retryRecoveryMs',r=>phase(r,'delivery-retry-recovery').elapsedMs],
  ['digestGenerationAndDedupeMs',r=>phase(r,'digest-generation').elapsedMs],
  ['digestWorkerCpuMs',r=>cpu(phase(r,'digest-generation'),['worker'])],
  ['digestWorkerLoopMaxMs',r=>server(phase(r,'digest-generation'),'worker').loop.maxMs],
  ['retentionWorkerCpuMs',r=>cpu(phase(r,'retention-backlog'),['worker'])],
  ['retentionWorkerLoopMaxMs',r=>server(phase(r,'retention-backlog'),'worker').loop.maxMs],
];
const focused = runs.every(r=>r.phases.length===3);
const selected = focused ? measurements.slice(0,13) : measurements;
if(focused) {
  selected.push(
    ['globalWorkRequests',r=>phase(r,'global-work').requests.length],
    ['globalWorkApiCpuMs',r=>cpu(phase(r,'global-work'),['app0','app1'])],
    ['globalWorkResponseMiB',r=>phase(r,'global-work').requests.reduce((n,q)=>n+q.bytes,0)/1024**2],
    ['globalWorkAppLoopMaxMs',r=>Math.max(...phase(r,'global-work').servers.filter(s=>['app0','app1'].includes(s.name)).map(s=>s.loop.maxMs))],
  );
  for(const name of ['move.transaction','automation.applyTriggeredAutomations','automation.applyAutomationActionsAndRecordStats','automation.emitAutomationEffectsInScope']) {
    selected.push([`${name}.p50Ms`,r=>percentile(phase(r,'triggered-automations').servers.flatMap(s=>s.diagnostics.stages?.[name]??[]).map(s=>s.ms),.5)]);
    selected.push([`${name}.p95Ms`,r=>percentile(phase(r,'triggered-automations').servers.flatMap(s=>s.diagnostics.stages?.[name]??[]).map(s=>s.ms),.95)]);
  }
}
assert.ok(runs.length>=2);
for(const r of runs) {
  assert.deepEqual(r.correctness.errors,[]);
  assert.deepEqual(r.outboxPending,{board:0,direct:0});
  assert.equal(r.phases.length,focused?3:7);
  assert.ok(r.phases.every(p=>p.servers.every(s=>(s.diagnostics.fanout?.pending ?? 0)===0)),'Fanout remained pending at a phase boundary');
}
const before=runs.filter(r=>r.label.startsWith('before')), after=runs.filter(r=>r.label.startsWith('after'));
assert.equal(before.length,after.length);
const rows=selected.map(([metric,measure])=>{
  const previous=before.map(measure), current=after.map(measure);
  assert.ok([...previous,...current].every(Number.isFinite),`Missing ${metric}`);
  const b=median(previous), a=median(current);
  return {metric,before:b,after:a,changePercent:b?(a/b-1)*100:0,beforeSamples:previous,afterSamples:current};
});
const summary={ rounds:before.length,members:runs[0].fixture.recipients,method:'Median of per-run metrics. Global Work uses the same 40 first-page requests plus four complete 3,000-card walks. CPU/160 is per 100 card-equivalents when page sizes differ. Other phases use fixed write/job counts with rate-limited reads until completion; read counts differ when jobs finish sooner. No production capacity, browser, TLS/WAN or real-provider claim.', correctness:runs.map(r=>({label:r.label,...r.correctness})),rows };
writeFileSync(`${directory}/summary.json`,JSON.stringify(summary,null,2));
console.log(`Rounds: ${summary.rounds}; members: ${summary.members}`);
for(const row of rows) console.log(`${row.metric.padEnd(38)} ${row.before.toFixed(2).padStart(10)} -> ${row.after.toFixed(2).padStart(10)} (${row.changePercent.toFixed(1)}%)`);
