import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const command = resolve('scripts/deploy/probe.mjs');
const revision = 'a'.repeat(40);
async function fixture(t, health, smoke = false) {
  let item; let acknowledged = false;
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') response.end(JSON.stringify(health));
    else if (smoke) {
      assert.equal(request.headers.authorization, 'Bearer fixture-owner-token-000000000000000000');
      if (request.method === 'DELETE') { response.statusCode = 204; response.end(); }
      else if (request.url.endsWith('/ack')) { acknowledged = true; response.statusCode = 204; response.end(); }
      else if (request.url.endsWith('/result')) {
        if (acknowledged) { response.statusCode = 410; response.end(JSON.stringify({ error: 'result_delivered' })); }
        else { response.setHeader('Content-Type', 'image/png'); response.end(readFileSync(new URL('./synthetic.png', import.meta.url))); }
      } else {
        if (request.method === 'POST') {
          let body = ''; for await (const part of request) body += part;
          item = JSON.parse(body); response.statusCode = 202;
        }
        response.end(JSON.stringify({ ...item, mode: 'demo', status: 'ready', type: 'Футболка', colors: ['Синий'],
          resultPath: `/v1/items/${item.itemId}/operations/${item.operationId}/result` }));
      }
    } else { response.statusCode = 500; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const run = overrides => new Promise(resolve => {
    const child = spawn(process.execPath, [command], { env: { ...process.env,
      NODE_ENV: 'test', SAINT_LOOK_DEPLOY_TEST_ALLOW_HTTP: '1', SAINT_LOOK_PROBE_TIMEOUT_MS: '100',
      SAINT_LOOK_DEV_URL: `http://127.0.0.1:${server.address().port}`, SAINT_LOOK_EXPECTED_REVISION: revision,
      SAINT_LOOK_EXPECTED_DEPLOYMENT_ID: 'deployment-new', SAINT_LOOK_DEV_OWNER_TOKEN: 'fixture-owner-token-000000000000000000', ...overrides,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { requests, run };
}

test('an old instance with the same commit cannot satisfy the deployment readiness check', async t => {
  const f = await fixture(t, { status: 'ok', mode: 'demo', revision, dataVersion: 1, deploymentId: 'deployment-old' });
  const result = await f.run();
  assert.equal(result.code, 1); assert.match(result.stderr, /Selected deployment did not become ready/);
  assert.ok(f.requests.every(request => request.url === '/health' && !request.authorization));
  assert.doesNotMatch(result.stderr, /fixture-owner-token/);
});


test('a selected ready deployment accepts, delivers and cleans up a synthetic thing', async t => {
  const f = await fixture(t, { status: 'ok', mode: 'demo', revision, dataVersion: 1, deploymentId: 'deployment-new' }, true);
  const result = await f.run({ SAINT_LOOK_PROBE_TIMEOUT_MS: '1000' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.requests.filter(request => request.method === 'POST' && request.url === '/v1/items').length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith('/ack')).length, 1);
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  assert.equal(JSON.parse(result.stdout).smoke, 'passed');
});
