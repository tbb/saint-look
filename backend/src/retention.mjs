import { RequestError, uuid } from './upload.mjs';

export function initializeRetention(database) {
  const columns = database.prepare('PRAGMA table_info(items)').all();
  if (!columns.some(column => column.name === 'retention_state')) {
    database.exec("ALTER TABLE items ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'active'");
  }
}

export function clearAttempt(database, itemId, operationId, state) {
  database.prepare(`UPDATE items SET retention_state=?, status='failed', source=X'', result=NULL,
    attributes=NULL, type=NULL, colors=NULL, attributes_state='cleared', cutout_state='cleared', error=?
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
