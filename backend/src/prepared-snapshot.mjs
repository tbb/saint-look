import { RequestError } from './upload.mjs';
import { sha256, featureDigest, canonicalText } from './publication-contract.mjs';

export function incompatible(activeSpaceID) {
  const error = new RequestError(409, 'incompatible_representations');
  error.activeSpaceID = activeSpaceID;
  return error;
}
// Receipts retain hashes/identity, not a server wardrobe. The caller supplies the
// byte-exact local representation and effective features on each request.
export function createPreparedSnapshots(database, model) {
  const delivered = database.prepare("SELECT * FROM preparations WHERE item_id=? AND retention_state='delivered' ORDER BY revision DESC LIMIT 1");
  const get = database.prepare('SELECT * FROM preparations WHERE operation_id=?');
  const deleted = database.prepare('SELECT 1 FROM deleted_items WHERE item_id=?');
  function current(itemId, publishedVersionId, targetOnly = false) {
    if (deleted.get(itemId)) throw new RequestError(409, 'snapshot_stale');
    const latest = delivered.get(itemId);
    if (latest && latest.operation_id !== publishedVersionId) throw new RequestError(409, 'snapshot_stale');
    if (targetOnly && !latest) {
      const claimed = publishedVersionId && get.get(publishedVersionId);
      if (claimed && claimed.item_id !== itemId) throw new RequestError(400, 'invalid_prepared_item');
      return null;
    }
    const receipt = get.get(publishedVersionId);
    if (!receipt || receipt.item_id !== itemId || receipt.retention_state !== 'delivered') throw new RequestError(400, 'invalid_prepared_item');
    return receipt;
  }
  return {
    capture(items, target, status) {
      const references = Array.isArray(target) ? target : [target];
      const prepared = new Map();
      for (const item of items) {
        const receipt = current(item.itemId, item.publishedVersionId);
        if (receipt.photo_version_id !== item.photoVersionId || receipt.source_set_version_id !== item.sourceSetVersionId
          || sha256(item.representationJSON) !== item.representationSHA256 || receipt.representation_digest !== item.representationSHA256
          || receipt.features_digest !== featureDigest(item.features)) throw new RequestError(400, 'invalid_prepared_item');
        if (receipt.space_id !== status.activeSpaceID || receipt.mode !== status.mode) throw incompatible(status.activeSpaceID);
        let representation;
        try {
          const input = JSON.parse(receipt.input);
          if (input.sourceSHA256 !== receipt.source_digest || input.textSHA256 !== sha256(canonicalText(item.features))) throw new Error();
          representation = model.readRepresentation(item.representationJSON, { spaceID: receipt.space_id, photoVersionID: item.photoVersionId, ...input });
        } catch { throw new RequestError(400, 'invalid_prepared_item'); }
        prepared.set(item.itemId, { ...item, representation });
      }
      for (const reference of references) if (reference.itemId && !prepared.has(reference.itemId)) current(reference.itemId, reference.publishedVersionId, true);
      return {
        items: prepared,
        recheck() {
          for (const item of items) current(item.itemId, item.publishedVersionId);
          for (const reference of references) if (reference.itemId) current(reference.itemId, reference.publishedVersionId, !prepared.has(reference.itemId));
        },
      };
    },
  };
}
