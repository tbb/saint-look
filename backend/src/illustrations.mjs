import {qualityCorrection} from './illustration-quality.mjs';
import { featureDigest, validateObserved } from './publication-contract.mjs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { RequestError, uuid } from './upload.mjs';
import { requireNotDeleted } from './deletion.mjs';
import { ProviderError } from './providers.mjs';
import { createIllustrationProvider, illustrationVersions, illustrationTaxonomy } from './illustration-provider.mjs';
import {compareTopProportions,measureTopProportions} from './illustration-proportions.mjs';
import { registerGarmentLayout, garmentLayout } from './illustration-layout.mjs';

const stages = ['preparation', 'attributes', 'generation', 'finalization', 'fidelity'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = value => value === null ? null : JSON.parse(value);
const json = value => JSON.stringify(value ?? null);
const cleared = "source=NULL,prepared=NULL";

function compatiblePreparedVersions(serialized) {
  let versions;
  try { versions = JSON.parse(serialized); } catch { return false; }
  // Switching renderers preserves segmentation; its billing mode is checked separately.
  return versions && ['fal-ai/nano-banana-pro/edit', illustrationVersions.modelVersion].includes(versions.modelVersion)
    && ((versions.templateVersion === illustrationVersions.templateVersion && versions.geometryVersion === illustrationVersions.geometryVersion)
      || (versions.modelVersion === 'gemini-3-pro-image' && versions.templateVersion === 'category-front-anchors-v4' && versions.geometryVersion === 'fitting-anchors-1024-v4')
      || (versions.modelVersion === 'gemini-3-pro-image' && versions.templateVersion === 'category-front-anchors-v3' && versions.geometryVersion === 'fitting-anchors-1024-v3')
      || (versions.modelVersion === 'gemini-3-pro-image' && versions.templateVersion === 'category-front-anchors-v2' && versions.geometryVersion === 'fitting-anchors-1024-v2')
      || (versions.templateVersion === 'front-360x560-proposed-v1' && versions.geometryVersion === 'fitting-square-1024-v1'));
}

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
    sourceSetVersionId: input.sourceSetVersionId.toLowerCase(), revision: input.revision, manualType, manualColors, ...(input.reuseObserved ? { reuseObserved: input.reuseObserved } : {}),
    photos: photos.map(({ id, role, digest }) => ({ id, role, digest })), ...illustrationVersions };
  return { ...identity, fingerprint: digest(JSON.stringify(identity)), photos };
}

export function createIllustrations(database, env, retention, budget) {
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
  const illustrationColumns = new Set(database.prepare('PRAGMA table_info(illustrations)').all().map(column => column.name));
  if (!illustrationColumns.has('photoroom_mode')) database.exec("ALTER TABLE illustrations ADD COLUMN photoroom_mode TEXT NOT NULL DEFAULT 'sandbox'");
  for (const column of ['result_digest', 'observed_digest', 'effective_digest']) if (!illustrationColumns.has(column)) database.exec(`ALTER TABLE illustrations ADD COLUMN ${column} TEXT`);
  if (!illustrationColumns.has('quality_attempt')) database.exec('ALTER TABLE illustrations ADD COLUMN quality_attempt INTEGER NOT NULL DEFAULT 0');
  if (!illustrationColumns.has('quality_history')) database.exec("ALTER TABLE illustrations ADD COLUMN quality_history TEXT NOT NULL DEFAULT '[]'");
  if (!illustrationColumns.has('cutout')) database.exec('ALTER TABLE illustrations ADD COLUMN cutout BLOB');
  // Existing undelivered v3 output has real bytes: bind them before any cleanup.
  for (const row of database.prepare('SELECT * FROM illustrations WHERE result IS NOT NULL OR observed IS NOT NULL OR effective IS NOT NULL').all()) {
    database.prepare('UPDATE illustrations SET result_digest=COALESCE(result_digest,?),observed_digest=COALESCE(observed_digest,?),effective_digest=COALESCE(effective_digest,?) WHERE operation_id=?')
      .run(row.result ? digest(row.result) : null, row.observed ? featureDigest(parse(row.observed)) : null,
        row.effective ? featureDigest(parse(row.effective)) : null, row.operation_id);
  }
  // Identity receipts, not a server wardrobe: no image bytes or attributes survive here.
  database.exec(`CREATE TABLE IF NOT EXISTS published_sources (
    item_id TEXT PRIMARY KEY, photo_version_id TEXT NOT NULL,
    source_set_version_id TEXT NOT NULL, photos TEXT NOT NULL)`);
  // Delivered operations retain their source identities after their artifacts are cleared.
  for (const row of database.prepare("SELECT illustrations.* FROM illustrations JOIN items ON items.item_id=illustrations.item_id AND items.photo_version_id=illustrations.photo_version_id WHERE illustrations.retention_state='delivered' ORDER BY illustrations.revision DESC").all()) {
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
  if (!sourceColumns.has('prepared_mode')) database.exec("ALTER TABLE illustration_sources ADD COLUMN prepared_mode TEXT NOT NULL DEFAULT 'sandbox'");
  // Keep hash-only receipts so an older client cache can still be authenticated
  // after a production preparation succeeds but a later generation fails.
  database.exec(`CREATE TABLE IF NOT EXISTS prepared_source_receipts (
    item_id TEXT NOT NULL, photo_id TEXT NOT NULL, digest TEXT NOT NULL,
    versions TEXT NOT NULL, photoroom_mode TEXT NOT NULL,
    PRIMARY KEY(item_id,photo_id,digest));
    INSERT OR IGNORE INTO prepared_source_receipts
      SELECT item_id,photo_id,prepared_digest,prepared_versions,prepared_mode FROM illustration_sources
      WHERE prepared_digest IS NOT NULL AND prepared_versions IS NOT NULL;`);
  const provider = createIllustrationProvider(env), timers = new Map(), abort = new AbortController();
  let closing = false;
  const get = id => database.prepare('SELECT * FROM illustrations WHERE operation_id=?').get(id);
  const current = id => database.prepare('SELECT * FROM illustrations WHERE item_id=? ORDER BY revision DESC LIMIT 1').get(id);
  function sweep() {
    const now = retention.deadline() - 7 * 24 * 60 * 60 * 1000;
    // Ordinary photo replacement is authoritative even when the illustration
    // worker is awaiting a provider. The old operation must not lock the item.
    database.prepare(`UPDATE illustrations SET status='failed',error='operation_superseded',retention_state='superseded',
      generated=NULL,cutout=NULL,result=NULL,observed=NULL,effective=NULL,manual_type=NULL,manual_colors=NULL
      WHERE retention_state='active' AND EXISTS (SELECT 1 FROM items
        WHERE items.item_id=illustrations.item_id AND items.photo_version_id<>illustrations.photo_version_id)`).run();
    for (const source of database.prepare('SELECT item_id,photo_id FROM illustration_sources WHERE source IS NOT NULL').all()) {
      const referenced = database.prepare("SELECT photos FROM illustrations WHERE item_id=? AND retention_state='active'").all(source.item_id)
        .some(row => parse(row.photos).some(photo => photo.id === source.photo_id));
      if (!referenced) database.prepare(`UPDATE illustration_sources SET ${cleared},state=CASE WHEN state='in_flight' THEN 'unknown' ELSE state END WHERE item_id=? AND photo_id=?`).run(source.item_id, source.photo_id);
    }
    database.prepare(`UPDATE illustrations SET status='failed',error='result_expired',retention_state='expired',
      generated=NULL,cutout=NULL,result=NULL,observed=NULL,effective=NULL,manual_type=NULL,manual_colors=NULL,processing=?
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
      resultSHA256: row.result_digest, observedFeaturesSHA256: row.observed_digest, effectiveFeaturesSHA256: row.effective_digest,
      processing: parse(row.processing), observedFeatures: parse(row.observed), effectiveFeatures: parse(row.effective),
      manualType: row.manual_type, manualColors: parse(row.manual_colors), ...parse(row.versions),
      preparedSources: row.status === 'ready' ? parse(row.photos).map(photo => {
        const source = database.prepare('SELECT prepared_digest,prepared_versions FROM illustration_sources WHERE item_id=? AND photo_id=?').get(row.item_id, photo.id);
        return { photoId: photo.id, sourceSHA256: photo.digest, preparedSHA256: source?.prepared_digest ?? null,
          versions: parse(source?.prepared_versions ?? null), preparedPath: `/v1/items/${row.item_id}/illustrations/${row.operation_id}/sources/${photo.id}/prepared` };
      }) : [],
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
      if (row.mode !== provider.mode || row.photoroom_mode !== provider.photoroomMode
        || row.versions !== json(illustrationVersions)) throw new ProviderError('provider_configuration_changed');
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
          budget.reserve('photoroom', `${operationId}:preparation:${input.id}`);
          const prepared = await provider.prepare(Buffer.from(source.source), abort.signal);
          if (!live(operationId)) return;
          database.prepare("UPDATE illustration_sources SET prepared=?,prepared_digest=?,prepared_versions=?,prepared_mode=?,state='done' WHERE item_id=? AND photo_id=?")
            .run(prepared, digest(prepared), json(illustrationVersions), provider.photoroomMode, row.item_id, input.id);
          database.prepare(`INSERT INTO prepared_source_receipts VALUES (?,?,?,?,?)
            ON CONFLICT(item_id,photo_id,digest) DO UPDATE SET versions=excluded.versions,photoroom_mode=excluded.photoroom_mode`)
            .run(row.item_id, input.id, digest(prepared), json(illustrationVersions), provider.photoroomMode);
          source = { ...source, prepared };
        }
        photos.push({ ...input, source: Buffer.from(source.source), prepared: Buffer.from(source.prepared) });
      }
      setStage(operationId, stage, 'done');
      stage = 'attributes'; row = live(operationId); if (!row) return;
      let effective = parse(row.effective);
      if (!effective) {
        setStage(operationId, stage, 'in_flight');
        budget.reserve('jev', `${operationId}:illustration:attributes:${row.photo_version_id}`);
        const observed = await provider.attributes(photos, abort.signal);
        if (!live(operationId)) return;
        effective = { ...observed, type: row.manual_type ?? observed.type, colors: parse(row.manual_colors) ?? observed.colors };
        database.prepare('UPDATE illustrations SET observed=?,effective=?,observed_digest=?,effective_digest=? WHERE operation_id=?').run(json(observed), json(effective), featureDigest(observed), featureDigest(effective), operationId);
        setStage(operationId, stage, 'done');
      }
      stage = 'generation'; row = live(operationId); if (!row) return;
      let generated = row.generated && { png: Buffer.from(row.generated), usableAlpha: Boolean(row.generated_alpha) };
      if (!generated) {
        garmentLayout(effective); // Reject unsupported placement before reserving a paid generation.
        setStage(operationId, stage, 'in_flight');
        if (!row.provider_receipt) budget.reserve('gemini', `${operationId}:illustration:generation:${row.photo_version_id}:${row.quality_attempt}`);
        generated = await provider.generate(photos, effective, abort.signal, receipt => {
          if (live(operationId)) database.prepare('UPDATE illustrations SET provider_receipt=? WHERE operation_id=?').run(receipt, operationId);
        }, row.provider_receipt, parse(row.quality_history).at(-1)?.correction);
        if (!live(operationId)) return;
        database.prepare('UPDATE illustrations SET generated=?,generated_alpha=? WHERE operation_id=?').run(generated.png, Number(generated.usableAlpha), operationId);
        setStage(operationId, stage, 'done');
      }
      stage = 'finalization';
      let result = row.result && Buffer.from(row.result);
      if (!result) {
        let finalizationState = generated.usableAlpha ? 'skipped' : 'done';
        let cutout = row.cutout && Buffer.from(row.cutout);
        if (!cutout) {
          if (generated.usableAlpha) cutout = generated.png;
          else {
            setStage(operationId, stage, 'in_flight');
            budget.reserve('photoroom', `${operationId}:finalization:${row.photo_version_id}:${row.quality_attempt}`);
            // Save the paid segmentation before doing fallible local placement.
            cutout = await provider.prepare(generated.png, abort.signal, stage);
          }
          const active = live(operationId); if (!active) return;
          database.prepare('UPDATE illustrations SET cutout=?,processing=? WHERE operation_id=?')
            .run(cutout,json({...parse(active.processing),finalization:finalizationState}),operationId);
        }
        result = await registerGarmentLayout(cutout,effective,await measureTopProportions(cutout,effective));
        const active = live(operationId); if (!active) return;
        // Persist the paid output and its completed stage together. It remains
        // private while pending; restart must not pay for finalization again.
        const processing = { ...parse(active.processing), finalization: finalizationState };
        database.prepare('UPDATE illustrations SET result=?,result_digest=?,processing=? WHERE operation_id=?')
          .run(result, digest(result), json(processing), operationId);
      }
      const front=photos.find(photo=>photo.role==='front')||photos[0];
      const proportions=await compareTopProportions(front.prepared,result,effective);
      if(proportions.measurable && !proportions.valid) throw new ProviderError('illustration_proportions_changed');
      if(!live(operationId))return;
      stage='fidelity';setStage(operationId,stage,'in_flight');
      budget.reserve('jev',`${operationId}:illustration:fidelity:${row.photo_version_id}:${row.quality_attempt}`);
      await provider.fidelity(front.source,result,abort.signal);
      const checked = live(operationId); if (!checked) return;
      database.prepare("UPDATE illustrations SET processing=?,status='ready',error=NULL WHERE operation_id=?")
        .run(json({ ...parse(checked.processing), fidelity: 'done' }), operationId);
    } catch (error) {
      if (!live(operationId)) return;
      const unknown = !(error instanceof ProviderError) || error.unknown;
      const active = live(operationId);
      const correction = !unknown && qualityCorrection(error);
      if (correction && active.quality_attempt === 0) {
        // Only completed, demonstrably defective candidates admit a new POST.
        // Persist its ordinal and the previous receipt BEFORE scheduling it;
        // a crash while the second request is in flight remains unknown.
        const history = [...parse(active.quality_history), {
          correction, providerReceipt: active.provider_receipt,
          generatedDigest: active.generated ? digest(active.generated) : null,
          resultDigest: active.result_digest,
        }];
        database.prepare(`UPDATE illustrations SET quality_attempt=1,quality_history=?,
          generated=NULL,generated_alpha=0,cutout=NULL,result=NULL,result_digest=NULL,provider_receipt=NULL,
          processing=? WHERE operation_id=? AND status='pending' AND quality_attempt=0`)
          .run(json(history),json({...parse(active.processing),generation:'pending',finalization:'pending',fidelity:'pending'}),operationId);
        schedule(operationId);
        return;
      }
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
    available: async () => await provider.available() && budget.available(),
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
      let reusedObserved = null;
      if (input.reuseObserved) {
        const reuse = input.reuseObserved;
        validateObserved(reuse.observedFeatures);
        const prior = get(reuse.previousIllustrationOperationId);
        if (!prior || prior.item_id !== itemId || prior.photo_version_id !== input.photoVersionId
          || prior.source_set_version_id !== input.sourceSetVersionId || reuse.sourceSetVersionId !== input.sourceSetVersionId
          || prior.photos !== sourceSet || (prior.observed_digest ? prior.observed_digest !== featureDigest(reuse.observedFeatures)
            || reuse.observedFeaturesSHA256 !== prior.observed_digest : reuse.legacyImport !== true || prior.retention_state !== 'delivered')) {
          throw new RequestError(409, 'observed_features_conflict');
        }
        reusedObserved = reuse.observedFeatures;
      }
      const deadline = retention.deadline();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO illustrations(operation_id,item_id,photo_version_id,source_set_version_id,revision,fingerprint,
          photos,manual_type,manual_colors,mode,processing,expires_at,versions,photoroom_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(input.operationId, input.itemId, input.photoVersionId, input.sourceSetVersionId, input.revision, input.fingerprint,
            json(input.photos.map(({ id, role, digest }) => ({ id, role, digest }))), input.manualType, json(input.manualColors), provider.mode,
            json(Object.fromEntries(stages.map(stage => [stage, 'pending']))), deadline, json(illustrationVersions), provider.photoroomMode);
        if (reusedObserved) {
          const effective = { ...reusedObserved, type: input.manualType ?? reusedObserved.type, colors: input.manualColors ?? reusedObserved.colors };
          database.prepare('UPDATE illustrations SET observed=?,effective=?,observed_digest=?,effective_digest=?,processing=? WHERE operation_id=?')
            .run(json(reusedObserved), json(effective), featureDigest(reusedObserved), featureDigest(effective),
              json(Object.fromEntries(stages.map(stage => [stage, stage === 'attributes' ? 'done' : 'pending']))), input.operationId);
        }
        for (const photo of input.photos) {
          const known = database.prepare('SELECT * FROM illustration_sources WHERE item_id=? AND photo_id=?').get(input.itemId, photo.id);
          if (known && known.digest !== photo.digest) throw new RequestError(409, 'identity_conflict');
          const receipt = photo.prepared && database.prepare('SELECT * FROM prepared_source_receipts WHERE item_id=? AND photo_id=? AND digest=?')
            .get(input.itemId, photo.id, digest(photo.prepared));
          if (photo.prepared && (!known || !receipt || !compatiblePreparedVersions(receipt.versions))) throw new RequestError(409, 'prepared_source_conflict');
          if (receipt && known.prepared_digest === receipt.digest && !compatiblePreparedVersions(known.prepared_versions)) {
            throw new RequestError(409, 'prepared_source_conflict');
          }
          if (known && ['in_flight', 'unknown'].includes(known.state)) throw new RequestError(409, 'processing_unknown');
          database.prepare(`INSERT INTO illustration_sources(item_id,photo_id,digest,source,expires_at) VALUES (?,?,?,?,?)
            ON CONFLICT(item_id,photo_id) DO UPDATE SET source=excluded.source,expires_at=excluded.expires_at`)
            .run(input.itemId, photo.id, photo.digest, photo.source, deadline);
          if (known && known.prepared_mode !== provider.photoroomMode) {
            database.prepare("UPDATE illustration_sources SET prepared=NULL,state='pending' WHERE item_id=? AND photo_id=?")
              .run(input.itemId, photo.id);
          }
          if (receipt && receipt.photoroom_mode === provider.photoroomMode) {
            database.prepare("UPDATE illustration_sources SET prepared=?,prepared_digest=?,prepared_versions=?,prepared_mode=?,state='done' WHERE item_id=? AND photo_id=?")
              .run(photo.prepared, receipt.digest, receipt.versions, receipt.photoroom_mode, input.itemId, photo.id);
          }
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
      requireNotDeleted(database, itemId);
      const row = get(operationId);
      if (!row || row.item_id !== itemId) throw new RequestError(404, 'not_found');
      if (row.retention_state === 'delivered') return;
      readable(itemId, operationId);
      throw new RequestError(409, 'preparation_required');
    },
    commit(itemId, operationId) {
      if (!uuid.test(itemId) || !uuid.test(operationId)) throw new RequestError(400, 'invalid_identity');
      requireNotDeleted(database, itemId);
      const known = get(operationId);
      if (!known || known.item_id !== itemId) throw new RequestError(404, 'not_found');
      // A delivered receipt proves a previous commit even if its response was lost.
      if (known.retention_state === 'delivered') {
        const locked = database.prepare('SELECT * FROM published_sources WHERE item_id=?').get(itemId);
        if (!locked || locked.photo_version_id !== known.photo_version_id || locked.source_set_version_id !== known.source_set_version_id) {
          throw new RequestError(409, 'operation_superseded');
        }
        return;
      }
      const row = readable(itemId, operationId);
      if (row.status !== 'ready') throw new RequestError(409, 'not_ready');
      {
        // This is the publication commit: generated output alone never freezes photos.
        lockSources(row);
        database.prepare(`UPDATE illustrations SET retention_state='delivered',status='failed',error='result_delivered',
          generated=NULL,cutout=NULL,result=NULL,observed=NULL,effective=NULL,manual_type=NULL,manual_colors=NULL,processing=? WHERE operation_id=?`)
          .run(json(Object.fromEntries(stages.map(stage => [stage, 'cleared']))), operationId);
        for (const photo of parse(row.photos)) {
          const used = database.prepare("SELECT photos FROM illustrations WHERE item_id=? AND retention_state='active'").all(itemId)
            .some(other => parse(other.photos).some(input => input.id === photo.id));
          if (!used) database.prepare(`UPDATE illustration_sources SET ${cleared} WHERE item_id=? AND photo_id=?`).run(itemId, photo.id);
        }
      }
    },
    close() { closing = true; clearInterval(cleanup); for (const timer of timers.values()) clearTimeout(timer); abort.abort(); },
  };
}
