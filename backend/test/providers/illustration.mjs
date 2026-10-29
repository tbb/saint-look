import { createServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { modelFixture } from './model.mjs';

// The fixture implements external HTTP boundaries, never production fallback.
export async function illustrationFixture(t, handlers = {}) {
  const calls = { preparation: [], attributes: [], generation: [], finalization: [], model: [], rank: [] };
  const result = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 120, height: 160, channels: 4, background: '#dd3322ff' } }).png().toBuffer(), left: 452, top: 260 }]).png().toBuffer();
  let url;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (await modelFixture(request, response, body, handlers, calls.model, calls.rank)) return;
      if (request.url === '/fal-ai/nano-banana-pro/requests/fixture-1/status') {
        if (handlers.status) { await handlers.status(request, response); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ status: 'COMPLETED' })); return;
      }
      if (request.url === '/fal-ai/nano-banana-pro/requests/fixture-1') {
        if (handlers.result) { await handlers.result(request, response); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ images: [{ url: `${url}/result.png` }] })); return;
      }
      if (request.url === '/result.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(handlers.opaque ? await sharp(result).flatten({ background: '#ffffff' }).png().toBuffer() : result); return;
      }
      const stage = request.url === '/v1/systemone' ? 'attributes' : request.url === '/fal-ai/nano-banana-pro/edit' ? 'generation'
        : request.url === '/v1/segment' ? (body.includes(Buffer.from('finalization.png')) ? 'finalization' : 'preparation') : null;
      if (!stage) { response.writeHead(404); response.end(); return; }
      calls[stage].push({ body, headers: request.headers });
      if (handlers[stage]) { await handlers[stage](request, response, { body, result }); return; }
      if (stage === 'attributes') {
        const payload = JSON.parse(body);
        const answers = Object.fromEntries(Object.entries(payload.questions).map(([name, q]) => {
          if (q.type === 'noul') return [name, { type: 'noul', noul: handlers.colors
            ? (handlers.colors[name.slice(6)] ?? 0.01) : name === 'color_red' ? 0.99 : 0.01 }];
          const selected = name === 'suitability' ? 'suitable' : name === 'item_type' ? 't_shirt' : 'unknown';
          return [name, { type: 'choice', choice: selected, confidence: 1,
            probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === selected ? 1 : 0])) }];
        }));
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ model: payload.model, answers, usage: { input_tokens: 1000 } }));
      } else if (stage === 'generation') {
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ request_id: 'fixture-1' }));
      } else if (stage === 'finalization') {
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(result);
      } else {
        const start = body.indexOf(Buffer.from('\x89PNG', 'latin1'));
        const end = body.indexOf(Buffer.from('\r\n--'), start);
        const source = body.subarray(start, end);
        const { width, height } = await sharp(source).metadata();
        const prepared = await sharp({ create: { width, height, channels: 4, background: '#00000000' } })
          .composite([{ input: await sharp({ create: { width: Math.max(1, width - 2), height: Math.max(1, height - 2), channels: 4, background: '#dd3322ff' } }).png().toBuffer(), left: 1, top: 1 }]).png().toBuffer();
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(prepared);
      }
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, result, env: { NODE_ENV: 'test', SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'true', SAINT_LOOK_ILLUSTRATION_TEST_ORIGIN: url,
    ...(!handlers.modelDisabled ? { SAINT_LOOK_TEST_MODEL_ORIGIN: url } : {}),
    PHOTOROOM_SANDBOX_API_KEY: 'sandbox_fixture', TYPESAFE_API_KEY: 'fixture', FAL_KEY: 'fixture',
    SAINT_LOOK_ILLUSTRATION_TIMEOUT_MS: '2000', SAINT_LOOK_ILLUSTRATION_POLL_MS: '1' } };
}
