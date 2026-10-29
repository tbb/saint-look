import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { RequestError } from './upload.mjs';
import { illustrationTaxonomy } from './illustration-provider.mjs';
import { observableChoices } from './illustration-features.mjs';

export const publicationProtocol = 'prepared-item-v1';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonicalJSON = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
export const featureDigest = value => sha256(canonicalJSON(value));
export function canonicalFeatures(features, labels = false) {
  const key = labels ? 'label' : 'id';
  const type = illustrationTaxonomy.types.find(entry => entry[key] === features?.type)?.id;
  const colors = Array.isArray(features?.colors) && features.colors.map(color => illustrationTaxonomy.colors.find(entry => entry[key] === color)?.id);
  if (!type || !colors || colors.length > 5 || colors.some(color => !color) || new Set(colors).size !== colors.length) throw new RequestError(400, 'invalid_features');
  return { type, colors: [...colors].sort() };
}
export function validateObserved(features) {
  canonicalFeatures(features, true);
  if (features.version !== 'fitting-observable-v2-photoroom-sandbox' || !features.traits
    || Object.keys(features.traits).length !== Object.keys(observableChoices).length
    || Object.entries(observableChoices).some(([name, values]) => !Object.hasOwn(values, features.traits[name]))) throw new RequestError(400, 'invalid_features');
  return features;
}
export function canonicalText(features) {
  const { type, colors } = canonicalFeatures(features);
  return type.replaceAll('_', ' ') + (colors.length ? '. Colors: ' + colors.join(', ') : '') + '.';
}
export async function readJSON(request, limit) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new RequestError(415, 'unsupported_content_type');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { request.resume(); throw new RequestError(413, 'image_too_large'); }
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new RequestError(400, 'invalid_request'); }
}
export async function decodePNG(base64, maxBytes, dimensions) {
  if (typeof base64 !== 'string' || !base64.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new RequestError(400, 'invalid_image');
  const raw = Buffer.from(base64, 'base64');
  if (raw.length > maxBytes) throw new RequestError(413, 'image_too_large');
  try {
    const image = sharp(raw, { limitInputPixels: 16_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || (metadata.pages || 1) !== 1 || (dimensions && (metadata.width !== dimensions || metadata.height !== dimensions))) throw new Error();
    const normalized = await image.rotate().png().toBuffer();
    if (normalized.length > maxBytes) throw new Error();
    return { raw, normalized, metadata };
  } catch { throw new RequestError(400, 'invalid_image'); }
}
