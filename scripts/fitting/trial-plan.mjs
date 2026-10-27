import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { jevModel } from '../../backend/src/jev.mjs';
export const sharp = createRequire(new URL('../../backend/package.json', import.meta.url))('sharp');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const rates = Object.freeze({ preparation: 0, attributes: 2753, generation: 150000, segmentation: 0 });
export const models = Object.freeze({ generation: 'fal-ai/nano-banana-pro/edit', preparation: 'photoroom-sandbox/v1/segment', segmentation: 'photoroom-sandbox/v1/segment', attributes: 'jev-1.14.0' });
const identifier = x => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(x);

export async function loadPlan(path) {
  const raw = await readFile(path), plan = JSON.parse(raw), base = dirname(resolve(path));
  if (jevModel !== models.attributes || plan.version !== 1 || plan.pipelineVersion !== 'photoroom-first-v2' || plan.candidateEndpoint !== models.generation || plan.requiresSegmentation !== true || plan.preparationEndpoint !== models.preparation || plan.segmentationEndpoint !== models.segmentation
    || !Object.keys(rates).every(k => plan.ratesMicrousd?.[k] === rates[k])
    || !Array.isArray(plan.items) || !plan.items.length || plan.items.length > 10
    || new Set(plan.items.map(x => x.id)).size !== plan.items.length
    || typeof plan.seed !== 'string' || !plan.seed || typeof plan.templateVersion !== 'string') throw new Error('Unsupported trial plan');
  if (plan.items.reduce((sum, item) => sum + (item.photos?.length || 0), 0) > 12
    || !Array.isArray(plan.combinations) || plan.combinations.length > 10
    || !plan.combinations.every(c => identifier(c.id) && Array.isArray(c.items) && c.items.length >= 1
      && c.items.length <= 8 && c.items.every(id => plan.items.some(item => item.id === id)))) throw new Error('Invalid bounded dataset/combinations');
  const photos = new Map(), inputs = [], hashes = [];
  for (const item of plan.items) {
    if (!identifier(item.id) || !['head', 'top', 'bottom', 'shoes'].includes(item.category)
      || !Array.isArray(item.photos) || !item.photos.length || item.photos.length > 3
      || !Array.isArray(item.photoRoles) || item.photoRoles.length !== item.photos.length
      || !item.photoRoles.every(r => ['front', 'front-open', 'front-closed', 'back', 'detail', 'unspecified-detail', 'pair-three-quarter'].includes(r))) throw new Error('Invalid item or photo roles');
    const images = [];
    for (const file of item.photos) {
      const bytes = await readFile(resolve(base, file));
      const source = item.sources?.find(s => s.path === file);
      if (!source?.sha256 || !source.source || !source.author || !source.license || sha256(bytes) !== source.sha256) throw new Error('Source provenance/hash mismatch');
      if (bytes.length > 5 * 1024 * 1024) throw new Error('Source exceeds 5 MiB');
      const metadata = await sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'error' }).metadata();
      if (!['png', 'jpeg'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error('Source must be one PNG/JPEG image');
      // Decode before a paid operation, including corrupt-tail detection.
      await sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'error' }).raw().toBuffer();
      images.push(bytes); hashes.push({ itemId: item.id, path: file, sha256: source.sha256 });
    }
    photos.set(item.id, images);
    inputs.push({ item, input: 'single', photos: images.slice(0, 1), roles: item.photoRoles.slice(0, 1) });
    if (images.length > 1) inputs.push({ item, input: 'multi', photos: images, roles: item.photoRoles });
  }
  const template = await readFile(resolve(base, plan.template));
  if (template.length > 1024 * 1024) throw new Error('Template too large');
  const templatePng = await sharp(template, { limitInputPixels: 16_000_000, failOn: 'error' })
    .resize({ width: 1024, height: 1024, fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).png().toBuffer();
  const runtimeFiles = ['trial.mjs', 'trial-plan.mjs', 'trial-http.mjs', 'trial-ledger.mjs', 'trial-photoroom.mjs', 'trial-jev.mjs', 'trial-report.mjs', '../../backend/src/jev.mjs', '../../backend/package-lock.json', '../../shared/wardrobe-taxonomy.json'];
  const runtimeSha256 = sha256(JSON.stringify(await Promise.all(runtimeFiles.map(async file => [file, sha256(await readFile(new URL(file, import.meta.url)))]))));
  const planSha256 = sha256(JSON.stringify({ runtimeSha256, rawSha256: sha256(raw), hashes, templateSha256: sha256(template), runnerVersion: 'fitting-trial-v2-photoroom-sandbox', frameVersion: 'square-letterbox-1024-v1', renderedTemplateSha256: sha256(templatePng) }));
  const forecast = { preparation: new Set(hashes.map(h => h.sha256)).size, attributes: inputs.length, generation: inputs.length * 2, segmentation: inputs.length * 2 };
  return { plan, planSha256, runtimeSha256, photos, inputs, templatePng, templateSha256: sha256(template), hashes,
    forecast, reservedMicrousd: Object.keys(rates).reduce((sum, k) => sum + rates[k] * forecast[k], 0) };
}
