import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
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
async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Expected external request did not arrive');
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

test('replacing the primary photo supersedes a pending illustration and late provider data cannot block the new photo', async t => {
  let release;
  const fixture = await illustrationFixture(t, { attributes: async (request, response) => {
    await new Promise(resolve => { release = resolve; }); response.writeHead(500); response.end();
  } });
  const env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const initial = illustration(photo); await requestIllustration(server, photo.itemId, initial);
  await until(() => release);
  const replacement = { ...await photoRequest(), itemId: photo.itemId, revision: 1, action: 'replace' };
  assert.equal((await server.request(`/v1/items/${photo.itemId}/attempts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(replacement) })).status, 202);
  const next = illustration(replacement, { revision: 2 });
  const accepted = await requestIllustration(server, photo.itemId, next);
  release();
  assert.equal(accepted.status, 202);
  assert.equal((await server.request(`/v1/items/${photo.itemId}/illustrations/${initial.operationId}`)).status, 409);
  assert.equal((await (await server.request(`/v1/items/${photo.itemId}/illustrations/${next.operationId}`)).json()).photoVersionId, replacement.photoVersionId);
});

test('native test fixture explicitly enables illustrations without changing existing ingestion counters', async t => {
  const child = spawn(process.execPath, ['test/providers/ui-server.mjs'], { env: { ...process.env,
    NODE_ENV: 'test', SAINT_LOOK_UI_PROVIDER_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => { child.kill('SIGTERM'); await once(child, 'exit'); });
  const reader = createInterface({ input: child.stdout });
  const [line] = await once(reader, 'line'), origin = JSON.parse(line).url;
  const env = await environment(t), server = await env.launch({ NODE_ENV: 'test', SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'true',
    SAINT_LOOK_ILLUSTRATION_TEST_ORIGIN: origin, SAINT_LOOK_ILLUSTRATION_TEST_CONTROLLED: 'true',
    TYPESAFE_API_KEY: 'fixture-typesafe-key', PHOTOROOM_SANDBOX_API_KEY: 'sandbox_fixture', FAL_KEY: 'fixture' });
  const control = input => fetch(`${origin}/__control`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: 'Bearer saint-look-ui-provider-control-token-00000001' }, body: JSON.stringify(input) });
  assert.equal((await (await server.request('/health')).json()).illustrationAvailable, false);
  assert.equal((await control({ illustrationMode: 'success' })).status, 200);
  assert.equal((await (await server.request('/health')).json()).illustrationAvailable, true);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo); assert.equal((await requestIllustration(server, photo.itemId, input)).status, 202);
  assert.equal((await waitForIllustration(server, photo.itemId, input.operationId)).status, 'ready');
  const counters = await (await control({})).json();
  assert.equal(counters.attributesCalls, 0); assert.equal(counters.cutoutCalls, 0);
  assert.equal(counters.illustrationGenerationCalls, 1);
  await control({ reset: true });
  assert.equal((await (await server.request('/health')).json()).illustrationAvailable, false);
});
