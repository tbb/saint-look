import { RequestError, uuid } from './upload.mjs';
import { readJSON, canonicalFeatures } from './publication-contract.mjs';
import { isZone } from './recommendation-policy.mjs';

export const recommendationLimits = Object.freeze({ items: 300, context: 32, requestBytes: 4 * 1024 * 1024, representationBytes: 8 * 1024 });
const invalid = () => { throw new RequestError(400, 'invalid_request'); };
const id = value => { if (typeof value !== 'string' || !uuid.test(value)) invalid(); return value.toLowerCase(); };
const unique = values => { if (new Set(values).size !== values.length) invalid(); return values; };
function ids(value) { if (!Array.isArray(value)) invalid(); return unique(value.map(id)); }
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
export async function readRecommendationInput(request, { composition = false } = {}) {
  let raw;
  try { raw = await readJSON(request, recommendationLimits.requestBytes); }
  catch (error) { if (error instanceof RequestError && error.status === 413) throw new RequestError(413, 'request_too_large'); throw error; }
  fields(raw, ['requestId', 'snapshotId', 'orderedSlots', 'pinnedSlotIds', 'excludedItemIds', 'items', ...(composition ? ['mode'] : ['targetSlotId', 'intent'])]);
  const mode = composition ? raw.mode : null;
  if (composition && !['fillEmpty', 'rebuild'].includes(mode)) invalid();
  const intent = composition ? null : raw.intent ?? 'complement';
  if (!composition && !['complement', 'similar'].includes(intent)) invalid();
  const requestId = id(raw.requestId), snapshotId = id(raw.snapshotId), targetSlotId = composition ? null : id(raw.targetSlotId);
  if (!Array.isArray(raw.items) || !Array.isArray(raw.orderedSlots) || !raw.orderedSlots.length) invalid();
  if (raw.orderedSlots.length > 33) throw new RequestError(400, 'context_too_large');
  if (raw.items.length > recommendationLimits.items) throw new RequestError(400, 'too_many_items');
  const items = raw.items.map(item => {
    fields(item, ['itemId', 'publishedVersionId', 'photoVersionId', 'sourceSetVersionId', 'features', 'representationJSON', 'representationSHA256', 'effectiveFeatures']);
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
    if ((!result.itemId && result.publishedVersionId) || (result.itemId && !result.publishedVersionId && !composition && result.slotId !== targetSlotId)) invalid();
    return result;
  });
  unique(orderedSlots.map(slot => slot.slotId));
  const target = orderedSlots.find(slot => slot.slotId === targetSlotId); if (!composition && !target) invalid();
  for (const zone of ['head', 'bottom', 'shoes']) if (orderedSlots.filter(slot => slot.zone === zone).length > 1) invalid();
  const pinnedSlotIds = ids(raw.pinnedSlotIds), excludedItemIds = ids(raw.excludedItemIds);
  const slotIds = new Set(orderedSlots.map(slot => slot.slotId));
  if (pinnedSlotIds.some(value => !slotIds.has(value))) invalid();
  const byId = new Map(items.map(item => [item.itemId, item]));
  for (const slot of orderedSlots) {
    if (!slot.itemId) continue;
    const item = byId.get(slot.itemId);
    if (!item && !composition && slot.slotId !== targetSlotId) throw new RequestError(400, 'invalid_prepared_item');
    if (item && item.publishedVersionId !== slot.publishedVersionId) invalid();
  }
  return { requestId, snapshotId, targetSlotId, orderedSlots, pinnedSlotIds, excludedItemIds, items, target, intent, mode };
}

