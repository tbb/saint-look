import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { providerFixture } from './providers/fixture.mjs';

test('an accepted queued photo completes after backend restart and keeps one operation', async (t) => {
  const env = await environment(t);
  const original = await env.launch({ SAINT_LOOK_DEMO_DELAY_MS: '10000' });
  const photo = await photoRequest();
  assert.equal((await upload(original, photo)).status, 202);
  await original.stop();
  const restarted = await env.launch({ SAINT_LOOK_DEMO_DELAY_MS: '20' });
  const ready = await waitForItem(restarted, photo.itemId);
  assert.equal(ready.operationId, photo.operationId);
  const replay = await upload(restarted, photo);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).status, 'ready');
});

async function waitForProcessing(server, itemId, expected) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const item = await (await server.request(`/v1/items/${itemId}`)).json();
    if (Object.entries(expected).every(([stage, state]) => item.processing?.[stage] === state)) return item;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Expected processing state was not reached');
}


test('restart reuses completed attributes and performs only the unstarted cutout stage', async (t) => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const original = await env.launch({ ...fixture.env, SAINT_LOOK_STAGE_DELAY_MS: '1000' });
  const photo = await photoRequest();
  assert.equal((await upload(original, photo)).status, 202);
  const pending = await waitForProcessing(original, photo.itemId, { attributes: 'done', cutout: 'pending' });
  assert.equal(pending.status, 'pending');
  await original.stop('SIGKILL');

  const restarted = await env.launch(fixture.env);
  const ready = await waitForItem(restarted, photo.itemId);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.type, 'Рубашка');
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
  assert.equal((await upload(restarted, photo)).status, 200);
  await restarted.stop();
  const again = await env.launch(fixture.env);
  assert.equal((await upload(again, photo)).status, 200);
  assert.equal((await waitForItem(again, photo.itemId)).photoVersionId, photo.photoVersionId);
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
});

test('a crash during an external stage preserves unknown outcome without calling it again', async (t) => {
  const fixture = await providerFixture(t, { cutout() { /* The provider accepted the request but has not replied. */ } });
  const env = await environment(t);
  const original = await env.launch(fixture.env);
  const photo = await photoRequest();
  assert.equal((await upload(original, photo)).status, 202);
  await waitForProcessing(original, photo.itemId, { attributes: 'done', cutout: 'in_flight' });
  for (let attempt = 0; fixture.calls.cutout.length === 0 && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fixture.calls.cutout.length, 1);
  await original.stop('SIGKILL');

  const restarted = await env.launch(fixture.env);
  const unknown = await waitForItem(restarted, photo.itemId, 'failed');
  assert.equal(unknown.error, 'processing_unknown');
  assert.deepEqual(unknown.processing, { attributes: 'done', cutout: 'unknown' });
  assert.equal((await upload(restarted, photo)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
  assert.equal((await restarted.request(`/v1/items/${photo.itemId}/result`)).status, 409);
});
