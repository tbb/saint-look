import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
