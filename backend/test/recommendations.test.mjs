import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, waitForModelConfiguration } from './support.mjs';
import { illustrationFixture } from './providers/illustration.mjs';
import { publishedItem, slot, singleInput, postJSON } from './recommendation-support.mjs';

test('single complement ranks cached candidates while preserving all other places and excluding original', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const top = await publishedItem(server, 't_shirt'), original = await publishedItem(server, 'jeans'), replacement = await publishedItem(server, 'trousers');
  const body = slot('body', top), target = slot('bottom', original);
  const input = singleInput([top, replacement], [body, target], target, { pinnedSlotIds: [body.slotId] });
  const before = Object.fromEntries(Object.entries(fixture.calls).map(([key, value]) => [key, value.length]));
  const response = await postJSON(server, '/v1/recommendations/single', input), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.outcome, 'proposed'); assert.deepEqual(result.proposal, { itemId: replacement.item.itemId, publishedVersionId: replacement.item.publishedVersionId });
  assert.equal(result.snapshotId, input.snapshotId); assert.equal(result.targetSlotId, target.slotId); assert.equal(result.requestId, input.requestId);
  assert.equal(result.mode, 'controlled'); assert.equal(result.policyVersion, 'outfit-placement-v1');
  for (const name of ['preparation', 'attributes', 'generation', 'finalization', 'model']) assert.equal(fixture.calls[name].length, before[name]);
  assert.equal(fixture.calls.rank.length, 1);
  assert.deepEqual(fixture.calls.rank[0].context.map(p => p.photoVersionID), [top.item.photoVersionId]);
  assert.deepEqual(fixture.calls.rank[0].candidates.map(p => p.photoVersionID), [replacement.item.photoVersionId]);
  assert.ok(fixture.calls.rank[0].context.every(p => !('imageBase64' in p) && !('imagePath' in p)));
});

test('automatic body layers preserve equal ranks and reject fixed inversions without changing manual policy', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const hoodie = await publishedItem(server, 'hoodie'), jacket = await publishedItem(server, 'jacket'), tee = await publishedItem(server, 't_shirt'), sweater = await publishedItem(server, 'sweater');
  const inner = slot('body'), middle = slot('body', hoodie), outer = slot('body', jacket);
  let input = singleInput([hoodie, jacket, tee, sweater], [inner, middle, outer], inner);
  let result = await (await postJSON(server, '/v1/recommendations/single', input)).json();
  assert.equal(result.outcome, 'proposed');
  assert.deepEqual(new Set(fixture.calls.rank.at(-1).candidates.map(c => c.photoVersionID)), new Set([tee.item.photoVersionId, sweater.item.photoVersionId]));
  input = { ...input, orderedSlots: [middle, outer, inner] };
  result = await (await postJSON(server, '/v1/recommendations/single', input)).json();
  assert.equal(result.outcome, 'no_alternative'); assert.equal(result.reason, 'layer_constraints');
  input = { ...input, orderedSlots: [outer, inner, middle] };
  result = await (await postJSON(server, '/v1/recommendations/single', input)).json();
  assert.equal(result.outcome, 'constraints_conflict'); assert.equal(result.reason, 'fixed_layer_order');
  assert.deepEqual(result.conflictingSlotIds, [outer.slotId, middle.slotId]); assert.equal(fixture.calls.rank.length, 1);
  // The target may itself be the bad layer: removing it permits a valid replacement.
  input = singleInput([hoodie, tee, sweater], [outer, middle], outer);
  result = await (await postJSON(server, '/v1/recommendations/single', input)).json();
  assert.equal(result.outcome, 'proposed'); assert.equal(fixture.calls.rank.length, 2);
  result = await (await postJSON(server, '/v1/recommendations/single', { ...input, pinnedSlotIds: [outer.slotId] })).json();
  assert.equal(result.reason, 'target_pinned'); assert.equal(fixture.calls.rank.length, 2);
});

test('empty context and missing or excluded alternatives are distinct no-op outcomes without a model call', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), trousers = await publishedItem(server, 'trousers');
  const body = slot('body'), bottom = slot('bottom', trousers), shoes = slot('shoes');
  const empty = singleInput([tee], [body], body);
  assert.equal((await (await postJSON(server, '/v1/recommendations/single', empty)).json()).outcome, 'empty_context');
  const absent = singleInput([tee, trousers], [slot('body', tee), bottom, shoes], shoes);
  assert.equal((await (await postJSON(server, '/v1/recommendations/single', absent)).json()).reason, 'no_category_candidates');
  const excluded = singleInput([tee, trousers], [body, bottom], body, { excludedItemIds: [tee.item.itemId] });
  assert.equal((await (await postJSON(server, '/v1/recommendations/single', excluded)).json()).reason, 'excluded_or_occupied');
  const malformedCategory = singleInput([tee, trousers], [slot('body', trousers), shoes], shoes);
  assert.equal((await (await postJSON(server, '/v1/recommendations/single', malformedCategory)).json()).reason, 'fixed_category_mismatch');
  const duplicate = singleInput([tee, trousers], [slot('body', tee), slot('body', tee), shoes], shoes);
  assert.equal((await (await postJSON(server, '/v1/recommendations/single', duplicate)).json()).reason, 'duplicate_item');
  assert.equal(fixture.calls.rank.length, 0);
  await server.stop(); const restarted = await env.launch({ ...fixture.env, SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'false' });
  const config = await waitForModelConfiguration(restarted);
  assert.equal(config.recommendations.available, true); assert.equal(config.newItemPreparation.available, false);
});

test('the best negative score is still proposed and exact ties use stable item UUID rather than request order', async t => {
  let preferred, tie = false;
  const fixture = await illustrationFixture(t, { rank: async (request, response, input) => response.end(JSON.stringify({ scores: input.candidates.map(c => tie ? -0.5 : c.photoVersionID === preferred ? -0.2 : -0.9) })) });
  const env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), boots = await publishedItem(server, 'boots'), sneakers = await publishedItem(server, 'sneakers');
  preferred = boots.item.photoVersionId;
  const target = slot('shoes'), input = singleInput([tee, sneakers, boots], [slot('body', tee), target], target);
  let result = await (await postJSON(server, '/v1/recommendations/single', input)).json();
  assert.equal(result.proposal.itemId, boots.item.itemId); assert.equal('score' in result, false);
  tie = true;
  const expected = [boots.item.itemId, sneakers.item.itemId].sort()[0];
  for (const items of [input.items, [...input.items].reverse()]) {
    result = await (await postJSON(server, '/v1/recommendations/single', { ...input, items })).json();
    assert.equal(result.proposal.itemId, expected);
  }
});

test('snapshot receipts bind exact opaque bytes and features, with no interpretation of an unprepared target as context', async t => {
  const { randomUUID, createHash } = await import('node:crypto');
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), trousers = await publishedItem(server, 'trousers');
  const target = { ...slot('body'), itemId: randomUUID(), publishedVersionId: null };
  const input = singleInput([tee, trousers], [target, slot('bottom', trousers)], target);
  const result = await (await postJSON(server, '/v1/recommendations/single', input)).json();
  assert.equal(result.proposal.itemId, tee.item.itemId);
  assert.equal(fixture.calls.rank[0].context.length, 1);
  const changes = [
    item => ({ ...item, features: { type: 'hoodie', colors: ['red'] } }),
    item => ({ ...item, sourceSetVersionId: randomUUID() }),
    item => ({ ...item, representationJSON: item.representationJSON + ' ', representationSHA256: createHash('sha256').update(item.representationJSON + ' ').digest('hex') }),
  ];
  for (const mutate of changes) {
    const response = await postJSON(server, '/v1/recommendations/single', { ...input, items: [mutate(tee.item), trousers.item] });
    assert.equal(response.status, 400); assert.equal((await response.json()).error, 'invalid_prepared_item');
  }
  assert.equal(fixture.calls.rank.length, 1);
  await server.request(`/v1/items/${target.itemId}`, { method: 'DELETE' });
  assert.equal((await postJSON(server, '/v1/recommendations/single', input)).status, 409);
});

test('a deleted candidate during rank invalidates the whole captured result', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = await illustrationFixture(t, { rank: async (request, response, input) => { await gate; response.end(JSON.stringify({ scores: input.candidates.map(() => 0.8) })); } });
  const env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), trousers = await publishedItem(server, 'trousers');
  const target = slot('body'), input = singleInput([tee, trousers], [target, slot('bottom', trousers)], target);
  const pending = postJSON(server, '/v1/recommendations/single', input);
  for (let i = 0; i < 150 && !fixture.calls.rank.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fixture.calls.rank.length, 1);
  assert.equal((await server.request(`/v1/items/${tee.item.itemId}`, { method: 'DELETE' })).status, 204);
  release(); const response = await pending;
  assert.equal(response.status, 409); assert.equal((await response.json()).error, 'snapshot_stale');
});

test('model failure and malformed scores never become a random or empty suggestion', async t => {
  let malformed = false;
  const fixture = await illustrationFixture(t, { rank: async (request, response) => { if (malformed) response.end(JSON.stringify({ scores: [null] })); else { response.writeHead(500); response.end('{}'); } } });
  const env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), trousers = await publishedItem(server, 'trousers');
  const target = slot('body'), input = singleInput([tee, trousers], [target, slot('bottom', trousers)], target);
  for (const invalid of [false, true]) {
    malformed = invalid;
    const response = await postJSON(server, '/v1/recommendations/single', input);
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'model_failed' });
  }
});

test('new pending preparation preserves old published admission, but a newer commit during rank makes the response stale', async t => {
  const { refreshedItem } = await import('./recommendation-support.mjs');
  let release, gated = false;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = await illustrationFixture(t, { rank: async (request, response, input) => {
    if (gated) await gate; response.end(JSON.stringify({ scores: input.candidates.map(() => 0.5) }));
  } });
  const env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), trousers = await publishedItem(server, 'trousers');
  const refreshed = await refreshedItem(server, tee, false), target = slot('body');
  const input = singleInput([tee, trousers], [target, slot('bottom', trousers)], target);
  assert.equal((await postJSON(server, '/v1/recommendations/single', input)).status, 200);
  const undelivered = await postJSON(server, '/v1/recommendations/single', { ...input, items: [refreshed.item, trousers.item] });
  assert.ok([400, 409].includes(undelivered.status));
  gated = true;
  const pending = postJSON(server, '/v1/recommendations/single', input);
  for (let i = 0; i < 150 && fixture.calls.rank.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fixture.calls.rank.length, 2);
  assert.equal((await refreshed.acknowledge()).status, 204);
  release();
  const result = await pending;
  assert.equal(result.status, 409); assert.equal((await result.json()).error, 'snapshot_stale');
  assert.equal((await postJSON(server, '/v1/recommendations/single', { ...input, items: [refreshed.item, trousers.item] })).status, 200);
});

test('used vectors require the active space, while an excluded original from an older space remains replaceable', async t => {
  const { refreshedItem } = await import('./recommendation-support.mjs');
  const controls = {};
  const fixture = await illustrationFixture(t, controls), env = await environment(t);
  let server = await env.launch(fixture.env);
  const original = await publishedItem(server, 't_shirt'), candidate = await publishedItem(server, 'hoodie'), trousers = await publishedItem(server, 'trousers');
  const target = slot('body', original);
  let input = singleInput([candidate, trousers], [target, slot('bottom', trousers)], target);
  await server.stop(); controls.spaceID = 'controlled-outfit-next'; server = await env.launch(fixture.env);
  await waitForModelConfiguration(server);
  const incompatible = await postJSON(server, '/v1/recommendations/single', input);
  assert.equal(incompatible.status, 409);
  assert.deepEqual(await incompatible.json(), { error: 'incompatible_representations', activeSpaceID: controls.spaceID });
  const nextCandidate = await refreshedItem(server, candidate), nextTrousers = await refreshedItem(server, trousers);
  input = singleInput([nextCandidate, nextTrousers], [target, slot('bottom', nextTrousers)], target);
  const result = await (await postJSON(server, '/v1/recommendations/single', input)).json();
  assert.equal(result.proposal.itemId, candidate.item.itemId); assert.equal(result.spaceID, controls.spaceID);
  assert.equal(fixture.calls.rank.length, 1);
});

test('owner auth, packet size and item limits reject malformed input before model work', async t => {
  const { randomUUID } = await import('node:crypto');
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  assert.equal((await fetch(server.url + '/v1/recommendations/single', { method: 'POST' })).status, 401);
  const target = slot('body'), input = singleInput([], [target], target);
  const tooMany = await postJSON(server, '/v1/recommendations/single', { ...input, items: Array.from({ length: 301 }, () => ({ itemId: randomUUID() })) });
  assert.equal(tooMany.status, 400); assert.equal((await tooMany.json()).error, 'too_many_items');
  const tooLarge = await postJSON(server, '/v1/recommendations/single', { ...input, padding: 'a'.repeat(4 * 1024 * 1024) });
  assert.equal(tooLarge.status, 413); assert.equal((await tooLarge.json()).error, 'request_too_large');
  assert.equal((await postJSON(server, '/v1/recommendations/single', { ...input, orderedSlots: [target, target] })).status, 400);
  assert.equal(fixture.calls.rank.length, 0);
});

test('300 synthetic prepared receipts fit one HTTP request and automatic context length is explicitly bounded', async t => {
  const { clonePreparedPacket, installReceiptFixture } = await import('./prepared-receipt-fixture.mjs');
  const fixture = await illustrationFixture(t), env = await environment(t);
  let server = await env.launch(fixture.env);
  const baseline = await publishedItem(server, 't_shirt');
  const synthetic = Array.from({ length: 299 }, () => clonePreparedPacket(baseline.item));
  await server.stop(); installReceiptFixture(env.directory, synthetic); server = await env.launch(fixture.env);
  await waitForModelConfiguration(server);
  const target = slot('body'), input = singleInput([baseline], [slot('body', baseline), target], target);
  input.items = [baseline.item, ...synthetic];
  const response = await postJSON(server, '/v1/recommendations/single', input), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.outcome, 'proposed');
  assert.equal(fixture.calls.rank[0].candidates.length, 299);
  const manySlots = [slot('body', baseline), ...synthetic.slice(0, 32).map(item => ({ slotId: item.itemId, zone: 'body', itemId: item.itemId, publishedVersionId: item.publishedVersionId })), target];
  const tooLong = await postJSON(server, '/v1/recommendations/single', { ...input, orderedSlots: manySlots });
  assert.equal(tooLong.status, 400); assert.equal((await tooLong.json()).error, 'context_too_large');
  assert.equal(fixture.calls.rank.length, 1);
});
