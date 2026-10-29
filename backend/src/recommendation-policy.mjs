// Product constraints shared by recommendation strategies; never a taste model.
export const policyVersion = 'outfit-placement-v1';
const zones = {
  head: ['headwear'],
  body: ['t_shirt', 'polo', 'shirt', 'blouse', 'top', 'sweater', 'cardigan', 'sweatshirt', 'hoodie', 'vest', 'blazer', 'jacket', 'coat', 'raincoat'],
  bottom: ['jeans', 'trousers', 'shorts', 'skirt'],
  shoes: ['sneakers', 'shoes', 'boots', 'sandals', 'slippers'],
};
const ranks = [
  ['t_shirt', 'polo', 'shirt', 'blouse', 'top'],
  ['sweater', 'cardigan', 'sweatshirt', 'hoodie', 'vest'],
  ['blazer', 'jacket'], ['coat', 'raincoat'],
];
export const isZone = zone => Object.hasOwn(zones, zone);
export const accepts = (zone, item) => zones[zone]?.includes(item.features.type) === true;
export function layerConflict(slots, items) {
  let previous = null;
  for (const slot of slots) {
    if (slot.zone !== 'body' || !slot.itemId) continue;
    const rank = ranks.findIndex(types => types.includes(items.get(slot.itemId)?.features.type));
    if (rank < 0) return [slot.slotId];
    if (previous && previous.rank > rank) return [previous.slotId, slot.slotId];
    previous = { rank, slotId: slot.slotId };
  }
  return [];
}
