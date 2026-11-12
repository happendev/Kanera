// Isolated serial microbenchmarks; no sockets or notifications are published.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const {Client}=require('pg');
const Redis=require('ioredis');
const url=new URL(process.env.DATABASE_URL!);
assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/kanera_realtime_\d+$/);
const redisUrl=new URL(process.env.REDIS_URL!);assert.equal(redisUrl.hostname,'127.0.0.1');assert.notEqual(redisUrl.port,'6379');
const out=process.env.REALTIME_OUTPUT!;
const db=new Client({connectionString:url.toString()});
const redis=new Redis(redisUrl.toString());
const summary=(times:number[])=>{const t=[...times].sort((a,b)=>a-b);return {p50:t[Math.floor(t.length*.5)],p95:t[Math.floor(t.length*.95)]};};
await db.connect();await redis.ping();
try {
 await db.query('set max_parallel_workers_per_gather=0');
 const claims=[];
 for(const kind of ['event','direct']) {
  const source=kind==='event'?'event_outbox':'direct_realtime_outbox', table=`bench_${kind}`;
  await db.query(`create table ${table} (like ${source} including all)`);
  const columns=kind==='event'?'scope,scope_id,workspace_id,event_type,payload,realtime_dispatched,webhooks_enqueued,created_at':'scope,client_id,event_type,payload,realtime_dispatched,created_at';
  const values=kind==='event'?`'workspace',gen_random_uuid(),gen_random_uuid(),'workspace:updated',jsonb_build_object('name',repeat('x',500)),g<=100000,g<=100000`:`'client',gen_random_uuid(),'client:updated',jsonb_build_object('name',repeat('x',500)),g<=100000`;
  await db.query(`insert into ${table}(${columns}) select ${values},now()-(100500-g)*interval '1 millisecond' from generate_series(1,100500) g`);
  await db.query(`analyze ${table}`);
  const pending=kind==='event'?'(realtime_dispatched=false or webhooks_enqueued=false)':'realtime_dispatched=false';
  const update=`update ${table} set processing_lease_expires_at=now()+interval '30 seconds',attempts=attempts+1,updated_at=now() where id in (select id from ${table} where ${pending} and (processing_lease_expires_at is null or processing_lease_expires_at<=now()) order by created_at,id limit 50 for update skip locked)`;
  const cte=`with claimed as (${update} returning *) select * from claimed order by created_at,id`;
  async function run(variant:string) {
   if(variant==='cte') return (await db.query(cte)).rows;
   await db.query('begin');
   const ids=(await db.query(update+' returning id')).rows.map((r:any)=>r.id);
   const rows=ids.length?(await db.query(`select * from ${table} where id=any($1::uuid[]) order by created_at,id`,[ids])).rows:[];
   await db.query('commit');return rows;
  }
  async function reset(rows:any[]) {if(rows.length) await db.query(`update ${table} set processing_lease_expires_at=null,attempts=0 where id=any($1::uuid[])`,[rows.map(r=>r.id)]);}
  const baseline=await run('current');await reset(baseline);const candidate=await run('cte');await reset(candidate);
  const stable=(rows:any[])=>rows.map(({updated_at,processing_lease_expires_at,...r})=>r);
  assert.deepEqual(stable(candidate),stable(baseline));assert.equal(candidate.length,50);
  for(const state of ['backlog','empty']) {
   if(state==='empty') await db.query(`update ${table} set realtime_dispatched=true ${kind==='event'?',webhooks_enqueued=true':''} where ${pending}`);
   const samples:any[]=[];
   for(let round=0;round<6;round++) for(const variant of round%2?['cte','current']:['current','cte']) for(let i=0;i<20;i++) {
    const start=performance.now();const rows=await run(variant);const ms=performance.now()-start;
    assert.equal(rows.length,state==='empty'?0:50);await reset(rows);samples.push({round,variant,ms});
   }
   const result={kind,state,samples,summary:Object.fromEntries(['current','cte'].map(v=>[v,summary(samples.filter(s=>s.variant===v).map(s=>s.ms))]))};
   claims.push(result);console.log('claim',kind,state,JSON.stringify(result.summary));
  }
 }
 writeFileSync(`${out}/claims.json`,JSON.stringify(claims,null,2));
 // Filtered audience publication still uses per-recipient INSERT/NOTIFY despite an existing
 // bounded bulk helper elsewhere. Compare SQL work serially, not with a larger connection pool.
 const publication=[];
 for(const size of [10,100,1000]) {
  const samples:any[]=[];
  for(let round=0;round<6;round++) for(const variant of round%2?['batch','individual']:['individual','batch']) for(let sample=0;sample<3;sample++) {
   const ids:string[]=[];
   const start=performance.now();
   const chunkSize=variant==='batch'?100:1;
   for(let offset=0;offset<size;offset+=chunkSize) {
    const count=Math.min(chunkSize,size-offset);
    const values=Array.from({length:count},()=>`('client',gen_random_uuid(),'client:updated','{"name":"benchmark"}'::jsonb)`);
    const rows=(await db.query(`insert into bench_direct(scope,client_id,event_type,payload) values ${values.join(',')} returning ${variant==='batch'?'id':'*'}`)).rows;
    ids.push(...rows.map((r:any)=>r.id));
    await db.query('select pg_notify($1,$2)',['benchmark_only',rows[0].id]);
   }
   const ms=performance.now()-start;
   assert.equal(ids.length,size);
   await db.query('delete from bench_direct where id=any($1::uuid[])',[ids]);
   samples.push({variant,round,ms});
  }
  const result={size,samples,commands:{individual:size*2,batch:Math.ceil(size/100)*2},summary:Object.fromEntries(['individual','batch'].map(v=>[v,summary(samples.filter(s=>s.variant===v).map(s=>s.ms))]))};
  publication.push(result);console.log('publication',size,JSON.stringify(result.summary));
 }
 writeFileSync(`${out}/publication.json`,JSON.stringify(publication,null,2));
 const source=readFileSync(new URL('../../apps/api/src/realtime/presence.ts',import.meta.url),'utf8');
 const script=(name:string)=>{const match=source.match(new RegExp(`const ${name} = \\x60([\\s\\S]*?)\\x60;`));assert.ok(match);return match[1];};
 const online=script('MARK_ONLINE_SCRIPT'),offline=script('MARK_OFFLINE_SCRIPT');
 const onlineCounts=`
 local old=redis.call('HGET',KEYS[1],ARGV[1])
 local count=tonumber(redis.call('HGET',KEYS[3],ARGV[2]) or '0')
 if old~=ARGV[2] then
  if old then local n=redis.call('HINCRBY',KEYS[3],old,-1);if n==0 then redis.call('HDEL',KEYS[3],old) end end
  redis.call('HINCRBY',KEYS[3],ARGV[2],1)
 end
 redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])
 redis.call('SADD',KEYS[2],ARGV[3])
 redis.call('SADD',KEYS[4],ARGV[4])
 if count==0 then return 1 else return 0 end`;
 const offlineCounts=`
 if redis.call('HGET',KEYS[1],ARGV[1])~=ARGV[2] then redis.call('SREM',KEYS[2],ARGV[3]);return 0 end
 redis.call('HDEL',KEYS[1],ARGV[1]);redis.call('SREM',KEYS[2],ARGV[3])
 local count=redis.call('HINCRBY',KEYS[3],ARGV[2],-1)
 if count==0 then redis.call('HDEL',KEYS[3],ARGV[2]);return 1 else return 0 end`;
 const sha={online:await redis.script('LOAD',online),offline:await redis.script('LOAD',offline),onlineCounts:await redis.script('LOAD',onlineCounts),offlineCounts:await redis.script('LOAD',offlineCounts)};
 async function change(variant:string,join:boolean,workspace:string,socket:string,user:string) {
  const keys=[`${variant}:${workspace}:sockets`,`${variant}:server:sockets`];
  const args=[socket,user,JSON.stringify({workspace,socket,user})];
  if(variant==='counts') return redis.evalsha(join?sha.onlineCounts:sha.offlineCounts,join?4:3,...keys,`${variant}:${workspace}:counts`,...(join?[`${variant}:servers`]:[]),...args,...(join?['server']:[]));
  const result=await redis[variant==='current'?'eval':'evalsha'](variant==='current'?(join?online:offline):(join?sha.online:sha.offline),2,...keys,...args);
  if(join) await redis.sadd(`${variant}:servers`,'server');
  return result;
 }
 // Repeat joins, multiple tabs, stale disconnects and socket replacement must match existing results.
 const operations=[[true,'s1','u1'],[true,'s1','u1'],[true,'s2','u1'],[false,'s1','wrong'],[false,'s1','u1'],[true,'s2','u2'],[false,'s2','u1'],[false,'s2','u2'],[false,'s2','u2']] as const;
 for(const [join,socket,user] of operations) {
  const expected=await change('current',join,'parity',socket,user);
  assert.equal(await change('counts',join,'parity',socket,user),expected);
  assert.deepEqual(await redis.hgetall('counts:parity:sockets'),await redis.hgetall('current:parity:sockets'));
 }
 assert.equal(await redis.hlen('counts:parity:counts'),0);
 const presence=[];
 for(const size of [10,1000,10000]) {
  for(const variant of ['current','cached','counts']) {
   const entries=Array.from({length:size},(_,i)=>[`s${i}`,`u${Math.floor(i/2)}`]).flat();
   await redis.hset(`${variant}:load:sockets`,...entries);
   if(variant==='counts') {const counts=Array.from({length:size/2},(_,i)=>[`u${i}`,'2']).flat();await redis.hset('counts:load:counts',...counts);}
  }
  const samples:any[]=[];
  for(let round=0;round<6;round++) for(const variant of round%2?['counts','cached','current']:['current','cached','counts']) {
   const cpuBefore=await redis.info('cpu');
   for(let i=0;i<100;i++) {
    const start=performance.now();assert.equal(await change(variant,true,'load','new-socket','new-user'),1);assert.equal(await change(variant,false,'load','new-socket','new-user'),1);
    samples.push({round,variant,ms:performance.now()-start});
   }
   const cpuAfter=await redis.info('cpu');
   writeFileSync(`${out}/presence-cpu-${size}-${round}-${variant}.json`,JSON.stringify({cpuBefore,cpuAfter},null,2));
  }
  const result={size,samples,summary:Object.fromEntries(['current','cached','counts'].map(v=>[v,summary(samples.filter(s=>s.variant===v).map(s=>s.ms))]))};
  presence.push(result);console.log('presence',size,JSON.stringify(result.summary));
 }
 writeFileSync(`${out}/presence.json`,JSON.stringify({parityOperations:operations.length,presence,online,offline,onlineCounts,offlineCounts},null,2));
 writeFileSync(`${out}/valkey-info.txt`,await redis.info());
} finally {await db.end();await redis.quit();}
