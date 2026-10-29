// Explicit opt-in: installed pinned assets + a real public photograph, no downloads/API keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { environment, upload, waitForItem } from './support.mjs';
import { illustrationFixture } from './providers/illustration.mjs';

const post = (server, path, body) => server.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function wait(server, path) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await server.request(path), value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    if (value.status === 'ready') return value;
    assert.notEqual(value.status, 'failed', JSON.stringify(value));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Real preparation deadline exceeded');
}
test('installed real checkpoint prepares a public photograph through HTTP and commits the full version',
  { skip: process.env.SAINT_LOOK_REAL_MODEL_TEST !== '1', timeout: 180_000 }, async t => {
    for (const key of ['SAINT_LOOK_REAL_MODEL_PHOTO', 'SAINT_LOOK_MODEL_PYTHON', 'SAINT_LOOK_MODEL_ASSETS']) assert.ok(process.env[key], `${key} is required`);
    const source = await readFile(process.env.SAINT_LOOK_REAL_MODEL_PHOTO);
    const png = await sharp(source).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const fixture = await illustrationFixture(t, { modelDisabled: true, colors: {} });
    const env = await environment(t), server = await env.launch({ ...fixture.env, SAINT_LOOK_TEST_MODEL_ORIGIN: '',
      SAINT_LOOK_MODEL_PROFILE: 'outfit-transformer-labse-v1', SAINT_LOOK_MODEL_THREADS: '1' });
    const config = await (await server.request('/v1/recommendations/config')).json();
    assert.equal(config.encoder.mode, 'real'); assert.equal(config.encoder.available, true);
    const photo = { itemId: randomUUID(), operationId: randomUUID(), photoVersionId: randomUUID(), imageBase64: png.toString('base64') };
    assert.equal((await upload(server, photo)).status, 202); const cutout = await waitForItem(server, photo.itemId);
    const illustrationId = randomUUID(), sourceSetVersionId = randomUUID();
    assert.equal((await post(server, `/v1/items/${photo.itemId}/illustrations`, { operationId: illustrationId, photoVersionId: photo.photoVersionId,
      sourceSetVersionId, revision: 1, photos: [{ id: photo.photoVersionId, role: 'front', imageBase64: photo.imageBase64 }] })).status, 202);
    await wait(server, `/v1/items/${photo.itemId}/illustrations/${illustrationId}`);
    const preparationId = randomUUID(), start = performance.now();
    assert.equal((await post(server, `/v1/items/${photo.itemId}/preparations`, { operationId: preparationId, revision: 1,
      photoVersionId: photo.photoVersionId, sourceSetVersionId, illustrationOperationId: illustrationId, cutoutOperationId: photo.operationId,
      spaceID: config.encoder.activeSpaceID, mode: 'fromIllustration', imageBase64: photo.imageBase64, features: { type: 't_shirt', colors: [] } })).status, 202);
    const preparedPath = `/v1/items/${photo.itemId}/preparations/${preparationId}`;
    const prepared = await wait(server, preparedPath);
    const prepareMilliseconds = performance.now() - start;
    assert.equal(prepared.mode, 'real'); assert.equal(prepared.imageMode, 'test');
    assert.equal(prepared.artifacts.cutoutSHA256, cutout.resultSHA256);
    assert.equal(prepared.input.textSHA256, createHash('sha256').update('t shirt.').digest('hex'));
    assert.equal(prepared.input.sourceSHA256, createHash('sha256').update(png).digest('hex'));
    assert.equal(prepared.representationSHA256, createHash('sha256').update(prepared.representationJSON).digest('hex'));
    const ackPath = `/v1/items/${photo.itemId}/illustrations/${illustrationId}/ack`;
    const ack = { publicationProtocol: 'prepared-item-v1', preparationOperationId: preparationId };
    assert.equal((await post(server, ackPath, ack)).status, 204);
    assert.equal((await server.request(preparedPath)).status, 410);
    assert.equal((await post(server, ackPath, ack)).status, 204);
    assert.equal(fixture.calls.model.length, 0, 'The controlled model endpoint was never used');
    console.log(JSON.stringify({ evidence: 'real-model-http-publication', imageProviders: 'controlled', model: 'real',
      sourceSHA256: prepared.input.sourceSHA256, publicFileSHA256: createHash('sha256').update(source).digest('hex'),
      spaceID: prepared.spaceID, representationSHA256: prepared.representationSHA256, prepareMilliseconds: Math.round(prepareMilliseconds),
      representationBytes: Buffer.byteLength(prepared.representationJSON), committed: true }));
  });
