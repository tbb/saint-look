import { RequestError, uuid } from './upload.mjs';
import { requireNotDeleted } from './deletion.mjs';
import { createModelBridge } from './model-bridge.mjs';
import { publicationProtocol, sha256, canonicalJSON, canonicalFeatures, featureDigest, validateObserved, readJSON, decodePNG } from './publication-contract.mjs';

const mib = 1024 * 1024, parse = text => text == null ? null : JSON.parse(text);
const cleared = 'source=NULL,features=NULL,representation=NULL';
export function createPreparations(database, env, retention, illustrations, directory) {
  database.exec(`CREATE TABLE IF NOT EXISTS preparations (
    operation_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,photo_version_id TEXT NOT NULL,source_set_version_id TEXT NOT NULL,
    illustration_operation_id TEXT NOT NULL,cutout_operation_id TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,
    space_id TEXT NOT NULL,request_mode TEXT NOT NULL,mode TEXT NOT NULL,image_mode TEXT NOT NULL,provenance TEXT NOT NULL,
    source BLOB,source_digest TEXT NOT NULL,features TEXT,features_digest TEXT NOT NULL,artifacts TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',representation TEXT,representation_digest TEXT,input TEXT,error TEXT,
    retention_state TEXT NOT NULL DEFAULT 'active',expires_at INTEGER NOT NULL,UNIQUE(item_id,revision));
    CREATE INDEX IF NOT EXISTS preparation_expiry ON preparations(retention_state,expires_at);`);
  const model = createModelBridge(env, directory);
  let closing = false, running = false, admitting = false;
  const get = id => database.prepare('SELECT * FROM preparations WHERE operation_id=?').get(id);
  const latest = id => database.prepare('SELECT * FROM preparations WHERE item_id=? ORDER BY revision DESC LIMIT 1').get(id);
  const illustration = id => database.prepare('SELECT * FROM illustrations WHERE operation_id=?').get(id);
  function sweep() {
    const now = retention.deadline() - 7 * 24 * 60 * 60 * 1000;
    database.prepare(`UPDATE preparations SET ${cleared},status='failed',retention_state='expired',error='result_expired'
      WHERE retention_state='active' AND expires_at<=?`).run(now);
    database.prepare(`UPDATE preparations SET ${cleared},status='failed',retention_state='superseded',error='operation_superseded'
      WHERE retention_state='active' AND (EXISTS (SELECT 1 FROM items WHERE items.item_id=preparations.item_id AND items.photo_version_id<>preparations.photo_version_id)
      OR EXISTS (SELECT 1 FROM illustrations newer JOIN illustrations own ON own.operation_id=preparations.illustration_operation_id
        WHERE newer.item_id=preparations.item_id AND newer.revision>own.revision)
      OR EXISTS (SELECT 1 FROM preparations newer WHERE newer.item_id=preparations.item_id AND newer.revision>preparations.revision))`).run();
  }
  function readable(itemId, operationId) {
    if (!uuid.test(itemId) || !uuid.test(operationId)) throw new RequestError(400, 'invalid_identity');
    requireNotDeleted(database, itemId); sweep();
    const row = get(operationId);
    if (!row || row.item_id !== itemId) throw new RequestError(404, 'not_found');
    if (row.retention_state === 'superseded') throw new RequestError(409, 'operation_superseded');
    if (row.retention_state !== 'active') throw new RequestError(410, row.error);
    return row;
  }
  function response(row) {
    return { itemId: row.item_id, operationId: row.operation_id, revision: row.revision, photoVersionId: row.photo_version_id,
      sourceSetVersionId: row.source_set_version_id, illustrationOperationId: row.illustration_operation_id, cutoutOperationId: row.cutout_operation_id,
      spaceID: row.space_id, status: row.status, mode: row.mode, imageMode: row.image_mode, provenance: row.provenance,
      effectiveFeatures: parse(row.features), input: parse(row.input), representationJSON: row.representation,
      representationSHA256: row.representation_digest, artifacts: parse(row.artifacts), error: row.error };
  }
  async function processQueue() {
    if (running || closing) return;
    running = true;
    try {
      while (!closing) {
        sweep();
        const row = database.prepare("SELECT * FROM preparations WHERE status='pending' AND retention_state='active' ORDER BY rowid LIMIT 1").get();
        if (!row) break;
        try {
          const status = await model.status();
          if (!status.available || status.activeSpaceID !== row.space_id || status.mode !== row.mode) throw new Error('encoder_unavailable');
          const result = await model.prepare(Buffer.from(row.source), row.photo_version_id, parse(row.features));
          if (closing) break;
          sweep();
          database.prepare(`UPDATE preparations SET status='ready',representation=?,representation_digest=?,input=?,error=NULL
            WHERE operation_id=? AND retention_state='active'`).run(result.representationJSON, result.representationSHA256, JSON.stringify(result.input), row.operation_id);
        } catch (error) {
          if (closing) break;
          sweep();
          database.prepare("UPDATE preparations SET status='failed',error=? WHERE operation_id=? AND retention_state='active'")
            .run(error.message === 'encoder_unavailable' ? 'encoder_unavailable' : 'encoder_failed', row.operation_id);
        }
      }
    } finally { running = false; }
  }
  async function config() {
    const encoder = await model.status(), imageAvailable = await illustrations.available();
    return { protocolVersion: 1, publicationProtocol, preparationRequired: true, representationEncoding: 'opaque-json-string-v1', encoder,
      newItemPreparation: { available: encoder.available && imageAvailable, reason: !encoder.available ? encoder.reason : !imageAvailable ? 'illustration_unavailable' : null },
      encoderRefresh: { available: encoder.available, reason: encoder.reason }, recommendations: { available: false, reason: 'not_enabled' } };
  }
  async function legacyArtifacts(input, row, cutout, features) {
    const packet = input.legacy, saved = packet?.illustration?.response;
    if (row.retention_state !== 'delivered' || !saved || saved.itemId !== row.item_id || saved.operationId !== row.operation_id
      || saved.photoVersionId !== row.photo_version_id || saved.sourceSetVersionId !== row.source_set_version_id || saved.status !== 'ready'
      || saved.mode !== row.mode || !['live', 'demo', 'test'].includes(packet.cutout?.mode)
      || (cutout.result_mode && packet.cutout.mode !== cutout.result_mode)
      || Object.entries(parse(row.versions)).some(([key, value]) => saved[key] !== value)) throw new RequestError(409, 'legacy_artifact_conflict');
    validateObserved(saved.observedFeatures); validateObserved(saved.effectiveFeatures);
    if (canonicalJSON(canonicalFeatures(saved.effectiveFeatures, true)) !== canonicalJSON(features)) throw new RequestError(409, 'features_conflict');
    const primary = await decodePNG(packet.cutout.imageBase64, 10 * mib);
    const image = await decodePNG(packet.illustration.imageBase64, 10 * mib, 1024);
    if (!primary.metadata.hasAlpha || !image.metadata.hasAlpha) throw new RequestError(400, 'invalid_image');
    const artifacts = { cutoutSHA256: sha256(primary.raw), illustrationSHA256: sha256(image.raw),
      observedFeaturesSHA256: featureDigest(saved.observedFeatures), effectiveFeaturesSHA256: featureDigest(saved.effectiveFeatures) };
    if ((cutout.result_digest && cutout.result_digest !== artifacts.cutoutSHA256) || (row.result_digest && row.result_digest !== artifacts.illustrationSHA256)
      || (row.observed_digest && row.observed_digest !== artifacts.observedFeaturesSHA256) || (row.effective_digest && row.effective_digest !== artifacts.effectiveFeaturesSHA256)) throw new RequestError(409, 'legacy_artifact_conflict');
    const photos = parse(row.photos);
    if (!Array.isArray(packet.preparedPhotos) || packet.preparedPhotos.length !== photos.length) throw new RequestError(409, 'prepared_source_conflict');
    for (const photo of photos) {
      const meta = packet.preparedPhotos.find(value => value.photoId === photo.id);
      const source = database.prepare('SELECT * FROM illustration_sources WHERE item_id=? AND photo_id=?').get(row.item_id, photo.id);
      if (!meta || !source || meta.sourceSHA256 !== photo.digest || meta.preparedSHA256 !== source.prepared_digest
        || canonicalJSON(meta.versions) !== canonicalJSON(parse(source.prepared_versions))) throw new RequestError(409, 'prepared_source_conflict');
    }
    return artifacts;
  }
  async function accept(request, itemId) {
    // Bound decoded PNG/JSON memory, including legacy imports, across admissions.
    if (admitting) { request.resume(); throw new RequestError(429, 'preparation_busy'); }
    admitting = true;
    try {
      const input = await readJSON(request, 36 * mib);
      if (input.mode !== 'legacyImport' && Buffer.byteLength(JSON.stringify(input)) > 8 * mib) throw new RequestError(413, 'image_too_large');
      if (!uuid.test(itemId) || ['operationId', 'photoVersionId', 'sourceSetVersionId', 'illustrationOperationId', 'cutoutOperationId'].some(key => typeof input[key] !== 'string' || !uuid.test(input[key]))) throw new RequestError(400, 'invalid_identity');
      for (const key of ['operationId', 'photoVersionId', 'sourceSetVersionId', 'illustrationOperationId', 'cutoutOperationId']) input[key] = input[key].toLowerCase();
      if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !['fromIllustration', 'reusePublication', 'legacyImport'].includes(input.mode)) throw new RequestError(400, 'invalid_attempt');
      const features = canonicalFeatures(input.features), photo = await decodePNG(input.imageBase64, 5 * mib);
      const status = await model.status();
      if (!status.available) throw new RequestError(503, 'encoder_unavailable');
      if (input.spaceID !== status.activeSpaceID) throw new RequestError(409, 'representation_space_changed');
      requireNotDeleted(database, itemId); sweep();
      const item = database.prepare('SELECT * FROM items WHERE item_id=?').get(itemId);
      const row = illustration(input.illustrationOperationId);
      const cutout = database.prepare('SELECT * FROM operation_receipts WHERE operation_id=?').get(input.cutoutOperationId);
      if (!item || !row || row.item_id !== itemId || !cutout || cutout.item_id !== itemId) throw new RequestError(404, 'not_found');
      if (item.photo_version_id !== input.photoVersionId || row.photo_version_id !== input.photoVersionId || row.source_set_version_id !== input.sourceSetVersionId
        || cutout.photo_version_id !== input.photoVersionId) throw new RequestError(409, 'operation_superseded');
      if (cutout.source_digest !== sha256(photo.normalized) || parse(row.photos)[0].digest !== sha256(photo.raw)) throw new RequestError(409, 'identity_conflict');
      const newestIllustration = database.prepare('SELECT operation_id FROM illustrations WHERE item_id=? ORDER BY revision DESC LIMIT 1').get(itemId);
      if (newestIllustration.operation_id !== row.operation_id) throw new RequestError(409, 'operation_superseded');
      let artifacts, provenance;
      if (input.mode === 'fromIllustration') {
        if (row.retention_state !== 'active' || row.status !== 'ready' || !cutout.result_digest) throw new RequestError(409, 'artifacts_not_ready');
        if (canonicalJSON(canonicalFeatures(parse(row.effective), true)) !== canonicalJSON(features)) throw new RequestError(409, 'features_conflict');
        artifacts = { cutoutSHA256: cutout.result_digest, illustrationSHA256: row.result_digest,
          observedFeaturesSHA256: row.observed_digest, effectiveFeaturesSHA256: row.effective_digest }; provenance = 'pipeline';
      } else if (input.mode === 'reusePublication') {
        const prior = get(input.reuse?.publicationId);
        if (!prior || prior.item_id !== itemId || prior.retention_state !== 'delivered' || prior.photo_version_id !== input.photoVersionId
          || prior.source_set_version_id !== input.sourceSetVersionId || prior.illustration_operation_id !== row.operation_id
          || prior.cutout_operation_id !== cutout.operation_id || prior.source_digest !== sha256(photo.raw)
          || prior.features_digest !== featureDigest(features) || canonicalJSON(input.reuse.artifacts) !== canonicalJSON(parse(prior.artifacts))) throw new RequestError(409, 'publication_conflict');
        artifacts = parse(prior.artifacts); provenance = 'reused';
      } else {
        if (database.prepare("SELECT 1 FROM preparations WHERE request_mode='legacyImport' AND status='pending' AND retention_state='active' AND operation_id<>?").get(input.operationId)) throw new RequestError(429, 'preparation_busy');
        artifacts = await legacyArtifacts(input, row, cutout, features); provenance = 'legacyImport';
      }
      const fingerprint = featureDigest({ itemId, ...input, imageBase64: sha256(photo.raw), legacy: input.mode === 'legacyImport' ? artifacts : null });
      // All asynchronous validation completed: deletion/replacement still wins.
      requireNotDeleted(database, itemId); sweep();
      if (database.prepare('SELECT photo_version_id FROM items WHERE item_id=?').get(itemId)?.photo_version_id !== input.photoVersionId
        || database.prepare('SELECT operation_id FROM illustrations WHERE item_id=? ORDER BY revision DESC LIMIT 1').get(itemId)?.operation_id !== row.operation_id) throw new RequestError(409, 'operation_superseded');
      const known = get(input.operationId);
      if (known) {
        if (known.fingerprint !== fingerprint) throw new RequestError(409, 'identity_conflict');
        return { status: 200, body: response(readable(itemId, input.operationId)) };
      }
      if ((latest(itemId)?.revision ?? 0) >= input.revision) throw new RequestError(409, 'stale_revision');
      if (database.prepare("SELECT COUNT(*) n FROM preparations WHERE status='pending' AND retention_state='active'").get().n >= 8) throw new RequestError(429, 'preparation_busy');
      database.prepare(`INSERT INTO preparations(operation_id,item_id,photo_version_id,source_set_version_id,illustration_operation_id,cutout_operation_id,
        revision,fingerprint,space_id,request_mode,mode,image_mode,provenance,source,source_digest,features,features_digest,artifacts,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.operationId,itemId,input.photoVersionId,input.sourceSetVersionId,input.illustrationOperationId,input.cutoutOperationId,
          input.revision,fingerprint,input.spaceID,input.mode,status.mode,row.mode,provenance,photo.raw,sha256(photo.raw),JSON.stringify(features),featureDigest(features),JSON.stringify(artifacts),retention.deadline());
      sweep(); void processQueue();
      return { status: 202, body: response(get(input.operationId)) };
    } finally { admitting = false; }
  }
  async function acknowledge(request, itemId, illustrationId) {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new RequestError(413, 'invalid_request'); chunks.push(chunk); }
    if (!size) { illustrations.acknowledge(itemId, illustrationId); return; }
    let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw new RequestError(400, 'invalid_request'); }
    if (body?.publicationProtocol !== publicationProtocol || !uuid.test(body.preparationOperationId ?? '')) throw new RequestError(400, 'invalid_publication');
    requireNotDeleted(database, itemId);
    const operationId = body.preparationOperationId.toLowerCase(), known = get(operationId);
    if (!known || known.item_id !== itemId || known.illustration_operation_id !== illustrationId) throw new RequestError(409, 'publication_conflict');
    if (known.retention_state === 'delivered') return;
    const status = await model.status();
    const row = readable(itemId, operationId);
    if (row.status !== 'ready' || !row.representation || !row.representation_digest) throw new RequestError(409, 'preparation_required');
    if (!status.available || row.space_id !== status.activeSpaceID) throw new RequestError(409, 'representation_space_changed');
    database.exec('BEGIN IMMEDIATE');
    try {
      const artifacts = parse(row.artifacts);
      database.prepare('UPDATE illustrations SET result_digest=?,observed_digest=?,effective_digest=? WHERE operation_id=?')
        .run(artifacts.illustrationSHA256, artifacts.observedFeaturesSHA256, artifacts.effectiveFeaturesSHA256, illustrationId);
      database.prepare('UPDATE operation_receipts SET result_digest=COALESCE(result_digest,?) WHERE operation_id=?')
        .run(artifacts.cutoutSHA256, row.cutout_operation_id);
      illustrations.commit(itemId, illustrationId);
      database.prepare(`UPDATE preparations SET ${cleared},retention_state='delivered',status='failed',error='result_delivered' WHERE operation_id=?`).run(operationId);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  sweep(); void processQueue();
  const cleanup = setInterval(sweep, 1000);
  return { config, sweep, accept, acknowledge, read: (item, operation) => response(readable(item, operation)),
    close() { closing = true; clearInterval(cleanup); model.close(); } };
}
