// External Jev protocol fixture: independent of the backend provider implementation.
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
const taxonomy = JSON.parse(readFileSync(new URL('../../../shared/wardrobe-taxonomy.json', import.meta.url)));
const suitability = ['suitable', 'on_person', 'multiple_items', 'no_item', 'unclear'];
export function jevAnswer({ reason = 'suitable', type = 'shirt', colors = { red: 0.98 }, confidence = 0.95 } = {}) {
  const choice = (selected, options, certainty) => ({ type: 'choice', choice: selected, confidence: certainty,
    probabilities: Object.fromEntries(options.map(id => [id, id === selected ? 1 : 0])) });
  return { model: 'jev-1.14.0', answers: {
    suitability: choice(reason, suitability, 0.95),
    item_type: choice(type, taxonomy.types.map(item => item.id), confidence),
    ...Object.fromEntries(taxonomy.colors.map(color => [`color_${color.id}`, { type: 'noul', noul: colors[color.id] ?? 0.01 }])),
  }, usage: { input_tokens: 1000, output_tokens: 100 } };
}
export async function validateJevRequest(request, body, key) {
  if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${key}`
    || request.headers['typesafe-danger-zone-images'] !== 'true') throw new Error('Invalid Jev headers');
  const payload = JSON.parse(body);
  if (payload.model !== 'jev-1.14.0' || typeof payload.state?.photo !== 'string'
    || Object.keys(payload.assets || {}).length !== 1) throw new Error('Invalid Jev image reference');
  const asset = payload.assets[payload.state.photo];
  if (asset?.type !== 'image' || asset.format !== 'png' || typeof asset.data_base64 !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.data_base64)) throw new Error('Invalid Jev asset');
  const image = await sharp(Buffer.from(asset.data_base64, 'base64')).metadata();
  if (image.format !== 'png' || image.width < 280 || image.height < 280 || image.width > 1568 || image.height > 1568
    || image.width * image.height < 78400 || (image.pages || 1) !== 1) throw new Error('Invalid Jev dimensions');
  for (const [id, options] of [['suitability', suitability], ['item_type', taxonomy.types.map(item => item.id)]]) {
    const question = payload.questions?.[id];
    if (question?.type !== 'choice' || typeof question.instructions !== 'string'
      || JSON.stringify(Object.keys(question.criteria).sort()) !== JSON.stringify(options.toSorted())) throw new Error('Invalid Jev Choice');
  }
  for (const color of taxonomy.colors) {
    const question = payload.questions?.[`color_${color.id}`];
    if (question?.type !== 'noul' || typeof question.instructions !== 'string' || !question.instructions.includes(color.description)) throw new Error('Invalid Jev Noul');
  }
  if (Object.keys(payload.questions).length !== 16) throw new Error('Unexpected Jev questions');
  return payload;
}
