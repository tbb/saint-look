import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { providerFixture } from './providers/fixture.mjs';

function ack(server, item, options = {}) {
  return server.request(`/v1/items/${item.itemId}/operations/${item.operationId}/ack`, { method: 'POST', ...options });
}

async function assertCleared(server, item, reason) {
  for (const suffix of ['', `/operations/${item.operationId}`]) {
    const response = await server.request(`/v1/items/${item.itemId}${suffix}`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.status, 'failed');
    assert.equal(state.error, reason);
    assert.equal(state.type, null);
    assert.deepEqual(state.colors, []);
    assert.equal(state.resultPath, null);
    const result = await server.request(`/v1/items/${item.itemId}${suffix}/result`);
    assert.equal(result.status, 410);
    assert.deepEqual(await result.json(), { error: reason });
  }
}

test('owner acknowledgement clears a saved result and is safe to repeat after restart', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const item = await photoRequest();
  assert.equal((await upload(server, item)).status, 202);
  const ready = await waitForItem(server, item.itemId);
  const saved = Buffer.from(await (await server.request(ready.resultPath)).arrayBuffer());
  assert.deepEqual(saved, fixture.cutout);
  assert.equal((await ack(server, item, { headers: { Authorization: 'Bearer wrong-owner' } })).status, 401);
  assert.equal((await server.request(ready.resultPath)).status, 200);
  const confirmed = await ack(server, item);
  assert.equal(confirmed.status, 204);
  assert.equal(await confirmed.text(), '');
  await assertCleared(server, item, 'result_delivered');
  assert.equal((await ack(server, item)).status, 204);
  assert.equal((await upload(server, item)).status, 200);
  await assertCleared(server, item, 'result_delivered');
  await server.stop();
  const restarted = await env.launch(fixture.env);
  assert.equal((await ack(restarted, item)).status, 204);
  await assertCleared(restarted, item, 'result_delivered');
  assert.deepEqual(saved, fixture.cutout, 'Clearing the server copy cannot alter the downloaded bytes');
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
});

async function clockFor(env) {
  const path = join(env.directory, 'clock.json');
  async function advance(offsetMs) {
    await writeFile(path + '.next', JSON.stringify({ offsetMs }));
    await rename(path + '.next', path);
  }
  await advance(0);
  return { advance, env: { SAINT_LOOK_TEST_CLOCK_FILE: path } };
}

test('a ready result expires seven days from upload and replay never renews its lifetime', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const clock = await clockFor(env);
  const server = await env.launch({ ...fixture.env, ...clock.env });
  const item = await photoRequest();
  await upload(server, item);
  const ready = await waitForItem(server, item.itemId);
  await clock.advance(6 * 24 * 60 * 60 * 1000);
  assert.equal((await upload(server, item)).status, 200);
  assert.equal((await server.request(ready.resultPath)).status, 200);
  await clock.advance(7 * 24 * 60 * 60 * 1000);
  await assertCleared(server, item, 'result_expired');
  assert.equal((await upload(server, item)).status, 200);
  await assertCleared(server, item, 'result_expired');
  assert.equal((await ack(server, item)).status, 204);
  await server.stop();
  const restarted = await env.launch({ ...fixture.env, ...clock.env });
  await assertCleared(restarted, item, 'result_expired');
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
});

function attempt(server, item) {
  return server.request(`/v1/items/${item.itemId}/attempts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item),
  });
}

test('explicit retry after delivery uses the local original and an old acknowledgement cannot clear its new result', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const original = await photoRequest();
  await upload(server, original);
  await waitForItem(server, original.itemId);
  assert.equal((await ack(server, original)).status, 204);
  const retry = { ...original, operationId: randomUUID(), revision: 1, action: 'retry' };
  assert.equal((await attempt(server, retry)).status, 202);
  const ready = await waitForItem(server, retry.itemId);
  assert.equal(ready.operationId, retry.operationId);
  assert.equal((await ack(server, original)).status, 204);
  assert.equal((await server.request(ready.resultPath)).status, 200);
  assert.equal((await attempt(server, retry)).status, 200);
  assert.equal(fixture.calls.attributes.length, 2);
  assert.equal(fixture.calls.cutout.length, 2);
});
