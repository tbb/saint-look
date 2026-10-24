import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readUpload, RequestError } from './upload.mjs';
import { demoResult } from './demo-provider.mjs';

const ownerToken = process.env.SAINT_LOOK_OWNER_TOKEN;
if (!ownerToken || ownerToken.length < 32 || process.env.SAINT_LOOK_PROVIDER !== 'demo') {
  console.error('Set an owner token of at least 32 characters and SAINT_LOOK_PROVIDER=demo.');
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
database.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS items (
    item_id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, photo_version_id TEXT NOT NULL,
    status TEXT NOT NULL, source BLOB NOT NULL, result BLOB, type TEXT, colors TEXT, error TEXT
  )`);
const delay = Number(process.env.SAINT_LOOK_DEMO_DELAY_MS || 1500);
const scheduled = new Set();
let closing = false;

function itemResponse(row) {
  return { itemId: row.item_id, operationId: row.operation_id, photoVersionId: row.photo_version_id,
    status: row.status, mode: 'demo', type: row.type, colors: row.colors ? JSON.parse(row.colors) : [],
    resultPath: row.status === 'ready' ? `/v1/items/${row.item_id}/result` : null, error: row.error };
}
function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
function schedule(itemId) {
  const timer = setTimeout(async () => {
    scheduled.delete(timer);
    try {
      if (process.env.SAINT_LOOK_DEMO_OUTCOME === 'fail') throw new Error('Controlled demo failure');
      const result = await demoResult();
      if (closing) return;
      database.prepare("UPDATE items SET status='ready', result=?, type=?, colors=? WHERE item_id=?")
        .run(result.image, result.type, JSON.stringify(result.colors), itemId);
    } catch {
      if (closing) return;
      database.prepare("UPDATE items SET status='failed', error='processing_failed' WHERE item_id=?").run(itemId);
    }
  }, delay);
  scheduled.add(timer);
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health') return send(response, 200, { status: 'ok', mode: 'demo' });
    if (!authorized(request)) return send(response, 401, { error: 'unauthorized' });
    if (request.method === 'POST' && path === '/v1/items') {
      const input = await readUpload(request);
      const existing = database.prepare('SELECT * FROM items WHERE item_id=? OR operation_id=?').all(input.itemId, input.operationId);
      if (existing.length) {
        const row = existing[0];
        if (existing.length === 1 && row.item_id === input.itemId && row.operation_id === input.operationId
          && row.photo_version_id === input.photoVersionId && Buffer.from(row.source).equals(input.source)) {
          return send(response, 200, itemResponse(row));
        }
        return send(response, 409, { error: 'identity_conflict' });
      }
      database.prepare('INSERT INTO items(item_id,operation_id,photo_version_id,status,source) VALUES (?,?,?,?,?)')
        .run(input.itemId, input.operationId, input.photoVersionId, 'pending', input.source);
      schedule(input.itemId);
      return send(response, 202, itemResponse(database.prepare('SELECT * FROM items WHERE item_id=?').get(input.itemId)));
    }
    const route = path.match(/^\/v1\/items\/([^/]+)(\/result)?$/);
    if (request.method === 'GET' && route) {
      const row = database.prepare('SELECT * FROM items WHERE item_id=?').get(route[1].toLowerCase());
      if (!row) return send(response, 404, { error: 'not_found' });
      if (!route[2]) return send(response, 200, itemResponse(row));
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
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, mode: 'demo' }));
});
process.on('SIGTERM', () => {
  closing = true;
  for (const timer of scheduled) clearTimeout(timer);
  server.close(() => { database.close(); process.exit(0); });
  server.closeIdleConnections();
});
