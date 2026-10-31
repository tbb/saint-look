import { createServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { modelFixture } from './model.mjs';
import { createHash } from 'node:crypto';
import { garmentLayout } from '../../src/illustration-layout.mjs';

// The fixture implements external HTTP boundaries, never production fallback.
export async function illustrationFixture(t, handlers = {}) {
  const calls = { preparation: [], attributes: [], generation: [], recovery: [], finalization: [], model: [], rank: [] };
  const result = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 120, height: 160, channels: 4, background: '#dd3322ff' } }).png().toBuffer(), left: 452, top: 260 }]).png().toBuffer();
  const generated = await sharp(result).flatten({ background: '#ffffff' }).jpeg().toBuffer();
  const imageKey = async bytes => createHash('sha256').update(await sharp(bytes).ensureAlpha().raw().toBuffer()).digest('hex');
  const cutouts = new Map([[await imageKey(generated), result]]);
  let url;
  const interaction = { id: 'v1_fixture-1', model: 'gemini-3-pro-image', status: 'completed', steps: [{ type: 'model_output', content: [
    { type: 'image', mime_type: 'image/jpeg', data: generated.toString('base64') },
  ] }] };
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (await modelFixture(request, response, body, handlers, calls.model, calls.rank)) return;
      if (request.url === '/v1beta/interactions/v1_fixture-1') {
        calls.recovery.push({ headers: request.headers });
        if (handlers.recovery) { await handlers.recovery(request, response); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(interaction)); return;
      }
      if (request.url === '/result.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(handlers.opaque ? await sharp(result).flatten({ background: '#ffffff' }).png().toBuffer() : result); return;
      }
      const stage = request.url === '/v1/systemone' ? 'attributes' : request.url === '/v1beta/interactions' ? 'generation'
        : request.url === '/v1/segment' ? (body.includes(Buffer.from('finalization.png')) ? 'finalization' : 'preparation') : null;
      if (!stage) { response.writeHead(404); response.end(); return; }
      calls[stage].push({ body, headers: request.headers, path: request.url });
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
        if (handlers.generation) { await handlers.generation(request, response, { body, result, interaction }); return; }
        const request = JSON.parse(body);
        calls.generation.at(-1).interaction = request;
        const features = JSON.parse(request.input.at(-1).text.split('take precedence): ')[1]);
        let cutout = result;
        if (features.type !== 'Футболка') {
          const layout = garmentLayout(features);
          cutout = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-100 0 560 560"><path d="${layout.path}" fill="#dd3322"/></svg>`)).png().toBuffer();
        }
        const jpeg = await sharp(cutout).flatten({ background: '#ffffff' }).jpeg().toBuffer();
        cutouts.set(await imageKey(jpeg), cutout);
        const answer = { ...interaction, steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: jpeg.toString('base64') }] }] };
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(answer));
      } else if (stage === 'finalization') {
        const start = body.indexOf(Buffer.from('\x89PNG', 'latin1'));
        const end = body.indexOf(Buffer.from('\r\n--'), start);
        const cutout = cutouts.get(await imageKey(body.subarray(start, end)));
        if (!cutout) throw new Error('Unknown generated fixture');
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(cutout);
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
    PHOTOROOM_SANDBOX_API_KEY: 'sandbox_fixture', TYPESAFE_API_KEY: 'fixture', GEMINI_API_KEY: 'fixture',
    SAINT_LOOK_ILLUSTRATION_TIMEOUT_MS: '2000' } };
}
