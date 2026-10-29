// Explicit input fixture for bounded-load/real-rank experiments, not a publication
// API or proof of live image readiness. Functional tests publish through HTTP.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { featureDigest } from '../src/publication-contract.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');

export function clonePreparedPacket(item) {
  const photoVersionId = randomUUID();
  const representationJSON = JSON.stringify({ ...JSON.parse(item.representationJSON), photoVersionID: photoVersionId });
  return { ...item, itemId: randomUUID(), publishedVersionId: randomUUID(), photoVersionId, sourceSetVersionId: randomUUID(),
    representationJSON, representationSHA256: digest(representationJSON) };
}
export function installReceiptFixture(directory, items, mode = 'controlled') {
  const database = new DatabaseSync(join(directory, 'wardrobe.sqlite'));
  const insert = database.prepare(`INSERT INTO preparations(operation_id,item_id,photo_version_id,source_set_version_id,illustration_operation_id,cutout_operation_id,
    revision,fingerprint,space_id,request_mode,mode,image_mode,provenance,source_digest,features_digest,artifacts,status,representation_digest,input,retention_state,error,expires_at)
    VALUES (?,?,?,?,?,?,1,?,?,'legacyImport',?,'test','syntheticReceiptFixture',?,?,?,'failed',?,?,'delivered','result_delivered',?)`);
  database.exec('BEGIN');
  try {
    for (const item of items) {
      const representation = JSON.parse(item.representationJSON);
      const features = { colors: [...item.features.colors].sort(), type: item.features.type };
      const artifact = digest('synthetic final image receipt fixture');
      insert.run(item.publishedVersionId, item.itemId, item.photoVersionId, item.sourceSetVersionId, randomUUID(), randomUUID(),
        digest(item.itemId), representation.spaceID, mode, representation.sourceSHA256, digest(JSON.stringify(features)),
        JSON.stringify({ cutoutSHA256: artifact, illustrationSHA256: artifact, observedFeaturesSHA256: artifact, effectiveFeaturesSHA256: item.effectiveFeatures ? featureDigest(item.effectiveFeatures) : artifact }),
        item.representationSHA256, JSON.stringify({ sourceSHA256: representation.sourceSHA256, textSHA256: representation.textSHA256 }), Date.now());
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  finally { database.close(); }
}
