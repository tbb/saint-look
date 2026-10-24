// Test-only transport fault proxy. It never accepts a non-loopback upstream.
import { createServer } from 'node:http';

const upstream = new URL(process.env.SAINT_LOOK_UI_PROXY_UPSTREAM || 'http://127.0.0.1:8787');
const controlToken = process.env.SAINT_LOOK_UI_TEST_CONTROL_TOKEN || 'saint-look-ui-control-test-token-00000001';
if (process.env.NODE_ENV !== 'test' || upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1'
  || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
  throw new Error('UI proxy requires NODE_ENV=test and a loopback HTTP upstream.');
}
const health = await fetch(new URL('/health', upstream), { signal: AbortSignal.timeout(5000), redirect: 'error' });
if (!health.ok || (await health.json()).mode !== 'demo') throw new Error('UI proxy requires a demo or controlled-provider backend.');
let mode = 'online';
const acceptedOperations = new Set();
let forwardedUploads = 0;
let droppedUploadResponses = 0;
function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/__control') {
      if (request.headers.authorization !== `Bearer ${controlToken}`) return reply(response, 401, { error: 'unauthorized' });
      if (request.method === 'POST') {
        const input = JSON.parse((await readBody(request, 1024)).toString());
        if (!['online', 'offline', 'drop-next-upload-response'].includes(input.mode)) return reply(response, 400, { error: 'invalid_mode' });
        mode = input.mode;
        if (input.reset) { acceptedOperations.clear(); forwardedUploads = 0; droppedUploadResponses = 0; }
      } else if (request.method !== 'GET') return reply(response, 405, { error: 'method_not_allowed' });
      return reply(response, 200, { mode, acceptedOperations: acceptedOperations.size, forwardedUploads, droppedUploadResponses });
    }
    if (request.url !== '/health' && !request.url?.startsWith('/v1/items')) return reply(response, 404, { error: 'not_found' });
    if (mode === 'offline') { request.socket.destroy(); return; }
    const body = await readBody(request, 8 * 1024 * 1024);
    const isUpload = request.method === 'POST' && request.url === '/v1/items';
    const shouldDrop = isUpload && mode === 'drop-next-upload-response';
    if (shouldDrop) mode = 'online';
    if (isUpload) forwardedUploads++;
    const result = await fetch(new URL(request.url, upstream), {
      method: request.method,
      headers: { 'Content-Type': request.headers['content-type'] || 'application/json', Authorization: request.headers.authorization || '' },
      body: body.length ? body : undefined,
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    const data = Buffer.from(await result.arrayBuffer());
    if (isUpload && result.ok) acceptedOperations.add(JSON.parse(data).operationId);
    if (shouldDrop) { droppedUploadResponses++; request.socket.destroy(); return; }
    response.writeHead(result.status, { 'Content-Type': result.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    response.end(data);
  } catch {
    if (!response.destroyed && !response.headersSent) reply(response, 502, { error: 'upstream_unavailable' });
  }
});
server.listen(Number(process.env.SAINT_LOOK_UI_PROXY_PORT || 8788), '127.0.0.1', () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
});
process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); });
