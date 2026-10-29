import { createHash } from 'node:crypto';
import { RequestError } from './upload.mjs';
import { requireNotDeleted } from './deletion.mjs';

function digest(source) { return createHash('sha256').update(source).digest('hex'); }

export function initializeAttempts(database) {
  const columns = database.prepare('PRAGMA table_info(items)').all();
  if (!columns.some(column => column.name === 'revision')) database.exec('ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  database.exec(`CREATE TABLE IF NOT EXISTS operation_receipts (
    operation_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, photo_version_id TEXT NOT NULL,
    revision INTEGER NOT NULL, action TEXT NOT NULL, source_digest TEXT NOT NULL,
    UNIQUE(item_id, revision)
  )`);
  const record = database.prepare('INSERT INTO operation_receipts VALUES (?,?,?,?,?,?)');
  // Existing catalogs contain only the initial attempt; keep its identity on upgrade.
  for (const row of database.prepare(`SELECT items.* FROM items LEFT JOIN operation_receipts receipt
    ON items.operation_id=receipt.operation_id WHERE receipt.operation_id IS NULL`).all()) {
    record.run(row.operation_id, row.item_id, row.photo_version_id, row.revision, 'create', digest(Buffer.from(row.source)));
  }
}

export function acceptAttempt(database, input, provider, explicit = false, expiresAt) {
  // Upload decoding/normalization awaited before admission. Recheck here so a
  // DELETE that arrived during that await also wins over receipt replay.
  requireNotDeleted(database, input.itemId);
  const revision = explicit ? input.revision : 0;
  const action = explicit ? input.action : 'create';
  if (explicit && (!Number.isSafeInteger(revision) || revision < 1 || !['retry', 'replace'].includes(action))) {
    throw new RequestError(400, 'invalid_attempt');
  }
  const sourceDigest = digest(input.source);
  const receipt = database.prepare('SELECT * FROM operation_receipts WHERE operation_id=?').get(input.operationId);
  const current = database.prepare('SELECT * FROM items WHERE item_id=?').get(input.itemId);
  if (receipt) {
    if (receipt.item_id !== input.itemId || receipt.photo_version_id !== input.photoVersionId
      || receipt.revision !== revision || receipt.action !== action || receipt.source_digest !== sourceDigest) {
      throw new RequestError(409, 'identity_conflict');
    }
    if (current?.operation_id !== input.operationId) throw new RequestError(409, 'operation_superseded');
    return { status: 200, row: current };
  }
  if (current) {
    if (!explicit) throw new RequestError(409, 'identity_conflict');
    if (revision <= current.revision) throw new RequestError(409, 'stale_revision');
  }
  const locked = database.prepare('SELECT * FROM published_sources WHERE item_id=?').get(input.itemId);
  if (locked && (input.photoVersionId !== locked.photo_version_id
    || sourceDigest !== JSON.parse(locked.photos)[0].normalizedDigest || action === 'replace')) {
    throw new RequestError(409, 'photos_locked');
  }
  const knownPhoto = database.prepare('SELECT source_digest FROM operation_receipts WHERE item_id=? AND photo_version_id=?')
    .get(input.itemId, input.photoVersionId);
  // A retry keeps the client's local photo. Its preceding replacement may never
  // have reached admission (for example, a rejected owner token). Once known, a
  // photo version is immutable and a historical version cannot become current again.
  if (action === 'retry' && knownPhoto && (input.photoVersionId !== current?.photo_version_id
    || knownPhoto.source_digest !== sourceDigest)) throw new RequestError(409, 'identity_conflict');
  if (action === 'replace' && knownPhoto) throw new RequestError(409, 'identity_conflict');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('INSERT INTO operation_receipts VALUES (?,?,?,?,?,?)')
      .run(input.operationId, input.itemId, input.photoVersionId, revision, action, sourceDigest);
    database.prepare(`INSERT INTO items(item_id,operation_id,photo_version_id,status,source,mode,provider_id,revision,expires_at)
      VALUES (?,?,?,'pending',?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
      operation_id=excluded.operation_id,photo_version_id=excluded.photo_version_id,status='pending',source=excluded.source,
      mode=excluded.mode,provider_id=excluded.provider_id,revision=excluded.revision,expires_at=excluded.expires_at,retention_state='active',result=NULL,type=NULL,colors=NULL,error=NULL,
      attributes_state='pending',cutout_state='pending',attributes=NULL`)
      .run(input.itemId, input.operationId, input.photoVersionId, input.source, provider.mode, provider.id, revision, expiresAt);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { status: 202, row: database.prepare('SELECT * FROM items WHERE item_id=?').get(input.itemId) };
}

export function readAttempt(database, itemId, operationId) {
  requireNotDeleted(database, itemId);
  const row = database.prepare('SELECT * FROM items WHERE item_id=?').get(itemId);
  if (row && (!operationId || row.operation_id === operationId)) return row;
  if (operationId && database.prepare('SELECT 1 FROM operation_receipts WHERE item_id=? AND operation_id=?').get(itemId, operationId)) {
    throw new RequestError(409, 'operation_superseded');
  }
  throw new RequestError(404, 'not_found');
}
