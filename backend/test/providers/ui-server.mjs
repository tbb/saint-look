// Controlled external HTTP providers for Simulator and the isolated dev profile; never live AI.
import { createServer } from 'node:http';
import sharp from 'sharp';
import { modelFixture } from './model.mjs';
import { jevAnswer, validateJevRequest } from './jev.mjs';
import { demoResult } from '../../src/demo-provider.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('UI providers require NODE_ENV=test.');
const token = process.env.SAINT_LOOK_UI_PROVIDER_CONTROL_TOKEN || 'saint-look-ui-provider-control-token-00000001';
const blue = (await demoResult()).image;
const red = await sharp(blue).tint({ r: 210, g: 40, b: 45 }).png().toBuffer();
let attributesCalls = 0;
let cutoutCalls = 0;
let encoderPreparationCalls = 0, modelRankCalls = 0;
const modelCalls = { push() { encoderPreparationCalls++; } }, rankCalls = { push() { modelRankCalls++; } };
let nextAttributes = null;
let nextCutout = null;
let illustrationMode = null;
let illustrationPreparationCalls = 0, illustrationAttributesCalls = 0, illustrationGenerationCalls = 0, illustrationFinalizationCalls = 0;
const illustrationCutout = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
  .composite([{ input: await sharp(blue).resize(260, 300, { fit: 'contain', background: '#00000000' }).png().toBuffer(), left: 382, top: 250 }]).png().toBuffer();
const illustrationImage = await sharp(illustrationCutout).flatten({ background: '#ffffff' }).jpeg().toBuffer();
const illustrationInteraction = { id: 'v1_ui-fixture', model: 'gemini-3-pro-image', status: 'completed', steps: [{ type: 'model_output', content: [
  { type: 'image', mime_type: 'image/jpeg', data: illustrationImage.toString('base64') },
] }] };
function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function bodyOf(request, limit) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit) throw new Error('Request too large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return reply(response, 200, { status: 'ok', illustrationAvailable: illustrationMode !== null });
    if (request.url === '/__control') {
      if (request.headers.authorization !== `Bearer ${token}`) return reply(response, 401, { error: 'unauthorized' });
      if (request.method === 'POST') {
        const input = JSON.parse((await bodyOf(request, 1024)).toString());
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['reset', 'nextAttributes', 'nextCutout', 'illustrationMode'].includes(key))
          || ('reset' in input && typeof input.reset !== 'boolean')
          || ('nextAttributes' in input && ![null, 'photo_on_person', 'photo_multiple_items'].includes(input.nextAttributes))
          || ('nextCutout' in input && ![null, 'provider_quota_exceeded', 'red'].includes(input.nextCutout))
          || ('illustrationMode' in input && ![null, 'success', 'failed', 'unknown'].includes(input.illustrationMode))) {
          return reply(response, 400, { error: 'invalid_control' });
        }
        if (input.reset) { attributesCalls = 0; cutoutCalls = 0; nextAttributes = null; nextCutout = null; illustrationMode = null;
          illustrationPreparationCalls = 0; illustrationAttributesCalls = 0; illustrationGenerationCalls = 0; illustrationFinalizationCalls = 0; encoderPreparationCalls = 0; modelRankCalls = 0; }
        if ('nextAttributes' in input) nextAttributes = input.nextAttributes;
        if ('nextCutout' in input) nextCutout = input.nextCutout;
        if ('illustrationMode' in input) illustrationMode = input.illustrationMode;
      } else if (request.method !== 'GET') return reply(response, 405, { error: 'method_not_allowed' });
      return reply(response, 200, { attributesCalls, cutoutCalls, illustrationPreparationCalls, illustrationAttributesCalls, illustrationGenerationCalls, illustrationFinalizationCalls, encoderPreparationCalls, modelRankCalls });
    }
    if (request.method === 'GET' && request.url === '/v1beta/interactions/ui-fixture') return reply(response, 200, illustrationInteraction);
    if (request.method !== 'POST') return reply(response, 404, { error: 'not_found' });
    const body = await bodyOf(request, 16 * 1024 * 1024);
    if (await modelFixture(request, response, body, {}, modelCalls, rankCalls)) return;
    if (request.url === '/v1beta/interactions') {
      illustrationGenerationCalls++;
      if (illustrationMode === 'unknown') { response.destroy(); return; }
      if (illustrationMode === 'failed') return reply(response, 422, { error: 'fixture_generation_failed' });
      if (illustrationMode !== 'success') return reply(response, 503, { error: 'fixture_unavailable' });
      return reply(response, 200, illustrationInteraction);
    }
    if (request.url === '/v1/systemone') {
      const payload = JSON.parse(body);
      if (payload.questions?.silhouette) {
        illustrationAttributesCalls++;
        const answers = Object.fromEntries(Object.entries(payload.questions).map(([name, q]) => {
          if (q.type === 'noul') return [name, { type: 'noul', noul: name === 'color_blue' ? 0.99 : 0.01 }];
          const selected = name === 'suitability' ? 'suitable' : name === 'item_type' ? 't_shirt' : 'unknown';
          return [name, { type: 'choice', choice: selected, confidence: 1,
            probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === selected ? 1 : 0])) }];
        }));
        return reply(response, 200, { model: payload.model, answers, usage: { input_tokens: 1000 } });
      }
      const key = process.env.TYPESAFE_API_KEY || 'fixture-typesafe-key';
      if (!['fixture-typesafe-key', 'controlled-fixture-typesafe'].includes(key)) throw new Error('Only dummy provider credentials are allowed');
      await validateJevRequest(request, body, key);
      attributesCalls++;
      const reason = nextAttributes;
      nextAttributes = null;
      return reply(response, 200, jevAnswer({
        reason: reason === 'photo_on_person' ? 'on_person' : reason === 'photo_multiple_items' ? 'multiple_items' : 'suitable',
        type: 't_shirt', colors: { blue: 0.98 },
      }));
    }
    if (request.url === '/v1/segment') {
      if (body.includes(Buffer.from('filename="preparation.png"')) || body.includes(Buffer.from('filename="finalization.png"'))) {
        if (body.includes(Buffer.from('filename="finalization.png"'))) {
          illustrationFinalizationCalls++; response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(illustrationCutout);
        }
        illustrationPreparationCalls++;
        const start = body.indexOf(Buffer.from('\x89PNG', 'latin1')), end = body.indexOf(Buffer.from('\r\n--'), start);
        const { width, height } = await sharp(body.subarray(start, end)).metadata();
        const prepared = await sharp(blue).resize(width, height, { fit: 'contain', background: '#00000000' }).png().toBuffer();
        response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(prepared);
      }
      cutoutCalls++;
      const outcome = nextCutout;
      nextCutout = null;
      if (outcome === 'provider_quota_exceeded') return reply(response, 429, { error: 'test_quota_exceeded' });
      response.writeHead(200, { 'Content-Type': 'image/png' });
      return response.end(outcome === 'red' ? red : blue);
    }
    return reply(response, 404, { error: 'not_found' });
  } catch {
    if (!response.destroyed && !response.headersSent) reply(response, 400, { error: 'invalid_request' });
  }
});
server.listen(Number(process.env.SAINT_LOOK_UI_PROVIDER_PORT || 8789), '127.0.0.1', () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
});
process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); });
