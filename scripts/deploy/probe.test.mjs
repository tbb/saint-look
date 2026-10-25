import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const run = (overrides, args = []) => new Promise(resolve => {
    const child = spawn(process.execPath, [command, ...args], { env: { ...process.env,
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


test('a retained synthetic result survives a new deployment identity and is explicitly cleaned up', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'saint-look-continuity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'canary.json');
  const health = { status: 'ok', mode: 'demo', revision, dataVersion: 1, deploymentId: 'deployment-new' };
  const f = await fixture(t, health, true);
  let result = await f.run({}, ['seed', file]);
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(readFileSync(file));
  assert.equal(state.status, 'ready');
  assert.match(state.resultSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /token|imageBase64/);
  assert.equal(f.requests.filter(r => r.url.endsWith('/ack') || r.method === 'DELETE').length, 0);
  health.revision = 'b'.repeat(40); health.deploymentId = 'deployment-restarted';
  const changed = { SAINT_LOOK_EXPECTED_REVISION: health.revision, SAINT_LOOK_EXPECTED_DEPLOYMENT_ID: health.deploymentId };
  result = await f.run(changed, ['verify', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).continuity, 'passed');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1, 'Verification must not re-upload the canary.');
  result = await f.run(changed, ['cleanup', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 1);
});

test('live readiness checks only health and refuses a synthetic smoke', async t => {
  const f = await fixture(t, { status: 'ok', mode: 'live', revision, dataVersion: 1, deploymentId: 'deployment-new' });
  const result = await f.run({ SAINT_LOOK_DEPLOYMENT_PROFILE: 'live' }, ['health']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'live');
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(r => r.url === '/health' && r.method === 'GET' && !r.authorization));
  assert.equal((await f.run({ SAINT_LOOK_DEPLOYMENT_PROFILE: 'live' })).code, 1);
  assert.ok(f.requests.every(r => r.url === '/health' && r.method === 'GET'));
});
