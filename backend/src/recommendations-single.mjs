import { RequestError, uuid } from './upload.mjs';
import { readJSON, canonicalFeatures } from './publication-contract.mjs';
import { accepts, isZone, layerConflict, policyVersion } from './recommendation-policy.mjs';
import { createPreparedSnapshots, incompatible } from './prepared-snapshot.mjs';

export const recommendationLimits = Object.freeze({ items: 300, context: 32, requestBytes: 4 * 1024 * 1024, representationBytes: 8 * 1024 });
const invalid = () => { throw new RequestError(400, 'invalid_request'); };
const id = value => { if (typeof value !== 'string' || !uuid.test(value)) invalid(); return value.toLowerCase(); };
const unique = values => { if (new Set(values).size !== values.length) invalid(); return values; };
function ids(value) { if (!Array.isArray(value)) invalid(); return unique(value.map(id)); }
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
async function readInput(request) {
  let raw;
  try { raw = await readJSON(request, recommendationLimits.requestBytes); }
  catch (error) { if (error instanceof RequestError && error.status === 413) throw new RequestError(413, 'request_too_large'); throw error; }
  fields(raw, ['requestId', 'snapshotId', 'targetSlotId', 'orderedSlots', 'pinnedSlotIds', 'excludedItemIds', 'items']);
  const requestId = id(raw.requestId), snapshotId = id(raw.snapshotId), targetSlotId = id(raw.targetSlotId);
  if (!Array.isArray(raw.items) || !Array.isArray(raw.orderedSlots) || !raw.orderedSlots.length) invalid();
  if (raw.items.length > recommendationLimits.items) throw new RequestError(400, 'too_many_items');
  const items = raw.items.map(item => {
    fields(item, ['itemId', 'publishedVersionId', 'photoVersionId', 'sourceSetVersionId', 'features', 'representationJSON', 'representationSHA256']);
    if (typeof item.representationJSON !== 'string' || !item.representationJSON.length || Buffer.byteLength(item.representationJSON) > recommendationLimits.representationBytes
      || typeof item.representationSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.representationSHA256)) invalid();
    fields(item.features, ['type', 'colors']);
    return { ...item, itemId: id(item.itemId), publishedVersionId: id(item.publishedVersionId), photoVersionId: id(item.photoVersionId),
      sourceSetVersionId: id(item.sourceSetVersionId), features: canonicalFeatures(item.features) };
  });
  unique(items.map(item => item.itemId));
  const orderedSlots = raw.orderedSlots.map(slot => {
    fields(slot, ['slotId', 'zone', 'itemId', 'publishedVersionId']);
    if (!isZone(slot.zone)) invalid();
    const result = { slotId: id(slot.slotId), zone: slot.zone, itemId: slot.itemId == null ? null : id(slot.itemId),
      publishedVersionId: slot.publishedVersionId == null ? null : id(slot.publishedVersionId) };
    if ((!result.itemId && result.publishedVersionId) || (result.itemId && !result.publishedVersionId && result.slotId !== targetSlotId)) invalid();
    return result;
  });
  unique(orderedSlots.map(slot => slot.slotId));
  const target = orderedSlots.find(slot => slot.slotId === targetSlotId); if (!target) invalid();
  for (const zone of ['head', 'bottom', 'shoes']) if (orderedSlots.filter(slot => slot.zone === zone).length > 1) invalid();
  const pinnedSlotIds = ids(raw.pinnedSlotIds), excludedItemIds = ids(raw.excludedItemIds);
  const slotIds = new Set(orderedSlots.map(slot => slot.slotId));
  if (pinnedSlotIds.some(value => !slotIds.has(value))) invalid();
  const byId = new Map(items.map(item => [item.itemId, item]));
  for (const slot of orderedSlots) {
    if (!slot.itemId) continue;
    const item = byId.get(slot.itemId);
    if (!item && slot.slotId !== targetSlotId) throw new RequestError(400, 'invalid_prepared_item');
    if (item && item.publishedVersionId !== slot.publishedVersionId) invalid();
  }
  return { requestId, snapshotId, targetSlotId, orderedSlots, pinnedSlotIds, excludedItemIds, items, target };
}

export function createSingleRecommendations(database, model) {
  const snapshots = createPreparedSnapshots(database, model);
  return {
    capability(status) { return { available: status.available, reason: status.available ? null : 'model_unavailable',
      strategies: ['single'], policyVersion, limits: recommendationLimits }; },
    async recommend(request) {
      const input = await readInput(request);
      const status = await model.status();
      if (!status.available) throw new RequestError(503, 'model_unavailable');
      const snapshot = snapshots.capture(input.items, input.target, status);
      const result = (outcome, reason = null, proposal = null, conflictingSlotIds = []) => ({ requestId: input.requestId,
        snapshotId: input.snapshotId, targetSlotId: input.targetSlotId, outcome, proposal, reason, conflictingSlotIds,
        spaceID: status.activeSpaceID, mode: status.mode, policyVersion });
      const occupied = input.orderedSlots.filter(slot => slot.itemId);
      const duplicate = occupied.filter((slot, i) => occupied.some((other, j) => j < i && other.itemId === slot.itemId));
      if (duplicate.length) return result('constraints_conflict', 'duplicate_item', null, duplicate.map(slot => slot.slotId));
      if (input.pinnedSlotIds.includes(input.targetSlotId)) return result('constraints_conflict', 'target_pinned', null, [input.targetSlotId]);
      const fixed = input.orderedSlots.filter(slot => slot.slotId !== input.targetSlotId && slot.itemId);
      if (fixed.length > recommendationLimits.context) throw new RequestError(400, 'context_too_large');
      const invalidSlots = fixed.filter(slot => !accepts(slot.zone, snapshot.items.get(slot.itemId)));
      if (invalidSlots.length) return result('constraints_conflict', 'fixed_category_mismatch', null, invalidSlots.map(slot => slot.slotId));
      const conflict = layerConflict(fixed, snapshot.items);
      if (conflict.length) return result('constraints_conflict', 'fixed_layer_order', null, conflict);
      if (!fixed.length) return result('empty_context', 'context_required');
      const category = [...snapshot.items.values()].filter(item => accepts(input.target.zone, item));
      if (!category.length) return result('no_alternative', 'no_category_candidates');
      const excluded = new Set([...input.excludedItemIds, ...occupied.map(slot => slot.itemId)]);
      const available = category.filter(item => !excluded.has(item.itemId));
      if (!available.length) return result('no_alternative', 'excluded_or_occupied');
      const candidates = available.filter(item => !layerConflict(input.orderedSlots.map(slot => slot.slotId === input.targetSlotId ? { ...slot, itemId: item.itemId } : slot), snapshot.items).length);
      if (!candidates.length) return result('no_alternative', 'layer_constraints');
      let scores;
      try { scores = await model.rank(fixed.map(slot => snapshot.items.get(slot.itemId).representation), candidates.map(item => item.representation)); }
      catch (error) { throw new RequestError(503, error.message === 'encoder_unavailable' ? 'model_unavailable' : 'model_failed'); }
      // A valid model response must never undo a delete or newer publication that
      // completed while Python/transport was awaited. Local edits are checked by iOS.
      snapshot.recheck();
      const after = await model.status();
      if (!after.available) throw new RequestError(503, 'model_unavailable');
      if (after.activeSpaceID !== status.activeSpaceID || after.mode !== status.mode) throw incompatible(after.activeSpaceID);
      snapshot.recheck();
      const ranked = candidates.map((item, index) => ({ item, score: scores[index] })).sort((a, b) => b.score - a.score
        || (a.item.itemId < b.item.itemId ? -1 : a.item.itemId > b.item.itemId ? 1 : 0));
      const selected = ranked[0].item;
      return result('proposed', null, { itemId: selected.itemId, publishedVersionId: selected.publishedVersionId });
    },
  };
}
