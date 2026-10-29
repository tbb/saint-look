import test from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './support.mjs';
import { illustrationFixture } from './providers/illustration.mjs';
import { publishedItem, slot, singleInput, postJSON } from './recommendation-support.mjs';

function observableFixture(state) {
  return async (_request, response, { body }) => {
    const payload = JSON.parse(body);
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([name, q]) => {
      if (q.type === 'noul') return [name, { type: 'noul', noul: name === 'color_red' ? 0.99 : 0.01 }];
      const choice = name === 'suitability' ? 'suitable' : name === 'item_type' ? 't_shirt' : state[name] ?? 'unknown';
      return [name, { type: 'choice', choice, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === choice ? 1 : 0])) }];
    }));
    response.end(JSON.stringify({ model: payload.model, answers, usage: { input_tokens: 1000 } }));
  };
}
async function packet(server, type, colors = ['red']) {
  const publication = await publishedItem(server, type, colors);
  // The normal publication helper captures the effective traits before its ack
  // clears the provider payload; no second attribute or image request is needed.
  return { ...publication, item: { ...publication.item, effectiveFeatures: publication.effectiveFeatures } };
}

test('explicit similar intent balances published observable similarity with context through the same HTTP contract', async t => {
  let preferred;
  const traits = { silhouette: 'straight', pattern: 'plain' };
  const fixture = await illustrationFixture(t, { attributes: observableFixture(traits), rank: async (_request, response, input) =>
    response.end(JSON.stringify({ scores: input.candidates.map(c => c.photoVersionID === preferred ? 0.8 : 0.4) })) });
  const env = await environment(t), server = await env.launch(fixture.env);
  const original = await packet(server, 't_shirt'), similar = await packet(server, 't_shirt');
  traits.silhouette = 'relaxed'; traits.pattern = 'checks';
  const complement = await packet(server, 'hoodie', ['blue']), jeans = await packet(server, 'jeans');
  preferred = complement.item.photoVersionId;
  const target = slot('body', original), input = singleInput([original, similar, complement, jeans], [target, slot('bottom', jeans)], target);
  const before = Object.fromEntries(Object.entries(fixture.calls).map(([key, value]) => [key, value.length]));
  const other = await (await postJSON(server, '/v1/recommendations/single', input)).json();
  assert.equal(other.proposal.itemId, complement.item.itemId);
  const response = await postJSON(server, '/v1/recommendations/single', { ...input, intent: 'similar' }), close = await response.json();
  assert.equal(response.status, 200, JSON.stringify(close)); assert.equal(close.outcome, 'proposed');
  assert.equal(close.proposal.itemId, similar.item.itemId); assert.equal(close.intent, 'similar');
  assert.equal(close.rankingVersion, 'observable-context-v1');
  for (const name of ['preparation', 'attributes', 'generation', 'finalization', 'model']) assert.equal(fixture.calls[name].length, before[name]);
  assert.equal(fixture.calls.rank.length - before.rank, 2);
  assert.ok(fixture.calls.rank.every(call => call.context.every(item => item.photoVersionID !== original.item.photoVersionId)));
});

test('similarity is a soft preference: no exact analogue still proposes; pins, exclusions and no alternatives preserve the original', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const original = await packet(server, 't_shirt'), alternative = await packet(server, 'hoodie', ['blue']), jeans = await packet(server, 'jeans');
  const target = slot('body', original), input = singleInput([original, alternative, jeans], [target, slot('bottom', jeans)], target, { intent: 'similar' });
  const result = await (await postJSON(server, '/v1/recommendations/single', input)).json();
  assert.equal(result.outcome, 'proposed'); assert.equal(result.proposal.itemId, alternative.item.itemId);
  const excluded = await (await postJSON(server, '/v1/recommendations/single', { ...input, excludedItemIds: [alternative.item.itemId] })).json();
  assert.equal(excluded.outcome, 'no_alternative'); assert.equal(excluded.proposal, null);
  const pinned = await (await postJSON(server, '/v1/recommendations/single', { ...input, pinnedSlotIds: [target.slotId] })).json();
  assert.equal(pinned.reason, 'target_pinned'); assert.equal(pinned.proposal, null);
  assert.equal(fixture.calls.rank.length, 1);
});

test('published trait hashes and original admission prevent silently invented style evidence', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const original = await packet(server, 't_shirt'), alternative = await packet(server, 'polo'), jeans = await packet(server, 'jeans');
  const target = slot('body', original), input = singleInput([original, alternative, jeans], [target, slot('bottom', jeans)], target, { intent: 'similar' });
  const changed = structuredClone(input); changed.items[1].effectiveFeatures.traits.pattern = 'stripes';
  let response = await postJSON(server, '/v1/recommendations/single', changed);
  assert.equal(response.status, 400); assert.equal((await response.json()).error, 'invalid_prepared_item');
  const missing = structuredClone(input); delete missing.items[1].effectiveFeatures;
  response = await postJSON(server, '/v1/recommendations/single', missing);
  assert.equal(response.status, 400); assert.equal((await response.json()).error, 'similarity_features_required');
  response = await postJSON(server, '/v1/recommendations/single', { ...input, items: input.items.slice(1) });
  assert.equal(response.status, 400); assert.equal((await response.json()).error, 'similarity_source_required');
  assert.equal(fixture.calls.rank.length, 0);
});


test('similar origin-only intent uses explicit observed similarity without pretending there is model context', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch(fixture.env);
  const original = await packet(server, 't_shirt'), alternative = await packet(server, 'polo');
  const target = slot('body', original), input = singleInput([original, alternative], [target], target, { intent: 'similar' });
  const response = await postJSON(server, '/v1/recommendations/single', input), result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.proposal.itemId, alternative.item.itemId);
  assert.equal(result.intent, 'similar'); assert.equal(fixture.calls.rank.length, 0);
  const complement = await (await postJSON(server, '/v1/recommendations/single', { ...input, intent: 'complement' })).json();
  assert.equal(complement.outcome, 'empty_context'); assert.equal(complement.proposal, null);
});
