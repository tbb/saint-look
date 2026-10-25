import sharp from 'sharp';
import { demoResult } from './demo-provider.mjs';
import { jevRequest, jevAttributes, providerConfig } from './jev.mjs';

export class ProviderError extends Error {
  constructor(code, unknown = false) { super(code); this.code = code; this.unknown = unknown; }
}

function checkResponse(response) {
  if (response.ok) return;
  // Never retain or log provider bodies: they can include credentials or photo details.
  void response.body?.cancel().catch(() => {});
  if ([402, 429].includes(response.status)) throw new ProviderError('provider_quota_exceeded');
  if ([401, 403].includes(response.status)) throw new ProviderError('provider_unauthorized');
  if (response.status >= 500) throw new ProviderError('processing_unknown', true);
  throw new ProviderError('provider_rejected');
}

async function exchange(url, options, signal, timeout, limit) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    checkResponse(response);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new ProviderError('invalid_provider_response');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Fetch/timeout/body interruption may happen after acceptance; never guess it was free.
    throw new ProviderError('processing_unknown', true);
  }
}

export function createProviders(env) {
  if (env.SAINT_LOOK_PROVIDER === 'demo') return {
    id: 'demo', mode: 'demo', preflight() {},
    async attributes() {
      if (env.SAINT_LOOK_DEMO_OUTCOME === 'fail') throw new ProviderError('processing_failed');
      return { type: 'Футболка', colors: ['Синий'] };
    },
    async cutout() { return (await demoResult()).image; },
  };
  const testOrigin = env.SAINT_LOOK_TEST_PROVIDER_ORIGIN;
  const timeout = Number(env.SAINT_LOOK_PROVIDER_TIMEOUT_MS || 60000);
  const attributesURL = `${testOrigin || 'https://api.typesafe.ai'}/v1/systemone`;
  const cutoutURL = `${testOrigin || 'https://sdk.photoroom.com'}/v1/segment`;
  return {
    id: `${testOrigin ? 'live-test' : 'live'}-${providerConfig}`, mode: testOrigin ? 'demo' : 'live',
    preflight(source) {
      if (source.length > 5 * 1024 * 1024) throw new ProviderError('image_too_large');
      if (!Number.isInteger(timeout) || timeout < 50 || timeout > 120000) throw new ProviderError('provider_not_configured');
      if (!env.TYPESAFE_API_KEY?.trim() || !env.PHOTOROOM_API_KEY?.trim()) throw new ProviderError('provider_not_configured');
      if (env.NODE_ENV === 'test' && !testOrigin) throw new ProviderError('provider_not_configured');
      if (testOrigin) {
        let origin;
        try { origin = new URL(testOrigin); } catch { throw new ProviderError('provider_not_configured'); }
        if (env.NODE_ENV !== 'test' || origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)
          || origin.username || origin.password || origin.search || origin.hash || (origin.pathname !== '/' && origin.pathname !== '')) {
          throw new ProviderError('provider_not_configured');
        }
      }
      if (env.SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED !== 'true') throw new ProviderError('provider_preflight_required');
    },
    async attributes(source, signal) {
      const request = await jevRequest(source);
      const bytes = await exchange(attributesURL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'TypeSafe-Danger-Zone-Images': 'true' },
        body: JSON.stringify(request),
      }, signal, timeout, 64 * 1024);
      try { return jevAttributes(JSON.parse(bytes.toString('utf8'))); }
      catch (error) {
        const reasons = ['photo_on_person', 'photo_multiple_items', 'photo_no_item', 'photo_unclear'];
        throw new ProviderError(reasons.includes(error.message) ? error.message : 'invalid_provider_response');
      }
    },
    async cutout(source, signal) {
      const body = new FormData();
      body.set('image_file', new Blob([source], { type: 'image/png' }), 'item.png');
      body.set('format', 'png'); body.set('despill', 'false');
      const bytes = await exchange(cutoutURL, { method: 'POST', headers: { 'x-api-key': env.PHOTOROOM_API_KEY }, body }, signal, timeout, 10 * 1024 * 1024);
      try {
        if (bytes.length > 10 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG');
        const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
        const metadata = await image.metadata();
        if (!metadata.hasAlpha || (metadata.pages || 1) !== 1) throw new Error('Missing alpha');
        const { channels } = await image.stats();
        const alpha = channels[channels.length - 1];
        if (alpha.min === 255 || alpha.max === 0) throw new Error('No usable cutout');
        const normalized = await image.png().toBuffer();
        if (normalized.length > 10 * 1024 * 1024) throw new Error('Oversized result');
        return normalized;
      } catch { throw new ProviderError('invalid_provider_response'); }
    },
  };
}
