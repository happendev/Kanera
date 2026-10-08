// Real nginx regression/performance proof: decoded bodies, cache policy, gzip negotiation and
// service-worker control files. Uses the production build, and only a disposable local container.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
const root = fileURLToPath(new URL('../../', import.meta.url));
const browser = join(root, 'apps/web/dist/web/browser');
const output = process.env.PERF_OUTPUT ?? '/tmp/kanera-performance-fixes/root/static-serving.json';
const name = 'kanera-performance-static-' + process.pid;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function request(origin, path, encoding = 'gzip') {
  return new Promise((resolve, reject) => {
    get(origin + path, { headers: { 'accept-encoding': encoding } }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}
try {
  docker('create', '--name', name, '--pull=never', '-p', '127.0.0.1::80', '--add-host', 'public-api:127.0.0.1', process.env.PERF_NGINX_IMAGE ?? 'nginx:1.30.4-alpine');
  docker('cp', join(root, 'apps/web/nginx.conf'), name + ':/etc/nginx/conf.d/default.conf');
  docker('cp', browser + '/.', name + ':/usr/share/nginx/html');
  docker('start', name);
  const origin = 'http://' + docker('port', name, '80/tcp').trim();
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await request(origin, '/health')).status, 200); break; }
    catch (error) { if (attempt === 30) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
  const ngsw = JSON.parse(await readFile(join(browser, 'ngsw.json'), 'utf8'));
  const assets = ngsw.assetGroups.find(g => g.name === 'app-shell').urls.filter(p => /\.(js|css)$/.test(p));
  const results = [];
  for (const path of assets) {
    const original = await readFile(join(browser, path));
    const response = await request(origin, path);
    assert.equal(response.status, 200, path);
    const hashed = /^\/(?:main|polyfills|styles|chunk)-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(path);
    if (hashed) assert.match(response.headers['cache-control'], /max-age=31536000, immutable/, path);
    else assert.equal(response.headers['cache-control'], 'no-cache', path);
    const encoded = response.headers['content-encoding'] === 'gzip';
    assert.deepEqual(encoded ? gunzipSync(response.body) : response.body, original, path);
    if (original.length >= 1024) assert.equal(encoded, true, path);
    results.push({ path, originalBytes: original.length, transferredBytes: response.body.length, gzip: encoded });
  }
  for (const path of ['/index.html', '/ngsw.json', '/ngsw-worker.js']) {
    const response = await request(origin, path);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-cache', path);
    assert.deepEqual(response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body, await readFile(join(browser, path)), path);
  }
  const identity = await request(origin, assets[0], 'identity');
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.deepEqual(identity.body, await readFile(join(browser, assets[0])));
  for (const path of ['/missing-bundle.js', '/chunk-AbCd_12345.js', '/media/missing.woff2']) {
    const missing = await request(origin, path);
    assert.equal(missing.status, 404, path);
    assert.equal(missing.headers['cache-control'], 'no-cache', path);
  }
  assert.equal((await request(origin, '/b/nonexistent-client-route')).status, 200);
  const result = { checkedAssets: results.length, originalBytes: results.reduce((n,r) => n+r.originalBytes,0), transferredBytes: results.reduce((n,r) => n+r.transferredBytes,0), decodedBytesIdentical: true, controlFilesRevalidate: true, assets: results };
  await mkdir(fileURLToPath(new URL('.', 'file://' + output)), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, assets: undefined }, null, 2));
} finally { try { docker('rm', '-f', name); } catch { /* Preserve the original failure. */ } }
