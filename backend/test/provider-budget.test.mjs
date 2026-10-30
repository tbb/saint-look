import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createProviderBudget } from '../src/provider-budget.mjs';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { providerFixture } from './providers/fixture.mjs';
import { illustrationFixture } from './providers/illustration.mjs';

function policy(limits = { photoroom: 2, jev: 2, gemini: 1 }) {
  return JSON.stringify({ id: 'epic63-public-v1-5d85dde081e8', approved: true, pricesCheckedAt: new Date().toISOString(),
    limits, ratesMicrousd: { photoroom: 0, jev: 2753, gemini: 400000 }, maxCostMicrousd: 4500000 });
}
test('unapproved real-provider admission fails before external calls', async t => {
  const fixture = await providerFixture(t), env = await environment(t), server = await env.launch({ ...fixture.env, SAINT_LOOK_TEST_REQUIRE_API_BUDGET: 'true' });
  const photo = await photoRequest(); assert.equal((await upload(server, photo)).status, 202);
  assert.equal((await waitForItem(server, photo.itemId, 'failed')).error, 'provider_budget_not_approved');
  assert.equal(fixture.calls.attributes.length, 0); assert.equal(fixture.calls.cutout.length, 0);
});

test('failed calls keep their reservation across restart and cannot exceed the approved count', async t => {
  const fixture = await providerFixture(t, { attributes: async (request, response) => { response.writeHead(422); response.end('{}'); } });
  const env = await environment(t), settings = { ...fixture.env, SAINT_LOOK_API_BUDGET_JSON: policy({ photoroom: 1, jev: 1, gemini: 1 }) };
  let server = await env.launch(settings);
  const photo = await photoRequest(); await upload(server, photo);
  assert.equal((await waitForItem(server, photo.itemId, 'failed')).error, 'provider_rejected');
  assert.equal((await upload(server, photo)).status, 200); assert.equal(fixture.calls.attributes.length, 1);
  await server.stop(); server = await env.launch(settings);
  const second = await photoRequest(); await upload(server, second);
  assert.equal((await waitForItem(server, second.itemId, 'failed')).error, 'provider_budget_exhausted');
  assert.equal(fixture.calls.attributes.length, 1); assert.equal(fixture.calls.cutout.length, 0);
});

test('illustration reservations bound Gemini submissions and expose exhausted preparation capability', async t => {
  const fixture = await illustrationFixture(t), env = await environment(t), server = await env.launch({ ...fixture.env, SAINT_LOOK_API_BUDGET_JSON: policy() });
  const photo = await photoRequest(); await upload(server, photo); await waitForItem(server, photo.itemId);
  const initial = { operationId: randomUUID(), photoVersionId: photo.photoVersionId, sourceSetVersionId: randomUUID(), revision: 1,
    photos: [{ id: photo.photoVersionId, role: 'front', imageBase64: photo.imageBase64 }] };
  const send = input => server.request(`/v1/items/${photo.itemId}/illustrations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  async function finish(id, expected) {
    for (let i = 0; i < 150; i++) {
      const value = await (await server.request(`/v1/items/${photo.itemId}/illustrations/${id}`)).json();
      if (value.status === expected) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Illustration deadline exceeded');
  }
  assert.equal((await send(initial)).status, 202); await finish(initial.operationId, 'ready');
  const config = await (await server.request('/v1/recommendations/config')).json();
  assert.equal(config.newItemPreparation.available, false); assert.equal(config.encoderRefresh.available, true);
  const second = { ...initial, operationId: randomUUID(), revision: 2 };
  assert.equal((await send(second)).status, 202);
  assert.equal((await finish(second.operationId, 'failed')).error, 'provider_budget_exhausted');
  assert.equal(fixture.calls.generation.length, 1); assert.equal(fixture.calls.preparation.length, 1);
});

test('migrates the exact deployed fal policy while preserving old reservations and total spend', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE provider_budgets (id TEXT PRIMARY KEY, policy TEXT NOT NULL);
    CREATE TABLE provider_reservations (budget_id TEXT NOT NULL, provider TEXT NOT NULL, operation_key TEXT NOT NULL,
      cost_microusd INTEGER NOT NULL, reserved_at INTEGER NOT NULL, PRIMARY KEY(budget_id, provider, operation_key));`);
  const id = 'epic63-public-v1-5d85dde081e8';
  const deployedFalPolicy = { id, approved: true,
    limits: { photoroom: 60, jev: 48, fal: 24 },
    ratesMicrousd: { photoroom: 0, jev: 2753, fal: 150000 }, maxCostMicrousd: 4500000 };
  database.prepare('INSERT INTO provider_budgets VALUES (?,?)').run(id, JSON.stringify(deployedFalPolicy));
  const reservation = database.prepare('INSERT INTO provider_reservations VALUES (?,?,?,?,?)');
  for (let attempt = 1; attempt <= 24; attempt++) {
    reservation.run(id, 'fal', `historical-fal-attempt-${attempt}`, 150000, attempt);
  }
  const env = { SAINT_LOOK_API_BUDGET_JSON: policy(), NODE_ENV: 'production' };
  const budget = createProviderBudget(database, env);
  assert.equal(budget.available('gemini'), false);
  assert.throws(() => budget.reserve('gemini', 'new-gemini-attempt'), { code: 'provider_budget_exhausted' });
  assert.equal(database.prepare('SELECT SUM(cost_microusd) AS total FROM provider_reservations WHERE budget_id=?')
    .get(id).total, 3600000);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM provider_reservations WHERE provider='gemini'").get().count, 0);
  assert.equal(JSON.parse(database.prepare('SELECT policy FROM provider_budgets WHERE id=?').get(id).policy).limits.gemini, 1);
  database.close();
});
