import test from 'node:test';
import assert from 'node:assert/strict';
import { photoroomConfiguration } from '../src/photoroom-config.mjs';
import { createIllustrationProvider } from '../src/illustration-provider.mjs';

test('production requires explicit mode, approval and a non-sandbox credential without fallback', async () => {
  const env = { SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'fixture', GEMINI_API_KEY: 'fixture',
    PHOTOROOM_SANDBOX_API_KEY: 'sandbox_fixture', PHOTOROOM_API_KEY: 'production-fixture',
    SAINT_LOOK_PHOTOROOM_MODE: 'production', PHOTOROOM_PRODUCTION_APPROVED: 'true' };
  assert.equal(photoroomConfiguration(env).key, 'production-fixture');
  assert.equal(await createIllustrationProvider(env).available(), true);
  for (const overrides of [{ PHOTOROOM_PRODUCTION_APPROVED: '' }, { PHOTOROOM_API_KEY: '' },
    { PHOTOROOM_API_KEY: 'sandbox_fixture' }, { SAINT_LOOK_PHOTOROOM_MODE: 'typo' }]) {
    assert.equal(await createIllustrationProvider({ ...env, ...overrides }).available(), false);
  }
  const sandbox = { ...env, SAINT_LOOK_PHOTOROOM_MODE: 'sandbox' };
  assert.equal(photoroomConfiguration(sandbox).key, 'sandbox_fixture');
  assert.equal(await createIllustrationProvider({ ...sandbox, PHOTOROOM_SANDBOX_API_KEY: '' }).available(), false);
});
