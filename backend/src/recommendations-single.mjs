import { RequestError } from './upload.mjs';
import { readRecommendationInput, recommendationLimits } from './recommendation-input.mjs';
export { recommendationLimits } from './recommendation-input.mjs';
import { accepts, layerConflict, policyVersion } from './recommendation-policy.mjs';
import { createPreparedSnapshots, incompatible } from './prepared-snapshot.mjs';


export function createSingleRecommendations(database, model) {
  const snapshots = createPreparedSnapshots(database, model);
  return {
    capability(status) { return { available: status.available, reason: status.available ? null : 'model_unavailable',
      strategies: ['single'], policyVersion, limits: recommendationLimits }; },
    async recommend(request) {
      const input = await readRecommendationInput(request);
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
