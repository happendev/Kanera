// Local system load generator. Uses production HTTP, SQL, schedulers and realtime paths.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const config = JSON.parse(process.env.MIXED_CLIENT);
const require = createRequire(`${config.root}/apps/api/package.json`);
const { Client } = require(`${config.root}/apps/api/node_modules/pg`);
const { io } = require(`${config.root}/apps/web/node_modules/socket.io-client`);
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/kanera_mixed_\d+$/);
const db = new Client({ connectionString: database.toString() }); await db.connect();
const board = '70000000-0000-4000-8000-000000000200';
const workspace = '70000000-0000-4000-8000-000000000100';
const owner = '70000000-0000-4000-8000-000000000010';
const client = '70000000-0000-4000-8000-000000000001';
const scope = { allAccessible: false, boardIds: [board] };
const result = { label: config.label, phases: [], fixture: { cards: 3000, recipients: config.systemMembers }, limits: 'Local synthetic self-hosted workload. Worker trigger hooks bypass idle poll delays; email uses real local SMTP. Workspace webhook SSRF permits only the exact local fixture receiver in disposable source. No browser rendering, WAN, real provider or hosted billing measured.' };
const sockets = [], errors = [], receipts = [], requests = [];
let token, secret, sequence = 0, closing = false;
const stats = xs => { const sorted = [...xs].sort((a,b)=>a-b); return { count: xs.length, p50: sorted[Math.floor((xs.length-1)*.5)] ?? 0, p95: sorted[Math.floor((xs.length-1)*.95)] ?? 0, p99: sorted[Math.floor((xs.length-1)*.99)] ?? 0, max: sorted.at(-1) ?? 0 }; };
async function request(path, { method = 'POST', body = {}, credential = token, decode = true, port = 3100 + (sequence++ % 2) } = {}) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  assert.ok(response.ok, `${path}: ${response.status}: ${text.slice(0,400)}`);
  requests.push({ path, port, ms: performance.now()-started, bytes: Buffer.byteLength(text) });
  return text && decode ? JSON.parse(text) : null;
}
async function control(endpoint) { return Promise.all(config.services.map(async service => ({ name: service.name, ...await (await fetch(`http://127.0.0.1:${service.control}/${endpoint}`)).json() }))); }
async function until(check, description, timeout = 120000) { const start = performance.now(); while (!await check()) { assert.ok(performance.now()-start < timeout, `Timeout: ${description}`); await delay(100); } }
async function settled() {
  await until(async()=>Number((await db.query(`select (select count(*) from event_outbox where not realtime_dispatched or not webhooks_enqueued) + (select count(*) from direct_realtime_outbox where not realtime_dispatched) as n`)).rows[0].n) === 0, 'outbox drain');
}
async function phase(name, action) {
  console.log(`Starting ${name}`); await settled(); await control('reset');
  const start = performance.now(), first = requests.length, receiptStart = receipts.length;
  const detail = await action(); await settled();
  const servers = await control('snapshot');
  const output = { name, elapsedMs: performance.now()-start, ...detail, requests: requests.slice(first), receipts: receipts.slice(receiptStart), servers };
  result.phases.push(output); writeFileSync(config.output, JSON.stringify(result, null, 2));
  console.log(`${name}: ${output.elapsedMs.toFixed(1)}ms`); return output;
}
async function jobs(names) {
  const prior = await (await fetch('http://127.0.0.1:3197/startup')).json();
  await Promise.all(names.map(name=>request(`/benchmark/trigger/${name}`, { port: 3121 })));
  await until(async()=>{
    const current = await (await fetch('http://127.0.0.1:3197/startup')).json();
    for (const name of names) assert.equal(current[name]?.failed ?? 0, prior[name]?.failed ?? 0, `Scheduler failure: ${name}`);
    return names.every(name=>(current[name]?.completed ?? 0) > (prior[name]?.completed ?? 0) && !current[name]?.running);
  }, `schedulers ${names}`);
}
async function withReads(action) {
  let finished = false; const samples = [];
  const lanes = ['my','team','board','health'];
  const readers = lanes.map(async lens=>{ while(!finished) {
    const start=performance.now();
    if(lens==='board') await request(`/boards/${board}/open`,{decode:false});
    else if(lens==='health') await request('/health',{method:'GET'});
    else await request('/work/cards/query',{body:{lens,scope,limit:100}});
    samples.push({lens,ms:performance.now()-start});
    await delay(Math.max(0,(lens==='board'?500:lens==='health'?1000:250)-(performance.now()-start)));
  } });
  try { await action(); } finally { finished = true; await Promise.all(readers); }
  return Object.fromEntries(lanes.map(lens=>[lens,stats(samples.filter(x=>x.lens===lens).map(x=>x.ms))]));
}
const smtpSeen = new Map(), smtpAccepted = new Set(), smtpConnections = new Set();
const smtp = net.createServer(socket=>{
  smtpConnections.add(socket); socket.on('close',()=>smtpConnections.delete(socket)); socket.on('error',()=>{});
  socket.setEncoding('utf8'); socket.write('220 benchmark SMTP\r\n'); let buffer='', data=false, recipient='';
  socket.on('data', chunk=>{ buffer+=chunk; for(;;) {
    if(data) { const end=buffer.indexOf('\r\n.\r\n'); if(end<0) break; buffer=buffer.slice(end+5); data=false;
      const count=(smtpSeen.get(recipient)??0)+1; smtpSeen.set(recipient,count);
      const n=Number(recipient.match(/email(\d+)/)?.[1]??0), fail=n>0 && n%13===0 && count===1;
      setTimeout(()=>{ if(!fail) smtpAccepted.add(recipient); socket.write(fail?'451 injected retry\r\n':'250 accepted\r\n'); },n>0 && n%10===0?500:100); continue;
    }
    const end=buffer.indexOf('\r\n'); if(end<0) break; const line=buffer.slice(0,end); buffer=buffer.slice(end+2);
    if(line.startsWith('RCPT TO:')) recipient=line;
    if(line==='DATA') { data=true; socket.write('354 body\r\n'); }
    else if(line==='QUIT') socket.write('221 bye\r\n'); else socket.write('250 accepted\r\n');
  }});
});
const webhooks = new Map();
const receiver = http.createServer((req,res)=>{ let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{
  const key=`${req.url}:${req.headers['x-kanera-event-id']}`;
  const signature=`sha256=${createHmac('sha256','benchmark-only-secret').update(`${req.headers['x-kanera-timestamp']}.${body}`).digest('hex')}`;
  if(signature!==req.headers['x-kanera-signature']) errors.push('Bad webhook signature');
  const previous=webhooks.get(key)??{ attempts:0, accepted:0 }; previous.attempts++; webhooks.set(key,previous);
  const fail=(req.url==='/slow' || (req.url==='/personal' && Number(JSON.parse(body).notification.title.match(/(\d+)$/)?.[1])%13===0)) && previous.attempts===1;
  setTimeout(()=>{ if(!fail) previous.accepted++; res.writeHead(fail?503:200); res.end(fail?'retry':'ok'); },req.url==='/slow'?300:20);
}); });
try {
  await new Promise(resolve=>smtp.listen(3194,'127.0.0.1',resolve));
  await new Promise(resolve=>receiver.listen(3195,'127.0.0.1',resolve));
  token=(await request('/auth/login',{body:{email:'perf@kanera.local',password:'Perf12345'}})).accessToken;
  secret=(await request('/me/api-keys',{body:{label:'System benchmark',scope:'write'}})).secret;
  const users=(await db.query('select id,email from "user" where client_id=$1 order by id',[client])).rows;
  assert.equal(users.length,config.systemMembers);
  await db.query('insert into board_member(board_id,user_id,role) select $1,id,\'editor\' from "user" where client_id=$2 on conflict do nothing',[board,client]);
  for(const user of users.slice(0,config.observers)) {
    const credential=(await request('/auth/login',{body:{email:user.email,password:'Perf12345'}})).accessToken;
    const socket=io(`http://127.0.0.1:${3100+sockets.length%2}`,{auth:{token:credential},transports:['websocket'],reconnection:false,autoConnect:false}); sockets.push(socket);
    socket.on('notification:created',({notification})=>receipts.push({ userId:user.id, cardId:notification.cardId, activityId:notification.activityId, id:notification.id, at:Date.now() }));
    socket.on('disconnect',reason=>{ if(!closing) errors.push(reason); });
    await new Promise((resolve,reject)=>{ socket.once('connect',resolve); socket.once('connect_error',reject); socket.connect(); });
  }
  const cards=(await db.query('select id,list_id from card where board_id=$1 order by id',[board])).rows;
  const lists=(await db.query('select id from list where workspace_id=$1 order by position',[workspace])).rows;
  for(let i=0;i<10;i++) await request('/work/cards/query',{body:{lens:i%2?'my':'team',scope,limit:100}});
  await request(`/boards/${board}/open`,{decode:false});
  await request(`/boards/${board}/open`,{decode:false});
  await phase('global-work',async()=>{
    const firstPages={};
    for(const lens of ['my','team']) {
      const times=[]; for(let i=0;i<20;i++) { const start=performance.now(); const page=await request('/work/cards/query',{body:{lens,scope,limit:100}}); assert.equal(page.cards.length,100); assert.equal(page.totals.cards,3000); times.push(performance.now()-start); }
      const pageSize=config.variant==='before'?100:(config.systemPageSize??100);
      const walks=[];
      for(let i=0;i<2;i++) { let cursor, pages=0; const ids=new Set(), values=[], start=performance.now(); do { const page=await request('/work/cards/query',{body:{lens,scope,limit:pageSize,includeMetadata:!cursor,...(cursor?{cursor}:{})}}); for(const card of page.cards) { assert.ok(!ids.has(card.id)); ids.add(card.id); const value=structuredClone(card); if(value.coverUrl) { const url=new URL(value.coverUrl); url.searchParams.delete('e'); url.searchParams.delete('t'); value.coverUrl=url.toString(); } values.push(value); } cursor=page.nextCursor; pages++; } while(cursor); assert.equal(ids.size,3000); assert.equal(pages,Math.ceil(3000/pageSize)); if(i===0) { const parity=`${dirname(config.output)}/parity-${config.round}-${lens}.json`; if(existsSync(parity)) assert.deepEqual(values,JSON.parse(readFileSync(parity)),`${lens} all-card wire parity`); else writeFileSync(parity,JSON.stringify(values)); } walks.push(performance.now()-start); }
      firstPages[lens]={first:stats(times),walk:stats(walks)};
    } return {firstPages};
  });
  await db.query('insert into board_watcher(board_id,user_id) select $1,id from "user" where client_id=$2 on conflict do nothing',[board,client]);
  // Watchers all qualify for comment notifications; outbound opt-in stays off in this phase.
  await phase('notification-fanout',async()=>{
    const selected=cards.slice(0,40).map(x=>x.id), start=Date.now(), initial=receipts.length, submitted=new Map();
    const readLatency=await withReads(async()=>{
      let index=0; await Promise.all(Array.from({length:4},async()=>{ while(index<selected.length) { const id=selected[index++]; submitted.set(id,Date.now()); await request(`/api/v1/cards/${id}/comments`,{port:3120,credential:secret,body:{body:`Benchmark fanout ${id}`}}); } }));
      await until(async()=>Number((await db.query('select count(*) as n from notification where card_id=any($1::uuid[]) and created_at >= $2',[selected,new Date(start)])).rows[0].n)===40*(users.length-1),'all notification rows');
      await until(()=>receipts.slice(initial).filter(x=>selected.includes(x.cardId)).length>=40*(config.observers-1),'notification observer delivery');
    });
    const delivered=receipts.slice(initial).filter(x=>selected.includes(x.cardId)); assert.equal(new Set(delivered.map(x=>`${x.userId}:${x.id}`)).size,40*(config.observers-1));
    return {notifications:40*(users.length-1), observerDeliveries:delivered.length, burstToObserverMs:stats(delivered.map(x=>x.at-start)),requestToObserverMs:stats(delivered.map(x=>x.at-submitted.get(x.cardId))), readLatency};
  });
  // Deterministic ordered automation actions: each move must produce eight comments.
  async function rules(trigger,listId,count) {
    const ids=[]; for(let i=0;i<count;i++) { const row=(await db.query('insert into automation(workspace_id,position,trigger_type,trigger_list_id) values($1,$2,$3,$4) returning id',[workspace,1000+i,trigger,listId])).rows[0]; ids.push(row.id); for(let j=0;j<2;j++) await db.query("insert into automation_action(automation_id,type,config,position) values($1,'post_comment',$2,$3)",[row.id,JSON.stringify({template:`Benchmark automation ${i}/${j}: {{card.title}} in {{board.name}}`}),1000+j]); } return ids;
  }
  const target=lists[0].id, moveCards=cards.filter(x=>x.list_id!==target).slice(40,52);
  const ruleIds=await rules('card_enters_list',target,4);
  await phase('triggered-automations',async()=>{
    const before=Number((await db.query('select count(*) as n from comment where card_id=any($1::uuid[])',[moveCards.map(x=>x.id)])).rows[0].n);
    const readLatency=await withReads(async()=>{ for(const card of moveCards) await request(`/cards/${card.id}/move`,{body:{listId:target,beforeCardId:null}}); await until(async()=>Number((await db.query('select count(*) as n from notification where card_id=any($1::uuid[])',[moveCards.map(x=>x.id)])).rows[0].n)===12*(users.length-1),'move notification fanout'); });
    const comments=Number((await db.query('select count(*) as n from comment where card_id=any($1::uuid[])',[moveCards.map(x=>x.id)])).rows[0].n)-before; assert.equal(comments,96);
    return {moves:12,rules:4,actionsPerRule:2,comments,readLatency};
  });
  await db.query('update automation set enabled=false where id=any($1::uuid[])',[ruleIds]);
  if (!config.systemFocus) {
  const dueCards=cards.slice(150,175).map(x=>x.id), dueRules=await rules('due_date_arrives',null,2);
  await db.query("update card set due_date_local_date='2020-01-01',due_date_slot='anyTime',due_date_timezone='UTC' where id=any($1::uuid[])",[dueCards]);
  for(let i=1;i<=100;i++) await db.query("insert into email_queue(to_email,subject,type,data) values($1,'Benchmark','welcome',$2)",[`email${i}@example.test`,JSON.stringify({displayName:'Benchmark',loginUrl:'http://127.0.0.1/login'})]);
  await db.query("update notification_settings set webhook_enabled=true,encrypted_webhook_secret='benchmark-only-secret',card_overdue_webhook=false,webhook_url='http://127.0.0.1:3195/personal' where user_id in (select id from \"user\" where client_id=$1)",[client]);
  for(let i=1;i<=100;i++) await db.query("insert into push_queue(client_id,user_id,reason,channel,payload) values($1,$2,'watching','webhook',$3)",[client,users[i%users.length].id,JSON.stringify({title:`Benchmark push ${i}`,body:'Local delivery',url:'http://127.0.0.1/card'})]);
  const endpointIds=[]; for(const path of ['fast','slow']) endpointIds.push((await db.query("insert into webhook_endpoint(workspace_id,created_by_id,name,url,encrypted_secret,event_types) values($1,$2,$3,$4,'benchmark-only-secret',to_jsonb(array['comment:created'])) returning id",[workspace,owner,path,`http://127.0.0.1:3195/${path}`])).rows[0].id);
  await phase('competing-background-jobs',async()=>{
    const start=performance.now(); let emailMs;
    const readLatency=await withReads(async()=>{
      await Promise.all([jobs(['due-date-automation','overdue-notification','daily-digest','retention-cleanup','push-queue']), request('/benchmark/email',{port:3121}).then(x=>{emailMs=performance.now()-start;assert.equal(x.processed,100);})]);
      await settled(); await jobs(['webhook-delivery']);
    });
    const runs=Number((await db.query('select count(*) as n from automation_run where automation_id=any($1::uuid[])',[dueRules])).rows[0].n); assert.equal(runs,50);
    const emails=(await db.query('select status,count(*)::int as n from email_queue group by status')).rows;
    assert.equal(emails.find(x=>x.status==='success')?.n,93); assert.equal(emails.find(x=>x.status==='queued')?.n,7);
    return {dueCards:25,automationRuns:runs,emailMs,emailStatuses:emails,emailQueueAgeMs:stats((await db.query("select extract(epoch from (sent_at-created_at))*1000 as ms from email_queue where status='success'")).rows.map(x=>Number(x.ms))),webhooks:(await db.query('select status,count(*)::int as n from webhook_delivery group by status')).rows,readLatency};
  });
  await phase('delivery-retry-recovery',async()=>{
    await db.query("update email_queue set next_attempt_at=now() where status='queued'; update webhook_delivery set next_attempt_at=now() where status='queued'");
    await Promise.all([request('/benchmark/email',{port:3121}),jobs(['webhook-delivery','push-queue'])]);
    await until(async()=>Number((await db.query("select count(*) as n from webhook_delivery where status<>'success'")).rows[0].n)===0,'all webhook retries delivered');
    assert.equal(Number((await db.query("select count(*) as n from push_queue where status='success'")).rows[0].n),100);
    assert.equal(Number((await db.query('select count(*) as n from webhook_delivery where endpoint_id=any($1::uuid[])',[endpointIds])).rows[0].n),200);
    assert.equal(webhooks.size,300);
    assert.equal(smtpAccepted.size,100); for(const value of webhooks.values()) assert.equal(value.accepted,1);
    assert.equal(Number((await db.query("select count(*) as n from email_queue where status='success'")).rows[0].n),100);
    return {emailAccepted:smtpAccepted.size,workspaceWebhookDeliveries:200,personalNotificationDeliveries:100,pushStatuses:(await db.query('select status,count(*)::int as n from push_queue group by status')).rows,uniqueWebhookDeliveries:webhooks.size,retriedWebhooks:[...webhooks.values()].filter(x=>x.attempts>1).length};
  });
  await db.query('update "user" set timezone=\'UTC\' where client_id=$1',[client]);
  await db.query('update notification_settings set email_enabled=true where user_id in (select id from "user" where client_id=$1)',[client]);
  await db.query('insert into card_assignee(card_id,user_id) select c.id,u.id from card c cross join "user" u where c.id=any($1::uuid[]) and u.client_id=$2 on conflict do nothing',[dueCards,client]);
  await phase('digest-generation',async()=>{
    const first=await request('/benchmark/digest',{port:3121}); assert.equal(first.enqueued,users.length);
    const second=await request('/benchmark/digest',{port:3121}); assert.equal(second.enqueued,0);
    const queued=Number((await db.query("select count(*) as n from email_queue where type='daily_digest'")).rows[0].n); assert.equal(queued,users.length);
    return {digests:queued,duplicateSweepEnqueued:second.enqueued};
  });
  const digestPayloads=(await db.query("select to_email,data from email_queue where type='daily_digest' order by to_email")).rows;
  const digestParity=`${dirname(config.output)}/parity-${config.round}-digests.json`;
  if(existsSync(digestParity)) assert.deepEqual(digestPayloads,JSON.parse(readFileSync(digestParity)),'all digest payloads retain exact dates, labels and items');
  else writeFileSync(digestParity,JSON.stringify(digestPayloads));
  await request('/benchmark/email',{port:3121});
  assert.equal(smtpAccepted.size,100+users.length);
  assert.equal(Number((await db.query("select count(*) as n from email_queue where status<>'success'")).rows[0].n),0);
  const expired=(await db.query("insert into activity_event(client_id,workspace_id,board_id,actor_id,entity_type,entity_id,action,created_at) select $1,$2,$3,$4,'card',$5,'updated','2000-01-01' from generate_series(1,10000) returning id",[client,workspace,board,owner,cards[0].id])).rows.map(x=>x.id);
  await db.query("insert into notification(user_id,client_id,activity_id,card_id,list_id,board_id,workspace_id,reason) select $1,$2,id,$3,$4,$5,$6,'assigned' from activity_event where id=any($7::uuid[])",[owner,client,cards[0].id,cards[0].list_id,board,workspace,expired]);
  let deleted=0; sockets[0].on('notification:deleted',({notificationIds})=>{deleted+=notificationIds.length;});
  await phase('retention-backlog',async()=>{
    const readLatency=await withReads(()=>jobs(['retention-cleanup']));
    await until(()=>deleted===10000,'retention deletion realtime');
    assert.equal(Number((await db.query('select count(*) as n from activity_event where id=any($1::uuid[])',[expired])).rows[0].n),0);
    assert.equal(Number((await db.query('select count(*) as n from notification where activity_id=any($1::uuid[])',[expired])).rows[0].n),0);
    return {activitiesDeleted:10000,notificationsDeleted:deleted,readLatency};
  });
  }
  assert.deepEqual(errors,[]); result.servers=[]; result.correctness={errors,emailAccepted:smtpAccepted.size,websocketReceipts:receipts.length};
  writeFileSync(config.output,JSON.stringify(result,null,2));
} finally {
  closing=true; for(const socket of sockets) socket.disconnect();
  for(const socket of smtpConnections) socket.destroy();
  smtp.close(); receiver.closeAllConnections(); receiver.close(); await db.end();
}
