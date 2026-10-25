import { createServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { jevAnswer, validateJevRequest } from './jev.mjs';

export async function providerFixture(t, handlers = {}) {
  const calls = { attributes: [], cutout: [] };
  const cutout = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000ff' } }).png().toBuffer() }])
    .png().toBuffer();
  const attributes = jevAnswer();
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const stage = request.url === '/v1/systemone' ? 'attributes'
        : request.url === '/v1/segment' ? 'cutout' : null;
      if (!stage) { response.writeHead(404); response.end(); return; }
      calls[stage].push({ headers: request.headers, body });
      if (stage === 'attributes') await validateJevRequest(request, body, 'fixture-typesafe-key');
      if (handlers[stage]) { await handlers[stage](request, response, { body, cutout, attributes }); return; }
      if (stage === 'attributes') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(attributes));
      } else {
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(cutout);
      }
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {
    calls, cutout,
    env: { NODE_ENV: 'test', SAINT_LOOK_PROVIDER: 'live',
      SAINT_LOOK_TEST_PROVIDER_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      TYPESAFE_API_KEY: 'fixture-typesafe-key', PHOTOROOM_API_KEY: 'fixture-photoroom-key',
      SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED: 'true', SAINT_LOOK_PROVIDER_TIMEOUT_MS: '2000', SAINT_LOOK_STAGE_DELAY_MS: '0' },
  };
}
