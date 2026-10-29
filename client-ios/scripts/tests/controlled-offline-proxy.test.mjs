import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const token = 'local-proxy-smoke-control';
const itemId = '00000000-0000-4000-8000-000000000001';
const operationId = '00000000-0000-4000-8000-000000000002';
const nextOperationId = '00000000-0000-4000-8000-000000000003';
const operationPath = `/v1/items/${itemId}/operations/${operationId}`;

async function fixture(t) {
  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    upstreamCalls++;
    response.writeHead(request.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/health' ? { mode: 'demo' } : { error: 'not_found' }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../ui-test-proxy.mjs', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'test', SAINT_LOOK_UI_PROXY_PORT: '0',
      SAINT_LOOK_UI_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      SAINT_LOOK_UI_TEST_CONTROL_TOKEN: token, SAINT_LOOK_TEST_CLOCK_FILE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'exit');
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Proxy startup timed out')), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]).url); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Proxy exited: ${code}`)); });
  });
  // Raw HTTP avoids transparent fetch retries when reset deliberately closes a held GET.
  const request = (path, body) => new Promise((resolve, reject) => {
    const outgoing = httpRequest(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode })));
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const control = async body => {
    const response = await request('/__control', body);
    assert.equal(response.status, 200);
    return response.json();
  };
  const held = async () => {
    const deadline = Date.now() + 3000;
    do {
      const state = await control();
      if (state.offlineHeldResponses?.length === 1) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.fail('Expected one held operation status');
  };
  const post = (operation = operationId, revision = 1) => request(`/v1/items/${itemId}/attempts`, {
    itemId, operationId: operation, revision, action: 'replace', imageBase64: 'not-recorded',
  });
  return { request, control, held, post, upstreamCalls: () => upstreamCalls };
}

test('controlled offline errors release exactly one status, prove new intent, never forward, reset, and fail on deadline', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  await f.control({ mode: 'controlled-offline', reset: true });
  const first = await f.post();
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: 'fixture_offline' });
  let state = await f.control();
  assert.equal(state.offlineAttemptedUploads, 1);
  assert.deepEqual(state.offlineLastAttempt, { itemId, operationId, revision: 1, action: 'replace', operationPath });
  assert.equal(JSON.stringify(state).includes('not-recorded'), false);
  const pending = f.request(operationPath);
  state = await f.held();
  const firstHeld = state.offlineHeldResponses[0];
  assert.equal(firstHeld.operationPath, operationPath);
  assert.equal(state.offlineStatusRequests, 1);
  const mismatch = await f.request('/__control', { mode: 'controlled-offline', releaseOfflineError: true,
    operationPath, heldRequestId: firstHeld.requestId + 1 });
  assert.equal(mismatch.status, 409);
  assert.equal((await f.control()).offlineHeldResponses.length, 1);
  await f.control({ mode: 'controlled-offline', releaseOfflineError: true, operationPath, heldRequestId: firstHeld.requestId });
  const released = await pending;
  assert.equal(released.status, 503);
  assert.deepEqual(await released.json(), { error: 'fixture_offline' });
  const nextPending = f.request(operationPath).catch(() => null);
  state = await f.held();
  assert.notEqual(state.offlineHeldResponses[0].requestId, firstHeld.requestId);
  assert.equal(state.offlineStatusRequests, 2);
  assert.equal(state.offlineReleasedErrors, 1);
  assert.equal(state.offlineTimeouts, 0);
  assert.equal(state.offlineFault, null);
  assert.equal((await f.post(nextOperationId, 2)).status, 503);
  state = await f.control();
  assert.equal(state.offlineAttemptedUploads, 2);
  assert.equal(state.offlineLastAttempt.operationId, nextOperationId);
  assert.equal(state.offlineLastAttempt.revision, 2);
  assert.equal(f.upstreamCalls(), 1, 'Only startup health reaches the fake upstream');
  assert.equal(state.forwardedUploads, 0);
  const resetPending = f.request(`/v1/items/${itemId}/operations/${nextOperationId}`).catch(() => null);
  await f.held();
  await f.control({ mode: 'online', reset: true });
  await nextPending;
  await resetPending;
  state = await f.control();
  assert.equal(state.offlineAttemptedUploads, 0);
  assert.equal(state.offlineHeldResponses.length, 0);
  assert.equal(state.offlineLastAttempt, null);
  assert.equal((await f.request(operationPath)).status, 404);
  assert.equal(f.upstreamCalls(), 2);
  await f.control({ mode: 'offline' });
  await assert.rejects(f.request(operationPath), 'Existing offline mode still disconnects the socket');
  assert.equal(f.upstreamCalls(), 2);

  await f.control({ mode: 'controlled-offline', reset: true });
  await f.post();
  const timed = f.request(operationPath);
  await f.held();
  const expired = await timed;
  assert.equal(expired.status, 504);
  assert.deepEqual(await expired.json(), { error: 'fixture_offline_hold_expired' });
  state = await f.control();
  assert.equal(state.offlineTimeouts, 1);
  assert.equal(state.offlineFault, 'hold_deadline_exceeded');
  assert.equal(state.offlineReleasedErrors, 0, 'Deadline must never masquerade as a released 503');
  assert.equal(state.offlineHeldResponses.length, 0);
  assert.equal((await f.request(operationPath)).status, 500, 'Poisoned fixture cannot manufacture another barrier');
  assert.equal(f.upstreamCalls(), 2);
  await f.control({ mode: 'online', reset: true });
  assert.equal((await f.control()).offlineFault, null);
});
