import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { providerFixture } from './providers/fixture.mjs';

function ack(server, item, options = {}) {
  return server.request(`/v1/items/${item.itemId}/operations/${item.operationId}/ack`, { method: 'POST', ...options });
}

async function assertCleared(server, item, reason) {
  for (const suffix of ['', `/operations/${item.operationId}`]) {
    const response = await server.request(`/v1/items/${item.itemId}${suffix}`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.status, 'failed');
    assert.equal(state.error, reason);
    assert.equal(state.type, null);
    assert.deepEqual(state.colors, []);
    assert.equal(state.resultPath, null);
    const result = await server.request(`/v1/items/${item.itemId}${suffix}/result`);
    assert.equal(result.status, 410);
    assert.deepEqual(await result.json(), { error: reason });
  }
}

test('owner acknowledgement clears a saved result and is safe to repeat after restart', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const item = await photoRequest();
  assert.equal((await upload(server, item)).status, 202);
  const ready = await waitForItem(server, item.itemId);
  const saved = Buffer.from(await (await server.request(ready.resultPath)).arrayBuffer());
  assert.deepEqual(saved, fixture.cutout);
  assert.equal((await ack(server, item, { headers: { Authorization: 'Bearer wrong-owner' } })).status, 401);
  assert.equal((await server.request(ready.resultPath)).status, 200);
  const confirmed = await ack(server, item);
  assert.equal(confirmed.status, 204);
  assert.equal(await confirmed.text(), '');
  await assertCleared(server, item, 'result_delivered');
  assert.equal((await ack(server, item)).status, 204);
  assert.equal((await upload(server, item)).status, 200);
  await assertCleared(server, item, 'result_delivered');
  await server.stop();
  const restarted = await env.launch(fixture.env);
  assert.equal((await ack(restarted, item)).status, 204);
  await assertCleared(restarted, item, 'result_delivered');
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
});

async function clockFor(env) {
  const path = join(env.directory, 'clock.json');
  async function advance(offsetMs) {
    await writeFile(path + '.next', JSON.stringify({ offsetMs }));
    await rename(path + '.next', path);
  }
  await advance(0);
  return { advance, env: { SAINT_LOOK_TEST_CLOCK_FILE: path } };
}

test('a ready result expires seven days from upload and replay never renews its lifetime', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const clock = await clockFor(env);
  const server = await env.launch({ ...fixture.env, ...clock.env });
  const item = await photoRequest();
  await upload(server, item);
  const ready = await waitForItem(server, item.itemId);
  await clock.advance(6 * 24 * 60 * 60 * 1000);
  assert.equal((await upload(server, item)).status, 200);
  assert.equal((await server.request(ready.resultPath)).status, 200);
  await clock.advance(7 * 24 * 60 * 60 * 1000);
  await assertCleared(server, item, 'result_expired');
  assert.equal((await upload(server, item)).status, 200);
  await assertCleared(server, item, 'result_expired');
  assert.equal((await ack(server, item)).status, 204);
  await server.stop();
  const restarted = await env.launch({ ...fixture.env, ...clock.env });
  await assertCleared(restarted, item, 'result_expired');
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.cutout.length, 1);
});

function attempt(server, item) {
  return server.request(`/v1/items/${item.itemId}/attempts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item),
  });
}

test('explicit retry after delivery uses the local original and an old acknowledgement cannot clear its new result', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const original = await photoRequest();
  await upload(server, original);
  await waitForItem(server, original.itemId);
  assert.equal((await ack(server, original)).status, 204);
  const retry = { ...original, operationId: randomUUID(), revision: 1, action: 'retry' };
  assert.equal((await attempt(server, retry)).status, 202);
  const ready = await waitForItem(server, retry.itemId);
  assert.equal(ready.operationId, retry.operationId);
  assert.equal((await ack(server, original)).status, 204);
  assert.equal((await server.request(ready.resultPath)).status, 200);
  assert.equal((await attempt(server, retry)).status, 200);
  assert.equal(fixture.calls.attributes.length, 2);
  assert.equal(fixture.calls.cutout.length, 2);
});

test('unready attempts cannot be acknowledged and unknown or deleted identities are harmless no-ops', async t => {
  let release;
  const fixture = await providerFixture(t, { cutout(request, response) {
    release = () => { response.writeHead(429); response.end(); };
  } });
  const env = await environment(t);
  const server = await env.launch({ ...fixture.env, SAINT_LOOK_PROVIDER_TIMEOUT_MS: '10000' });
  const item = await photoRequest();
  await upload(server, item);
  await waitUntil(() => release);
  assert.equal((await ack(server, item)).status, 409);
  assert.equal((await (await server.request(`/v1/items/${item.itemId}`)).json()).status, 'pending');
  assert.equal((await ack(server, { ...item, operationId: randomUUID() })).status, 204);
  assert.equal((await ack(server, { ...item, operationId: 'invalid' })).status, 400);
  release();
  assert.equal((await waitForItem(server, item.itemId, 'failed')).error, 'provider_quota_exceeded');
  assert.equal((await ack(server, item)).status, 409);
  assert.equal((await server.request(`/v1/items/${item.itemId}`, { method: 'DELETE' })).status, 204);
  assert.equal((await ack(server, item)).status, 204);
  assert.equal((await server.request(`/v1/items/${item.itemId}`)).status, 410);
  assert.equal((await ack(server, await photoRequest())).status, 204);
});

test('periodic cleanup expires ready data without a client request and the marker survives a clock reset', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const clock = await clockFor(env);
  const server = await env.launch({ ...fixture.env, ...clock.env });
  const item = await photoRequest();
  await upload(server, item);
  await waitForItem(server, item.itemId);
  await clock.advance(7 * 24 * 60 * 60 * 1000);
  // No HTTP request during this interval: only the running backend's sweeper can expire it.
  await new Promise(resolve => setTimeout(resolve, 1200));
  await clock.advance(0);
  await assertCleared(server, item, 'result_expired');
});

test('expired attempts retry only by explicit higher revision and retain immutable photo identity after cleanup', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const clock = await clockFor(env);
  const server = await env.launch({ ...fixture.env, ...clock.env });
  const original = await photoRequest();
  await upload(server, original);
  await waitForItem(server, original.itemId);
  await clock.advance(7 * 24 * 60 * 60 * 1000);
  await assertCleared(server, original, 'result_expired');
  const retry = { ...original, operationId: randomUUID(), revision: 1, action: 'retry' };
  assert.equal((await attempt(server, { ...retry, imageBase64: fixture.cutout.toString('base64') })).status, 409);
  assert.equal((await attempt(server, retry)).status, 202);
  const ready = await waitForItem(server, retry.itemId);
  assert.equal(ready.operationId, retry.operationId);
  assert.equal((await ack(server, original)).status, 204);
  assert.equal((await server.request(ready.resultPath)).status, 200);
  assert.equal((await upload(server, original)).status, 409);
  assert.equal(fixture.calls.attributes.length, 2);
  assert.equal(fixture.calls.cutout.length, 2);
  await clock.advance(13 * 24 * 60 * 60 * 1000);
  assert.equal((await server.request(ready.resultPath)).status, 200, 'Explicit upload gets its own seven-day deadline');
  await clock.advance(14 * 24 * 60 * 60 * 1000);
  await assertCleared(server, retry, 'result_expired');
});

async function waitUntil(predicate) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected public processing boundary was not reached');
}

for (const phase of ['queued', 'between-stages']) {
  test(`startup clears expired ${phase} work before it can resume a provider stage`, async t => {
    const fixture = await providerFixture(t);
    const env = await environment(t);
    const clock = await clockFor(env);
    const server = await env.launch({ ...fixture.env, ...clock.env, SAINT_LOOK_STAGE_DELAY_MS: phase === 'queued' ? '60000' : '500' });
    const item = await photoRequest();
    await upload(server, item);
    if (phase === 'between-stages') {
      await waitUntil(async () => (await (await server.request(`/v1/items/${item.itemId}`)).json()).processing.attributes === 'done');
    }
    await server.stop('SIGKILL');
    await clock.advance(7 * 24 * 60 * 60 * 1000);
    const restarted = await env.launch({ ...fixture.env, ...clock.env });
    await assertCleared(restarted, item, 'result_expired');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fixture.calls.attributes.length, phase === 'queued' ? 0 : 1);
    assert.equal(fixture.calls.cutout.length, 0);
  });
}

for (const stage of ['attributes', 'cutout']) {
  for (const outcome of ['success', 'failure']) {
    test(`late ${stage} ${outcome} cannot publish or continue expired work`, async t => {
      let release;
      const fixture = await providerFixture(t, { [stage](request, response, { cutout, attributes }) {
        release = () => {
          if (outcome === 'failure') { response.writeHead(429); response.end(); }
          else if (stage === 'cutout') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(cutout); }
          else {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(attributes));
          }
        };
      } });
      const env = await environment(t);
      const clock = await clockFor(env);
      const server = await env.launch({ ...fixture.env, ...clock.env, SAINT_LOOK_PROVIDER_TIMEOUT_MS: '10000' });
      const item = await photoRequest();
      await upload(server, item);
      await waitUntil(() => release);
      await clock.advance(7 * 24 * 60 * 60 * 1000);
      release();
      await new Promise(resolve => setTimeout(resolve, 150));
      // Rewind before observing over HTTP, so the read guard cannot hide a late publication.
      await clock.advance(0);
      await assertCleared(server, item, 'result_expired');
      assert.equal(fixture.calls.attributes.length, 1);
      assert.equal(fixture.calls.cutout.length, stage === 'cutout' ? 1 : 0);
      assert.equal((await upload(server, item)).status, 200);
      await assertCleared(server, item, 'result_expired');
    });
  }
}

test('a controllable clock is rejected outside the isolated test-provider configuration', async t => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const clock = await clockFor(env);
  for (const invalid of [
    { NODE_ENV: 'production' }, { SAINT_LOOK_PROVIDER: 'demo' },
    { SAINT_LOOK_TEST_PROVIDER_ORIGIN: 'https://example.com' },
    { SAINT_LOOK_TEST_PROVIDER_ORIGIN: '' },
  ]) {
    await assert.rejects(env.launch({ ...fixture.env, ...clock.env, ...invalid }), /Invalid test clock configuration/);
  }
  for (const offset of [-1, 0.5, 31536000001]) {
    await clock.advance(offset);
    await assert.rejects(env.launch({ ...fixture.env, ...clock.env }), /Invalid test clock offset/);
  }
  assert.equal(fixture.calls.attributes.length, 0);
  assert.equal(fixture.calls.cutout.length, 0);
});
