import test from 'node:test';
import { commitIllustration } from './preparation-support.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerFixture } from './providers/fixture.mjs';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { illustrationFixture } from './providers/illustration.mjs';
import { createIllustrationProvider } from '../src/illustration-provider.mjs';

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
  assert.deepEqual(ready.processing, { preparation: 'done', attributes: 'done', generation: 'done', finalization: 'done' });
  const generation = fixture.calls.generation[0];
  assert.equal(generation.path, '/v1beta/interactions');
  assert.equal(generation.headers['x-goog-api-key'], 'fixture');
  const request = JSON.parse(generation.body);
  assert.equal(request.model, 'gemini-3-pro-image');
  assert.equal(request.store, true);
  assert.equal(request.generation_config.max_output_tokens, 2048);
  assert.deepEqual(request.response_format, { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' });
  const image = await server.request(ready.resultPath);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), fixture.result);
  assert.equal((await (await server.request(`/v1/items/${photo.itemId}`)).json()).status, 'ready');
  assert.equal((await commitIllustration(server, photo, input)).response.status, 204);
  assert.equal((await server.request(ready.resultPath)).status, 410);
  assert.equal((await server.request(`/v1/items/${photo.itemId}/illustrations/${input.operationId}`)).status, 410);
  assert.equal((await requestIllustration(server, photo.itemId, input)).status, 410);
  assert.equal((await server.request(`/v1/items/${photo.itemId}/result`)).status, 410);
});

test('multiple views preserve manual type and colors, reuse prepared photos, and reject mutated identities', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const detail = await photoRequest();
  const initial = illustration(photo, { photos: [
    { id: photo.photoVersionId, role: 'front', imageBase64: photo.imageBase64 },
    { id: detail.photoVersionId, role: 'detail', imageBase64: detail.imageBase64 }] });
  await requestIllustration(server, photo.itemId, initial);
  await waitForIllustration(server, photo.itemId, initial.operationId);
  const update = illustration(photo, { revision: 2, sourceSetVersionId: initial.sourceSetVersionId, manualType: 'Худи', manualColors: ['Чёрный'],
    photos: initial.photos });
  assert.equal((await requestIllustration(server, photo.itemId, update)).status, 202);
  const ready = await waitForIllustration(server, photo.itemId, update.operationId);
  assert.equal(ready.observedFeatures.type, 'Футболка');
  assert.equal(ready.effectiveFeatures.type, 'Худи');
  assert.deepEqual(ready.effectiveFeatures.colors, ['Чёрный']);
  // External boundary accounting: unchanged source must not consume sandbox quota twice.
  assert.equal(fixture.calls.preparation.length, 2);
  const payload = JSON.parse(fixture.calls.attributes.at(-1).body);
  assert.deepEqual(Object.keys(payload.state), ['photo_0_prepared_front', 'photo_1_original_front', 'photo_2_prepared_detail', 'photo_3_original_detail']);
  assert.ok(fixture.calls.generation.at(-1).interaction.input.at(-1).text.includes('Худи'));
  assert.equal((await requestIllustration(server, photo.itemId, update)).status, 200);
  assert.equal((await requestIllustration(server, photo.itemId, { ...update, manualColors: ['Белый'] })).status, 409);
  const changedSet = { ...update, operationId: randomUUID(), revision: 3, photos: initial.photos.slice(0, 1) };
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
    TYPESAFE_API_KEY: 'fixture-typesafe-key', PHOTOROOM_SANDBOX_API_KEY: 'sandbox_fixture', GEMINI_API_KEY: 'fixture' });
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

test('an opaque generated canvas gets a separate final sandbox cutout without replay charges', async t => {
  const fixture = await illustrationFixture(t, { opaque: true }), env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo); await requestIllustration(server, photo.itemId, input);
  const ready = await waitForIllustration(server, photo.itemId, input.operationId);
  assert.equal(ready.processing.finalization, 'done');
  const replay = await requestIllustration(server, photo.itemId, input);
  assert.equal(replay.status, 200);
  await server.request(ready.resultPath); await server.request(ready.resultPath);
  assert.equal(fixture.calls.preparation.length, 1); assert.equal(fixture.calls.finalization.length, 1); assert.equal(fixture.calls.generation.length, 1);
});

test('generation refusal supports explicit retry with cached preparation while unknown outcomes cannot repeat paid work', async t => {
  let outcome = 'quota';
  const fixture = await illustrationFixture(t, { generation: async (request, response) => {
    if (outcome === 'unknown') { response.destroy(); return; }
    response.writeHead(429); response.end();
  } });
  const env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const first = illustration(photo); await requestIllustration(server, photo.itemId, first);
  const failure = await waitForIllustration(server, photo.itemId, first.operationId, 'failed');
  assert.equal(failure.error, 'provider_quota_exceeded');
  assert.equal(failure.processing.generation, 'failed');
  outcome = 'unknown';
  const retry = { ...first, operationId: randomUUID(), revision: 2 };
  assert.equal((await requestIllustration(server, photo.itemId, retry)).status, 202);
  const unknown = await waitForIllustration(server, photo.itemId, retry.operationId, 'failed');
  assert.equal(unknown.error, 'processing_unknown');
  assert.equal(unknown.processing.generation, 'unknown');
  assert.equal((await requestIllustration(server, photo.itemId, retry)).status, 200);
  const unsafe = await requestIllustration(server, photo.itemId, { ...retry, operationId: randomUUID(), revision: 3 });
  assert.equal(unsafe.status, 409); assert.equal((await unsafe.json()).error, 'processing_unknown');
  assert.equal(fixture.calls.preparation.length, 1);
  assert.equal(fixture.calls.generation.length, 2);
  await server.stop(); const restarted = await env.launch(fixture.env);
  assert.equal((await (await restarted.request(`/v1/items/${photo.itemId}/illustrations/${retry.operationId}`)).json()).error, 'processing_unknown');
  assert.equal(fixture.calls.generation.length, 2);
});

test('delete during generation permanently removes illustrations and rejects late receipt, result and replay', async t => {
  let release;
  const fixture = await illustrationFixture(t, { generation: async (request, response, { interaction }) => {
    await new Promise(resolve => { release = resolve; });
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(interaction));
  } });
  const env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo); await requestIllustration(server, photo.itemId, input);
  await until(() => release);
  assert.equal((await server.request(`/v1/items/${photo.itemId}`, { method: 'DELETE' })).status, 204);
  release();
  const path = `/v1/items/${photo.itemId}/illustrations/${input.operationId}`;
  assert.equal((await server.request(path)).status, 410);
  assert.equal((await server.request(`${path}/result`)).status, 410);
  assert.equal((await requestIllustration(server, photo.itemId, input)).status, 410);
  await server.stop(); const restarted = await env.launch(fixture.env);
  assert.equal((await restarted.request(path)).status, 410);
  assert.equal((await restarted.request(`${path}/ack`, { method: 'POST' })).status, 410);
  assert.equal(fixture.calls.generation.length, 1);
});

test('crash during JEV preserves uncertain outcome and cannot automatically repeat its external request', async t => {
  const fixture = await illustrationFixture(t, { attributes: async () => {} });
  const env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo); await requestIllustration(server, photo.itemId, input);
  await until(() => fixture.calls.attributes.length === 1);
  await server.stop('SIGKILL'); const restarted = await env.launch(fixture.env);
  const failed = await waitForIllustration(restarted, photo.itemId, input.operationId, 'failed');
  assert.equal(failed.processing.attributes, 'unknown'); assert.equal(failed.error, 'processing_unknown');
  assert.equal((await requestIllustration(restarted, photo.itemId, input)).status, 200);
  assert.equal(fixture.calls.attributes.length, 1); assert.equal(fixture.calls.generation.length, 0);
});

test('ready illustration survives restart, expires after seven days, and old acknowledgement does not clear an explicit refresh', async t => {
  const ordinary = await providerFixture(t), fixture = await illustrationFixture(t), env = await environment(t);
  const clock = join(env.directory, 'clock.json'); await writeFile(clock, JSON.stringify({ offsetMs: 0 }));
  const config = { ...ordinary.env, ...fixture.env, TYPESAFE_API_KEY: ordinary.env.TYPESAFE_API_KEY, SAINT_LOOK_TEST_CLOCK_FILE: clock };
  const server = await env.launch(config);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo, { manualType: 'Худи', manualColors: ['Чёрный'] }); await requestIllustration(server, photo.itemId, input);
  const ready = await waitForIllustration(server, photo.itemId, input.operationId);
  await server.stop(); const restarted = await env.launch(config);
  assert.deepEqual(Buffer.from(await (await restarted.request(ready.resultPath)).arrayBuffer()), fixture.result);
  await writeFile(clock, JSON.stringify({ offsetMs: 8 * 24 * 60 * 60 * 1000 }));
  assert.equal((await restarted.request(ready.resultPath)).status, 410);
  const expired = await restarted.request(`/v1/items/${photo.itemId}/illustrations/${input.operationId}`);
  assert.equal(expired.status, 410); assert.deepEqual(await expired.json(), { error: 'result_expired' });
  assert.equal((await requestIllustration(restarted, photo.itemId, input)).status, 410);
  const refresh = { ...input, operationId: randomUUID(), revision: 2 };
  assert.equal((await requestIllustration(restarted, photo.itemId, refresh)).status, 202);
  const refreshed = await waitForIllustration(restarted, photo.itemId, refresh.operationId);
  assert.equal((await restarted.request(`/v1/items/${photo.itemId}/illustrations/${input.operationId}/ack`, { method: 'POST' })).status, 409);
  assert.equal((await restarted.request(refreshed.resultPath)).status, 200);
  assert.equal(fixture.calls.preparation.length, 2);
});

test('multicolor JEV observations use the five most confident canonical colors before generation', async t => {
  const fixture = await illustrationFixture(t, { colors: { red: 0.80, black: 0.91, white: 0.99, blue: 0.75, green: 0.89, orange: 0.95 } });
  const env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo); await requestIllustration(server, photo.itemId, input);
  const ready = await waitForIllustration(server, photo.itemId, input.operationId);
  assert.deepEqual(ready.observedFeatures.colors, ['Белый', 'Оранжевый', 'Чёрный', 'Зелёный', 'Красный']);
  assert.deepEqual(ready.effectiveFeatures.colors, ready.observedFeatures.colors);
  const prompt = fixture.calls.generation[0].interaction.input.at(-1).text;
  const effective = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.deepEqual(effective.colors, ['Белый', 'Оранжевый', 'Чёрный', 'Зелёный', 'Красный']);
});

test('Gemini saved receipt uses GET retrieval and never submits a second generation', async t => {
  const fixture = await illustrationFixture(t, { recovery: async (request, response) => { response.writeHead(429); response.end(); } });
  const provider = createIllustrationProvider(fixture.env);
  await assert.rejects(provider.generate([], {}, new AbortController().signal, () => assert.fail('No new receipt'), 'v1_fixture-1'), error => {
    assert.equal(error.code, 'processing_unknown'); assert.equal(error.unknown, true); return true;
  });
  assert.equal(fixture.calls.generation.length, 0);
  assert.equal(fixture.calls.recovery.length, 1);
});

test('a malformed successful generation receipt remains uncertain rather than allowing another paid submission', async t => {
  const fixture = await illustrationFixture(t, { generation: async (request, response) => { response.writeHead(200); response.end('{'); } });
  const env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo); await requestIllustration(server, photo.itemId, input);
  const failed = await waitForIllustration(server, photo.itemId, input.operationId, 'failed');
  assert.equal(failed.error, 'processing_unknown');
  assert.equal((await requestIllustration(server, photo.itemId, { ...input, operationId: randomUUID(), revision: 2 })).status, 409);
  assert.equal(fixture.calls.generation.length, 1);
});

test('locally saved prepared sources survive acknowledgement and avoid sandbox charges on manual refresh', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo); await requestIllustration(server, photo.itemId, input);
  const first = await waitForIllustration(server, photo.itemId, input.operationId);
  assert.equal(first.preparedSources.length, 1);
  assert.equal(first.preparedSources[0].photoId, photo.photoVersionId);
  const prepared = await server.request(first.preparedSources[0].preparedPath);
  assert.equal(prepared.status, 200);
  const preparedBase64 = Buffer.from(await prepared.arrayBuffer()).toString('base64');
  assert.equal((await commitIllustration(server, photo, input)).response.status, 204);
  assert.equal((await server.request(first.preparedSources[0].preparedPath)).status, 410);
  const refresh = { ...input, operationId: randomUUID(), revision: 2, manualType: 'Худи', photos: [{ ...input.photos[0], preparedBase64 }] };
  assert.equal((await requestIllustration(server, photo.itemId, refresh)).status, 202);
  assert.equal((await waitForIllustration(server, photo.itemId, refresh.operationId)).effectiveFeatures.type, 'Худи');
  assert.equal(fixture.calls.preparation.length, 1);
  const bad = { ...refresh, operationId: randomUUID(), revision: 3, photos: [{ ...input.photos[0], preparedBase64: input.photos[0].imageBase64 }] };
  assert.equal((await requestIllustration(server, photo.itemId, bad)).status, 409);
  assert.equal(fixture.calls.preparation.length, 1);
});

test('a completed source set stays immutable after delivery and restart, while attribute updates retain its identity', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const initial = illustration(photo);
  await requestIllustration(server, photo.itemId, initial);
  await waitForIllustration(server, photo.itemId, initial.operationId);
  assert.equal((await commitIllustration(server, photo, initial)).response.status, 204);
  await server.stop();
  const restarted = await env.launch(fixture.env);
  for (const action of ['replace', 'retry']) {
    const replacement = { ...await photoRequest(), itemId: photo.itemId, revision: 1, action };
    const denied = await restarted.request(`/v1/items/${photo.itemId}/attempts`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(replacement) });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, 'photos_locked');
  }
  const detail = await photoRequest();
  const changed = illustration(photo, { revision: 2, photos: [...initial.photos,
    { id: detail.photoVersionId, role: 'detail', imageBase64: detail.imageBase64 }] });
  const denied = await requestIllustration(restarted, photo.itemId, changed);
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error, 'photos_locked');
  const update = illustration(photo, { sourceSetVersionId: initial.sourceSetVersionId, revision: 2,
    manualType: 'Худи', manualColors: ['Чёрный'] });
  assert.equal((await requestIllustration(restarted, photo.itemId, update)).status, 202);
  const ready = await waitForIllustration(restarted, photo.itemId, update.operationId);
  assert.equal(ready.effectiveFeatures.type, 'Худи');
  assert.deepEqual(ready.effectiveFeatures.colors, ['Чёрный']);
  const newThing = await photoRequest();
  assert.equal((await upload(restarted, newThing)).status, 202);
});

test('editing angles before first publication supersedes generated output; commit alone freezes the accepted set', async t => {
  const fixture = await illustrationFixture(t);
  const env = await environment(t);
  let server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const initial = illustration(photo);
  await requestIllustration(server, photo.itemId, initial);
  await until(() => fixture.calls.generation.length === 1);
  const detail = await photoRequest();
  const newer = illustration(photo, { revision: 2, photos: [...initial.photos,
    { id: detail.photoVersionId, role: 'detail', imageBase64: detail.imageBase64 }] });
  await waitForIllustration(server, photo.itemId, initial.operationId);
  await server.stop();
  server = await env.launch(fixture.env);
  // Restart must not misinterpret generated output as a committed publication.
  // The client discarded the first response after its local angle edit. No download or ack.
  assert.equal((await requestIllustration(server, photo.itemId, newer)).status, 202);
  const staleAck = await server.request(`/v1/items/${photo.itemId}/illustrations/${initial.operationId}/ack`, { method: 'POST' });
  assert.equal(staleAck.status, 409);
  assert.equal((await staleAck.json()).error, 'operation_superseded');
  await waitForIllustration(server, photo.itemId, newer.operationId);
  const commitPath = `/v1/items/${photo.itemId}/illustrations/${newer.operationId}/ack`;
  const commit = await commitIllustration(server, photo, newer);
  assert.equal(commit.response.status, 204);
  await server.stop();
  const restarted = await env.launch(fixture.env);
  assert.equal((await restarted.request(commitPath, commit.ack)).status, 204, 'Lost commit response is safely recoverable');
  const changed = illustration(photo, { revision: 3 });
  const denied = await requestIllustration(restarted, photo.itemId, changed);
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error, 'photos_locked');
});


test('old fal prepared cutouts are reused after Gemini migration with exact source binding', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t);
  let server = await env.launch(fixture.env);
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const input = illustration(photo); await requestIllustration(server, photo.itemId, input);
  const first = await waitForIllustration(server, photo.itemId, input.operationId);
  const preparedBase64 = Buffer.from(await (await server.request(first.preparedSources[0].preparedPath)).arrayBuffer()).toString('base64');
  assert.equal((await commitIllustration(server, photo, input)).response.status, 204);
  await server.stop();
  const db = new DatabaseSync(join(env.directory, 'wardrobe.sqlite'));
  const versions = { modelVersion: 'fal-ai/nano-banana-pro/edit', templateVersion: 'front-360x560-proposed-v1', geometryVersion: 'fitting-square-1024-v1' };
  db.prepare('UPDATE illustration_sources SET prepared_versions=? WHERE item_id=? AND photo_id=?')
    .run(JSON.stringify(versions), photo.itemId, photo.photoVersionId);
  db.close();
  server = await env.launch(fixture.env);
  const refresh = { ...input, operationId: randomUUID(), revision: 2, manualType: 'Худи', photos: [{ ...input.photos[0], preparedBase64 }] };
  assert.equal((await requestIllustration(server, photo.itemId, refresh)).status, 202);
  await waitForIllustration(server, photo.itemId, refresh.operationId);
  assert.equal(fixture.calls.preparation.length, 1, 'Generation provider switch must not repeat an unchanged paid cutout');
  const changedBytes = { ...refresh, operationId: randomUUID(), revision: 3,
    photos: [{ ...input.photos[0], preparedBase64: input.photos[0].imageBase64 }] };
  assert.equal((await requestIllustration(server, photo.itemId, changedBytes)).status, 409);
  await server.stop();
  const changed = new DatabaseSync(join(env.directory, 'wardrobe.sqlite'));
  changed.prepare('UPDATE illustration_sources SET prepared_versions=? WHERE item_id=? AND photo_id=?')
    .run(JSON.stringify({ ...versions, modelVersion: 'unknown-renderer' }), photo.itemId, photo.photoVersionId);
  changed.close();
  server = await env.launch(fixture.env);
  assert.equal((await requestIllustration(server, photo.itemId, { ...refresh, operationId: randomUUID(), revision: 3 })).status, 409);
  assert.equal(fixture.calls.preparation.length, 1);
});
