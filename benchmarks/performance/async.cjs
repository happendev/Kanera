// Reproducible, loopback-only before/after probes. No database or external service is contacted.
// Baseline: KANERA_PERF_REF=<commit> KANERA_PERF_OUTPUT=/tmp/before.json node benchmarks/performance/async.cjs
// Current:  KANERA_PERF_OUTPUT=/tmp/after.json node benchmarks/performance/async.cjs
// Functions are extracted verbatim from the selected source using TypeScript; stubs count DB work,
// and actual TCP SMTP/S3 fixtures measure protocol waits and connection reuse. These are isolated
// measurements, not predictions of production response time.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const sourceRef = process.env.KANERA_PERF_REF;
function source(rel) { return sourceRef ? execFileSync('git', ['show', `${sourceRef}:${rel}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, rel), 'utf8'); }
const req = createRequire(root + '/apps/api/package.json');
const ts = req('typescript');
function extract(rel, names, globals = {}) {
 const text = source(rel);
 const file = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
 const parts = file.statements.filter(s => s.name && names.includes(s.name.text) || ts.isVariableStatement(s) && s.declarationList.declarations.some(d => names.includes(d.name.text))).map(s => s.getText(file).replace(/^export\s+/, ''));
 assert.equal(parts.length, names.length, 'all requested source declarations present: '+names.join(','));
 const js = ts.transpileModule(parts.join('\n') + '\nglobalThis.extracted = {'+names.join(',')+'};', { compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.None}}).outputText;
 const ctx = vm.createContext({console, setTimeout,clearTimeout,Buffer,Date,Promise,Map,Set,performance,AbortSignal,AbortController,...globals});
 vm.runInContext(js, ctx, {filename:rel});
 return ctx.extracted;
}
const sql = (...args)=>args;
const noop = (...args)=>args;
const base = {eq:noop,and:noop,inArray:noop,asc:noop,lt:noop,lte:noop,isNull:noop,gt:noop,or:noop,sql};
function chain(value, onResolve) {const q=new Proxy({}, {get(_,key){ if(key==='then')return (resolve,reject)=>{onResolve?.();return Promise.resolve(value).then(resolve,reject)}; return ()=>q;}});return q;}
const output = [];
async function testWebhooks(){
 let release;const gate = new Promise(r=>release=r);let called=0;
 let start,deliveredAt;
 const mod=extract('apps/api/src/lib/webhooks.ts',['processWebhookDeliveries', ...(source('apps/api/src/lib/webhooks.ts').includes('async function processRegularWebhookDeliveries(') ? ['processRegularWebhookDeliveries'] : [])],{
  processMcpEventDeliveries:()=>gate,postMcpWebhook:noop,claimWebhookDeliveries:async()=>[{id:'regular-delivery'}],
  deliverWebhookDelivery:async()=>{called++;deliveredAt=performance.now()-start},DELIVERY_CONCURRENCY:5,DELIVERY_LIMIT:25});
 start=performance.now();const pending=mod.processWebhookDeliveries();
 await new Promise(r=>setTimeout(r,120));const whileBlocked=called;
 release(false);await pending;assert.equal(called,1);if(!sourceRef)assert.equal(whileBlocked,1,'regular delivery must start before MCP settles');
 output.push({finding:'MCP drain blocks regular webhooks',regularCallsBeforeMcpSettled:whileBlocked,regularStartDelayMs:Math.round(deliveredAt),injectedMcpDelayMs:120});
}
async function testOutboxEndpointCache(){
 let selects=0;
 const events=Array.from({length:50},(_,i)=>({id:String(i),workspaceId:'w',eventType:'card:updated',realtimeDispatched:true,webhooksEnqueued:false}));
 const db={select:()=>{selects++;return chain([])},update:()=>chain([]),transaction:async f=>f({execute:async()=>({rows:events}),select:()=>chain(events)})};
 const webhook=extract('apps/api/src/lib/webhooks.ts',['loadEnabledEndpointsByWorkspace','enqueueWebhookDeliveriesForOutboxEvent'],{
 ...base,db,webhookEndpoints:{},ENDPOINT_FANOUT_LIMIT:1000,enqueueMcpEventDeliveries:async()=>{},endpointIdFromPayload:()=>null,eventTypesMatch:()=>false,enrichChatPayloads:async()=>[]});
 const outbox=extract('apps/api/src/realtime/outbox.ts',['processEvent','processRealtimeOutbox'],{
 ...base,db,eventOutbox:{},DEFAULT_PROCESS_LIMIT:50,PROCESSING_LEASE_SECONDS:30,...webhook,
 loadActiveMcpSubscriptionsByWorkspace:async()=>new Map(),dependencies:{enqueueWebhookDeliveriesForOutboxEvent:webhook.enqueueWebhookDeliveriesForOutboxEvent}});
 const result=await outbox.processRealtimeOutbox();assert.equal(result.processed,50);if(!sourceRef)assert.equal(selects,1,'empty endpoint results must remain cached');
 output.push({finding:'Endpoint SELECTs for an empty workspace',events:50,workspaceCount:1,endpointCount:0,actualEndpointSelects:selects});
}
async function testMirrorIdle(){
 const mirrors=Array.from({length:100},(_,i)=>({id:'m'+i,sourceBoardId:'b'+i,targetBoardId:'t'+i,sourceWorkspaceId:'w',targetWorkspaceId:'w',lastSyncAt:new Date(),createdAt:new Date(),cursorEventCreatedAt:new Date(),cursorEventId:'0'}));
 let selects=0,updates=0,transactions=0;const mirrorTable={},eventTable={};
 const readyCheck=source('apps/api/src/lib/board-mirror/drain.ts').includes('hasPendingEvents:');
 const rows=readyCheck?mirrors.map(mirror=>({mirror,hasPendingEvents:false})):mirrors;
 const db={select:()=>{const first=selects++===0;return chain(first?rows:[])},update:()=>{updates++;return chain([])},transaction:async f=>{transactions++;return f(db)}};
 const mod=extract('apps/api/src/lib/board-mirror/drain.ts',['assertStructuralLoopPrevention','enqueueDirtySignals','drainMirror','processBoardMirrors'],{
 ...base,db,boardMirrors:mirrorTable,eventOutbox:eventTable,boardMirrorDirtyCards:{},TAIL_BATCH_SIZE:100,IDLE_CHECKPOINT_INTERVAL_MS:60000,GAP_SAFETY_MARGIN_MS:3600000,env:{REALTIME_OUTBOX_RETENTION_DAYS:7},boardSyncEligibleWorkspaceIds:async()=>new Set(['w']),applyDirtyCards:async()=>({processed:0,drainedFull:false}),reconcileMirror:async()=>{},dispatchMirrorEvent:()=>null});
 const result=await mod.processBoardMirrors();assert.equal(result.tailedEvents,0);if(!sourceRef){assert.equal(selects,1);assert.equal(updates,0);assert.equal(transactions,0);}
 output.push({finding:'Idle mirror poll touches every active mirror',mirrors:100,events:0,selects,updates,transactions,note:'excludes entitlement lookup and dirty-card lookup, which are mocked'});
}
async function testSmtp(){
 let connections=0;const sockets=new Set();
 const server=net.createServer(socket=>{connections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setEncoding('utf8');socket.write('220 local audit SMTP\r\n');let buf='',data=false;socket.on('data',chunk=>{buf+=chunk;for(;;){if(data){const end=buf.indexOf('\r\n.\r\n');if(end<0)break;buf=buf.slice(end+5);data=false;socket.write('250 accepted\r\n');continue;}const end=buf.indexOf('\r\n');if(end<0)break;const line=buf.slice(0,end);buf=buf.slice(end+2);if(line==='DATA'){data=true;socket.write('354 body\r\n');}else if(line==='QUIT'){socket.write('221 bye\r\n');}else socket.write('250 accepted\r\n');}})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const names=['SmtpProbe','sendEmail','formatAddress','buildMimeMessage','buildTextMessage','extraHeaderLines','encodeBase64Body','escapeData','smtpIdentityDomain','messageIdDomain','domainFromEmail','domainFromAddress','normalizeSmtpDomain'];
 const mod=extract('apps/api/src/lib/smtp.ts',names,{net,crypto,env:{},tls:require('node:tls')});
 const times=[];for(let i=0;i<10;i++){const start=performance.now();await mod.sendEmail({config:{host:'127.0.0.1',port:server.address().port,security:'none',fromEmail:'audit@example.test'},to:'local@example.test',subject:'audit',html:'local test'});times.push(performance.now()-start);}
 for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));
 const total=times.reduce((a,b)=>a+b,0);output.push({finding:'SMTP 25ms response polling plus serial sends creates artificial latency',messages:10,localInstantResponseServer:true,connections,totalMs:Math.round(total),meanMs:Math.round(total/10),timesMs:times.map(Math.round)});
}
async function testS3(){
 let connections=0;const sockets=new Set();
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':'4'});res.end('data')});
 server.on('connection',s=>{connections++;sockets.add(s);s.on('close',()=>sockets.delete(s))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let cached={};
 if(source('apps/api/src/lib/storage/s3.ts').includes('acquireS3Client')) cached=extract('apps/api/src/lib/storage/s3-client-cache.ts',['MAX_IDLE_CLIENTS','IDLE_TTL_MS','clients','cleanupTimer','pruneIdleClients','acquireS3Client'],{...req('@aws-sdk/client-s3'),createHash:crypto.createHash});
 const mod=extract('apps/api/src/lib/storage/s3.ts',['S3_OPERATION_TIMEOUT_MS','createS3Storage','totalLengthFromContentRange'],{...req('@aws-sdk/client-s3'),Readable,...cached});
 const config={kind:'s3',region:'us-east-1',endpoint:`http://127.0.0.1:${server.address().port}`,bucket:'audit',accessKeyId:'audit',secretAccessKey:'audit'};
 for(let i=0;i<10;i++){const object=await mod.createS3Storage('audit',config).getObject('image.jpg');for await(const chunk of object.body){}}
 const newProviderConnections=connections;
 const reused=mod.createS3Storage('audit',{...config,accessKeyId:'reused'});for(let i=0;i<10;i++){const object=await reused.getObject('image.jpg');for await(const chunk of object.body){}}
 const reusedProviderConnections=connections-newProviderConnections;
 assert.equal(reusedProviderConnections,1);if(!sourceRef)assert.equal(newProviderConnections,1);
 let retainedAfterChurn=null;
 if(cached.clients){for(let i=0;i<100;i++){await mod.createS3Storage('audit',{...config,accessKeyId:'churn-'+i}).get('image.jpg')}retainedAfterChurn=cached.clients.size;assert.equal(retainedAfterChurn,32);}
 for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));
 output.push({finding:'Each media storage lookup creates a new S3 client/socket pool',requestsPerCase:10,newProviderConnections,reusedProviderConnections,retainedAfter100Configs:retainedAfterChurn,endpoint:'local test HTTP only'});
}
(async()=>{await testWebhooks();await testOutboxEndpointCache();await testMirrorIdle();await testSmtp();await testS3();const report={source:sourceRef??'working-tree',results:output};if(process.env.KANERA_PERF_OUTPUT)fs.writeFileSync(process.env.KANERA_PERF_OUTPUT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));})().catch(e=>{console.error(e);process.exitCode=1});
