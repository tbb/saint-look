// Test-only transport fault proxy. It never accepts a non-loopback upstream.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const upstream = new URL(process.env.SAINT_LOOK_UI_PROXY_UPSTREAM || 'http://127.0.0.1:8787');
const controlToken = process.env.SAINT_LOOK_UI_TEST_CONTROL_TOKEN || 'saint-look-ui-control-test-token-00000001';
if (process.env.NODE_ENV !== 'test' || upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1'
  || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
  throw new Error('UI proxy requires NODE_ENV=test and a loopback HTTP upstream.');
}
const health = await fetch(new URL('/health', upstream), { signal: AbortSignal.timeout(5000), redirect: 'error' });
if (!health.ok || (await health.json()).mode !== 'demo') throw new Error('UI proxy requires a demo or controlled-provider backend.');
const clockFile = process.env.SAINT_LOOK_TEST_CLOCK_FILE;
const maximumClockOffset = 365 * 24 * 60 * 60 * 1000;
function readClockOffset() {
  const offset = JSON.parse(readFileSync(clockFile, 'utf8')).offsetMs;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximumClockOffset) throw new Error('Invalid test clock offset.');
  return offset;
}
if (clockFile) {
  if (!isAbsolute(clockFile)) throw new Error('Test clock requires an absolute path.');
  readClockOffset();
}
function updateClock(offsetMs) {
  const temporary = `${clockFile}.proxy-${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ offsetMs }), { mode: 0o600 });
  renameSync(temporary, clockFile);
}
let mode = 'online';
const acceptedOperations = new Set();
const deletedItems = new Set();
const acknowledgedOperations = new Set();
let forwardedAcknowledgements = 0;
let droppedAcknowledgementResponses = 0;
let lastOperationPath;
let forwardedDeletes = 0;
let droppedDeleteResponses = 0;
let forwardedUploads = 0;
let droppedUploadResponses = 0;
const heldResults = new Map();
function releaseResults() {
  for (const release of heldResults.values()) release();
}
async function holdResult(response) {
  await new Promise(resolve => {
    const release = () => {
      clearTimeout(timer);
      response.off('close', release);
      heldResults.delete(response);
      resolve();
    };
    const timer = setTimeout(release, 12000);
    timer.unref();
    heldResults.set(response, release);
    response.once('close', release);
  });
}
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
        if (!['online', 'offline', 'drop-next-upload-response', 'drop-next-delete-response', 'block-acks', 'drop-next-ack-response', 'accept-upload-then-offline', 'hold-next-result', 'legacy-attributes'].includes(input.mode)) return reply(response, 400, { error: 'invalid_mode' });
        let nextOffset;
        if (input.advanceTimeMs !== undefined) {
          if (!clockFile || !Number.isSafeInteger(input.advanceTimeMs) || input.advanceTimeMs < 0) {
            return reply(response, 400, { error: 'invalid_time_advance' });
          }
          nextOffset = (input.reset ? 0 : readClockOffset()) + input.advanceTimeMs;
          if (!Number.isSafeInteger(nextOffset) || nextOffset > maximumClockOffset) return reply(response, 400, { error: 'invalid_time_advance' });
        } else if (input.reset && clockFile) {
          nextOffset = 0;
        }
        if (nextOffset !== undefined) updateClock(nextOffset);
        mode = input.mode;
        if (mode !== 'hold-next-result' || input.reset) releaseResults();
        if (input.reset) { acceptedOperations.clear(); forwardedUploads = 0; droppedUploadResponses = 0; deletedItems.clear(); forwardedDeletes = 0; droppedDeleteResponses = 0; acknowledgedOperations.clear(); forwardedAcknowledgements = 0; droppedAcknowledgementResponses = 0; lastOperationPath = undefined; }
      } else if (request.method !== 'GET') return reply(response, 405, { error: 'method_not_allowed' });
      return reply(response, 200, { mode, acceptedOperations: acceptedOperations.size, forwardedUploads, droppedUploadResponses, heldResultResponses: heldResults.size, deletedItems: deletedItems.size, forwardedDeletes, droppedDeleteResponses, acknowledgedOperations: acknowledgedOperations.size, forwardedAcknowledgements, droppedAcknowledgementResponses, lastOperationPath, clockOffsetMs: clockFile ? readClockOffset() : undefined });
    }
    if (request.url !== '/health' && !request.url?.startsWith('/v1/items')) return reply(response, 404, { error: 'not_found' });
    if (mode === 'offline') { request.socket.destroy(); return; }
    const body = await readBody(request, 8 * 1024 * 1024);
    const isUpload = request.method === 'POST' && (request.url === '/v1/items' || /^\/v1\/items\/[^/]+\/attempts$/.test(request.url));
    const isAcknowledgement = request.method === 'POST' && /^\/v1\/items\/[^/]+\/operations\/[^/]+\/ack$/.test(request.url);
    if (isAcknowledgement && mode === 'block-acks') { request.socket.destroy(); return; }
    if (isAcknowledgement) forwardedAcknowledgements++;
    const shouldDropAcknowledgement = isAcknowledgement && mode === 'drop-next-ack-response';
    const isDelete = request.method === 'DELETE' && /^\/v1\/items\/[^/]+$/.test(request.url);
    if (isDelete) forwardedDeletes++;
    const shouldDropDelete = isDelete && mode === 'drop-next-delete-response';
    const shouldDisconnectAfterUpload = isUpload && mode === 'accept-upload-then-offline';
    const shouldDrop = isUpload && mode === 'drop-next-upload-response';
    const shouldHold = request.method === 'GET' && /^\/v1\/items\/[^/]+(?:\/operations\/[^/]+)?\/result$/.test(request.url) && mode === 'hold-next-result';
    if (shouldDrop || shouldDropDelete || shouldDropAcknowledgement || shouldHold) mode = 'online';
    if (isUpload) forwardedUploads++;
    const result = await fetch(new URL(request.url, upstream), {
      method: request.method,
      headers: { 'Content-Type': request.headers['content-type'] || 'application/json', Authorization: request.headers.authorization || '' },
      body: body.length ? body : undefined,
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    let data = Buffer.from(await result.arrayBuffer());
    if (mode === 'legacy-attributes' && result.ok
      && result.headers.get('content-type')?.includes('application/json')) {
      const payload = JSON.parse(data);
      if (payload.status === 'ready') {
        // Public response shape used by older releases before the finite taxonomy.
        payload.type = 'Накидка';
        payload.colors = ['Сиреневый'];
        data = Buffer.from(JSON.stringify(payload));
      }
    }
    if (isDelete && result.status === 204) deletedItems.add(request.url);
    if (isUpload && result.ok) {
      const accepted = JSON.parse(data);
      acceptedOperations.add(accepted.operationId);
      lastOperationPath = `/v1/items/${accepted.itemId}/operations/${accepted.operationId}`;
    }
    if (shouldDisconnectAfterUpload && result.ok) { mode = 'offline'; request.socket.destroy(); return; }
    if (isAcknowledgement && result.status === 204) acknowledgedOperations.add(request.url);
    if (shouldDropAcknowledgement && result.status === 204) { droppedAcknowledgementResponses++; request.socket.destroy(); return; }
    if (shouldDropDelete && result.status === 204) { droppedDeleteResponses++; request.socket.destroy(); return; }
    if (shouldDrop) { droppedUploadResponses++; request.socket.destroy(); return; }
    if (shouldHold && result.ok) await holdResult(response);
    if (response.destroyed) return;
    response.writeHead(result.status, { 'Content-Type': result.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    response.end(data);
  } catch {
    if (!response.destroyed && !response.headersSent) reply(response, 502, { error: 'upstream_unavailable' });
  }
});
server.listen(Number(process.env.SAINT_LOOK_UI_PROXY_PORT || 8788), '127.0.0.1', () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
});
process.on('SIGTERM', () => { releaseResults(); server.close(); server.closeAllConnections(); });
