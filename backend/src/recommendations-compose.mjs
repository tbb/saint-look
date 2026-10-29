import { RequestError } from './upload.mjs';
import { readRecommendationInput, recommendationLimits } from './recommendation-input.mjs';
import { accepts, layerConflict, policyVersion } from './recommendation-policy.mjs';
import { createPreparedSnapshots, incompatible } from './prepared-snapshot.mjs';

const placement = slot => ({ slotId: slot.slotId, itemId: slot.itemId, publishedVersionId: slot.publishedVersionId });
const occupancy = slots => slots.filter(slot => slot.itemId).length;
const identity = slots => slots.map(slot => slot.itemId ?? '').join('/');
const compare = (a, b) => occupancy(b.slots) - occupancy(a.slots) || b.score - a.score
  || identity(a.slots).localeCompare(identity(b.slots), 'en');

export function createComposeRecommendations(database, model) {
  const snapshots = createPreparedSnapshots(database, model);
  return {
    async recommend(request) {
      const input = await readRecommendationInput(request, { composition: true });
      if (input.orderedSlots.length > recommendationLimits.context) throw new RequestError(400, 'context_too_large');
      const status = await model.status();
      if (!status.available) throw new RequestError(503, 'model_unavailable');
      const snapshot = snapshots.capture(input.items, input.orderedSlots, status);
      const result = (outcome, reason = null, placements = null, conflictingSlotIds = []) => ({
        requestId: input.requestId, snapshotId: input.snapshotId, mode: input.mode, modelMode: status.mode,
        outcome, reason, placements, conflictingSlotIds, spaceID: status.activeSpaceID, policyVersion,
      });
      const pinned = new Set(input.pinnedSlotIds);
      const fixed = slot => pinned.has(slot.slotId) || (input.mode === 'fillEmpty' && Boolean(slot.itemId));
      const editable = input.orderedSlots.filter(slot => !fixed(slot));
      if (!editable.length) return result('unchanged', input.orderedSlots.every(slot => pinned.has(slot.slotId)) ? 'all_pinned' : 'nothing_to_fill');
      const fixedOccupied = input.orderedSlots.filter(slot => fixed(slot) && slot.itemId);
      const missing = fixedOccupied.filter(slot => !snapshot.items.has(slot.itemId));
      if (missing.length) return result('constraints_conflict', 'preparation_required', null, missing.map(slot => slot.slotId));
      const duplicate = fixedOccupied.filter((slot, i) => fixedOccupied.some((other, j) => j < i && other.itemId === slot.itemId));
      if (duplicate.length) return result('constraints_conflict', 'duplicate_item', null, duplicate.map(slot => slot.slotId));
      const category = fixedOccupied.filter(slot => !accepts(slot.zone, snapshot.items.get(slot.itemId)));
      if (category.length) return result('constraints_conflict', 'fixed_category_mismatch', null, category.map(slot => slot.slotId));
      const conflict = layerConflict(fixedOccupied, snapshot.items);
      if (conflict.length) return result('constraints_conflict', 'fixed_layer_order', null, conflict);
      const excluded = new Set(input.excludedItemIds);
      let beam = [{ slots: input.orderedSlots.map(slot => fixed(slot) ? slot : { ...slot, itemId: null, publishedVersionId: null }), score: 0 }];
      for (const target of editable) {
        const expanded = [];
        for (const state of beam) {
          const occupied = new Set(state.slots.filter(slot => slot.itemId).map(slot => slot.itemId));
          const place = item => state.slots.map(slot => slot.slotId === target.slotId
            ? { ...slot, itemId: item.itemId, publishedVersionId: item.publishedVersionId } : slot);
          const candidates = [...snapshot.items.values()].filter(item => accepts(target.zone, item) && !excluded.has(item.itemId)
            && !occupied.has(item.itemId) && !layerConflict(place(item), snapshot.items).length);
          if (!candidates.length) { expanded.push(state); continue; }
          snapshot.recheck();
          let scores;
          try {
            scores = await model.rank(state.slots.filter(slot => slot.itemId).map(slot => snapshot.items.get(slot.itemId).representation),
              candidates.map(item => item.representation));
          } catch (error) { throw new RequestError(503, error.message === 'encoder_unavailable' ? 'model_unavailable' : 'model_failed'); }
          snapshot.recheck();
          const ranked = candidates.map((item, index) => ({ item, score: scores[index] })).sort((a, b) => b.score - a.score
            || (a.item.itemId < b.item.itemId ? -1 : a.item.itemId > b.item.itemId ? 1 : 0));
          for (const rankedItem of ranked.slice(0, 2)) expanded.push({ slots: place(rankedItem.item), score: state.score + rankedItem.score });
        }
        beam = expanded.sort(compare).slice(0, 2);
      }
      const after = await model.status();
      if (!after.available) throw new RequestError(503, 'model_unavailable');
      if (after.activeSpaceID !== status.activeSpaceID || after.mode !== status.mode) throw incompatible(after.activeSpaceID);
      snapshot.recheck();
      const best = beam[0].slots;
      // Bounded search is not proof that a fuller outfit is impossible. Never
      // discard an existing composition merely because this search found less.
      if (occupancy(best) < occupancy(input.orderedSlots)) return result('unchanged', 'insufficient_improvement');
      if (identity(best) === identity(input.orderedSlots)) return result(occupancy(best) ? 'unchanged' : 'no_solution', occupancy(best) ? 'same_composition' : 'no_candidates');
      const partial = best.some(slot => !fixed(slot) && !slot.itemId);
      return result(partial ? 'partial' : 'proposed', partial ? 'bounded_search_partial' : null, best.map(placement));
    },
  };
}
