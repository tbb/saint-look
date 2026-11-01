import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPhotoroomAccount } from './photoroom-account.mjs';

const env = { SAINT_LOOK_PHOTOROOM_MODE: 'production', PHOTOROOM_PRODUCTION_APPROVED: 'true', PHOTOROOM_API_KEY: 'production-fixture-key' };
test('account inspection is one read-only fixed-origin request and returns only quota metadata', async () => {
  let count = 0;
  const result = await inspectPhotoroomAccount(env, async (url, options) => {
    count++;
    assert.equal(url, 'https://image-api.photoroom.com/v2/account');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-api-key'], env.PHOTOROOM_API_KEY);
    return Response.json({ images: { available: 0, subscription: 10 }, plan: 'basic', key: env.PHOTOROOM_API_KEY, email: 'private@example.test' });
  });
  assert.equal(count, 1); assert.equal(result.availableImages, 0); assert.equal(result.imagesProcessed, 0);
  assert.doesNotMatch(JSON.stringify(result), /fixture-key|private@/);
});
test('account inspection rejects wrong credentials before network and never reveals error bodies', async () => {
  await assert.rejects(inspectPhotoroomAccount({ ...env, PHOTOROOM_API_KEY: 'sandbox_fixture' }, () => assert.fail('network')), /configuration/);
  await assert.rejects(inspectPhotoroomAccount(env, async () => new Response('secret-private-body', { status: 401 })), /HTTP 401/);
  await assert.rejects(inspectPhotoroomAccount(env, async () => Response.json({ images: { available: -1, subscription: 10 } })), /valid credit/);
});
