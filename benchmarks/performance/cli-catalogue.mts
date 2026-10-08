// Run with: node --import ./apps/cli/node_modules/tsx/dist/loader.mjs benchmarks/performance/cli-catalogue.mts
// Real CLI/MCP protocol on loopback with synthetic authentication and API responses. A cold session
// and fresh warm sessions must return identical data; only the public catalogue request disappears.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHttpHandler } from '../../apps/mcp/src/http.ts';
import { openToolSession } from '../../apps/cli/src/tools.ts';
const home = await mkdtemp(join(tmpdir(), 'kanera-cli-performance-'));
const previousHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = home;
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
console.info = () => {};
const upstream: string[] = [];
let revoked = false;
const api = createServer((req,res) => {
  upstream.push(req.url!);
  res.writeHead(revoked ? 401 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(revoked ? { code: 'UNAUTHORIZED' } : { userId: '00000000-0000-4000-8000-000000000001', scope: 'read' }));
});
let exchanges = 0;
const wire: {method:string;bytes:number}[] = [];
const results: unknown[] = [];
let mcp: ReturnType<typeof createServer> | undefined;
try {
  await new Promise<void>(resolve => api.listen(0,'127.0.0.1',resolve));
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  const handler = createMcpHttpHandler({ publicApiUrl: 'http://127.0.0.1:' + address.port, tokenExchange: async () => { exchanges++; return 'kanera_delegate_synthetic'; } });
  mcp = createServer(handler);
  await new Promise<void>(resolve => mcp!.listen(0,'127.0.0.1',resolve));
  const mcpAddress = mcp.address();
  assert.ok(mcpAddress && typeof mcpAddress !== 'string');
  const mcpUrl = 'http://127.0.0.1:' + mcpAddress.port + '/mcp';
  globalThis.fetch = async (url,init) => {
    const response = await originalFetch(url,init);
    if (String(url) === mcpUrl && typeof init?.body === 'string') {
      wire.push({ method: JSON.parse(init.body).method, bytes: (await response.clone().arrayBuffer()).byteLength });
    }
    return response;
  };
  const options = { mcpUrl, accessToken: async () => 'kanera_mcp_' + 'A'.repeat(43) };
  for (let sample = 0; sample < 3; sample++) {
    const before = { upstream: upstream.length, exchanges, wire: wire.length };
    const started = performance.now();
    const session = await openToolSession(options);
    try {
      const result = await session.call('session.get',{});
      assert.deepEqual(result, { userId: '00000000-0000-4000-8000-000000000001', scope: 'read' });
      const requests = wire.slice(before.wire);
      assert.equal(requests.filter(r => r.method === 'tools/list').length, sample === 0 ? 1 : 0);
      assert.equal(requests.filter(r => r.method === 'server/discover').length, 1);
      results.push({ sample, cache: sample === 0 ? 'cold' : 'warm', durationMs: performance.now()-started, toolCount: session.tools.length, exchanges: exchanges-before.exchanges, upstream: upstream.slice(before.upstream), requests, transferredBytes: requests.reduce((n,r)=>n+r.bytes,0) });
    } finally { await session.close(); }
  }
  revoked = true;
  await assert.rejects(openToolSession(options));
  const report = { results, revokedCredentialRejectedWithWarmCache: true };
  if (process.env.KANERA_PERF_OUTPUT) await writeFile(process.env.KANERA_PERF_OUTPUT, JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
} finally {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  api.closeAllConnections();
  mcp?.closeAllConnections();
  await Promise.all([new Promise<void>(resolve=>api.close(()=>resolve())),new Promise<void>(resolve=>mcp ? mcp.close(()=>resolve()) : resolve())]);
  if (previousHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
}
