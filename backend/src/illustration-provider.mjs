import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { exchange, ProviderError } from './providers.mjs';
import { featureRequest, featureAnswer } from './illustration-features.mjs';

export const illustrationVersions = Object.freeze({ modelVersion: 'fal-ai/nano-banana-pro/edit',
  templateVersion: 'front-360x560-proposed-v1', geometryVersion: 'fitting-square-1024-v1' });
export const illustrationTaxonomy = JSON.parse(readFileSync(new URL('../../shared/wardrobe-taxonomy.json', import.meta.url)));
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const dataURI = image => `data:image/png;base64,${image.toString('base64')}`;

async function decode(bytes, { width, height, requireAlpha = false } = {}) {
  try {
    if (!bytes.subarray(0, 8).equals(pngHeader)) throw new Error();
    const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if ((metadata.pages || 1) !== 1 || (width && metadata.width !== width) || (height && metadata.height !== height)) throw new Error();
    const stats = await image.stats();
    const alpha = metadata.hasAlpha && stats.channels.at(-1);
    const usableAlpha = Boolean(alpha && alpha.min < 255 && alpha.max > 0);
    if (requireAlpha && !usableAlpha) throw new Error();
    const png = await image.png().toBuffer();
    if (png.length > 10 * 1024 * 1024) throw new Error();
    return { png, usableAlpha };
  } catch { throw new ProviderError('invalid_provider_response'); }
}

export function createIllustrationProvider(env) {
  const origin = env.SAINT_LOOK_ILLUSTRATION_TEST_ORIGIN;
  const timeout = Number(env.SAINT_LOOK_ILLUSTRATION_TIMEOUT_MS || 60000);
  const pollMs = Number(env.SAINT_LOOK_ILLUSTRATION_POLL_MS || 1500);
  let configured = env.SAINT_LOOK_ILLUSTRATIONS_ENABLED === 'true';
  const key = env.PHOTOROOM_SANDBOX_API_KEY;
  if (!key?.startsWith('sandbox_') || !env.TYPESAFE_API_KEY?.trim() || !env.FAL_KEY?.trim()
    || !Number.isInteger(timeout) || timeout < 50 || timeout > 120000
    || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 10000) configured = false;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { configured = false; }
    if (env.NODE_ENV !== 'test' || parsed?.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed?.hostname)
      || parsed?.username || parsed?.password || parsed?.pathname !== '/' || parsed?.search || parsed?.hash) configured = false;
  } else if (env.NODE_ENV === 'test') configured = false;
  const cutoutURL = `${origin || 'https://sdk.photoroom.com'}/v1/segment`;
  const jevURL = `${origin || 'https://api.typesafe.ai'}/v1/systemone`;
  const falOrigin = origin || 'https://queue.fal.run';
  const headers = { Authorization: `Key ${env.FAL_KEY}`, 'Content-Type': 'application/json', 'X-Fal-No-Retry': '1',
    'x-app-fal-disable-fallback': 'true', 'X-Fal-Store-IO': '0',
    'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: 3600 }), 'X-Fal-Request-Start-Timeout': '120' };
  async function json(url, options, signal) {
    const body = await exchange(url, options, signal, timeout, 256 * 1024);
    try { return JSON.parse(body); } catch { throw new ProviderError('invalid_provider_response'); }
  }
  function ensureConfigured() { if (!configured) throw new ProviderError('illustration_unavailable'); }
  return {
    mode: origin ? 'test' : 'live',
    async available() {
      if (!configured) return false;
      if (env.SAINT_LOOK_ILLUSTRATION_TEST_CONTROLLED === 'true') {
        if (!origin) return false;
        try { return (await json(`${origin}/health`, {}, new AbortController().signal)).illustrationAvailable === true; }
        catch { return false; }
      }
      return true;
    },
    async prepare(source, signal, stage = 'preparation') {
      ensureConfigured();
      const { width, height } = await sharp(source).metadata();
      const body = new FormData();
      body.set('image_file', new Blob([source], { type: 'image/png' }), `${stage}.png`);
      for (const [name, value] of Object.entries({ channels: 'rgba', size: 'full', crop: 'false', format: 'png', despill: 'false' })) body.set(name, value);
      const bytes = await exchange(cutoutURL, { method: 'POST', headers: { 'x-api-key': key }, body }, signal, timeout, 10 * 1024 * 1024);
      return (await decode(bytes, { width, height, requireAlpha: true })).png;
    },
    async attributes(photos, signal) {
      ensureConfigured();
      const request = await featureRequest(photos.flatMap(photo => [photo.prepared, photo.source]),
        photos.flatMap(photo => [`prepared_${photo.role}`, `original_${photo.role}`]));
      const answer = await json(jevURL, { method: 'POST', headers: { 'Content-Type': 'application/json',
        Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'TypeSafe-Danger-Zone-Images': 'true' }, body: JSON.stringify(request) }, signal);
      try {
        const parsed = featureAnswer(answer, request), { item_type, colors = [], ...traits } = parsed.features;
        return { version: parsed.version, type: illustrationTaxonomy.types.find(type => type.id === item_type)?.label || 'Не определён',
          colors: colors.map(id => illustrationTaxonomy.colors.find(color => color.id === id).label), traits };
      } catch (error) { throw new ProviderError(error.message === 'JEV item suitability not confirmed' ? 'photo_unclear' : 'invalid_provider_response'); }
    },
    async generate(photos, features, signal, recordReceipt, savedReceipt) {
      ensureConfigured();
      let requestId = savedReceipt;
      if (!requestId) {
        const template = await sharp(new URL('./fitting-mannequin.svg', import.meta.url).pathname)
          .resize(1024, 1024, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
        const prompt = `Create a faithful restrained editorial illustration of ONLY ONE garment. Image pairs: ${photos.map(p => `original_${p.role}, prepared_${p.role}`).join('; ')}. LAST image is a common mannequin pose/style reference, not the item. Ignore PHOTOROOM sandbox watermarks; use originals as detail and color references. Never reproduce processing watermarks. Preserve garment silhouette, proportions, color, construction and prints. Do not invent text, brands, bodies, underlayers, or move back prints to the front. Render FRONT view on the full 1024 square canvas aligned to the reference shoulders, waist and feet; preserve white letterbox margins. Never independently crop, center or stretch garment. Use a plain white background. Effective features (manual type/colors take precedence): ${JSON.stringify(features)}`;
        const payload = { prompt, image_urls: [...photos.flatMap(photo => [dataURI(photo.source), dataURI(photo.prepared)]), dataURI(template)],
          num_images: 1, aspect_ratio: '1:1', output_format: 'png', resolution: '1K', limit_generations: true, enable_web_search: false };
        if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024 * 1024) throw new ProviderError('image_too_large');
        let receipt;
        try { receipt = await json(`${falOrigin}/${illustrationVersions.modelVersion}`, { method: 'POST', headers, body: JSON.stringify(payload) }, signal); }
        catch (error) {
          // A successful but undecodable receipt may already own a paid job.
          if (error.code === 'invalid_provider_response') throw new ProviderError('processing_unknown', true);
          throw error;
        }
        if (typeof receipt.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.request_id)) throw new ProviderError('processing_unknown', true);
        requestId = receipt.request_id;
        recordReceipt(requestId);
      }
      const base = `${falOrigin}/fal-ai/nano-banana-pro/requests/${requestId}`;
      let provenFailure = false;
      try {
      for (let poll = 0; poll < 120; poll++) {
        const state = await json(`${base}/status`, { headers }, signal);
        if (state.status === 'COMPLETED') {
          if (state.error || state.error_type) { provenFailure = true; throw new ProviderError('provider_rejected'); }
          const output = await json(base, { headers }, signal);
          let url;
          try {
            if (!Array.isArray(output.images) || output.images.length !== 1) throw new Error();
            url = new URL(output.images[0].url);
            const allowed = origin ? url.origin === origin : url.protocol === 'https:' && (url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'));
            if (!allowed || url.username || url.password || url.hash) throw new Error();
          } catch { throw new ProviderError('invalid_provider_response'); }
          const bytes = await exchange(url, {}, signal, timeout, 10 * 1024 * 1024);
          return decode(bytes, { width: 1024, height: 1024 });
        }
        if (!['IN_QUEUE', 'IN_PROGRESS'].includes(state.status)) throw new ProviderError('processing_unknown', true);
        await pause(pollMs, undefined, { signal });
      }
      throw new ProviderError('processing_unknown', true);
      } catch (error) {
        // Retrieval authentication, quota, corrupt payload or network failure
        // says nothing about whether an accepted generation finished and billed.
        if (provenFailure) throw error;
        throw new ProviderError('processing_unknown', true);
      }
    },
  };
}
