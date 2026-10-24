import { demoResult } from './demo-provider.mjs';

export class ProviderError extends Error {
  constructor(code, unknown = false) { super(code); this.code = code; this.unknown = unknown; }
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
  const attributesURL = `${testOrigin || 'https://generativelanguage.googleapis.com'}/v1beta/models/gemini-3.1-flash-lite:generateContent`;
  const cutoutURL = `${testOrigin || 'https://sdk.photoroom.com'}/v1/segment`;
  return {
    id: testOrigin ? 'live-test' : 'live', mode: testOrigin ? 'demo' : 'live',
    preflight() {
      if (!env.GEMINI_API_KEY?.trim() || !env.PHOTOROOM_API_KEY?.trim()) throw new ProviderError('provider_not_configured');
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
      const response = await fetch(attributesURL, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [
          { text: 'Classify one standalone clothing item. Return suitable, reason, type and main colors in Russian. A pair of shoes is one item; separate garments in an outfit are multiple items. Reject people wearing clothes and ambiguous/multiple items.' },
          { inlineData: { mimeType: 'image/png', data: Buffer.from(source).toString('base64') } },
        ] }], generationConfig: { responseMimeType: 'application/json', responseJsonSchema: {
          type: 'object', properties: { suitable: { type: 'boolean' }, reason: { type: ['string', 'null'] }, type: { type: ['string', 'null'] }, colors: { type: 'array', items: { type: 'string' } } },
          required: ['suitable', 'reason', 'type', 'colors'], additionalProperties: false,
        } } }),
      });
      const payload = await response.json();
      const result = JSON.parse(payload.candidates[0].content.parts[0].text);
      return { type: result.type, colors: result.colors };
    },
    async cutout(source, signal) {
      const body = new FormData();
      body.set('image_file', new Blob([source], { type: 'image/png' }), 'item.png');
      body.set('format', 'png'); body.set('despill', 'false');
      const response = await fetch(cutoutURL, { method: 'POST', signal, headers: { 'x-api-key': env.PHOTOROOM_API_KEY }, body });
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
