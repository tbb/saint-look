import { ProviderError } from './providers.mjs';

export function initializeProcessing(database) {
  const columns = new Set(database.prepare('PRAGMA table_info(items)').all().map(column => column.name));
  for (const [name, declaration] of Object.entries({
    mode: "TEXT NOT NULL DEFAULT 'demo'", provider_id: "TEXT NOT NULL DEFAULT 'demo'",
    attributes_state: "TEXT NOT NULL DEFAULT 'pending'", cutout_state: "TEXT NOT NULL DEFAULT 'pending'", attributes: 'TEXT',
  })) if (!columns.has(name)) database.exec(`ALTER TABLE items ADD COLUMN ${name} ${declaration}`);
  database.exec("UPDATE items SET attributes_state='done',cutout_state='done' WHERE status='ready'");
}

export function createWorker(database, provider, env, retention) {
  if (env.SAINT_LOOK_DEPLOYMENT_PROFILE && database.prepare("SELECT 1 FROM items WHERE status='pending' AND provider_id != ? LIMIT 1").get(provider.id)) {
    throw new Error('Pending work belongs to another provider profile. Finish or delete it before switching.');
  }
  const timers = new Map();
  const abort = new AbortController();
  let closing = false;
  const delay = Number(env.SAINT_LOOK_STAGE_DELAY_MS || 0);
  const initialDelay = provider.id === 'demo' ? Number(env.SAINT_LOOK_DEMO_DELAY_MS || 1500) : delay;
  if (![delay, initialDelay].every(value => Number.isInteger(value) && value >= 0 && value <= 60000)) throw new Error('Invalid processing delay configuration.');
  function schedule(itemId, operationId, first = true) {
    if (closing || timers.has(operationId)) return;
    timers.set(operationId, setTimeout(() => { timers.delete(operationId); void process(itemId, operationId); }, first ? initialDelay : delay));
  }
  async function process(itemId, operationId) {
    if (closing) return;
    retention.sweep();
    const row = database.prepare('SELECT * FROM items WHERE item_id=? AND operation_id=?').get(itemId, operationId);
    if (closing || !row || row.status !== 'pending') return;
    const stage = row.attributes_state === 'done' ? 'cutout' : 'attributes';
    try {
      if (row.provider_id !== provider.id) throw new ProviderError('provider_configuration_changed');
      provider.preflight(Buffer.from(row.source));
      database.prepare(`UPDATE items SET ${stage}_state='in_flight' WHERE item_id=? AND operation_id=? AND retention_state='active'`).run(itemId, operationId);
      const result = await provider[stage](Buffer.from(row.source), abort.signal);
      if (closing) return;
      retention.sweep();
      if (stage === 'attributes') {
        database.prepare("UPDATE items SET attributes_state='done',attributes=? WHERE item_id=? AND operation_id=? AND retention_state='active'").run(JSON.stringify(result), itemId, operationId);
        schedule(itemId, operationId, false);
      } else {
        const attributes = JSON.parse(row.attributes);
        database.prepare("UPDATE items SET cutout_state='done',status='ready',result=?,type=?,colors=? WHERE item_id=? AND operation_id=? AND retention_state='active'")
          .run(result, attributes.type, JSON.stringify(attributes.colors), itemId, operationId);
      }
    } catch (error) {
      if (closing) return;
      retention.sweep();
      const known = error instanceof ProviderError;
      database.prepare(`UPDATE items SET status='failed',${stage}_state=?,error=? WHERE item_id=? AND operation_id=? AND retention_state='active'`)
        .run(!known || error.unknown ? 'unknown' : 'failed', known ? error.code : 'processing_unknown', itemId, operationId);
    }
  }
  // Intent survives a crash. A previously started external request cannot be retried safely.
  database.exec(`UPDATE items SET status='failed',error='processing_unknown',
    attributes_state=CASE WHEN attributes_state='in_flight' THEN 'unknown' ELSE attributes_state END,
    cutout_state=CASE WHEN cutout_state='in_flight' THEN 'unknown' ELSE cutout_state END
    WHERE status='pending' AND (attributes_state IN ('in_flight','unknown') OR cutout_state IN ('in_flight','unknown'))`);
  for (const row of database.prepare("SELECT item_id, operation_id FROM items WHERE status='pending'").all()) schedule(row.item_id, row.operation_id);
  return { schedule, close() { closing = true; for (const timer of timers.values()) clearTimeout(timer); abort.abort(); } };
}
