import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { RequestError, uuid } from './upload.mjs';
import { requireNotDeleted } from './deletion.mjs';
import { ProviderError } from './providers.mjs';
import { createIllustrationProvider, illustrationVersions, illustrationTaxonomy } from './illustration-provider.mjs';

const stages = ['preparation', 'attributes', 'generation', 'finalization'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = value => value === null ? null : JSON.parse(value);
const json = value => JSON.stringify(value ?? null);
const cleared = "source=NULL,prepared=NULL";

async function readInput(request, itemId) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new RequestError(415, 'unsupported_content_type');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) { request.resume(); throw new RequestError(413, 'image_too_large'); }
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks)); } catch { throw new RequestError(400, 'invalid_request'); }
  if (!uuid.test(itemId) || !input || ['operationId', 'photoVersionId', 'sourceSetVersionId'].some(field => typeof input[field] !== 'string' || !uuid.test(input[field]))) {
    throw new RequestError(400, 'invalid_identity');
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new RequestError(400, 'invalid_attempt');
  if (!Array.isArray(input.photos) || input.photos.length < 1 || input.photos.length > 3 || input.photos[0]?.role !== 'front'
    || input.photos.slice(1).some(photo => photo?.role === 'front')) throw new RequestError(400, 'invalid_photos');
  const photos = [];
  for (const photo of input.photos) {
    if (!photo || typeof photo.id !== 'string' || !uuid.test(photo.id) || !['front', 'back', 'detail'].includes(photo.role)
      || typeof photo.imageBase64 !== 'string' || !photo.imageBase64.length
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(photo.imageBase64)) throw new RequestError(400, 'invalid_image');
    const raw = Buffer.from(photo.imageBase64, 'base64');
    if (raw.length > 5 * 1024 * 1024) throw new RequestError(413, 'image_too_large');
    let source;
    try {
      const image = sharp(raw, { limitInputPixels: 16_000_000, failOn: 'warning' });
      const metadata = await image.metadata();
      if (metadata.format !== 'png' || (metadata.pages || 1) !== 1) throw new Error();
      source = await image.rotate().png().toBuffer();
    } catch { throw new RequestError(400, 'invalid_image'); }
    if (source.length > 5 * 1024 * 1024) throw new RequestError(413, 'image_too_large');
    let prepared = null;
    if (photo.preparedBase64 != null) {
      if (typeof photo.preparedBase64 !== 'string' || !photo.preparedBase64.length
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(photo.preparedBase64)) throw new RequestError(400, 'invalid_image');
      prepared = Buffer.from(photo.preparedBase64, 'base64');
      if (prepared.length > 10 * 1024 * 1024) throw new RequestError(413, 'image_too_large');
    }
    photos.push({ id: photo.id.toLowerCase(), role: photo.role, digest: digest(raw), source, normalizedDigest: digest(source), prepared });
  }
  if (new Set(photos.map(photo => photo.id)).size !== photos.length || photos[0].id !== input.photoVersionId.toLowerCase()) throw new RequestError(400, 'invalid_photos');
  const manualType = input.manualType ?? null, manualColors = input.manualColors ?? null;
  if ((manualType !== null && !illustrationTaxonomy.types.some(type => type.label === manualType))
    || (manualColors !== null && (!Array.isArray(manualColors) || manualColors.length > 5
      || new Set(manualColors).size !== manualColors.length || manualColors.some(color => !illustrationTaxonomy.colors.some(entry => entry.label === color))))) {
    throw new RequestError(400, 'invalid_features');
  }
  const identity = { itemId: itemId.toLowerCase(), operationId: input.operationId.toLowerCase(), photoVersionId: input.photoVersionId.toLowerCase(),
    sourceSetVersionId: input.sourceSetVersionId.toLowerCase(), revision: input.revision, manualType, manualColors,
    photos: photos.map(({ id, role, digest }) => ({ id, role, digest })), ...illustrationVersions };
  return { ...identity, fingerprint: digest(JSON.stringify(identity)), photos };
}

export function createIllustrations(database, env, retention) {
  database.exec(`CREATE TABLE IF NOT EXISTS illustrations (
    operation_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, photo_version_id TEXT NOT NULL,
    source_set_version_id TEXT NOT NULL, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    photos TEXT NOT NULL, manual_type TEXT, manual_colors TEXT, status TEXT NOT NULL DEFAULT 'pending',
    mode TEXT NOT NULL, processing TEXT NOT NULL, observed TEXT, effective TEXT, generated BLOB, result BLOB,
    provider_receipt TEXT, generated_alpha INTEGER NOT NULL DEFAULT 0, versions TEXT NOT NULL,
    error TEXT, retention_state TEXT NOT NULL DEFAULT 'active', expires_at INTEGER NOT NULL,
    UNIQUE(item_id, revision));
    CREATE TABLE IF NOT EXISTS illustration_sources (
      item_id TEXT NOT NULL, photo_id TEXT NOT NULL, digest TEXT NOT NULL, source BLOB, prepared BLOB,
      state TEXT NOT NULL DEFAULT 'pending', prepared_digest TEXT, prepared_versions TEXT,
      expires_at INTEGER NOT NULL, PRIMARY KEY(item_id,photo_id));
    CREATE INDEX IF NOT EXISTS illustration_expiry ON illustrations(retention_state,expires_at);`);
  // Identity receipts, not a server wardrobe: no image bytes or attributes survive here.
  database.exec(`CREATE TABLE IF NOT EXISTS published_sources (
    item_id TEXT PRIMARY KEY, photo_version_id TEXT NOT NULL,
    source_set_version_id TEXT NOT NULL, photos TEXT NOT NULL)`);
  // Delivered operations retain their source identities after their artifacts are cleared.
  for (const row of database.prepare("SELECT illustrations.* FROM illustrations JOIN items ON items.item_id=illustrations.item_id AND items.photo_version_id=illustrations.photo_version_id WHERE illustrations.status='ready' OR illustrations.retention_state='delivered' ORDER BY illustrations.revision DESC").all()) {
    lockSources(row);
  }
  function lockSources(row) {
    const photos = parse(row.photos).map(photo => {
      const primary = photo.id === row.photo_version_id
        ? database.prepare('SELECT source_digest FROM operation_receipts WHERE item_id=? AND photo_version_id=? LIMIT 1').get(row.item_id, photo.id) : null;
      return { ...photo, ...(primary ? { normalizedDigest: primary.source_digest } : {}) };
    });
    database.prepare('INSERT OR IGNORE INTO published_sources VALUES (?,?,?,?)')
      .run(row.item_id, row.photo_version_id, row.source_set_version_id, json(photos));
  }
  const sourceColumns = new Set(database.prepare('PRAGMA table_info(illustration_sources)').all().map(column => column.name));
  for (const column of ['prepared_digest', 'prepared_versions']) if (!sourceColumns.has(column)) database.exec(`ALTER TABLE illustration_sources ADD COLUMN ${column} TEXT`);
  const provider = createIllustrationProvider(env), timers = new Map(), abort = new AbortController();
  let closing = false;
  const get = id => database.prepare('SELECT * FROM illustrations WHERE operation_id=?').get(id);
  const current = id => database.prepare('SELECT * FROM illustrations WHERE item_id=? ORDER BY revision DESC LIMIT 1').get(id);
  function sweep() {
    const now = retention.deadline() - 7 * 24 * 60 * 60 * 1000;
    // Ordinary photo replacement is authoritative even when the illustration
    // worker is awaiting a provider. The old operation must not lock the item.
    database.prepare(`UPDATE illustrations SET status='failed',error='operation_superseded',retention_state='superseded',
      generated=NULL,result=NULL,observed=NULL,effective=NULL,manual_type=NULL,manual_colors=NULL
      WHERE retention_state='active' AND EXISTS (SELECT 1 FROM items
        WHERE items.item_id=illustrations.item_id AND items.photo_version_id<>illustrations.photo_version_id)`).run();
    for (const source of database.prepare('SELECT item_id,photo_id FROM illustration_sources WHERE source IS NOT NULL').all()) {
      const referenced = database.prepare("SELECT photos FROM illustrations WHERE item_id=? AND retention_state='active'").all(source.item_id)
        .some(row => parse(row.photos).some(photo => photo.id === source.photo_id));
      if (!referenced) database.prepare(`UPDATE illustration_sources SET ${cleared},state=CASE WHEN state='in_flight' THEN 'unknown' ELSE state END WHERE item_id=? AND photo_id=?`).run(source.item_id, source.photo_id);
    }
    database.prepare(`UPDATE illustrations SET status='failed',error='result_expired',retention_state='expired',
      generated=NULL,result=NULL,observed=NULL,effective=NULL,manual_type=NULL,manual_colors=NULL,processing=?
      WHERE retention_state='active' AND expires_at<=?`).run(json(Object.fromEntries(stages.map(stage => [stage, 'cleared']))), now);
    database.prepare(`UPDATE illustration_sources SET ${cleared} WHERE expires_at<=?`).run(now);
  }
  function readable(itemId, operationId) {
    if (!uuid.test(itemId) || !uuid.test(operationId)) throw new RequestError(400, 'invalid_identity');
    requireNotDeleted(database, itemId);
    const row = get(operationId);
    if (!row || row.item_id !== itemId) throw new RequestError(404, 'not_found');
    const item = database.prepare('SELECT photo_version_id FROM items WHERE item_id=?').get(itemId);
    if (item?.photo_version_id !== row.photo_version_id || current(itemId)?.operation_id !== operationId) throw new RequestError(409, 'operation_superseded');
    if (row.retention_state !== 'active') throw new RequestError(410, row.error);
    return row;
  }
  function response(row) {
    return { itemId: row.item_id, operationId: row.operation_id, photoVersionId: row.photo_version_id,
      sourceSetVersionId: row.source_set_version_id, revision: row.revision, status: row.status, mode: row.mode,
      processing: parse(row.processing), observedFeatures: parse(row.observed), effectiveFeatures: parse(row.effective),
      manualType: row.manual_type, manualColors: parse(row.manual_colors), ...parse(row.versions),
      preparedSources: row.status === 'ready' ? parse(row.photos).map(photo => ({ photoId: photo.id,
        preparedPath: `/v1/items/${row.item_id}/illustrations/${row.operation_id}/sources/${photo.id}/prepared` })) : [],
      resultPath: row.status === 'ready' ? `/v1/items/${row.item_id}/illustrations/${row.operation_id}/result` : null, error: row.error };
  }
  function live(operationId) {
    if (closing) return null;
    sweep();
    const row = get(operationId);
    if (!row || row.status !== 'pending' || row.retention_state !== 'active') return null;
    try { readable(row.item_id, operationId); } catch { return null; }
    return row;
  }
  function setStage(operationId, stage, state) {
    const row = get(operationId);
    if (row) database.prepare('UPDATE illustrations SET processing=? WHERE operation_id=?').run(json({ ...parse(row.processing), [stage]: state }), operationId);
  }
  function schedule(operationId) {
    if (closing || timers.has(operationId)) return;
    timers.set(operationId, setTimeout(() => { timers.delete(operationId); void process(operationId); }, 0));
  }
  async function process(operationId) {
    let row = live(operationId); if (!row) return;
    let stage = 'preparation';
    try {
      if (row.mode !== provider.mode || row.versions !== json(illustrationVersions)) throw new ProviderError('provider_configuration_changed');
      if (!await provider.available()) throw new ProviderError('illustration_unavailable');
      const inputs = parse(row.photos);
      const photos = [];
      for (const input of inputs) {
        let source = database.prepare('SELECT * FROM illustration_sources WHERE item_id=? AND photo_id=?').get(row.item_id, input.id);
        if (!source?.source || source.digest !== input.digest) throw new ProviderError('source_unavailable');
        if (['in_flight', 'unknown'].includes(source.state)) throw new ProviderError('processing_unknown', true);
        if (!source.prepared) {
          setStage(operationId, stage, 'in_flight');
          database.prepare("UPDATE illustration_sources SET state='in_flight' WHERE item_id=? AND photo_id=?").run(row.item_id, input.id);
          const prepared = await provider.prepare(Buffer.from(source.source), abort.signal);
          if (!live(operationId)) return;
          database.prepare("UPDATE illustration_sources SET prepared=?,prepared_digest=?,prepared_versions=?,state='done' WHERE item_id=? AND photo_id=?")
            .run(prepared, digest(prepared), json(illustrationVersions), row.item_id, input.id);
          source = { ...source, prepared };
        }
        photos.push({ ...input, source: Buffer.from(source.source), prepared: Buffer.from(source.prepared) });
      }
      setStage(operationId, stage, 'done');
      stage = 'attributes'; row = live(operationId); if (!row) return;
      let effective = parse(row.effective);
      if (!effective) {
        setStage(operationId, stage, 'in_flight');
        const observed = await provider.attributes(photos, abort.signal);
        if (!live(operationId)) return;
        effective = { ...observed, type: row.manual_type ?? observed.type, colors: parse(row.manual_colors) ?? observed.colors };
        database.prepare('UPDATE illustrations SET observed=?,effective=? WHERE operation_id=?').run(json(observed), json(effective), operationId);
        setStage(operationId, stage, 'done');
      }
      stage = 'generation'; row = live(operationId); if (!row) return;
      let generated = row.generated && { png: Buffer.from(row.generated), usableAlpha: Boolean(row.generated_alpha) };
      if (!generated) {
        setStage(operationId, stage, 'in_flight');
        generated = await provider.generate(photos, effective, abort.signal, receipt => {
          if (live(operationId)) database.prepare('UPDATE illustrations SET provider_receipt=? WHERE operation_id=?').run(receipt, operationId);
        }, row.provider_receipt);
        if (!live(operationId)) return;
        database.prepare('UPDATE illustrations SET generated=?,generated_alpha=? WHERE operation_id=?').run(generated.png, Number(generated.usableAlpha), operationId);
        setStage(operationId, stage, 'done');
      }
      stage = 'finalization';
      let result;
      if (generated.usableAlpha) { result = generated.png; setStage(operationId, stage, 'skipped'); }
      else {
        setStage(operationId, stage, 'in_flight');
        result = await provider.prepare(generated.png, abort.signal, stage);
        if (!live(operationId)) return;
        setStage(operationId, stage, 'done');
      }
      if (live(operationId)) {
        database.exec('BEGIN IMMEDIATE');
        try {
          database.prepare("UPDATE illustrations SET result=?,status='ready',error=NULL WHERE operation_id=?").run(result, operationId);
          lockSources(get(operationId));
          database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      }
    } catch (error) {
      if (!live(operationId)) return;
      const unknown = !(error instanceof ProviderError) || error.unknown;
      setStage(operationId, stage, unknown ? 'unknown' : 'failed');
      database.prepare("UPDATE illustrations SET status='failed',error=? WHERE operation_id=?").run(error instanceof ProviderError ? error.code : 'processing_unknown', operationId);
      if (stage === 'preparation') database.prepare("UPDATE illustration_sources SET state=? WHERE item_id=? AND state='in_flight'").run(unknown ? 'unknown' : 'failed', row.item_id);
    }
  }
  sweep();
  // A crash after paid admission must never submit that stage again blindly.
  for (const row of database.prepare("SELECT * FROM illustrations WHERE status='pending'").all()) {
    const processing = parse(row.processing);
    const uncertain = stages.filter(stage => processing[stage] === 'in_flight');
    if (uncertain.length) {
      for (const stage of uncertain) processing[stage] = 'unknown';
      database.prepare("UPDATE illustrations SET status='failed',error='processing_unknown',processing=? WHERE operation_id=?").run(json(processing), row.operation_id);
      database.prepare("UPDATE illustration_sources SET state='unknown' WHERE item_id=? AND state='in_flight'").run(row.item_id);
    } else schedule(row.operation_id);
  }
  const cleanup = setInterval(sweep, 1000);
  return {
    available: provider.available,
    sweep,
    async accept(request, itemId) {
      if (!await provider.available()) { request.resume(); throw new RequestError(503, 'illustration_unavailable'); }
      const input = await readInput(request, itemId);
      sweep(); requireNotDeleted(database, input.itemId);
      const item = database.prepare('SELECT * FROM items WHERE item_id=?').get(input.itemId);
      if (!item) throw new RequestError(404, 'not_found');
      if (item.photo_version_id !== input.photoVersionId) throw new RequestError(409, 'operation_superseded');
      const original = database.prepare('SELECT source_digest FROM operation_receipts WHERE item_id=? AND photo_version_id=? LIMIT 1').get(input.itemId, input.photoVersionId);
      if (original && original.source_digest !== input.photos[0].normalizedDigest) throw new RequestError(409, 'identity_conflict');
      const known = get(input.operationId);
      if (known) {
        if (known.fingerprint !== input.fingerprint) throw new RequestError(409, 'identity_conflict');
        return { status: 200, body: response(readable(input.itemId, input.operationId)) };
      }
      const previous = current(input.itemId);
      if (previous && input.revision <= previous.revision) throw new RequestError(409, 'stale_revision');
      if (previous?.status === 'pending') throw new RequestError(409, 'processing_in_progress');
      if (previous?.error === 'processing_unknown') throw new RequestError(409, 'processing_unknown');
      const sourceSet = json(input.photos.map(({ id, role, digest }) => ({ id, role, digest })));
      const locked = database.prepare('SELECT * FROM published_sources WHERE item_id=?').get(input.itemId);
      if (locked && (locked.photo_version_id !== input.photoVersionId || locked.source_set_version_id !== input.sourceSetVersionId
        || json(parse(locked.photos).map(({ id, role, digest }) => ({ id, role, digest }))) !== sourceSet)) {
        throw new RequestError(409, 'photos_locked');
      }
      const knownSet = database.prepare('SELECT photos FROM illustrations WHERE item_id=? AND source_set_version_id=? LIMIT 1').get(input.itemId, input.sourceSetVersionId);
      if (knownSet && knownSet.photos !== sourceSet) throw new RequestError(409, 'identity_conflict');
      const deadline = retention.deadline();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO illustrations(operation_id,item_id,photo_version_id,source_set_version_id,revision,fingerprint,
          photos,manual_type,manual_colors,mode,processing,expires_at,versions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(input.operationId, input.itemId, input.photoVersionId, input.sourceSetVersionId, input.revision, input.fingerprint,
            json(input.photos.map(({ id, role, digest }) => ({ id, role, digest }))), input.manualType, json(input.manualColors), provider.mode,
            json(Object.fromEntries(stages.map(stage => [stage, 'pending']))), deadline, json(illustrationVersions));
        for (const photo of input.photos) {
          const known = database.prepare('SELECT * FROM illustration_sources WHERE item_id=? AND photo_id=?').get(input.itemId, photo.id);
          if (known && known.digest !== photo.digest) throw new RequestError(409, 'identity_conflict');
          if (photo.prepared && (!known || known.prepared_digest !== digest(photo.prepared)
            || known.prepared_versions !== json(illustrationVersions))) throw new RequestError(409, 'prepared_source_conflict');
          database.prepare(`INSERT INTO illustration_sources(item_id,photo_id,digest,source,expires_at) VALUES (?,?,?,?,?)
            ON CONFLICT(item_id,photo_id) DO UPDATE SET source=excluded.source,expires_at=excluded.expires_at`)
            .run(input.itemId, photo.id, photo.digest, photo.source, deadline);
          if (photo.prepared) database.prepare("UPDATE illustration_sources SET prepared=?,state='done' WHERE item_id=? AND photo_id=?")
            .run(photo.prepared, input.itemId, photo.id);
        }
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      schedule(input.operationId);
      return { status: 202, body: response(get(input.operationId)) };
    },
    read(itemId, operationId) { return response(readable(itemId, operationId)); },
    result(itemId, operationId) {
      const row = readable(itemId, operationId);
      if (row.retention_state !== 'active') throw new RequestError(410, row.error);
      if (row.status !== 'ready') throw new RequestError(409, 'not_ready');
      return Buffer.from(row.result);
    },
    prepared(itemId, operationId, photoId) {
      const row = readable(itemId, operationId);
      if (row.retention_state !== 'active') throw new RequestError(410, row.error);
      if (row.status !== 'ready') throw new RequestError(409, 'not_ready');
      const input = parse(row.photos).find(photo => photo.id === photoId);
      if (!input) throw new RequestError(404, 'not_found');
      const source = database.prepare('SELECT * FROM illustration_sources WHERE item_id=? AND photo_id=?').get(itemId, photoId);
      if (!source?.prepared || source.digest !== input.digest) throw new RequestError(410, 'source_unavailable');
      return Buffer.from(source.prepared);
    },
    acknowledge(itemId, operationId) {
      if (!uuid.test(itemId) || !uuid.test(operationId)) throw new RequestError(400, 'invalid_identity');
      const row = get(operationId);
      if (!row || row.item_id !== itemId || row.retention_state !== 'active') return;
      if (row.status !== 'ready') throw new RequestError(409, 'not_ready');
      database.prepare(`UPDATE illustrations SET retention_state='delivered',status='failed',error='result_delivered',
        generated=NULL,result=NULL,observed=NULL,effective=NULL,manual_type=NULL,manual_colors=NULL,processing=? WHERE operation_id=?`)
        .run(json(Object.fromEntries(stages.map(stage => [stage, 'cleared']))), operationId);
      for (const photo of parse(row.photos)) {
        const used = database.prepare("SELECT photos FROM illustrations WHERE item_id=? AND retention_state='active'").all(itemId)
          .some(other => parse(other.photos).some(input => input.id === photo.id));
        if (!used) database.prepare(`UPDATE illustration_sources SET ${cleared} WHERE item_id=? AND photo_id=?`).run(itemId, photo.id);
      }
    },
    close() { closing = true; clearInterval(cleanup); for (const timer of timers.values()) clearTimeout(timer); abort.abort(); },
  };
}
