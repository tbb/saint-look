import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { environment } from './support.mjs';

test('startup refuses a newer data format instead of pretending rollback succeeded', async t => {
  const env = await environment(t);
  // Historical/future database is input to the public process boundary, not an assertion side channel.
  const future = new DatabaseSync(join(env.directory, 'wardrobe.sqlite'));
  future.exec('PRAGMA user_version=2; CREATE TABLE future_only (value TEXT);');
  future.close();
  await assert.rejects(env.launch(), /Unsupported data version/);
});
