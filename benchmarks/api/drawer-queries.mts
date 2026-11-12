// Benchmarks actual module operations with one DB connection and sequential requests.
// Experimental rewrites live only here; no application or migration files are changed.
import assert from 'node:assert/strict';
import {fixedRecipient, splitActivity, cardVisibilityExists} from './drawer-query-variants.mjs';
import { createRequire } from 'node:module';
import { writeFileSync, appendFileSync } from 'node:fs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const pg = require('pg');
const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.hostname, '127.0.0.1');
assert.match(url.pathname, /^\/kanera_drawer_\d+$/);
const out = process.env.DRAWER_OUTPUT!;
let captured: {text:string;values:unknown[]}[] = [];
let recording = false;
const original = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args: any[]) {
 const query = args[0];
 const text = typeof query === 'string' ? query : query.text;
 const values = Array.isArray(args[1]) ? args[1] : query.values ?? [];
 if(recording) {appendFileSync(`${out}/query-starts.jsonl`, JSON.stringify({text,values})+'\n');captured.push({text,values});}
 return original.apply(this,args);
};
const {db,pool} = await import('../../apps/api/src/db.js');
const {loadCardDetail} = await import('../../apps/api/src/modules/cards/card-queries.js');
const {loadCardFeedPage} = await import('../../apps/api/src/modules/comments/card-feed.js');
const {assertCardAccess} = await import('../../apps/api/src/lib/access.js');
const notifications = await import('../../apps/api/src/modules/notifications/notification-feed.js');
const {countUnreadNotifications} = await import('../../apps/api/src/lib/notifications.js');
const notificationCount = Number(process.env.DRAWER_NOTIFICATIONS ?? 5000);
assert.ok([5000,50000].includes(notificationCount));
const userId = '70000000-0000-4000-8000-000000000010';
const clientId = '70000000-0000-4000-8000-000000000001';
const boardId = '70000000-0000-4000-8000-000000000200';
try {
 await pool.query(`set max_parallel_workers_per_gather = 0`);
 // Fixture-only bulk loading: references come from existing seeded rows. Restore triggers before measuring.
 await pool.query('set session_replication_role = replica');
 await pool.query(`create temporary table bench_cards as select id, board_id, workspace_id, list_id, row_number() over(order by id) as n from card where board_id = $1`,[boardId]);
 await pool.query(`insert into activity_event (board_id,client_id,workspace_id,actor_id,entity_type,entity_id,action,payload,feed_visible,created_at)
 select c.board_id,$1,c.workspace_id,$2,
 case when g%7=0 then 'comment' else 'card' end,c.id,'updated',
 case when g%3=0 then jsonb_build_object('cardId',c.id::text,'title',repeat('History ',20)) else jsonb_build_object('title',repeat('History ',20)) end,
 g%13<>0, now()-g*interval '10 seconds'
 from generate_series(1,300000) g join bench_cards c on c.n=1+(g%3000)`,[clientId,userId]);
 await pool.query(`insert into notification(user_id,client_id,activity_id,card_id,list_id,board_id,workspace_id,reason,read_at,created_at)
 select $1,$2,a.id,c.id,c.list_id,c.board_id,c.workspace_id,
 case when row_number() over(order by a.created_at)%5=0 then 'mentioned' else 'watching' end,
 case when row_number() over(order by a.created_at)%10=0 then null else now() end,a.created_at
 from activity_event a join bench_cards c on c.id=a.entity_id order by a.created_at desc limit ${notificationCount}`,[userId,clientId]);
 await pool.query('set session_replication_role = origin');
 await pool.query('analyze');
 pool.options.statement_timeout = 5000;
 await pool.query("set statement_timeout = '5s'");
 const card = (await db.query.cards.findFirst({where:(c,{eq})=>eq(c.boardId,boardId)}))!;
 const auth = {sub:userId,cid:clientId,role:'owner' as const};
 const ctx = await assertCardAccess(auth,card);
 const richId=(await pool.query(`select c.id from card c join card_checklist cl on cl.card_id=c.id where c.board_id=$1 limit 1`,[boardId])).rows[0].id;
 const richCard=(await db.query.cards.findFirst({where:(c,{eq})=>eq(c.id,richId)}))!;
 const richCtx=await assertCardAccess(auth,richCard);
 // Force overlap, payload-only references, hidden rows, and equal timestamp sort priorities into
 // the parity fixture. UNION must preserve the historical OR semantics, not replace them with CASE.
 await pool.query(`insert into activity_event(board_id,client_id,workspace_id,actor_id,entity_type,entity_id,action,payload,feed_visible,created_at)
 select $1,$2,$3,$4,case when g=7 then 'comment' else 'card' end,
 case when g=6 then gen_random_uuid() else $5::uuid end,
 case when g=1 then 'created' else 'updated' end,
 jsonb_build_object('cardId',$5::text),g<>8,date_trunc('milliseconds',now()) from generate_series(1,8) g`,[boardId,clientId,card.workspaceId,userId,card.id]);
 const firstFeed=await loadCardFeedPage({card,cursor:null,limit:50,clientId});
 const nextFeedCursor=JSON.parse(Buffer.from(firstFeed.nextCursor!,'base64url').toString());

 writeFileSync(`${out}/fixture.json`,JSON.stringify({notificationCount,activityCount:300008,cardId:card.id,richCardId:richId,unreadFraction:0.1,parallelWorkersPerGather:(await pool.query('show max_parallel_workers_per_gather')).rows[0].max_parallel_workers_per_gather},null,2));
 const scenarios: Record<string,()=>Promise<unknown>> = {
  'card-detail':()=>loadCardDetail({auth,card,ctx}),
  'card-detail-rich':()=>loadCardDetail({auth,card:richCard,ctx:richCtx}),
  'card-feed':()=>loadCardFeedPage({card,cursor:null,limit:50,clientId}),
  'card-feed-next':()=>loadCardFeedPage({card,cursor:nextFeedCursor,limit:50,clientId}),
  'notifications-all':()=>notifications.listNotificationsPage({userId,rawQuery:{includeRead:true}}),
  'notifications-unread':()=>notifications.listNotificationsPage({userId,rawQuery:{},includeRead:false}),
  'notification-group-counts':()=>notifications.notificationGroupCounts(userId,{groupBy:'board',includeRead:true}),
  'notification-unread-count':()=>countUnreadNotifications(userId),
  'notification-mention-counts':async()=> { const {eq} = await import('../../apps/api/node_modules/drizzle-orm/index.js'); const {notifications:n} = await import('../../packages/shared/src/schema/index.js'); return notifications.feedCounts(userId,eq(n.reason,'mentioned')); },
  'notification-card-counts':()=>notifications.cardUnreadCounts(userId),
 };
 const profiles:any[]=[];
 for(const [name,run] of Object.entries(scenarios)) {
  captured=[]; recording=true;
  const times=[];
  let error:string|undefined;
  for(let i=0;i<5;i++) {
   const start=performance.now();
   try { await run();times.push(performance.now()-start); }
   catch(e) {error=String(e);break;}
  }
  await pool.query('select 1'); // Drain already queued reads after a timed-out operation.
  recording=false;
  const queries=Array.from(new Map(captured.filter(q=>q.text!=='select 1').map(q=>[q.text,q])).values());
  times.sort((a,b)=>a-b);
  profiles.push({name,p50:times[2],p95:times[4],completed:times.length,error,queriesPerCall:error?null:(captured.length-1)/5,queries});
  console.log(name,error?'timed out':times[2].toFixed(2)+' ms');
  writeFileSync(`${out}/profiles.json`,JSON.stringify(profiles,null,2));
 }
 writeFileSync(`${out}/profiles.json`,JSON.stringify(profiles,null,2));
 const plans=[];
 for(const profile of profiles) for(const q of profile.queries){
  let result, error;
  try {result=await pool.query('explain (analyze,buffers,format json) '+q.text,q.values);}
  catch(e) {error=String(e);result=await pool.query('explain (format json) '+q.text,q.values);}
  plans.push({scenario:profile.name,...q,error,plan:result.rows[0]['QUERY PLAN'][0]});
 }
 writeFileSync(`${out}/plans.json`,JSON.stringify(plans,null,2));
 const experiments=[];
 for(const entry of plans) {
  const q=entry;
  let variant:string|undefined;
  if(notificationCount===5000 && q.text.includes('"notification"."user_id"') && q.values.includes(userId)) variant=fixedRecipient(q.text,q.values,userId);
  else if(q.scenario.startsWith('card-feed') && q.text.includes('case when "activity_event"."entity_type"')) variant=splitActivity(q.text);
  if(!variant || variant===q.text) continue;
  const baseline=(await pool.query(q.text,q.values)).rows;
  const revised=(await pool.query(variant,q.values)).rows.map(({bench_priority,...row}:any)=>row);
  assert.deepEqual(revised,baseline,`${q.scenario} query parity`);
  const samples:any[]=[];
  for(let round=0;round<6;round++) for(const name of round%2?['after','before']:['before','after']) {
   const text=name==='before'?q.text:variant;
   for(let i=0;i<10;i++) {
    const start=performance.now();await pool.query(text,q.values);
    samples.push({name,round,ms:performance.now()-start});
   }
  }
  const plan=(await pool.query('explain (analyze,buffers,format json) '+variant,q.values)).rows[0]['QUERY PLAN'][0];
  const summary=Object.fromEntries(['before','after'].map(name=>{const times=samples.filter(s=>s.name===name).map(s=>s.ms).sort((a,b)=>a-b);return [name,{p50:times[30],p95:times[57]}];}));
  experiments.push({scenario:q.scenario,baseline:q.text,variant,values:q.values,summary,samples,beforePlan:q.plan,afterPlan:plan});
  writeFileSync(`${out}/experiments.json`,JSON.stringify(experiments,null,2));
  console.log('experiment',q.scenario,JSON.stringify(summary));
 }
 writeFileSync(`${out}/experiments.json`,JSON.stringify(experiments,null,2));
 const page=plans.find(q=>q.scenario==='notifications-all' && q.text.startsWith('select "notification"."id"'))!;
 const visibilityResults=[];
 for(const q of plans) {
  const variant=cardVisibilityExists(q.text);
  if(!variant) continue;
  let baseline,baselineError;
  try {baseline=(await pool.query(q.text,q.values)).rows;} catch(e) {
   baselineError=String(e);
   // Verify the same baseline SQL without the pathological nested-loop plan; this reference run
   // is for result equality only and is excluded from every reported baseline timing.
   await pool.query('set enable_nestloop = off');
   await pool.query('set jit = off');
   baseline=(await pool.query(q.text,q.values)).rows;
   await pool.query('set enable_nestloop = on');
   await pool.query('set jit = on');
  }
  const revised=(await pool.query(variant,q.values)).rows;
  if(baseline) assert.deepEqual(revised,baseline,`${q.scenario} exists parity`);
  const samples:number[]=[], baselineSamples:number[]=[];
  for(let round=0;round<6;round++) for(const name of round%2?['after','before']:['before','after']) {
   if(name==='before' && baselineError) continue;
   for(let i=0;i<5;i++) {
    const start=performance.now();await pool.query(name==='before'?q.text:variant,q.values);
    (name==='before'?baselineSamples:samples).push(performance.now()-start);
   }
  }
  const plan=(await pool.query('explain (analyze,buffers,format json) '+variant,q.values)).rows[0]['QUERY PLAN'][0];
  visibilityResults.push({scenario:q.scenario,variant,values:q.values,baselineError,parity:!!baseline,samples,baselineSamples,plan});
  writeFileSync(`${out}/visibility-experiment.json`,JSON.stringify(visibilityResults,null,2));
 }
 const indexResults=[];
 for(let round=0;round<4;round++) for(const variant of round%2?['index','baseline']:['baseline','index']) {
  await pool.query('drop index if exists bench_notification_order');
  if(variant==='index') await pool.query('create index bench_notification_order on notification(user_id,created_at desc,id desc)');
  let plan,error;
  try {plan=(await pool.query('explain (analyze,buffers,format json) '+page.text,page.values)).rows[0]['QUERY PLAN'][0];}
  catch(e) {error=String(e);}
  indexResults.push({round,variant,plan,error});
 }
 await pool.query('drop index if exists bench_notification_order');
 writeFileSync(`${out}/index-experiment.json`,JSON.stringify(indexResults,null,2));
 console.log('index experiment',indexResults.map(r=>[r.variant,r.plan?.['Execution Time'] ?? r.error]));
 const jitResults=[];
 for(const q of plans.filter(q=>q.scenario.startsWith('notification') && q.plan.JIT)) {
  for(let round=0;round<3;round++) for(const jit of round%2?['off','on']:['on','off']) {
   await pool.query(`set jit = ${jit}`);
   let plan,error;
   try {plan=(await pool.query('explain (analyze,buffers,format json) '+q.text,q.values)).rows[0]['QUERY PLAN'][0];}
   catch(e) {error=String(e);}
   jitResults.push({scenario:q.scenario,round,jit,plan,error});
  }
 }
 await pool.query('set jit = on');
 writeFileSync(`${out}/jit-experiment.json`,JSON.stringify(jitResults,null,2));
 await pool.query('create index bench_notification_order on notification(user_id,created_at desc,id desc)');
 await pool.query('set jit = off');
 const indexBytes=Number((await pool.query("select pg_relation_size('bench_notification_order') as bytes")).rows[0].bytes);
 const combined=[];
 for(let i=0;i<60;i++) {const start=performance.now();await pool.query(page.text,page.values);combined.push(performance.now()-start);}
 const combinedPlan=(await pool.query('explain (analyze,buffers,format json) '+page.text,page.values)).rows[0]['QUERY PLAN'][0];
 writeFileSync(`${out}/combined.json`,JSON.stringify({samples:combined,plan:combinedPlan,indexBytes},null,2));
 await pool.query('drop index bench_notification_order');
 await pool.query('set jit = on');
} finally { await pool.end(); }
