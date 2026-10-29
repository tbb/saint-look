import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { environment } from './support.mjs';
import { illustrationFixture } from './providers/illustration.mjs';
import { publishedItem, slot, postJSON, refreshedItem } from './recommendation-support.mjs';
const endpoint = '/v1/recommendations/compose';
const input = (publications, orderedSlots, changes = {}) => ({ requestId: randomUUID(), snapshotId: randomUUID(),
  mode: 'rebuild', orderedSlots, pinnedSlotIds: [], excludedItemIds: [], items: publications.map(p => p.item), ...changes });

test('compose starts from actual empty-context rank and fills existing places without encoding again', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), jeans = await publishedItem(server, 'jeans');
  const slots = [slot('body'), slot('bottom')], request = input([tee, jeans], slots);
  const before = Object.fromEntries(Object.entries(fixture.calls).map(([key, value]) => [key, value.length]));
  const response = await postJSON(server, endpoint, request), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.outcome, 'proposed'); assert.equal(result.mode, 'rebuild'); assert.equal(result.modelMode, 'controlled');
  assert.equal(result.requestId, request.requestId); assert.equal(result.snapshotId, request.snapshotId);
  assert.deepEqual(result.placements, slots.map((s, i) => ({ slotId: s.slotId, itemId: [tee, jeans][i].item.itemId, publishedVersionId: [tee, jeans][i].item.publishedVersionId })));
  assert.equal(fixture.calls.rank[0].context.length, 0); assert.equal(fixture.calls.rank[1].context.length, 1);
  for (const name of ['preparation', 'attributes', 'generation', 'finalization', 'model']) assert.equal(fixture.calls[name].length, before[name]);
});

test('fill preserves occupied slots and pinned emptiness; rebuild respects multiple pins and existing layers', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), hoodie = await publishedItem(server, 'hoodie'), coat = await publishedItem(server, 'coat'), jeans = await publishedItem(server, 'jeans');
  const slots = [slot('head'), slot('body', tee), slot('body'), slot('body', coat), slot('bottom')];
  const request = input([tee, hoodie, coat, jeans], slots, { mode: 'fillEmpty', pinnedSlotIds: [slots[0].slotId, slots[3].slotId] });
  let result = await (await postJSON(server, endpoint, request)).json();
  assert.equal(result.outcome, 'proposed');
  assert.deepEqual(result.placements.map(p => p.itemId), [null, tee.item.itemId, hoodie.item.itemId, coat.item.itemId, jeans.item.itemId]);
  result = await (await postJSON(server, endpoint, { ...request, mode: 'rebuild', pinnedSlotIds: [slots[0].slotId, slots[1].slotId, slots[3].slotId] })).json();
  assert.equal(result.outcome, 'proposed');
  assert.deepEqual(result.placements.map(p => p.itemId), [null, tee.item.itemId, hoodie.item.itemId, coat.item.itemId, jeans.item.itemId]);
  assert.ok(fixture.calls.rank.every(call => call.context.some(item => item.photoVersionID === coat.item.photoVersionId)));
});

test('partial search and no solution never remove a fuller current composition or invent new places', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), jeans = await publishedItem(server, 'jeans');
  const slots = [slot('body'), slot('bottom'), slot('shoes')];
  let result = await (await postJSON(server, endpoint, input([tee, jeans], slots))).json();
  assert.equal(result.outcome, 'partial'); assert.equal(result.reason, 'bounded_search_partial');
  assert.deepEqual(result.placements.map(p => p.slotId), slots.map(s => s.slotId)); assert.equal(result.placements[2].itemId, null);
  result = await (await postJSON(server, endpoint, input([tee, jeans], [slot('body', tee), slot('bottom', jeans)], { excludedItemIds: [jeans.item.itemId] }))).json();
  assert.equal(result.outcome, 'unchanged'); assert.equal(result.reason, 'insufficient_improvement'); assert.equal(result.placements, null);
  const calls = fixture.calls.rank.length;
  result = await (await postJSON(server, endpoint, input([], slots))).json();
  assert.equal(result.outcome, 'no_solution'); assert.equal(result.placements, null); assert.equal(fixture.calls.rank.length, calls);
});

test('fixed conflicts, all pins, missing preparation and a full fill request leave draft unchanged without rank', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), coat = await publishedItem(server, 'coat');
  const original = [slot('body', tee)];
  let result = await (await postJSON(server, endpoint, input([tee], original, { pinnedSlotIds: original.map(s => s.slotId) }))).json();
  assert.equal(result.reason, 'all_pinned'); assert.equal(result.placements, null);
  result = await (await postJSON(server, endpoint, input([tee], original, { mode: 'fillEmpty' }))).json();
  assert.equal(result.reason, 'nothing_to_fill');
  const legacy = { ...slot('body'), itemId: randomUUID() };
  result = await (await postJSON(server, endpoint, input([tee], [legacy, slot('bottom')], { pinnedSlotIds: [legacy.slotId] }))).json();
  assert.equal(result.reason, 'preparation_required'); assert.deepEqual(result.conflictingSlotIds, [legacy.slotId]);
  const inverted = [slot('body', coat), slot('body', tee), slot('bottom')];
  result = await (await postJSON(server, endpoint, input([tee, coat], inverted, { mode: 'fillEmpty' }))).json();
  assert.equal(result.reason, 'fixed_layer_order');
  const duplicate = [slot('body', tee), slot('body', tee), slot('bottom')];
  result = await (await postJSON(server, endpoint, input([tee], duplicate, { mode: 'fillEmpty' }))).json();
  assert.equal(result.reason, 'duplicate_item');
  const wrong = [slot('shoes', tee), slot('bottom')];
  result = await (await postJSON(server, endpoint, input([tee], wrong, { mode: 'fillEmpty' }))).json();
  assert.equal(result.reason, 'fixed_category_mismatch'); assert.equal(fixture.calls.rank.length, 0);
});

test('a deleted candidate or newer committed publication during composition invalidates every partial result', async t => {
  for (const action of ['delete', 'commit']) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fixture = await illustrationFixture(t, { rank: async (request, response, body) => { await gate; response.end(JSON.stringify({ scores: body.candidates.map(() => .5) })); } });
    const env = await environment(t), server = await env.launch(fixture.env), tee = await publishedItem(server, 't_shirt');
    const refreshed = action === 'commit' ? await refreshedItem(server, tee, false) : null;
    const pending = postJSON(server, endpoint, input([tee], [slot('body')]));
    for (let i = 0; i < 150 && !fixture.calls.rank.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.calls.rank.length, 1);
    if (refreshed) assert.equal((await refreshed.acknowledge()).status, 204);
    else assert.equal((await server.request(`/v1/items/${tee.item.itemId}`, { method: 'DELETE' })).status, 204);
    release(); const response = await pending;
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'snapshot_stale');
  }
});

test('composition rejects model errors and excessive structure without random fallback', async t => {
  let malformed = false;
  const fixture = await illustrationFixture(t, { rank: async (request, response) => { if (malformed) response.end(JSON.stringify({ scores: [null] })); else { response.writeHead(500); response.end('{}'); } } });
  const env = await environment(t), server = await env.launch(fixture.env), tee = await publishedItem(server, 't_shirt');
  for (const mode of [false, true]) {
    malformed = mode; const response = await postJSON(server, endpoint, input([tee], [slot('body')]));
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'model_failed');
  }
  const tooLong = await postJSON(server, endpoint, input([tee], Array.from({ length: 33 }, () => slot('body'))));
  assert.equal(tooLong.status, 400); assert.equal((await tooLong.json()).error, 'context_too_large');
  assert.equal(fixture.calls.rank.length, 2);
  assert.equal((await fetch(server.url + endpoint, { method: 'POST' })).status, 401);
});

test('coverage precedes sequential scores and 300 cached items stay inside the 63-call search bound', async t => {
  const { clonePreparedPacket, installReceiptFixture } = await import('./prepared-receipt-fixture.mjs');
  const fixture = await illustrationFixture(t), env = await environment(t);
  let server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt');
  const clones = Array.from({ length: 299 }, () => clonePreparedPacket(tee.item));
  await server.stop(); installReceiptFixture(env.directory, clones); server = await env.launch(fixture.env);
  const slots = Array.from({ length: 32 }, () => slot('body'));
  const request = input([tee], slots); request.items.push(...clones);
  const response = await postJSON(server, endpoint, request), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.outcome, 'proposed');
  assert.equal(new Set(result.placements.map(p => p.itemId)).size, 32);
  assert.equal(fixture.calls.rank.length, 63); assert.ok(fixture.calls.rank.every(call => call.context.length <= 31));
  assert.deepEqual(result.placements.map(p => p.slotId), slots.map(s => s.slotId));
});

test('beam prefers a fuller legal layer sequence over a higher scoring incomplete branch', async t => {
  let coatID;
  const fixture = await illustrationFixture(t, { rank: async (request, response, body) => response.end(JSON.stringify({ scores: body.candidates.map(c => c.photoVersionID === coatID ? 0.9 : -0.9) })) });
  const env = await environment(t), server = await env.launch(fixture.env);
  const tee = await publishedItem(server, 't_shirt'), coat = await publishedItem(server, 'coat'); coatID = coat.item.photoVersionId;
  const result = await (await postJSON(server, endpoint, input([coat, tee], [slot('body'), slot('body')]))).json();
  assert.equal(result.outcome, 'proposed'); assert.deepEqual(result.placements.map(p => p.itemId), [tee.item.itemId, coat.item.itemId]);
});
