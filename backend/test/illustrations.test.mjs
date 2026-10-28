import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';

function illustration(photo, changes = {}) {
  return { operationId: randomUUID(), photoVersionId: photo.photoVersionId,
    sourceSetVersionId: randomUUID(), revision: 1,
    photos: [{ id: photo.photoVersionId, role: 'front', imageBase64: photo.imageBase64 }], ...changes };
}
function requestIllustration(server, itemId, input) {
  return server.request(`/v1/items/${itemId}/illustrations`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
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
