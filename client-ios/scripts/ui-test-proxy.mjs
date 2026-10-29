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
let illustrationUploads = 0;
let preparedSourceDownloads = 0;
const illustrationOperations = new Set();
const illustrationAcknowledgements = new Set();
let lastIllustrationPath;
let droppedUploadResponses = 0;
// A deterministic retryable-error seam: no real upstream, photo retention, or app hooks.
let offlineAttemptedUploads = 0, offlineStatusRequests = 0, offlineReleasedErrors = 0, offlineTimeouts = 0;
let offlineLastAttempt = null, offlineFault = null;
let offlineRequestSequence = 0;
const offlineHeldResponses = new Map();
function clearOfflineHolds() {
  for (const entry of offlineHeldResponses.values()) { entry.cleanup(); entry.response.destroy(); }
}
function holdOfflineStatus(response, operationPath) {
  const requestId = ++offlineRequestSequence;
  const cleanup = () => {
    clearTimeout(timer);
    response.off('close', cleanup);
    offlineHeldResponses.delete(requestId);
  };
  const timer = setTimeout(() => {
    cleanup();
    offlineTimeouts++;
    offlineFault = 'hold_deadline_exceeded';
    // This is a fixture failure, never a normal release or a successful barrier.
    reply(response, 504, { error: 'fixture_offline_hold_expired' });
    clearOfflineHolds();
  }, 12000);
  timer.unref();
  offlineHeldResponses.set(requestId, { requestId, operationPath, response, cleanup });
  response.once('close', cleanup);
}
function offlineState() {
  return { offlineAttemptedUploads, offlineLastAttempt, offlineStatusRequests, offlineReleasedErrors,
    offlineTimeouts, offlineFault,
    offlineHeldResponses: [...offlineHeldResponses.values()].map(({ requestId, operationPath }) => ({ requestId, operationPath })) };
}
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
        if (!['online', 'offline', 'controlled-offline', 'drop-next-upload-response', 'drop-next-delete-response', 'block-acks', 'drop-next-ack-response', 'accept-upload-then-offline', 'hold-next-result', 'hold-next-illustration-result', 'foreign-illustration', 'block-prepared-sources', 'corrupt-prepared-source', 'legacy-attributes'].includes(input.mode)) return reply(response, 400, { error: 'invalid_mode' });
        if (input.releaseOfflineError !== undefined) {
          if (input.releaseOfflineError !== true || input.reset || input.advanceTimeMs !== undefined
            || input.mode !== 'controlled-offline' || mode !== 'controlled-offline') return reply(response, 400, { error: 'invalid_offline_release' });
          const held = offlineHeldResponses.get(input.heldRequestId);
          if (offlineFault || !held || held.operationPath !== input.operationPath || held.response.destroyed) {
            return reply(response, 409, { error: 'offline_response_not_held' });
          }
          held.cleanup();
          offlineReleasedErrors++;
          reply(held.response, 503, { error: 'fixture_offline' });
        }
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
        if (mode !== 'controlled-offline' || input.reset) clearOfflineHolds();
        if (input.reset) {
          offlineAttemptedUploads = 0; offlineStatusRequests = 0; offlineReleasedErrors = 0; offlineTimeouts = 0;
          offlineLastAttempt = null; offlineFault = null;
          // Request IDs stay monotonic so a stale release cannot match a new session.
        }
        if (!['hold-next-result', 'hold-next-illustration-result'].includes(mode) || input.reset) releaseResults();
        if (input.reset) { preparedSourceDownloads = 0; illustrationUploads = 0; illustrationOperations.clear(); illustrationAcknowledgements.clear(); lastIllustrationPath = undefined; acceptedOperations.clear(); forwardedUploads = 0; droppedUploadResponses = 0; deletedItems.clear(); forwardedDeletes = 0; droppedDeleteResponses = 0; acknowledgedOperations.clear(); forwardedAcknowledgements = 0; droppedAcknowledgementResponses = 0; lastOperationPath = undefined; }
      } else if (request.method !== 'GET') return reply(response, 405, { error: 'method_not_allowed' });
      return reply(response, 200, { mode, ...offlineState(), preparedSourceDownloads, illustrationUploads, illustrationOperations: illustrationOperations.size, illustrationAcknowledgements: illustrationAcknowledgements.size, lastIllustrationPath, acceptedOperations: acceptedOperations.size, forwardedUploads, droppedUploadResponses, heldResultResponses: heldResults.size, deletedItems: deletedItems.size, forwardedDeletes, droppedDeleteResponses, acknowledgedOperations: acknowledgedOperations.size, forwardedAcknowledgements, droppedAcknowledgementResponses, lastOperationPath, clockOffsetMs: clockFile ? readClockOffset() : undefined });
    }
    if (request.url !== '/health' && !request.url?.startsWith('/v1/items')) return reply(response, 404, { error: 'not_found' });
    if (mode === 'offline') { request.socket.destroy(); return; }
    if (mode === 'controlled-offline') {
      if (offlineFault) return reply(response, 500, { error: 'fixture_offline_poisoned' });
      const isAttempt = request.method === 'POST' && (request.url === '/v1/items' || /^\/v1\/items\/[^/]+\/attempts$/.test(request.url));
      if (isAttempt) {
        const { itemId, operationId, revision = 0, action = 'create' } = JSON.parse((await readBody(request, 16 * 1024 * 1024)).toString());
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        if (!uuid.test(itemId) || !uuid.test(operationId) || !Number.isSafeInteger(revision) || revision < 0
          || typeof action !== 'string' || action.length > 32) return reply(response, 400, { error: 'invalid_offline_attempt' });
        const operationPath = `/v1/items/${itemId}/operations/${operationId}`;
        if (offlineLastAttempt?.operationPath !== operationPath) clearOfflineHolds();
        offlineLastAttempt = { itemId, operationId, revision, action, operationPath };
        offlineAttemptedUploads++;
        return reply(response, 503, { error: 'fixture_offline' });
      }
      if (request.method === 'GET' && /^\/v1\/items\/[^/]+\/operations\/[^/]+$/.test(request.url)) {
        offlineStatusRequests++;
        if (request.url !== offlineLastAttempt?.operationPath) return reply(response, 409, { error: 'fixture_offline_foreign_operation' });
        holdOfflineStatus(response, request.url);
        return;
      }
      return reply(response, 503, { error: 'fixture_offline' });
    }
    const isPreparedSource = request.method === 'GET' && /^\/v1\/items\/[^/]+\/illustrations\/[^/]+\/sources\/[^/]+\/prepared$/.test(request.url);
    if (isPreparedSource) preparedSourceDownloads++;
    if (isPreparedSource && mode === 'corrupt-prepared-source') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      response.end('not a PNG');
      return;
    }
    if (isPreparedSource && mode === 'block-prepared-sources') return reply(response, 502, { error: 'fixture_delivery_unavailable' });
    const body = await readBody(request, 16 * 1024 * 1024);
    const isUpload = request.method === 'POST' && (request.url === '/v1/items' || /^\/v1\/items\/[^/]+\/attempts$/.test(request.url));
    const isIllustrationUpload = request.method === 'POST' && /^\/v1\/items\/[^/]+\/illustrations$/.test(request.url);
    if (isIllustrationUpload) illustrationUploads++;
    const isIllustrationAcknowledgement = request.method === 'POST' && /^\/v1\/items\/[^/]+\/illustrations\/[^/]+\/ack$/.test(request.url);
    const isAcknowledgement = isIllustrationAcknowledgement || (request.method === 'POST' && /^\/v1\/items\/[^/]+\/operations\/[^/]+\/ack$/.test(request.url));
    if (isAcknowledgement && mode === 'block-acks') { request.socket.destroy(); return; }
    if (isAcknowledgement) forwardedAcknowledgements++;
    const shouldDropAcknowledgement = isAcknowledgement && mode === 'drop-next-ack-response';
    const isDelete = request.method === 'DELETE' && /^\/v1\/items\/[^/]+$/.test(request.url);
    if (isDelete) forwardedDeletes++;
    const shouldDropDelete = isDelete && mode === 'drop-next-delete-response';
    const shouldDisconnectAfterUpload = isUpload && mode === 'accept-upload-then-offline';
    const shouldDrop = isUpload && mode === 'drop-next-upload-response';
    const shouldHold = request.method === 'GET' && ((/^\/v1\/items\/[^/]+(?:\/operations\/[^/]+)?\/result$/.test(request.url) && mode === 'hold-next-result')
      || (/^\/v1\/items\/[^/]+\/illustrations\/[^/]+\/result$/.test(request.url) && mode === 'hold-next-illustration-result'));
    if (shouldDrop || shouldDropDelete || shouldDropAcknowledgement || shouldHold) mode = 'online';
    if (isUpload) forwardedUploads++;
    const result = await fetch(new URL(request.url, upstream), {
      method: request.method,
      headers: { 'Content-Type': request.headers['content-type'] || 'application/json', Authorization: request.headers.authorization || '' },
      body: body.length ? body : undefined,
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    let data = Buffer.from(await result.arrayBuffer());
    if (mode === 'foreign-illustration' && result.ok && request.url.includes('/illustrations') && result.headers.get('content-type')?.includes('application/json')) {
      const payload = JSON.parse(data);
      payload.sourceSetVersionId = '00000000-0000-4000-8000-000000000099';
      data = Buffer.from(JSON.stringify(payload));
    }
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
    if (isIllustrationUpload && result.ok) {
      const accepted = JSON.parse(data);
      illustrationOperations.add(accepted.operationId);
      lastIllustrationPath = `/v1/items/${accepted.itemId}/illustrations/${accepted.operationId}`;
    }
    if (isIllustrationAcknowledgement && result.status === 204) illustrationAcknowledgements.add(request.url);
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
process.on('SIGTERM', () => { releaseResults(); clearOfflineHolds(); server.close(); server.closeAllConnections(); });
