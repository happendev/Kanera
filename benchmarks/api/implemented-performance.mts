// Actual application modules, serial calls, one connection per version. Local disposable data only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const pg = require('pg');
let commands=0;
// Install before db.ts binds each client's query method for instrumentation.
const original=pg.Client.prototype.query;
pg.Client.prototype.query=function(...args:any[]) {commands++;return original.apply(this,args);};
const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.hostname, '127.0.0.1');
assert.match(url.pathname, /^\/kanera_drawer_\d+$/);
const out = process.env.DRAWER_OUTPUT!;
const baselineRoot = resolve(process.env.BENCH_BASELINE_SOURCE!);
const beforeImport = (file: string) => import(pathToFileURL(`${baselineRoot}/${file}`).href);
const {db,pool} = await import('../../apps/api/src/db.js');
const beforeDb = await beforeImport('db.ts');
const beforeFeed = await beforeImport('modules/comments/card-feed.ts');
const beforeEmit = await beforeImport('realtime/emit.ts');
const {loadCardFeedPage} = await import('../../apps/api/src/modules/comments/card-feed.js');
const {emitToFilteredBoardAudience} = await import('../../apps/api/src/realtime/emit.js');
const {assertCardAccess} = await import('../../apps/api/src/lib/access.js');
const notifications = await import('../../apps/api/src/modules/notifications/notification-feed.js');
const {countUnreadNotifications} = await import('../../apps/api/src/lib/notifications.js');
const notificationCount = Number(process.env.DRAWER_NOTIFICATIONS ?? 5000);
assert.ok([5000,50000].includes(notificationCount));
const userId = '70000000-0000-4000-8000-000000000010';
const clientId = '70000000-0000-4000-8000-000000000001';
const boardId = '70000000-0000-4000-8000-000000000200';
const results: any[] = [];
const summarize = (values: number[]) => { const sorted=[...values].sort((a,b)=>a-b); return {n:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)]}; };
function save() {writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2));}
async function compare(name: string, before: ()=>Promise<unknown>, after: ()=>Promise<unknown>, options: {setup?:(version:string)=>Promise<void>;cleanup?:()=>Promise<void>;parity?:boolean;samples?:number} = {}) {
 const samples: any[]=[]; const errors: Record<string,string>={}; const outputs: Record<string,unknown>={};
 for(let round=0;round<6;round++) for(const version of round%2?['after','before']:['before','after']) {
  await options.setup?.(version);
  if(errors[version]) continue;
  const run=version==='before'?before:after;
  for(let i=0;i<(options.samples??5)+1;i++) {
   const start=performance.now();
   try { outputs[version]=await run(); if(i>0) samples.push({version,round,ms:performance.now()-start}); }
   catch(e:any) {errors[version]=e.cause ? `${e.cause.code}: ${e.cause.message}` : String(e);break;}
   finally { await options.cleanup?.(); }
  }
 }
 assert.equal(errors.after,undefined,`${name} revised operation must succeed`);
 if(errors.before) assert.ok(name==='notifications-all' && errors.before.startsWith('57014:'),errors.before);
 let parity=false;
 if(options.parity!==false && !Object.keys(errors).length) {assert.deepEqual(outputs.after,outputs.before,`${name} parity`);parity=true;}
 const result={name,parity,errors,before:summarize(samples.filter(s=>s.version==='before').map(s=>s.ms)),after:summarize(samples.filter(s=>s.version==='after').map(s=>s.ms)),samples};
 results.push(result);save();console.log(JSON.stringify({...result,samples:undefined}));
}
async function index(version:string) {
 await pool.query('drop index if exists notifications_user_id_created_at_idx');
 await pool.query('drop index if exists notifications_user_id_created_at_id_idx');
 await pool.query(version==='before'?'create index notifications_user_id_created_at_idx on notification(user_id,created_at)':'create index notifications_user_id_created_at_id_idx on notification(user_id,created_at desc,id desc)');
}
try {
 await pool.query(`set max_parallel_workers_per_gather = 0`);
 // Fixture-only bulk loading: references come from existing seeded rows. Restore triggers before measuring.
 await pool.query('set session_replication_role = replica');
 await pool.query(`create table bench_cards as select id, board_id, workspace_id, list_id, row_number() over(order by id) as n from card where board_id = $1`,[boardId]);
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

 beforeDb.pool.options.statement_timeout=5000;
 await beforeDb.pool.query("set statement_timeout='5s'");
 await compare('activity-first-page',()=>beforeFeed.loadCardFeedPage({card,cursor:null,limit:50,clientId}),()=>loadCardFeedPage({card,cursor:null,limit:50,clientId}));
 await compare('activity-next-page',()=>beforeFeed.loadCardFeedPage({card,cursor:nextFeedCursor,limit:50,clientId}),()=>loadCardFeedPage({card,cursor:nextFeedCursor,limit:50,clientId}));
 const page=()=>notifications.listNotificationsPage({userId,rawQuery:{includeRead:true}});
 await compare('notifications-all',page,page,{setup:index,samples:3});
 if(results.at(-1).errors.before) {
  await index('before');await pool.query('set enable_nestloop=off');await pool.query('set jit=off');
  const reference=await page();
  await pool.query('set enable_nestloop=on');await pool.query('set jit=on');await index('after');
  assert.deepEqual(await page(),reference);results.at(-1).parity=true;results.at(-1).parityReference='Original SQL with nestloop/JIT disabled, excluded from timing';save();
 }
 const unread=()=>countUnreadNotifications(userId);
 await compare('notification-unread-count',unread,unread,{setup:index});
 // Same valid FK rows with each replacement index; delete outside the timing window.
 await pool.query(`create table bench_notifications as
 select $1::uuid as user_id,$2::uuid as client_id,a.id as activity_id,c.id as card_id,c.list_id,c.board_id,c.workspace_id,a.created_at
 from activity_event a join bench_cards c on c.id=a.entity_id
 where not exists(select 1 from notification n where n.user_id=$1 and n.activity_id=a.id)
 order by a.created_at desc limit 100`,[userId,clientId]);
 const write=async()=>{const inserted=await pool.query(`insert into notification(user_id,client_id,activity_id,card_id,list_id,board_id,workspace_id,created_at,reason)
 select *, 'assigned' from bench_notifications`);assert.equal(inserted.rowCount,100);};
 await compare('notification-insert-100',write,write,{setup:index,cleanup:async()=>{await pool.query("delete from notification where reason='assigned'");}});
 const sizes=[];
 for(const version of ['before','after']) {await index(version); sizes.push({version,bytes:(await pool.query("select pg_relation_size($1) as bytes",[version==='before'?'notifications_user_id_created_at_idx':'notifications_user_id_created_at_id_idx'])).rows[0].bytes});}
 results.push({name:'notification-index-size',sizes});save();
 const users=(await pool.query('select id from "user" where client_id=$1 order by id limit 100',[clientId])).rows.map((r:any)=>r.id);
 assert.equal(users.length,100);
 const payload={boardId};
 const clear=async()=>{await pool.query('truncate direct_realtime_outbox,event_outbox cascade');};
 await clear();
 for(const size of [10,100]) {
  const audience=users.slice(0,size);
  const operation=(emit:any,p:any)=>async()=>{await emit(boardId,'board:deleted',payload,audience);await p.query('select 1');};
  const before=operation(beforeEmit.emitToFilteredBoardAudience,beforeDb.pool);
  const after=operation(emitToFilteredBoardAudience,pool);
  const evidence=[];
  for(const [version,run] of [['before',before],['after',after]] as const) {
   commands=0;await run();const count=commands;
   const direct=(await pool.query('select scope,user_id,event_type,payload from direct_realtime_outbox order by user_id')).rows;
   const events=(await pool.query('select scope,scope_id,event_type,payload,realtime_dispatched as dispatched from event_outbox')).rows;
   assert.equal(direct.length,size);assert.equal(events.length,1);
   evidence.push({version,commands:count,direct,events});await clear();
  }
  assert.deepEqual(evidence[0].direct,evidence[1].direct);assert.deepEqual(evidence[0].events,evidence[1].events);
  writeFileSync(`${out}/publication-${size}.json`,JSON.stringify(evidence,null,2));
  await compare(`filtered-audience-${size}`,before,after,{cleanup:clear,samples:3});
  results.at(-1).commands={before:evidence[0].commands,after:evidence[1].commands};save();
 }
 pg.Client.prototype.query=original;
} finally {await beforeDb.pool.end();await pool.end();}
