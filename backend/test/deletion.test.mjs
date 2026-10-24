import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { providerFixture } from './providers/fixture.mjs';

async function assertDeleted(server, item) {
  const path = `/v1/items/${item.itemId}`;
  for (const suffix of ['', '/result', `/operations/${item.operationId}`, `/operations/${item.operationId}/result`]) {
    const response = await server.request(path + suffix);
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: 'item_deleted' });
  }
}

test('only the owner can delete a completed thing, including its operation and result URLs', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const item = await photoRequest();
  assert.equal((await upload(server, item)).status, 202);
  const ready = await waitForItem(server, item.itemId);
  assert.deepEqual(Buffer.from(await (await server.request(ready.resultPath)).arrayBuffer()), fixture.cutout);
  const path = `/v1/items/${item.itemId}`;
  for (const authorization of ['', 'Bearer different-owner']) {
    assert.equal((await server.request(path, { method: 'DELETE', headers: { Authorization: authorization } })).status, 401);
    assert.equal((await server.request(ready.resultPath)).status, 200);
  }
  const deleted = await server.request(path, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), '');
  await assertDeleted(server, item);
  assert.equal((await server.request(path, { method: 'DELETE' })).status, 204);
  await server.stop();
  const restarted = await env.launch(fixture.env);
  await assertDeleted(restarted, item);
  assert.equal((await restarted.request(path, { method: 'DELETE' })).status, 204);
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
});

function attempt(server, input) {
  return server.request(`/v1/items/${input.itemId}/attempts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

async function assertRejected(response) {
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { error: 'item_deleted' });
}

test('deleted things reject old receipts and later retries or replacements even after restart', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const original = await photoRequest();
  await upload(server, original);
  await waitForItem(server, original.itemId);
  const replacement = { ...await photoRequest(), itemId: original.itemId, revision: 1, action: 'replace' };
  assert.equal((await attempt(server, replacement)).status, 202);
  await waitForItem(server, original.itemId);
  assert.equal((await server.request(`/v1/items/${original.itemId}`, { method: 'DELETE' })).status, 204);
  async function rejectReplays(target) {
    await assertRejected(await upload(target, original));
    await assertRejected(await attempt(target, replacement));
    await assertRejected(await attempt(target, { ...replacement, operationId: randomUUID(), revision: 2, action: 'retry' }));
    await assertRejected(await attempt(target, { ...await photoRequest(), itemId: original.itemId, revision: 50, action: 'replace' }));
    await assertDeleted(target, original);
    await assertDeleted(target, replacement);
  }
  await rejectReplays(server);
  await server.stop();
  const restarted = await env.launch(fixture.env);
  await rejectReplays(restarted);
  assert.equal(fixture.calls.attributes.length, 2);
  assert.equal(fixture.calls.cutout.length, 2);
});

test('deleting a never-uploaded UUID persists across restart and defeats a delayed upload body', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const item = await photoRequest();
  const path = `/v1/items/${item.itemId}`;
  assert.equal((await server.request(path)).status, 404);
  assert.equal((await server.request('/v1/items/not-a-uuid', { method: 'DELETE' })).status, 400);
  // Hold the real HTTP body open while the DELETE overtakes its admission.
  // Admission must check deletion after all asynchronous upload work.
  const body = JSON.stringify(item);
  let pending;
  const reply = new Promise((resolve, reject) => {
    pending = httpRequest(`${server.url}/v1/items`, { method: 'POST', headers: {
      Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      response.on('error', reject);
    });
    pending.on('error', reject);
  });
  t.after(() => pending.destroy());
  await new Promise((resolve, reject) => pending.write(body.slice(0, -1), error => error ? reject(error) : resolve()));
  assert.equal((await server.request(`/v1/items/${item.itemId.toUpperCase()}`, { method: 'DELETE' })).status, 204);
  pending.end(body.slice(-1));
  assert.deepEqual(await reply, { status: 410, body: { error: 'item_deleted' } });
  await assertDeleted(server, item);
  await server.stop();
  const restarted = await env.launch(fixture.env);
  assert.equal((await restarted.request(path, { method: 'DELETE' })).status, 204);
  await assertRejected(await upload(restarted, item));
  await assertRejected(await attempt(restarted, { ...item, operationId: randomUUID(), revision: 9, action: 'retry' }));
  await assertDeleted(restarted, item);
  assert.equal(fixture.calls.attributes.length, 0);
  assert.equal(fixture.calls.cutout.length, 0);
});

test('deleting queued work prevents provider calls before and after a backend restart', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const settings = { ...fixture.env, SAINT_LOOK_STAGE_DELAY_MS: '250' };
  const server = await env.launch(settings);
  const item = await photoRequest();
  assert.equal((await upload(server, item)).status, 202);
  assert.equal((await server.request(`/v1/items/${item.itemId}`, { method: 'DELETE' })).status, 204);
  await new Promise(resolve => setTimeout(resolve, 350));
  await assertDeleted(server, item);
  assert.equal(fixture.calls.attributes.length, 0);
  await server.stop();
  const restarted = await env.launch(settings);
  await new Promise(resolve => setTimeout(resolve, 350));
  await assertDeleted(restarted, item);
  assert.equal(fixture.calls.attributes.length, 0);
  assert.equal(fixture.calls.cutout.length, 0);
});

async function waitUntil(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Controlled external request was not reached');
}

for (const stage of ['attributes', 'cutout']) {
  for (const outcome of ['success', 'failure']) {
    test(`late ${stage} ${outcome} after deletion cannot publish a thing or start another provider stage`, async t => {
      let release;
      const fixture = await providerFixture(t, { [stage](request, response, { cutout, attributes }) {
        release = () => {
          if (outcome === 'failure') { response.writeHead(429); response.end(); }
          else if (stage === 'cutout') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(cutout); }
          else {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(attributes) }] } }] }));
          }
        };
      } });
      const env = await environment(t);
      const server = await env.launch({ ...fixture.env, SAINT_LOOK_PROVIDER_TIMEOUT_MS: '10000' });
      const item = await photoRequest();
      assert.equal((await upload(server, item)).status, 202);
      await waitUntil(() => release);
      assert.equal((await server.request(`/v1/items/${item.itemId}`, { method: 'DELETE' })).status, 204);
      release();
      await new Promise(resolve => setTimeout(resolve, 150));
      await assertDeleted(server, item);
      await assertRejected(await upload(server, item));
      assert.equal(fixture.calls.attributes.length, 1);
      assert.equal(fixture.calls.cutout.length, stage === 'cutout' ? 1 : 0);
      await server.stop();
      const restarted = await env.launch(fixture.env);
      await assertDeleted(restarted, item);
      assert.equal((await restarted.request(`/v1/items/${item.itemId}`, { method: 'DELETE' })).status, 204);
      assert.equal(fixture.calls.attributes.length, 1);
      assert.equal(fixture.calls.cutout.length, stage === 'cutout' ? 1 : 0);
    });
  }
}

test('a failed thing can be deleted without retrying its paid provider stages', async t => {
  const fixture = await providerFixture(t, { cutout(request, response) { response.writeHead(429); response.end(); } });
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const item = await photoRequest();
  assert.equal((await upload(server, item)).status, 202);
  assert.equal((await waitForItem(server, item.itemId, 'failed')).error, 'provider_quota_exceeded');
  assert.equal((await server.request(`/v1/items/${item.itemId}`, { method: 'DELETE' })).status, 204);
  await assertDeleted(server, item);
  await assertRejected(await attempt(server, { ...item, operationId: randomUUID(), action: 'retry', revision: 1 }));
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
});
