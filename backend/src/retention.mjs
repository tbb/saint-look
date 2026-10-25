import { readFileSync } from 'node:fs';
import { providerConfig } from './jev.mjs';
import { RequestError, uuid } from './upload.mjs';

const clearedFields = `retention_state=?, status='failed', source=X'', result=NULL,
  attributes=NULL, type=NULL, colors=NULL, attributes_state='cleared', cutout_state='cleared', error=?`;

export function createRetention(database, env, provider) {
  const now = clock(env, provider);
  const columns = database.prepare('PRAGMA table_info(items)').all();
  if (!columns.some(column => column.name === 'retention_state')) {
    database.exec("ALTER TABLE items ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'active'");
  }
  if (!columns.some(column => column.name === 'expires_at')) {
    // Earlier versions recorded no upload time. Their unknown-age copies must
    // expire instead of silently receiving another seven days on upgrade.
    database.exec('ALTER TABLE items ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
  }
  database.exec('CREATE INDEX IF NOT EXISTS retention_deadlines ON items(retention_state, expires_at)');
  function sweep() {
    database.prepare(`UPDATE items SET ${clearedFields}
      WHERE retention_state='active' AND expires_at<=?`).run('expired', 'result_expired', now());
  }
  sweep();
  const timer = setInterval(sweep, 1000);
  return { sweep, deadline: () => now() + 7 * 24 * 60 * 60 * 1000, close() { clearInterval(timer); } };
}

function clock(env, provider) {
  if (!env.SAINT_LOOK_TEST_CLOCK_FILE) return Date.now;
  let origin;
  try { origin = new URL(env.SAINT_LOOK_TEST_PROVIDER_ORIGIN); } catch { throw new Error('Invalid test clock configuration.'); }
  if (env.NODE_ENV !== 'test' || provider.id !== `live-test-${providerConfig}` || origin.protocol !== 'http:'
    || !['127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password
    || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Invalid test clock configuration.');
  return () => {
    const { offsetMs } = JSON.parse(readFileSync(env.SAINT_LOOK_TEST_CLOCK_FILE, 'utf8'));
    if (!Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs > 365 * 24 * 60 * 60 * 1000) {
      throw new Error('Invalid test clock offset.');
    }
    return Date.now() + offsetMs;
  };
}

function clearAttempt(database, itemId, operationId, state) {
  database.prepare(`UPDATE items SET ${clearedFields}
    WHERE item_id=? AND operation_id=? AND retention_state='active'`)
    .run(state, `result_${state}`, itemId, operationId);
}

export function acknowledge(database, itemId, operationId) {
  if (!uuid.test(itemId) || !uuid.test(operationId)) throw new RequestError(400, 'invalid_identity');
  const row = database.prepare('SELECT * FROM items WHERE item_id=? AND operation_id=?').get(itemId, operationId);
  // An acknowledgement owns only its original attempt, never a replacement.
  if (!row || row.retention_state !== 'active') return;
  if (row.status !== 'ready') throw new RequestError(409, 'not_ready');
  clearAttempt(database, itemId, operationId, 'delivered');
}
