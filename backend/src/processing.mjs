import { ProviderError } from './providers.mjs';

export function initializeProcessing(database) {
  const columns = new Set(database.prepare('PRAGMA table_info(items)').all().map(column => column.name));
  for (const [name, declaration] of Object.entries({
    mode: "TEXT NOT NULL DEFAULT 'demo'", provider_id: "TEXT NOT NULL DEFAULT 'demo'",
    attributes_state: "TEXT NOT NULL DEFAULT 'pending'", cutout_state: "TEXT NOT NULL DEFAULT 'pending'", attributes: 'TEXT',
  })) if (!columns.has(name)) database.exec(`ALTER TABLE items ADD COLUMN ${name} ${declaration}`);
  database.exec("UPDATE items SET attributes_state='done',cutout_state='done' WHERE status='ready'");
}

export function createWorker(database, provider, env) {
  const timers = new Map();
  const abort = new AbortController();
  let closing = false;
  const delay = Number(env.SAINT_LOOK_STAGE_DELAY_MS || 0);
  const initialDelay = provider.id === 'demo' ? Number(env.SAINT_LOOK_DEMO_DELAY_MS || 1500) : delay;
  function schedule(itemId, first = true) {
    if (closing || timers.has(itemId)) return;
    timers.set(itemId, setTimeout(() => { timers.delete(itemId); void process(itemId); }, first ? initialDelay : delay));
  }
  async function process(itemId) {
    const row = database.prepare('SELECT * FROM items WHERE item_id=?').get(itemId);
    if (closing || !row || row.status !== 'pending') return;
    const stage = row.attributes_state === 'done' ? 'cutout' : 'attributes';
    try {
      if (row.provider_id !== provider.id) throw new ProviderError('provider_configuration_changed');
      provider.preflight(Buffer.from(row.source));
      database.prepare(`UPDATE items SET ${stage}_state='in_flight' WHERE item_id=?`).run(itemId);
      const result = await provider[stage](Buffer.from(row.source), abort.signal);
      if (closing) return;
      if (stage === 'attributes') {
        database.prepare("UPDATE items SET attributes_state='done',attributes=? WHERE item_id=?").run(JSON.stringify(result), itemId);
        schedule(itemId, false);
      } else {
        const attributes = JSON.parse(row.attributes);
        database.prepare("UPDATE items SET cutout_state='done',status='ready',result=?,type=?,colors=? WHERE item_id=?")
          .run(result, attributes.type, JSON.stringify(attributes.colors), itemId);
      }
    } catch (error) {
      if (closing) return;
      const known = error instanceof ProviderError;
      database.prepare(`UPDATE items SET status='failed',${stage}_state=?,error=? WHERE item_id=?`)
        .run(!known || error.unknown ? 'unknown' : 'failed', known ? error.code : 'processing_unknown', itemId);
    }
  }
  // Intent survives a crash. A previously started external request cannot be retried safely.
  database.exec(`UPDATE items SET status='failed',error='processing_unknown',
    attributes_state=CASE WHEN attributes_state='in_flight' THEN 'unknown' ELSE attributes_state END,
    cutout_state=CASE WHEN cutout_state='in_flight' THEN 'unknown' ELSE cutout_state END
    WHERE status='pending' AND (attributes_state IN ('in_flight','unknown') OR cutout_state IN ('in_flight','unknown'))`);
  for (const row of database.prepare("SELECT item_id FROM items WHERE status='pending'").all()) schedule(row.item_id);
  return { schedule, close() { closing = true; for (const timer of timers.values()) clearTimeout(timer); abort.abort(); } };
}
