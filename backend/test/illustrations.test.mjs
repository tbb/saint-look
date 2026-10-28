import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { illustrationFixture } from './providers/illustration.mjs';

function illustration(photo, changes = {}) {
  return { operationId: randomUUID(), photoVersionId: photo.photoVersionId,
    sourceSetVersionId: randomUUID(), revision: 1,
    photos: [{ id: photo.photoVersionId, role: 'front', imageBase64: photo.imageBase64 }], ...changes };
}
function requestIllustration(server, itemId, input) {
  return server.request(`/v1/items/${itemId}/illustrations`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}
async function waitForIllustration(server, itemId, operationId, status = 'ready') {
  for (let i = 0; i < 150; i++) {
    const response = await server.request(`/v1/items/${itemId}/illustrations/${operationId}`);
    const value = await response.json();
    if (value.status === status) return value;
    if (value.status === 'failed') throw new Error(JSON.stringify(value));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Illustration never completed');
}

test('unavailable illustration service keeps an existing wardrobe item usable without starting generation', async t => {
  const env = await environment(t), server = await env.launch();
  const photo = await photoRequest();
  await upload(server, photo);
  await waitForItem(server, photo.itemId);
  assert.equal((await (await server.request('/health')).json()).illustrationAvailable, false);
  const response = await requestIllustration(server, photo.itemId, illustration(photo));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'illustration_unavailable' });
  assert.equal((await (await server.request(`/v1/items/${photo.itemId}`)).json()).status, 'ready');
});

test('single photo produces a separate transparent illustration with observed traits and durable delivery', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo);
  const response = await requestIllustration(server, photo.itemId, input);
  assert.equal(response.status, 202);
  const ready = await waitForIllustration(server, photo.itemId, input.operationId);
  assert.equal(ready.photoVersionId, photo.photoVersionId);
  assert.equal(ready.sourceSetVersionId, input.sourceSetVersionId);
  assert.equal(ready.mode, 'test');
  assert.equal(ready.observedFeatures.type, 'Футболка');
  assert.deepEqual(ready.effectiveFeatures.colors, ['Красный']);
  assert.equal(ready.effectiveFeatures.traits.silhouette, 'unknown');
  assert.deepEqual(ready.processing, { preparation: 'done', attributes: 'done', generation: 'done', finalization: 'skipped' });
  const image = await server.request(ready.resultPath);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), fixture.result);
  assert.equal((await (await server.request(`/v1/items/${photo.itemId}`)).json()).status, 'ready');
  assert.equal((await server.request(`/v1/items/${photo.itemId}/illustrations/${input.operationId}/ack`, { method: 'POST' })).status, 204);
  assert.equal((await server.request(ready.resultPath)).status, 410);
  assert.equal((await server.request(`/v1/items/${photo.itemId}/result`)).status, 200);
});

test('multiple views preserve manual type and colors, reuse prepared photos, and reject mutated identities', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const initial = illustration(photo);
  await requestIllustration(server, photo.itemId, initial);
  await waitForIllustration(server, photo.itemId, initial.operationId);
  const detail = await photoRequest();
  const update = illustration(photo, { revision: 2, manualType: 'Худи', manualColors: ['Чёрный'],
    photos: [...initial.photos, { id: detail.photoVersionId, role: 'detail', imageBase64: detail.imageBase64 }] });
  assert.equal((await requestIllustration(server, photo.itemId, update)).status, 202);
  const ready = await waitForIllustration(server, photo.itemId, update.operationId);
  assert.equal(ready.observedFeatures.type, 'Футболка');
  assert.equal(ready.effectiveFeatures.type, 'Худи');
  assert.deepEqual(ready.effectiveFeatures.colors, ['Чёрный']);
  // External boundary accounting: unchanged source must not consume sandbox quota twice.
  assert.equal(fixture.calls.preparation.length, 2);
  const payload = JSON.parse(fixture.calls.attributes.at(-1).body);
  assert.deepEqual(Object.keys(payload.state), ['photo_0_prepared_front', 'photo_1_original_front', 'photo_2_prepared_detail', 'photo_3_original_detail']);
  assert.ok(JSON.parse(fixture.calls.generation.at(-1).body).prompt.includes('Худи'));
  assert.equal((await requestIllustration(server, photo.itemId, update)).status, 200);
  assert.equal((await requestIllustration(server, photo.itemId, { ...update, manualColors: ['Белый'] })).status, 409);
  const changedSet = { ...update, operationId: randomUUID(), revision: 3, photos: initial.photos };
  const conflict = await requestIllustration(server, photo.itemId, changedSet);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'identity_conflict');
});
