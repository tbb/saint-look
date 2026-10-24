import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';

test('a photo becomes an explicitly demo card through the asynchronous public API', async (t) => {
  const env = await environment(t);
  const server = await env.launch();
  const request = await photoRequest();
  const accepted = await upload(server, request);
  assert.equal(accepted.status, 202);
  const pending = await accepted.json();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.mode, 'demo');
  const ready = await waitForItem(server, request.itemId);
  assert.deepEqual({ itemId: ready.itemId, operationId: ready.operationId, photoVersionId: ready.photoVersionId },
    { itemId: request.itemId, operationId: request.operationId, photoVersionId: request.photoVersionId });
  assert.equal(ready.type, 'Футболка');
  assert.deepEqual(ready.colors, ['Синий']);
  assert.equal(ready.mode, 'demo');
  const image = await server.request(ready.resultPath);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
  assert.equal(metadata.hasAlpha, true);
});

test('uploads, item status and images require the owner credential', async (t) => {
  const env = await environment(t);
  const server = await env.launch();
  const request = await photoRequest();
  const deniedUpload = await fetch(server.url + '/v1/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(deniedUpload.status, 401);
  await upload(server, request);
  const ready = await waitForItem(server, request.itemId);
  for (const path of [`/v1/items/${request.itemId}`, ready.resultPath]) {
    const response = await fetch(server.url + path, { headers: { Authorization: 'Bearer unrelated-owner-token-not-authorized' } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
});

test('a controlled processing error remains failed rather than publishing a ready card', async (t) => {
  const env = await environment(t);
  const server = await env.launch({ SAINT_LOOK_DEMO_OUTCOME: 'fail' });
  const request = await photoRequest();
  await upload(server, request);
  const failed = await waitForItem(server, request.itemId, 'failed');
  assert.equal(failed.error, 'processing_failed');
  assert.equal(failed.type, null);
  assert.equal(failed.resultPath, null);
  assert.equal((await server.request(`/v1/items/${request.itemId}/result`)).status, 409);
});

test('malformed identities, unsupported images and oversized requests never become jobs', async (t) => {
  const env = await environment(t);
  const server = await env.launch();
  const valid = await photoRequest();
  assert.equal((await upload(server, { ...valid, itemId: '../another-item' })).status, 400);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>');
  assert.equal((await upload(server, { ...valid, imageBase64: svg.toString('base64') })).status, 415);
  assert.equal((await server.request('/v1/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(8 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await server.request(`/v1/items/${valid.itemId}`)).status, 404);
});

test('replaying one operation returns the same item while conflicting identities or photos are rejected', async (t) => {
  const env = await environment(t);
  const server = await env.launch();
  const request = await photoRequest();
  assert.equal((await upload(server, request)).status, 202);
  const replay = await upload(server, request);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).operationId, request.operationId);
  assert.equal((await upload(server, { ...request, itemId: request.itemId.toUpperCase(), operationId: request.operationId.toUpperCase(), photoVersionId: request.photoVersionId.toUpperCase() })).status, 200);
  const other = await photoRequest();
  for (const conflict of [{ ...request, operationId: other.operationId }, { ...request, itemId: other.itemId }, { ...request, photoVersionId: other.photoVersionId },
    { ...request, imageBase64: (await sharp({ create: { width: 8, height: 8, channels: 3, background: 'green' } }).png().toBuffer()).toString('base64') }]) {
    assert.equal((await upload(server, conflict)).status, 409);
  }
  assert.equal((await server.request(`/v1/items/${other.itemId}`)).status, 404);
});

test('ready cards and accepted pending identities survive a backend restart', async (t) => {
  const env = await environment(t);
  let server = await env.launch();
  const request = await photoRequest();
  await upload(server, request);
  const ready = await waitForItem(server, request.itemId);
  const original = Buffer.from(await (await server.request(ready.resultPath)).arrayBuffer());
  await server.stop();
  server = await env.launch({ SAINT_LOOK_DEMO_DELAY_MS: '60000' });
  assert.deepEqual(await (await server.request(`/v1/items/${request.itemId}`)).json(), ready);
  assert.deepEqual(Buffer.from(await (await server.request(ready.resultPath)).arrayBuffer()), original);
  const pending = await photoRequest();
  await upload(server, pending);
  await server.stop();
  server = await env.launch();
  const retained = await (await server.request(`/v1/items/${pending.itemId}`)).json();
  assert.equal(retained.status, 'pending');
  assert.equal(retained.operationId, pending.operationId);
});

test('embedded photo metadata does not change the normalized photo accepted for the same operation', async (t) => {
  const env = await environment(t);
  const server = await env.launch();
  const request = await photoRequest();
  const tagged = await sharp(Buffer.from(request.imageBase64, 'base64')).withExif({ IFD0: { Artist: 'private synthetic fixture metadata' } }).png().toBuffer();
  assert.ok((await sharp(tagged).metadata()).exif);
  assert.equal((await upload(server, { ...request, imageBase64: tagged.toString('base64') })).status, 202);
  assert.equal((await upload(server, request)).status, 200);
});


test('a photo-sized upload is accepted while an image exceeding the pixel limit is rejected', async (t) => {
  const env = await environment(t);
  const server = await env.launch();
  const request = await photoRequest();
  const photo = await sharp(randomBytes(900 * 900 * 3), { raw: { width: 900, height: 900, channels: 3 } }).png().toBuffer();
  assert.equal((await upload(server, { ...request, imageBase64: photo.toString('base64') })).status, 202);
  await waitForItem(server, request.itemId);
  const oversizedPixels = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: 'blue' } }).png().toBuffer();
  const other = await photoRequest();
  assert.equal((await upload(server, { ...other, imageBase64: oversizedPixels.toString('base64') })).status, 400);
  assert.equal((await server.request(`/v1/items/${other.itemId}`)).status, 404);
});
