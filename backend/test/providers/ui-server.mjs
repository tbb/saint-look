// Controlled external HTTP providers for Simulator tests; never used by production.
import { createServer } from 'node:http';
import sharp from 'sharp';
import { demoResult } from '../../src/demo-provider.mjs';

if (process.env.NODE_ENV !== 'test') throw new Error('UI providers require NODE_ENV=test.');
const token = process.env.SAINT_LOOK_UI_PROVIDER_CONTROL_TOKEN || 'saint-look-ui-provider-control-token-00000001';
const blue = (await demoResult()).image;
const red = await sharp(blue).tint({ r: 210, g: 40, b: 45 }).png().toBuffer();
let attributesCalls = 0;
let cutoutCalls = 0;
let nextAttributes = null;
let nextCutout = null;
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
    if (request.method === 'GET' && request.url === '/health') return reply(response, 200, { status: 'ok' });
    if (request.url === '/__control') {
      if (request.headers.authorization !== `Bearer ${token}`) return reply(response, 401, { error: 'unauthorized' });
      if (request.method === 'POST') {
        const input = JSON.parse((await bodyOf(request, 1024)).toString());
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['reset', 'nextAttributes', 'nextCutout'].includes(key))
          || ('reset' in input && typeof input.reset !== 'boolean')
          || ('nextAttributes' in input && ![null, 'photo_on_person', 'photo_multiple_items'].includes(input.nextAttributes))
          || ('nextCutout' in input && ![null, 'provider_quota_exceeded', 'red'].includes(input.nextCutout))) {
          return reply(response, 400, { error: 'invalid_control' });
        }
        if (input.reset) { attributesCalls = 0; cutoutCalls = 0; nextAttributes = null; nextCutout = null; }
        if ('nextAttributes' in input) nextAttributes = input.nextAttributes;
        if ('nextCutout' in input) nextCutout = input.nextCutout;
      } else if (request.method !== 'GET') return reply(response, 405, { error: 'method_not_allowed' });
      return reply(response, 200, { attributesCalls, cutoutCalls });
    }
    if (request.method !== 'POST') return reply(response, 404, { error: 'not_found' });
    await bodyOf(request, 8 * 1024 * 1024);
    if (request.url === '/v1beta/models/gemini-3.1-flash-lite:generateContent') {
      attributesCalls++;
      const reason = nextAttributes;
      nextAttributes = null;
      const attributes = reason
        ? { suitable: false, reason: reason === 'photo_on_person' ? 'on_person' : 'multiple_items', type: null, colors: [] }
        : { suitable: true, reason: null, type: 'Футболка', colors: ['Синий'] };
      return reply(response, 200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(attributes) }] } }] });
    }
    if (request.url === '/v1/segment') {
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
