import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { environment, waitForModelConfiguration, photoRequest, upload, waitForItem } from './support.mjs';
import { illustrationFixture } from './providers/illustration.mjs';
import { controlledSpaceID } from './providers/model.mjs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createModelBridge } from '../src/model-bridge.mjs';

const post = (server, path, body) => server.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('startup has its own bounded deadline while inference keeps the shorter operational deadline', { timeout: 5000 }, async t => {
  let releaseStartup, described, releaseInference, inferenceReached;
  let startupGate = new Promise(resolve => { releaseStartup = resolve; });
  let started = new Promise(resolve => { described = resolve; });
  const inferenceGate = new Promise(resolve => { releaseInference = resolve; });
  const preparing = new Promise(resolve => { inferenceReached = resolve; });
  t.after(() => { releaseStartup(); releaseInference(); });
  const fixture = await illustrationFixture(t, {
    describe: async (_request, response) => { described(); await startupGate; response.end(JSON.stringify({ spaceID: controlledSpaceID })); },
    model: async (_request, response) => { inferenceReached(); await inferenceGate; response.end('{}'); },
  });
  const env = await environment(t);
  // Exercise the real bridge and HTTP ML boundary with elapsed time controlled
  // by Node timers. Native AbortSignal.timeout uses a separate internal clock.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('controlled deadline')), milliseconds);
    return controller.signal;
  });
  const model = createModelBridge(fixture.env, env.directory); t.after(() => model.close());
  await started;
  await assert.rejects(model.rank([], [{}]), /encoder_unavailable/);
  await assert.rejects(model.prepare(Buffer.from('unused'), randomUUID(), { type: 't_shirt', colors: [] }), /encoder_unavailable/);
  let settled = false;
  const boot = model.waitForStartup().then(() => { settled = true; });
  t.mock.timers.tick(299_999); await nextTurn();
  assert.equal(settled, false, 'Strict startup must survive the 120-second inference budget');
  releaseStartup(); await boot; assert.equal((await model.status()).available, true);
  let completed = false;
  const operation = model.prepare(Buffer.from('fixture source'), randomUUID(), { type: 't_shirt', colors: [] });
  const rejected = assert.rejects(operation, /controlled deadline/).then(() => { completed = true; });
  await preparing;
  t.mock.timers.tick(119_999); await nextTurn(); assert.equal(completed, false);
  t.mock.timers.tick(1); await rejected;
  model.close();
  startupGate = new Promise(resolve => { releaseStartup = resolve; });
  started = new Promise(resolve => { described = resolve; });
  const failed = createModelBridge(fixture.env, env.directory); t.after(() => failed.close());
  await started;
  t.mock.timers.tick(300_000); await failed.waitForStartup();
  assert.equal((await failed.status()).available, false, 'Hung startup must also terminate at its own bound');
  releaseStartup(); releaseInference();
});
test('warming model keeps health and configuration responsive until describe succeeds', async t => {
  let release, described;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { described = resolve; });
  t.after(() => release());
  const fixture = await illustrationFixture(t, { describe: async (_request, response) => {
    described(); await gate; response.end(JSON.stringify({ spaceID: controlledSpaceID }));
  } });
  const env = await environment(t), server = await env.launch(fixture.env);
  await started;
  const health = await (await server.request('/health', { signal: AbortSignal.timeout(1000) })).json();
  assert.equal(health.status, 'ok'); assert.equal(health.encoderAvailable, false);
  const config = await server.request('/v1/recommendations/config', { signal: AbortSignal.timeout(1000) });
  assert.equal(config.status, 503); assert.deepEqual(await config.json(), { error: 'encoder_unavailable' });
  release();
  for (let i = 0; i < 100; i++) {
    const current = await (await server.request('/v1/recommendations/config')).json();
    if (current.encoder?.available) {
      assert.equal(current.encoder.activeSpaceID, controlledSpaceID); return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Successful describe must publish model availability');
});
async function ready(server, path, status = 'ready') {
  for (let i = 0; i < 150; i++) {
    const response = await server.request(path), value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    if (value.status === status) return value;
    if (value.status === 'failed') throw new Error(JSON.stringify(value));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Operation did not finish');
}
async function illustrated(t, handlers = {}) {
  const fixture = await illustrationFixture(t, handlers), env = await environment(t), server = await env.launch(fixture.env);
  const photo = await photoRequest(); assert.equal((await upload(server, photo)).status, 202);
  const cutout = await waitForItem(server, photo.itemId);
  const illustration = { operationId: randomUUID(), photoVersionId: photo.photoVersionId, sourceSetVersionId: randomUUID(), revision: 1,
    photos: [{ id: photo.photoVersionId, role: 'front', imageBase64: photo.imageBase64 }] };
  assert.equal((await post(server, `/v1/items/${photo.itemId}/illustrations`, illustration)).status, 202);
  const path = `/v1/items/${photo.itemId}/illustrations/${illustration.operationId}`;
  const result = await ready(server, path);
  return { fixture, env, server, photo, cutout, illustration, result, path };
}
async function prepare(state, changes = {}) {
  const { server, photo, illustration } = state;
  const config = await waitForModelConfiguration(server);
  const input = { operationId: randomUUID(), revision: 1, photoVersionId: photo.photoVersionId, sourceSetVersionId: illustration.sourceSetVersionId,
    illustrationOperationId: illustration.operationId, cutoutOperationId: photo.operationId, spaceID: config.encoder.activeSpaceID,
    mode: 'fromIllustration', imageBase64: photo.imageBase64, features: { type: 't_shirt', colors: ['red'] }, ...changes };
  const path = `/v1/items/${photo.itemId}/preparations`;
  const response = await post(server, path, input);
  return { input, response, path: `${path}/${input.operationId}` };
}

test('disabled encoder reports unavailable and a ready illustration cannot bypass full preparation', async t => {
  const state = await illustrated(t, { modelDisabled: true });
  const config = await waitForModelConfiguration(state.server);
  assert.equal(config.encoder.available, false);
  assert.equal(config.newItemPreparation.available, false);
  assert.equal((await state.server.request(state.path + '/ack', { method: 'POST' })).status, 409);
  assert.equal((await state.server.request(state.result.resultPath)).status, 200);
});

test('full preparation binds source, features and artifacts; commit freezes photos and survives restart', async t => {
  const state = await illustrated(t), { server, photo } = state;
  assert.match(state.cutout.resultSHA256, /^[a-f0-9]{64}$/);
  const operation = await prepare(state);
  assert.equal(operation.response.status, 202, JSON.stringify(await operation.response.json()));
  const result = await ready(server, operation.path);
  assert.equal(result.mode, 'controlled'); assert.equal(result.imageMode, 'test');
  assert.equal(result.input.sourceSHA256, createHash('sha256').update(Buffer.from(photo.imageBase64, 'base64')).digest('hex'));
  assert.equal(result.representationSHA256, createHash('sha256').update(result.representationJSON).digest('hex'));
  assert.equal(result.artifacts.cutoutSHA256, state.cutout.resultSHA256);
  const ack = { publicationProtocol: 'prepared-item-v1', preparationOperationId: operation.input.operationId };
  assert.equal((await post(server, state.path + '/ack', ack)).status, 204);
  assert.equal((await server.request(operation.path)).status, 410);
  assert.equal((await server.request(state.cutout.resultPath)).status, 410);
  await server.stop(); const restarted = await state.env.launch(state.fixture.env);
  assert.equal((await post(restarted, state.path + '/ack', ack)).status, 204);
  const replacement = await photoRequest();
  assert.equal((await post(restarted, `/v1/items/${photo.itemId}/attempts`, { ...replacement, itemId: photo.itemId, revision: 1, action: 'replace' })).status, 409);
});

test('encoder-only refresh reuses committed artifacts without image-provider calls', async t => {
  const state = await illustrated(t), first = await prepare(state);
  const result = await ready(state.server, first.path);
  const ack = { publicationProtocol: 'prepared-item-v1', preparationOperationId: first.input.operationId };
  assert.equal((await post(state.server, state.path + '/ack', ack)).status, 204);
  await state.server.stop(); state.server = await state.env.launch({ ...state.fixture.env, SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'false' });
  const config = await waitForModelConfiguration(state.server);
  assert.equal(config.newItemPreparation.available, false); assert.equal(config.encoderRefresh.available, true);
  const before = Object.fromEntries(Object.entries(state.fixture.calls).map(([key, values]) => [key, values.length]));
  const refresh = await prepare(state, { revision: 2, mode: 'reusePublication', reuse: { publicationId: first.input.operationId, artifacts: result.artifacts } });
  assert.equal(refresh.response.status, 202, JSON.stringify(await refresh.response.json()));
  const refreshed = await ready(state.server, refresh.path);
  assert.equal(refreshed.provenance, 'reused');
  assert.deepEqual(refreshed.artifacts, result.artifacts);
  for (const key of ['preparation', 'attributes', 'generation', 'finalization']) assert.equal(state.fixture.calls[key].length, before[key]);
  assert.equal(state.fixture.calls.model.length, before.model + 1);
  const changed = await prepare(state, { revision: 3, mode: 'reusePublication', features: { type: 'hoodie', colors: ['red'] },
    reuse: { publicationId: first.input.operationId, artifacts: result.artifacts } });
  assert.equal(changed.response.status, 409);
  assert.equal((await post(state.server, state.path + '/ack', { ...ack, preparationOperationId: refresh.input.operationId })).status, 204);
});

test('invalid encoder output fails closed and explicit retry does not rerun paid stages', async t => {
  let invalid = true;
  const { modelFixture } = await import('./providers/model.mjs');
  const state = await illustrated(t, { model: async (request, response, input) => {
    if (invalid) response.end(JSON.stringify({ vector: [0] }));
    else await modelFixture(request, response, Buffer.from(JSON.stringify(input)));
  } });
  const first = await prepare(state); assert.equal(first.response.status, 202);
  assert.equal((await ready(state.server, first.path, 'failed')).error, 'encoder_failed');
  assert.equal((await post(state.server, state.path + '/ack', { publicationProtocol: 'prepared-item-v1', preparationOperationId: first.input.operationId })).status, 409);
  invalid = false;
  const retry = await prepare(state, { revision: 2 }); assert.equal(retry.response.status, 202);
  await ready(state.server, retry.path);
  assert.equal(state.fixture.calls.attributes.length, 1); assert.equal(state.fixture.calls.generation.length, 1);
});

test('delete during encoder work prevents late result or commit from resurrecting an item', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { modelFixture } = await import('./providers/model.mjs');
  const state = await illustrated(t, { model: async (request, response, input) => {
    await gate; await modelFixture(request, response, Buffer.from(JSON.stringify(input)));
  } });
  const operation = await prepare(state); assert.equal(operation.response.status, 202);
  assert.equal((await state.server.request(`/v1/items/${state.photo.itemId}`, { method: 'DELETE' })).status, 204);
  release();
  assert.equal((await state.server.request(operation.path)).status, 410);
  assert.equal((await post(state.server, state.path + '/ack', { publicationProtocol: 'prepared-item-v1', preparationOperationId: operation.input.operationId })).status, 410);
});

test('valid absent colors use the encoder without inventing a color', async t => {
  const state = await illustrated(t, { colors: {} });
  assert.deepEqual(state.result.effectiveFeatures.colors, []);
  const operation = await prepare(state, { features: { type: 't_shirt', colors: [] } });
  assert.equal(operation.response.status, 202);
  const result = await ready(state.server, operation.path);
  assert.equal(result.input.textSHA256, createHash('sha256').update('t shirt.').digest('hex'));
  assert.deepEqual(state.fixture.calls.model[0].colors, []);
});

test('new source/traits and incompatible space cannot be admitted using an old artifact packet', async t => {
  const state = await illustrated(t);
  for (const changes of [{ features: { type: 'hoodie', colors: ['red'] } }, { spaceID: 'wrong-space' }, { imageBase64: (await photoRequest()).imageBase64.replace(/^i/, 'j') }]) {
    const result = await prepare(state, changes); assert.ok([400, 409].includes(result.response.status));
  }
  assert.equal(state.fixture.calls.model.length, 0);
});

test('historical delivered final artifacts import without missing intermediate cache or repeated image calls', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { join } = await import('node:path');
  const state = await illustrated(t), { photo, result } = state;
  const cutoutBytes = Buffer.from(await (await state.server.request(state.cutout.resultPath)).arrayBuffer());
  const illustrationBytes = Buffer.from(await (await state.server.request(result.resultPath)).arrayBuffer());
  await state.server.stop();
  // Historical v3 database is input to migration, not an assertion side channel.
  const old = new DatabaseSync(join(state.env.directory, 'wardrobe.sqlite'));
  old.exec(`PRAGMA user_version=3;
    UPDATE illustrations SET retention_state='delivered',status='failed',error='result_delivered',result=NULL,generated=NULL,
      observed=NULL,effective=NULL,result_digest=NULL,observed_digest=NULL,effective_digest=NULL;
    UPDATE operation_receipts SET result_digest=NULL,result_mode=NULL;
    UPDATE illustration_sources SET source=NULL,prepared=NULL;`); old.close();
  state.server = await state.env.launch(state.fixture.env);
  assert.equal((await state.server.request(state.path + '/ack', { method: 'POST' })).status, 204, 'Legacy lost-ack replay is not encoder admission');
  const legacy = { cutout: { imageBase64: cutoutBytes.toString('base64'), mode: state.cutout.mode },
    illustration: { imageBase64: illustrationBytes.toString('base64'), response: result },
    preparedPhotos: result.preparedSources.map(({ photoId, sourceSHA256, preparedSHA256, versions }) => ({ photoId, sourceSHA256, preparedSHA256, versions })) };
  const bad = await prepare(state, { mode: 'legacyImport', legacy: { ...legacy, preparedPhotos: [{ ...legacy.preparedPhotos[0], preparedSHA256: '0'.repeat(64) }] } });
  assert.equal(bad.response.status, 409);
  // Original and final files survived locally; the intermediate cache did not.
  const operation = await prepare(state, { mode: 'legacyImport', legacy: { ...legacy, preparedPhotos: [] } });
  assert.equal(operation.response.status, 202, JSON.stringify(await operation.response.json()));
  const prepared = await ready(state.server, operation.path);
  assert.equal(prepared.provenance, 'legacyImport'); assert.equal(prepared.imageMode, 'test');
  assert.equal(prepared.artifacts.cutoutSHA256, createHash('sha256').update(cutoutBytes).digest('hex'));
  assert.equal((await post(state.server, state.path + '/ack', { publicationProtocol: 'prepared-item-v1', preparationOperationId: operation.input.operationId })).status, 204);
  assert.equal(state.fixture.calls.generation.length, 1); assert.equal(state.fixture.calls.attributes.length, 1); assert.equal(state.fixture.calls.preparation.length, 1);
  assert.equal((await state.server.request(operation.path)).status, 410);
});

test('manual trait refresh reuses source-bound observed features without a second JEV call', async t => {
  const state = await illustrated(t), first = await prepare(state);
  const saved = state.result;
  const preparedBase64 = Buffer.from(await (await state.server.request(saved.preparedSources[0].preparedPath)).arrayBuffer()).toString('base64');
  await ready(state.server, first.path);
  assert.equal((await post(state.server, state.path + '/ack', { publicationProtocol: 'prepared-item-v1', preparationOperationId: first.input.operationId })).status, 204);
  const input = { ...state.illustration, operationId: randomUUID(), revision: 2, manualType: 'Худи',
    photos: [{ ...state.illustration.photos[0], preparedBase64 }], reuseObserved: { previousIllustrationOperationId: state.illustration.operationId,
      sourceSetVersionId: state.illustration.sourceSetVersionId, observedFeatures: saved.observedFeatures, observedFeaturesSHA256: saved.observedFeaturesSHA256 } };
  assert.equal((await post(state.server, `/v1/items/${state.photo.itemId}/illustrations`, input)).status, 202);
  const result = await ready(state.server, `/v1/items/${state.photo.itemId}/illustrations/${input.operationId}`);
  assert.equal(result.effectiveFeatures.type, 'Худи'); assert.equal(result.observedFeatures.type, 'Футболка');
  assert.equal(state.fixture.calls.attributes.length, 1); assert.equal(state.fixture.calls.preparation.length, 1); assert.equal(state.fixture.calls.generation.length, 2);
  const changed = { ...input, operationId: randomUUID(), revision: 3, reuseObserved: { ...input.reuseObserved, observedFeatures: { ...saved.observedFeatures, type: 'Худи' } } };
  assert.equal((await post(state.server, `/v1/items/${state.photo.itemId}/illustrations`, changed)).status, 409);
});

test('ready representation survives restart byte-exact and a later illustration supersedes it', async t => {
  const state = await illustrated(t), operation = await prepare(state);
  const result = await ready(state.server, operation.path);
  await state.server.stop(); state.server = await state.env.launch(state.fixture.env);
  const restored = await (await state.server.request(operation.path)).json();
  assert.equal(restored.representationJSON, result.representationJSON); assert.equal(state.fixture.calls.model.length, 1);
  const next = { ...state.illustration, operationId: randomUUID(), revision: 2, manualType: 'Худи' };
  assert.equal((await post(state.server, `/v1/items/${state.photo.itemId}/illustrations`, next)).status, 202);
  assert.equal((await state.server.request(operation.path)).status, 409);
  assert.equal((await post(state.server, state.path + '/ack', { publicationProtocol: 'prepared-item-v1', preparationOperationId: operation.input.operationId })).status, 409);
  assert.equal(state.fixture.calls.model.length, 1);
});

test('accepted encoder work resumes after process death without repeating image stages', async t => {
  let release, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const { modelFixture } = await import('./providers/model.mjs');
  const state = await illustrated(t, { model: async (request, response, input) => {
    if (first) { first = false; await gate; }
    await modelFixture(request, response, Buffer.from(JSON.stringify(input)));
  } });
  const operation = await prepare(state); assert.equal(operation.response.status, 202);
  for (let i = 0; i < 100 && state.fixture.calls.model.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.fixture.calls.model.length, 1);
  await state.server.stop('SIGKILL'); state.server = await state.env.launch(state.fixture.env);
  const result = await ready(state.server, operation.path);
  release();
  assert.equal(result.operationId, operation.input.operationId);
  assert.equal(state.fixture.calls.model.length, 2);
  assert.equal(state.fixture.calls.attributes.length, 1); assert.equal(state.fixture.calls.generation.length, 1);
});

test('restart warming preserves a pending refresh and the previous publication until the same operation resumes', async t => {
  let releaseModel, releaseStartup, startupReached, warming = false, holdModel = false;
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  const startupGate = new Promise(resolve => { releaseStartup = resolve; });
  const started = new Promise(resolve => { startupReached = resolve; });
  t.after(() => { releaseModel(); releaseStartup(); });
  const { modelFixture } = await import('./providers/model.mjs');
  const state = await illustrated(t, {
    describe: async (_request, response) => {
      if (warming) { startupReached(); await startupGate; }
      response.end(JSON.stringify({ spaceID: controlledSpaceID }));
    },
    model: async (request, response, input) => {
      if (holdModel) { holdModel = false; await modelGate; }
      await modelFixture(request, response, Buffer.from(JSON.stringify(input)));
    },
  });
  const first = await prepare(state), saved = await ready(state.server, first.path);
  const imageCalls = Object.fromEntries(['preparation', 'attributes', 'generation', 'finalization'].map(stage => [stage, state.fixture.calls[stage].length]));
  const firstAck = { publicationProtocol: 'prepared-item-v1', preparationOperationId: first.input.operationId };
  assert.equal((await post(state.server, state.path + '/ack', firstAck)).status, 204);
  holdModel = true;
  const refresh = await prepare(state, { revision: 2, mode: 'reusePublication',
    reuse: { publicationId: first.input.operationId, artifacts: saved.artifacts } });
  assert.equal(refresh.response.status, 202);
  for (let i = 0; i < 100 && state.fixture.calls.model.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.fixture.calls.model.length, 2);
  await state.server.stop('SIGKILL'); warming = true;
  state.server = await state.env.launch(state.fixture.env); await started;
  assert.equal((await (await state.server.request('/health', { signal: AbortSignal.timeout(1000) })).json()).encoderAvailable, false);
  const pending = await (await state.server.request(refresh.path)).json();
  assert.equal(pending.status, 'pending'); assert.equal(pending.operationId, refresh.input.operationId);
  assert.equal((await post(state.server, state.path + '/ack', firstAck)).status, 204, 'Previous publication receipt survives warming');
  const submit = await state.server.request(`/v1/items/${state.photo.itemId}/preparations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(refresh.input), signal: AbortSignal.timeout(1000),
  });
  assert.equal(submit.status, 503); assert.equal((await submit.json()).error, 'encoder_unavailable');
  const target = randomUUID();
  const rank = await state.server.request('/v1/recommendations/single', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(1000),
    body: JSON.stringify({ requestId: randomUUID(), snapshotId: randomUUID(), targetSlotId: target,
      orderedSlots: [{ slotId: target, zone: 'body', itemId: null, publishedVersionId: null }], pinnedSlotIds: [], excludedItemIds: [], items: [] }),
  });
  assert.equal(rank.status, 503); assert.equal((await rank.json()).error, 'model_unavailable');
  assert.equal(state.fixture.calls.model.length, 2); assert.equal(state.fixture.calls.rank.length, 0);
  releaseStartup();
  const restored = await ready(state.server, refresh.path);
  assert.equal(restored.operationId, refresh.input.operationId); assert.deepEqual(restored.artifacts, saved.artifacts);
  assert.equal(state.fixture.calls.model.length, 3);
  assert.equal((await post(state.server, state.path + '/ack', { ...firstAck, preparationOperationId: refresh.input.operationId })).status, 204);
  assert.equal((await post(state.server, state.path + '/ack', firstAck)).status, 204);
  for (const [stage, count] of Object.entries(imageCalls)) assert.equal(state.fixture.calls[stage].length, count);
  releaseModel();
});

test('ready candidate acknowledgement during warming remains retryable without changing its representation', async t => {
  let warming = false, release, described, spaceID = controlledSpaceID;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { described = resolve; });
  t.after(() => release());
  const state = await illustrated(t, { describe: async (_request, response) => {
    if (warming) { described(); await gate; }
    response.end(JSON.stringify({ spaceID }));
  } });
  const operation = await prepare(state), saved = await ready(state.server, operation.path);
  await state.server.stop(); warming = true;
  state.server = await state.env.launch(state.fixture.env); await started;
  const ack = { publicationProtocol: 'prepared-item-v1', preparationOperationId: operation.input.operationId };
  const reply = await state.server.request(state.path + '/ack', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ack), signal: AbortSignal.timeout(1000) });
  assert.equal(reply.status, 503); assert.equal((await reply.json()).error, 'encoder_unavailable');
  const restored = await (await state.server.request(operation.path)).json();
  assert.equal(restored.status, 'ready'); assert.equal(restored.representationJSON, saved.representationJSON);
  assert.equal((await state.server.request(state.result.resultPath)).status, 200);
  release();
  for (let i = 0; i < 100; i++) {
    if ((await (await state.server.request('/v1/recommendations/config')).json()).encoder?.available) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await post(state.server, state.path + '/ack', ack)).status, 204);
  assert.equal(state.fixture.calls.model.length, 1);
  const next = await prepare(state, { revision: 2, mode: 'reusePublication',
    reuse: { publicationId: operation.input.operationId, artifacts: saved.artifacts } });
  await ready(state.server, next.path);
  await state.server.stop(); spaceID = 'changed-space'; warming = false;
  state.server = await state.env.launch(state.fixture.env);
  for (let i = 0; i < 100; i++) {
    if ((await (await state.server.request('/v1/recommendations/config')).json()).encoder?.available) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const mismatch = await post(state.server, state.path + '/ack', { ...ack, preparationOperationId: next.input.operationId });
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error, 'representation_space_changed');
});

test('definitive startup failure settles recovered work as unavailable without retrying image providers', async t => {
  let rejectStartup = false, release, called;
  const gate = new Promise(resolve => { release = resolve; });
  const preparing = new Promise(resolve => { called = resolve; });
  t.after(() => release());
  const state = await illustrated(t, {
    describe: async (_request, response) => response.end(JSON.stringify(rejectStartup ? {} : { spaceID: controlledSpaceID })),
    model: async (_request, response) => { called(); await gate; response.end('{}'); },
  });
  const operation = await prepare(state); assert.equal(operation.response.status, 202); await preparing;
  const imageCalls = Object.fromEntries(['preparation', 'attributes', 'generation', 'finalization'].map(stage => [stage, state.fixture.calls[stage].length]));
  await state.server.stop('SIGKILL'); rejectStartup = true;
  state.server = await state.env.launch(state.fixture.env);
  const failed = await ready(state.server, operation.path, 'failed');
  assert.equal(failed.operationId, operation.input.operationId); assert.equal(failed.error, 'encoder_unavailable');
  assert.equal((await (await state.server.request('/health', { signal: AbortSignal.timeout(1000) })).json()).encoderAvailable, false);
  const configResponse = await state.server.request('/v1/recommendations/config');
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.encoder.available, false); assert.equal(config.encoder.activeSpaceID, null);
  assert.equal((await state.server.request(state.result.resultPath)).status, 200);
  assert.equal(state.fixture.calls.model.length, 1);
  for (const [stage, count] of Object.entries(imageCalls)) assert.equal(state.fixture.calls[stage].length, count);
});

test('model configuration is authenticated and missing real assets never become a controlled fallback', async t => {
  const env = await environment(t), server = await env.launch({ SAINT_LOOK_MODEL_PROFILE: 'outfit-transformer-labse-v1',
    SAINT_LOOK_MODEL_PYTHON: '/does/not/exist', SAINT_LOOK_MODEL_ASSETS: '/does/not/exist' });
  assert.equal((await fetch(server.url + '/v1/recommendations/config')).status, 401);
  const config = await waitForModelConfiguration(server);
  assert.equal(config.encoder.mode, 'real'); assert.equal(config.encoder.available, false); assert.equal(config.encoder.activeSpaceID, null);
  assert.equal((await (await server.request('/health')).json()).preparationAvailable, false);
  await assert.rejects(env.launch({ NODE_ENV: 'production', SAINT_LOOK_TEST_MODEL_ORIGIN: 'http://127.0.0.1:8789' }), /Invalid controlled model origin/);
  await assert.rejects(env.launch({ NODE_ENV: 'test', SAINT_LOOK_TEST_MODEL_ORIGIN: 'https://example.com' }), /Invalid controlled model origin/);
});

test('v3 delivered digest-less cutout and undelivered ready illustration complete through explicit legacy import', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { join } = await import('node:path');
  const state = await illustrated(t);
  const cutout = Buffer.from(await (await state.server.request(state.cutout.resultPath)).arrayBuffer());
  const image = Buffer.from(await (await state.server.request(state.result.resultPath)).arrayBuffer());
  assert.equal((await state.server.request(`/v1/items/${state.photo.itemId}/operations/${state.photo.operationId}/ack`, { method: 'POST' })).status, 204);
  const saved = structuredClone(state.result);
  delete saved.resultSHA256; delete saved.observedFeaturesSHA256; delete saved.effectiveFeaturesSHA256;
  await state.server.stop();
  // Historical v3 input: ingestion delivered/cleared, illustration ready but not acknowledged.
  const legacyDatabase = new DatabaseSync(join(state.env.directory, 'wardrobe.sqlite'));
  legacyDatabase.exec(`PRAGMA user_version=3;
    UPDATE operation_receipts SET result_digest=NULL,result_mode=NULL;
    UPDATE illustrations SET result_digest=NULL,observed_digest=NULL,effective_digest=NULL;`);
  legacyDatabase.close();
  state.server = await state.env.launch(state.fixture.env);
  const oldAck = await state.server.request(state.path + '/ack', { method: 'POST' });
  assert.equal(oldAck.status, 409); assert.equal((await oldAck.json()).error, 'preparation_required');
  const withoutPacket = await prepare(state);
  assert.equal(withoutPacket.response.status, 409);
  assert.equal((await withoutPacket.response.json()).error, 'artifacts_not_ready');
  const legacy = { cutout: { imageBase64: cutout.toString('base64'), mode: state.cutout.mode },
    illustration: { imageBase64: image.toString('base64'), response: saved }, preparedPhotos: [] };
  const mutated = structuredClone(legacy);
  mutated.illustration.response.observedFeatures.traits.silhouette = 'relaxed';
  const bad = await prepare(state, { mode: 'legacyImport', legacy: mutated });
  assert.equal(bad.response.status, 409);
  assert.equal((await bad.response.json()).error, 'legacy_artifact_conflict');
  const operation = await prepare(state, { mode: 'legacyImport', legacy });
  const admitted = await operation.response.json();
  console.log(JSON.stringify({ migration: 'v3-cutout-delivered-illustration-ready', bodylessAck: 'preparation_required',
    noPacket: 'artifacts_not_ready', explicitPacketStatus: operation.response.status, explicitPacketError: admitted.error ?? null }));
  assert.equal(operation.response.status, 202, JSON.stringify(admitted));
  const prepared = await ready(state.server, operation.path);
  assert.equal(prepared.provenance, 'legacyImport'); assert.equal(prepared.imageMode, 'test');
  assert.equal((await state.server.request(state.path + '/ack', { method: 'POST' })).status, 409);
  assert.equal((await state.server.request(state.result.resultPath)).status, 200);
  const ack = { publicationProtocol: 'prepared-item-v1', preparationOperationId: operation.input.operationId };
  assert.equal((await post(state.server, state.path + '/ack', ack)).status, 204);
  assert.equal((await state.server.request(operation.path)).status, 410);
  assert.equal((await post(state.server, state.path + '/ack', ack)).status, 204);
  assert.equal(state.fixture.calls.preparation.length, 1); assert.equal(state.fixture.calls.attributes.length, 1); assert.equal(state.fixture.calls.generation.length, 1);
  const replacement = { ...await photoRequest(), itemId: state.photo.itemId, revision: 1, action: 'replace' };
  assert.equal((await post(state.server, `/v1/items/${state.photo.itemId}/attempts`, replacement)).status, 409);
});
