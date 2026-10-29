import { RequestError, uuid } from './upload.mjs';

export function initializeDeletion(database) {
  database.exec('CREATE TABLE IF NOT EXISTS deleted_items (item_id TEXT PRIMARY KEY)');
}

export function requireNotDeleted(database, itemId) {
  if (database.prepare('SELECT 1 FROM deleted_items WHERE item_id=?').get(itemId)) {
    throw new RequestError(410, 'item_deleted');
  }
}

export function deleteItem(database, itemId) {
  if (!uuid.test(itemId)) throw new RequestError(400, 'invalid_identity');
  database.exec('BEGIN IMMEDIATE');
  try {
    // Keep only identity, including IDs whose upload has not reached admission.
    database.prepare('INSERT OR IGNORE INTO deleted_items(item_id) VALUES (?)').run(itemId);
    database.prepare('DELETE FROM items WHERE item_id=?').run(itemId);
    database.prepare('DELETE FROM operation_receipts WHERE item_id=?').run(itemId);
    database.prepare('DELETE FROM preparations WHERE item_id=?').run(itemId);
    database.prepare('DELETE FROM illustrations WHERE item_id=?').run(itemId);
    database.prepare('DELETE FROM published_sources WHERE item_id=?').run(itemId);
    database.prepare('DELETE FROM illustration_sources WHERE item_id=?').run(itemId);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
