import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readUpload, RequestError } from './upload.mjs';
import { createProviders } from './providers.mjs';
import { initializeProcessing, createWorker } from './processing.mjs';
import { initializeAttempts, acceptAttempt, readAttempt } from './attempts.mjs';
import { initializeDeletion, deleteItem } from './deletion.mjs';
import { createRetention, acknowledge } from './retention.mjs';
import { initializeDataVersion, release } from './data-version.mjs';
import { readRevision } from './revision.mjs';
import { createIllustrations } from './illustrations.mjs';

const revision = readRevision();

const ownerToken = process.env.SAINT_LOOK_OWNER_TOKEN;
if (!ownerToken || ownerToken.length < 32 || !['demo', 'live'].includes(process.env.SAINT_LOOK_PROVIDER)) {
  console.error('Set an owner token of at least 32 characters and SAINT_LOOK_PROVIDER=demo|live.');
  process.exit(1);
}
const tokenDigest = createHash('sha256').update(`Bearer ${ownerToken}`).digest();
function authorized(request) {
  const supplied = createHash('sha256').update(request.headers.authorization || '').digest();
  return timingSafeEqual(tokenDigest, supplied);
}
process.umask(0o077);
const directory = resolve(process.env.SAINT_LOOK_DATA_DIR || '.data');
mkdirSync(directory, { recursive: true });
const database = new DatabaseSync(join(directory, 'wardrobe.sqlite'));
initializeDataVersion(database);
database.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS items (
    item_id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, photo_version_id TEXT NOT NULL,
    status TEXT NOT NULL, source BLOB NOT NULL, result BLOB, type TEXT, colors TEXT, error TEXT
  )`);
initializeDeletion(database);
initializeProcessing(database);
initializeAttempts(database);
const provider = createProviders(process.env);
const retention = createRetention(database, process.env, provider);
const worker = createWorker(database, provider, process.env, retention);
const illustrations = createIllustrations(database, process.env, retention);

function itemResponse(row) {
  return { itemId: row.item_id, operationId: row.operation_id, photoVersionId: row.photo_version_id,
    status: row.status, mode: row.mode, revision: row.revision, processing: { attributes: row.attributes_state, cutout: row.cutout_state }, type: row.type, colors: row.colors ? JSON.parse(row.colors) : [],
    resultPath: row.status === 'ready' ? `/v1/items/${row.item_id}/operations/${row.operation_id}/result` : null, error: row.error };
}
function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health') return send(response, 200, { status: 'ok', mode: provider.mode, revision, dataVersion: release.dataVersion, illustrationAvailable: await illustrations.available(),
      ...(process.env.SAINT_LOOK_DEPLOYMENT_ID ? { deploymentId: process.env.SAINT_LOOK_DEPLOYMENT_ID } : {}) });
    if (!authorized(request)) return send(response, 401, { error: 'unauthorized' });
    retention.sweep();
    illustrations.sweep();
    const illustration = path.match(/^\/v1\/items\/([^/]+)\/illustrations(?:\/([^/]+)(?:\/(result|ack))?)?$/);
    if (illustration) {
      const itemId = illustration[1].toLowerCase(), operationId = illustration[2]?.toLowerCase(), action = illustration[3];
      if (request.method === 'POST' && !operationId) {
        const accepted = await illustrations.accept(request, itemId);
        return send(response, accepted.status, accepted.body);
      }
      if (request.method === 'GET' && operationId && !action) return send(response, 200, illustrations.read(itemId, operationId));
      if (request.method === 'GET' && action === 'result') {
        const result = illustrations.result(itemId, operationId);
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return response.end(result);
      }
      if (request.method === 'POST' && action === 'ack') {
        illustrations.acknowledge(itemId, operationId); response.writeHead(204, { 'Cache-Control': 'no-store' }); return response.end();
      }
    }
    const acknowledgement = path.match(/^\/v1\/items\/([^/]+)\/operations\/([^/]+)\/ack$/);
    if (request.method === 'POST' && acknowledgement) {
      acknowledge(database, acknowledgement[1].toLowerCase(), acknowledgement[2].toLowerCase());
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    const deletion = path.match(/^\/v1\/items\/([^/]+)$/);
    if (request.method === 'DELETE' && deletion) {
      deleteItem(database, deletion[1].toLowerCase());
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    const newAttempt = path.match(/^\/v1\/items\/([^/]+)\/attempts$/);
    if (request.method === 'POST' && (path === '/v1/items' || newAttempt)) {
      const input = await readUpload(request);
      if (newAttempt && newAttempt[1].toLowerCase() !== input.itemId) throw new RequestError(409, 'identity_conflict');
      retention.sweep();
      const accepted = acceptAttempt(database, input, provider, Boolean(newAttempt), retention.deadline());
      if (accepted.status === 202) worker.schedule(input.itemId, input.operationId);
      return send(response, accepted.status, itemResponse(accepted.row));
    }
    const route = path.match(/^\/v1\/items\/([^/]+)(?:\/operations\/([^/]+))?(\/result)?$/);
    if (request.method === 'GET' && route) {
      const row = readAttempt(database, route[1].toLowerCase(), route[2]?.toLowerCase());
      if (!route[3]) return send(response, 200, itemResponse(row));
      if (row.retention_state !== 'active') return send(response, 410, { error: row.error });
      if (row.status !== 'ready') return send(response, 409, { error: 'not_ready' });
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return response.end(Buffer.from(row.result));
    }
    send(response, 404, { error: 'not_found' });
  } catch (error) {
    if (!response.destroyed && !response.headersSent) {
      send(response, error instanceof RequestError ? error.status : 400, { error: error instanceof RequestError ? error.code : 'invalid_request' });
    }
  }
});
server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, mode: provider.mode }));
});
process.on('SIGTERM', () => {
  worker.close();
  illustrations.close();
  retention.close();
  server.close(() => { database.close(); process.exit(0); });
  server.closeIdleConnections();
});
