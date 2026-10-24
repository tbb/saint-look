import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
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
