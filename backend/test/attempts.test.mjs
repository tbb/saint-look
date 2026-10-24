import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { providerFixture } from './providers/fixture.mjs';

function attempt(server, input) {
  return server.request(`/v1/items/${input.itemId}/attempts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

test('an explicit retry preserves the thing and photo, and replay never calls providers twice', async t => {
  let cutouts = 0;
  const fixture = await providerFixture(t, { cutout(request, response, { cutout }) {
    if (cutouts++ === 0) { response.writeHead(429); response.end(); }
    else { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(cutout); }
  } });
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const original = await photoRequest();
  assert.equal((await upload(server, original)).status, 202);
  const failed = await waitForItem(server, original.itemId, 'failed');
  assert.equal(failed.error, 'provider_quota_exceeded');
  const retry = { ...original, operationId: randomUUID(), revision: 1, action: 'retry' };
  assert.equal((await attempt(server, retry)).status, 202);
  assert.equal((await attempt(server, retry)).status, 200);
  const ready = await waitForItem(server, original.itemId);
  assert.equal(ready.operationId, retry.operationId);
  assert.equal(ready.photoVersionId, original.photoVersionId);
  assert.equal(ready.revision, 1);
  assert.equal(fixture.calls.attributes.length, 2);
  assert.equal(fixture.calls.cutout.length, 2);
  assert.equal((await attempt(server, retry)).status, 200);
  await server.stop();
  const restarted = await env.launch(fixture.env);
  assert.equal((await attempt(restarted, retry)).status, 200);
  assert.equal((await upload(restarted, original)).status, 409);
  assert.equal((await waitForItem(restarted, original.itemId)).operationId, retry.operationId);
  assert.equal(fixture.calls.attributes.length, 2);
  assert.equal(fixture.calls.cutout.length, 2);
});

async function waitUntil(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Controlled external request was not reached');
}

function attributesReply(response, attributes) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(attributes) }] } }] }));
}

for (const outcome of ['success', 'failure']) {
test(`late old cutout ${outcome} cannot replace the newer photo, its pinned result or its durable identity`, async t => {
  let releaseOld;
  let calls = 0;
  let attributesCalls = 0;
  const fixture = await providerFixture(t, {
    attributes(request, response, { attributes }) {
      attributesReply(response, { ...attributes, type: attributesCalls++ === 0 ? 'Пальто' : 'Рубашка' });
    },
    cutout(request, response, { cutout }) {
      if (calls++ === 0) releaseOld = () => {
        if (outcome === 'failure') { response.writeHead(429); response.end(); }
        else { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(cutout); }
      };
      else { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(cutout); }
    },
  });
  const env = await environment(t);
  const server = await env.launch({ ...fixture.env, SAINT_LOOK_PROVIDER_TIMEOUT_MS: '10000' });
  const original = await photoRequest();
  await upload(server, original);
  await waitUntil(() => releaseOld);
  const replacement = { ...await photoRequest(), itemId: original.itemId, revision: 1, action: 'replace' };
  const expectedPath = `/v1/items/${original.itemId}/operations/${replacement.operationId}`;
  assert.equal((await server.request(expectedPath)).status, 404);
  assert.equal((await attempt(server, replacement)).status, 202);
  const ready = await waitForItem(server, original.itemId);
  assert.equal(ready.operationId, replacement.operationId);
  assert.equal(ready.photoVersionId, replacement.photoVersionId);
  assert.equal(ready.type, 'Рубашка');
  assert.equal(ready.resultPath, `${expectedPath}/result`);
  const result = Buffer.from(await (await server.request(ready.resultPath)).arrayBuffer());
  releaseOld();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await (await server.request(expectedPath)).json(), ready);
  assert.deepEqual(Buffer.from(await (await server.request(ready.resultPath)).arrayBuffer()), result);
  const oldPath = `/v1/items/${original.itemId}/operations/${original.operationId}`;
  assert.equal((await server.request(oldPath)).status, 409);
  assert.equal((await server.request(`${oldPath}/result`)).status, 409);
  assert.equal((await upload(server, original)).status, 409);
  assert.equal((await attempt(server, replacement)).status, 200);
  await server.stop();
  const restarted = await env.launch(fixture.env);
  assert.equal((await restarted.request(`${oldPath}/result`)).status, 409);
  assert.deepEqual(await (await restarted.request(expectedPath)).json(), ready);
  assert.equal(fixture.calls.attributes.length, 2);
  assert.equal(fixture.calls.cutout.length, 2);
});
}

for (const outcome of ['success', 'failure']) {
  test(`late ${outcome} of superseded attributes neither changes the new card nor starts its old cutout`, async t => {
    let releaseOld;
    let calls = 0;
    const fixture = await providerFixture(t, { attributes(request, response, { attributes }) {
      if (calls++ === 0) releaseOld = () => {
        if (outcome === 'failure') { response.writeHead(429); response.end(); }
        else attributesReply(response, { ...attributes, type: 'Пальто' });
      };
      else attributesReply(response, attributes);
    } });
    const env = await environment(t);
    const server = await env.launch({ ...fixture.env, SAINT_LOOK_PROVIDER_TIMEOUT_MS: '10000' });
    const original = await photoRequest();
    await upload(server, original);
    await waitUntil(() => releaseOld);
    const replacement = { ...await photoRequest(), itemId: original.itemId, revision: 1, action: 'replace' };
    assert.equal((await attempt(server, replacement)).status, 202);
    const ready = await waitForItem(server, original.itemId);
    releaseOld();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await (await server.request(`/v1/items/${original.itemId}`)).json(), ready);
    assert.equal(ready.operationId, replacement.operationId);
    assert.equal(fixture.calls.attributes.length, 2);
    assert.equal(fixture.calls.cutout.length, 1);
  });
}

test('the latest offline replacement may arrive first and delayed lower revisions never reactivate', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const initial = await photoRequest();
  const latest = { ...await photoRequest(), itemId: initial.itemId, revision: 3, action: 'replace' };
  assert.equal((await attempt(server, latest)).status, 202);
  const ready = await waitForItem(server, initial.itemId);
  const delayed = { ...await photoRequest(), itemId: initial.itemId, revision: 2, action: 'replace' };
  assert.equal((await attempt(server, delayed)).status, 409);
  assert.equal((await upload(server, initial)).status, 409);
  assert.deepEqual(await (await server.request(`/v1/items/${initial.itemId}`)).json(), ready);
  assert.equal((await attempt(server, latest)).status, 200);
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
  await server.stop();
  const restarted = await env.launch(fixture.env);
  assert.equal((await attempt(restarted, delayed)).status, 409);
  assert.equal((await attempt(restarted, latest)).status, 200);
  assert.equal((await waitForItem(restarted, initial.itemId)).revision, 3);
});

test('invalid revisions, changed retry photos and conflicting receipts cannot start another attempt', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const initial = await photoRequest();
  await upload(server, initial);
  const ready = await waitForItem(server, initial.itemId);
  const retry = { ...initial, operationId: randomUUID(), revision: 1, action: 'retry' };
  for (const revision of [undefined, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.equal((await attempt(server, { ...retry, revision })).status, 400);
  }
  assert.equal((await attempt(server, { ...retry, action: 'automatic' })).status, 400);
  const changedPhoto = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'green' } }).png().toBuffer();
  assert.equal((await attempt(server, { ...retry, imageBase64: changedPhoto.toString('base64') })).status, 409);
  assert.equal((await attempt(server, { ...retry, action: 'replace' })).status, 409);
  assert.equal((await attempt(server, { ...retry, operationId: initial.operationId })).status, 409);
  assert.deepEqual(await (await server.request(`/v1/items/${initial.itemId}`)).json(), ready);
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
});


test('a catalog with unknown upload age expires on upgrade while preserving identity and explicit retry', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const original = await photoRequest();
  // Historical persisted input from the pre-#6 version; all observations below use HTTP.
  const legacy = new DatabaseSync(join(env.directory, 'wardrobe.sqlite'));
  legacy.exec(`CREATE TABLE items (
    item_id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, photo_version_id TEXT NOT NULL,
    status TEXT NOT NULL, source BLOB NOT NULL, result BLOB, type TEXT, colors TEXT, error TEXT,
    mode TEXT NOT NULL DEFAULT 'demo', provider_id TEXT NOT NULL DEFAULT 'demo',
    attributes_state TEXT NOT NULL DEFAULT 'pending', cutout_state TEXT NOT NULL DEFAULT 'pending', attributes TEXT
  )`);
  legacy.prepare(`INSERT INTO items(item_id,operation_id,photo_version_id,status,source,result,type,colors,
    provider_id,attributes_state,cutout_state,attributes) VALUES (?,?,?,'ready',?,?,?,?,'live-test','done','done',?)`)
    .run(original.itemId, original.operationId, original.photoVersionId, Buffer.from(original.imageBase64, 'base64'),
      fixture.cutout, 'Рубашка', '["Красный"]', '{"type":"Рубашка","colors":["Красный"]}');
  legacy.close();
  const server = await env.launch(fixture.env);
  const ready = await waitForItem(server, original.itemId, 'failed');
  assert.equal(ready.revision, 0);
  assert.equal(ready.operationId, original.operationId);
  assert.equal(ready.error, 'result_expired');
  assert.equal(ready.type, null);
  assert.equal(ready.resultPath, null);
  assert.equal((await server.request(`/v1/items/${original.itemId}/result`)).status, 410);
  assert.equal((await upload(server, original)).status, 200);
  assert.equal(fixture.calls.attributes.length, 0);
  assert.equal(fixture.calls.cutout.length, 0);
  const retry = { ...original, operationId: randomUUID(), revision: 1, action: 'retry' };
  assert.equal((await attempt(server, retry)).status, 202);
  assert.equal((await waitForItem(server, original.itemId)).operationId, retry.operationId);
  assert.equal((await upload(server, original)).status, 409);
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
});

test('retrying a replacement rejected before acceptance admits the local photo without reviving historical photos', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const original = await photoRequest();
  await upload(server, original);
  await waitForItem(server, original.itemId);
  const replacementImage = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'green' } }).png().toBuffer();
  const replacement = { ...original, imageBase64: replacementImage.toString('base64'),
    photoVersionId: randomUUID(), operationId: randomUUID(), revision: 1, action: 'replace' };
  const denied = await server.request(`/v1/items/${original.itemId}/attempts`, {
    method: 'POST', headers: { Authorization: 'Bearer wrong-owner-token', 'Content-Type': 'application/json' }, body: JSON.stringify(replacement),
  });
  assert.equal(denied.status, 401);
  assert.equal((await server.request(`/v1/items/${original.itemId}/operations/${replacement.operationId}`)).status, 404);
  const retry = { ...replacement, action: 'retry', operationId: randomUUID(), revision: 2 };
  assert.equal((await attempt(server, retry)).status, 202);
  assert.equal((await attempt(server, retry)).status, 200);
  const ready = await waitForItem(server, original.itemId);
  assert.equal(ready.operationId, retry.operationId);
  assert.equal(ready.photoVersionId, replacement.photoVersionId);
  assert.equal(ready.revision, 2);
  assert.equal((await attempt(server, replacement)).status, 409);
  const historicalRetry = { ...original, operationId: randomUUID(), revision: 3, action: 'retry' };
  assert.equal((await attempt(server, historicalRetry)).status, 409);
  await server.stop();
  const restarted = await env.launch(fixture.env);
  assert.equal((await attempt(restarted, retry)).status, 200);
  assert.equal((await attempt(restarted, historicalRetry)).status, 409);
  assert.deepEqual(await (await restarted.request(`/v1/items/${original.itemId}`)).json(), ready);
  assert.equal(fixture.calls.attributes.length, 2);
  assert.equal(fixture.calls.cutout.length, 2);
});
