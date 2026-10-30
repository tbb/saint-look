import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createProviderBudget, validateApiBudget } from '../src/provider-budget.mjs';
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

function fullPolicy(maxCostMicrousd = 4500000) {
  return { ...JSON.parse(policy({ photoroom: 60, jev: 48, gemini: 24 })), maxCostMicrousd };
}
const reservations = database => database.prepare('SELECT * FROM provider_reservations ORDER BY provider,operation_key').all();
const storedPolicy = database => JSON.parse(database.prepare('SELECT policy FROM provider_budgets').get().policy);

test('raises only the known same-ID cap, retaining reservations, failures, legacy counts and unknown cost', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const old = fullPolicy(), env = { NODE_ENV: 'production', SAINT_LOOK_API_BUDGET_JSON: JSON.stringify(old) };
    const budget = createProviderBudget(database, env);
    for (let index = 0; index < 10; index++) budget.reserve('gemini', `already-attempted-${index}`);
    budget.reserve('jev', 'already-attempted-jev'); budget.reserve('photoroom', 'already-attempted-cutout');
    const insert = database.prepare('INSERT INTO provider_reservations VALUES (?,?,?,?,?)');
    insert.run(old.id, 'fal', 'legacy-unknown-outcome', 150000, 1);
    insert.run(old.id, 'unknown-historical-provider', 'conservative-cost', 300000, 2);
    const before = reservations(database), oldTotal = before.reduce((sum, row) => sum + row.cost_microusd, 0);
    assert.equal(oldTotal, 4452753);
    assert.throws(() => budget.reserve('gemini', 'before-cap-change'), { code: 'provider_budget_exhausted' });
    env.SAINT_LOOK_API_BUDGET_JSON = JSON.stringify(fullPolicy(8800000));
    assert.equal(budget.available('gemini'), true);
    assert.deepEqual(reservations(database), before);
    const { pricesCheckedAt, ...expectedIdentity } = fullPolicy(8800000);
    assert.deepEqual(storedPolicy(database), expectedIdentity);
    budget.reserve('gemini', 'after-cap-change');
    const after = reservations(database);
    assert.equal(after.length, before.length + 1);
    assert.equal(after.reduce((sum, row) => sum + row.cost_microusd, 0), oldTotal + 400000);
    for (const row of before) assert.deepEqual(after.find(value => value.provider === row.provider && value.operation_key === row.operation_key), row);
    assert.throws(() => budget.reserve('gemini', 'already-attempted-0'), { code: 'provider_request_already_reserved' });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM provider_budgets').get().count, 1);
    env.SAINT_LOOK_API_BUDGET_JSON = JSON.stringify(fullPolicy());
    assert.equal(budget.available('gemini'), false);
    assert.throws(() => budget.reserve('jev', 'unsafe-downgrade'), { code: 'provider_budget_not_approved' });
    assert.equal(storedPolicy(database).maxCostMicrousd, 8800000);
    assert.deepEqual(reservations(database), after);
  } finally { database.close(); }
});

test('same-ID downgrade to the old cap is possible only while every reserved cost fits', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const env = { NODE_ENV: 'production', SAINT_LOOK_API_BUDGET_JSON: JSON.stringify(fullPolicy()) };
    const budget = createProviderBudget(database, env);
    budget.reserve('gemini', 'before-upgrade');
    const before = reservations(database);
    env.SAINT_LOOK_API_BUDGET_JSON = JSON.stringify(fullPolicy(8800000));
    assert.equal(budget.available('gemini'), true);
    env.SAINT_LOOK_API_BUDGET_JSON = JSON.stringify(fullPolicy());
    assert.equal(budget.available('gemini'), true);
    assert.equal(storedPolicy(database).maxCostMicrousd, 4500000);
    assert.deepEqual(reservations(database), before);
    budget.reserve('jev', 'after-safe-downgrade');
    assert.equal(reservations(database).length, before.length + 1);
  } finally { database.close(); }
});

test('cap migration rejects changed rates, limits, identity, arbitrary cap and above-$8.80 policy', () => {
  for (const change of [
    value => { value.ratesMicrousd.gemini = 399999; },
    value => { value.limits.gemini = 23; },
    value => { value.id = 'a-new-budget-must-not-reset-the-journal'; },
    value => { value.maxCostMicrousd = 6000000; },
    value => { value.maxCostMicrousd = 8800001; },
  ]) {
    const database = new DatabaseSync(':memory:');
    try {
      const env = { NODE_ENV: 'production', SAINT_LOOK_API_BUDGET_JSON: JSON.stringify(fullPolicy()) };
      const budget = createProviderBudget(database, env); budget.reserve('gemini', 'retained');
      const before = reservations(database), prior = storedPolicy(database), changed = fullPolicy(8800000);
      change(changed); env.SAINT_LOOK_API_BUDGET_JSON = JSON.stringify(changed);
      assert.equal(budget.available('gemini'), false);
      assert.throws(() => budget.reserve('gemini', 'must-not-spend'), { code: 'provider_budget_not_approved' });
      assert.deepEqual(reservations(database), before); assert.deepEqual(storedPolicy(database), prior);
    } finally { database.close(); }
  }
  assert.equal(validateApiBudget(fullPolicy(8800000)).maxCostMicrousd, 8800000);
  assert.throws(() => validateApiBudget(fullPolicy(8800001)), { code: 'provider_budget_not_approved' });
});

test('exact-cap downgrade preserves unknown cost and cannot bypass the separate fal migration', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const env = { NODE_ENV: 'production', SAINT_LOOK_API_BUDGET_JSON: JSON.stringify(fullPolicy(8800000)) };
    const budget = createProviderBudget(database, env); budget.reserve('gemini', 'known-attempt');
    database.prepare('INSERT INTO provider_reservations VALUES (?,?,?,?,?)')
      .run(fullPolicy().id, 'unknown-historical-provider', 'remaining-conservative-cost', 4100000, 1);
    const before = reservations(database);
    env.SAINT_LOOK_API_BUDGET_JSON = JSON.stringify(fullPolicy());
    assert.equal(budget.available('photoroom'), true);
    assert.equal(storedPolicy(database).maxCostMicrousd, 4500000);
    assert.deepEqual(reservations(database), before);
    assert.throws(() => budget.reserve('jev', 'cannot-exceed-lowered-cap'), { code: 'provider_budget_exhausted' });
    const falIdentity = { id: fullPolicy().id, approved: true, limits: { photoroom: 60, jev: 48, fal: 24 },
      ratesMicrousd: { photoroom: 0, jev: 2753, fal: 150000 }, maxCostMicrousd: 4500000 };
    database.prepare('UPDATE provider_budgets SET policy=?').run(JSON.stringify(falIdentity));
    env.SAINT_LOOK_API_BUDGET_JSON = JSON.stringify(fullPolicy(8800000));
    assert.equal(budget.available('photoroom'), false);
    assert.deepEqual(storedPolicy(database), falIdentity);
    assert.deepEqual(reservations(database), before);
  } finally { database.close(); }
});
