import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { environment } from './support.mjs';
import { illustrationFixture } from './providers/illustration.mjs';
import { publishedItem, refreshedItem, slot, singleInput, postJSON, awaitReady } from './recommendation-support.mjs';

const preparationPath = (item, operation) => `/v1/items/${item.photo.itemId}/preparations/${operation.operationId}`;
const acknowledgementPath = item => `/v1/items/${item.photo.itemId}/illustrations/${item.illustration.operationId}/ack`;
function refreshInput(item, spaceID, revision) {
  return { operationId: randomUUID(), revision, spaceID, mode: 'reusePublication',
    photoVersionId: item.photo.photoVersionId, sourceSetVersionId: item.illustration.sourceSetVersionId,
    illustrationOperationId: item.illustration.operationId, cutoutOperationId: item.photo.operationId,
    imageBase64: item.photo.imageBase64, features: item.item.features,
    reuse: { publicationId: item.item.publishedVersionId, artifacts: item.prepared.artifacts } };
}
const submit = (server, item, input) => postJSON(server, `/v1/items/${item.photo.itemId}/preparations`, input);
const acknowledge = (server, item, input) => postJSON(server, acknowledgementPath(item),
  { publicationProtocol: 'prepared-item-v1', preparationOperationId: input.operationId });
async function failed(server, path) {
  for (let i = 0; i < 150; i++) {
    const response = await server.request(path), result = await response.json();
    assert.equal(response.status, 200);
    if (result.status === 'failed') return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Accepted preparation never reached its terminal failure');
}

// All fixtures are external provider/model boundaries. The backend and its durable
// receipts are real; no database mutation or production keys are used here.
test('model restart terminates old-space CPU work and refreshes cached packets without repeating image stages', async t => {
  const controls = { spaceID: 'space-A' };
  const fixture = await illustrationFixture(t, controls), env = await environment(t);
  let server = await env.launch(fixture.env);
  const shirt = await publishedItem(server, 't_shirt'), trousers = await publishedItem(server, 'trousers');
  const target = slot('body'), bottom = slot('bottom', trousers), emptyLayer = slot('body');
  const input = singleInput([shirt, trousers], [target, emptyLayer, bottom], target, { pinnedSlotIds: [bottom.slotId] });
  assert.equal((await postJSON(server, '/v1/recommendations/single', input)).status, 200);
  const before = Object.fromEntries(Object.entries(fixture.calls).map(([key, values]) => [key, values.length]));

  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(release);
  controls.model = async (_request, response) => { entered(); await gate; response.end('{}'); };
  const interrupted = refreshInput(shirt, controls.spaceID, 2);
  assert.equal((await submit(server, shirt, interrupted)).status, 202);
  await started;
  await server.stop('SIGKILL');
  controls.spaceID = 'space-B'; delete controls.model;
  server = await env.launch({ ...fixture.env, SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'false' });
  release();
  const configuration = await (await server.request('/v1/recommendations/config')).json();
  assert.equal(configuration.encoder.activeSpaceID, 'space-B');
  assert.equal(configuration.encoderRefresh.available, true); assert.equal(configuration.newItemPreparation.available, false);
  const terminated = await failed(server, preparationPath(shirt, interrupted));
  assert.equal(terminated.error, 'encoder_unavailable'); assert.equal(terminated.spaceID, 'space-A');
  assert.equal((await submit(server, shirt, interrupted)).status, 409);
  const old = await postJSON(server, '/v1/recommendations/single', input);
  assert.equal(old.status, 409); assert.deepEqual(await old.json(), { error: 'incompatible_representations', activeSpaceID: 'space-B' });
  assert.equal(fixture.calls.rank.length, before.rank, 'Incompatible vectors never reach rank');

  // A real accepted encoder failure must leave the old publication receipt usable
  // as the basis of another CPU-only refresh, even after another process restart.
  controls.model = async (_request, response) => response.end('{}');
  const invalid = refreshInput(shirt, 'space-B', 3);
  assert.equal((await submit(server, shirt, invalid)).status, 202);
  assert.equal((await failed(server, preparationPath(shirt, invalid))).error, 'encoder_failed');
  assert.equal((await acknowledge(server, shirt, invalid)).status, 409);
  await server.stop(); delete controls.model;
  server = await env.launch({ ...fixture.env, SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'false' });
  const next = refreshInput(shirt, 'space-B', 4);
  assert.equal((await submit(server, shirt, next)).status, 202);
  const prepared = await awaitReady(server, preparationPath(shirt, next));
  assert.equal(JSON.parse(shirt.prepared.representationJSON).vector.length, 128);
  assert.equal(JSON.parse(prepared.representationJSON).vector.length, 128);
  assert.notEqual(prepared.spaceID, shirt.prepared.spaceID, 'Equal dimensions do not identify a compatible vector space');
  assert.deepEqual(prepared.artifacts, shirt.prepared.artifacts);
  assert.deepEqual(prepared.effectiveFeatures, shirt.item.features);
  assert.deepEqual(prepared.input, shirt.prepared.input, 'The immutable photo and paired current type/colors have the same hashes');
  const nextShirt = { ...shirt, prepared, item: { ...shirt.item, publishedVersionId: next.operationId,
    representationJSON: prepared.representationJSON, representationSHA256: prepared.representationSHA256 } };
  const nextTrousers = await refreshedItem(server, trousers);
  const nextBottom = { ...bottom, publishedVersionId: nextTrousers.item.publishedVersionId };
  const updated = singleInput([nextShirt, nextTrousers], [target, emptyLayer, nextBottom], target, { pinnedSlotIds: [bottom.slotId] });
  const uncommitted = await postJSON(server, '/v1/recommendations/single', updated);
  assert.equal(uncommitted.status, 409, 'A downloaded new packet is not admitted before publication ack');

  // Discard the acknowledgement response, then repeat the same commit after a
  // process restart. This models a client that cannot know whether ack arrived.
  await acknowledge(server, shirt, next);
  await server.stop(); server = await env.launch({ ...fixture.env, SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'false' });
  assert.equal((await acknowledge(server, shirt, next)).status, 204);
  assert.equal((await server.request(preparationPath(shirt, next))).status, 410);
  const result = await postJSON(server, '/v1/recommendations/single', updated), proposal = await result.json();
  assert.equal(result.status, 200, JSON.stringify(proposal));
  assert.equal(proposal.spaceID, 'space-B'); assert.equal(proposal.proposal.itemId, shirt.item.itemId);
  assert.equal(proposal.targetSlotId, target.slotId);
  const excluded = await postJSON(server, '/v1/recommendations/single', { ...updated, excludedItemIds: [shirt.item.itemId] });
  assert.equal(excluded.status, 200); assert.equal((await excluded.json()).outcome, 'no_alternative');
  const pinned = await postJSON(server, '/v1/recommendations/single', { ...updated, pinnedSlotIds: [target.slotId, bottom.slotId] });
  assert.equal(pinned.status, 200); assert.equal((await pinned.json()).outcome, 'constraints_conflict');
  for (const key of ['preparation', 'attributes', 'generation', 'finalization']) {
    assert.equal(fixture.calls[key].length, before[key], `Encoder switching never repeats the paid ${key} stage`);
  }
  for (const call of fixture.calls.model.slice(before.model)) {
    const source = call.photoVersionID === shirt.photo.photoVersionId ? shirt : trousers;
    assert.equal(call.imageBase64, source.photo.imageBase64);
    assert.equal(call.type, source.item.features.type); assert.deepEqual(call.colors, source.item.features.colors);
  }
});
