// Real Docker + HTTP boundary. Intentionally separate from npm test: Docker is
// required, and a missing daemon must never be reported as a passing check.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../release.json', import.meta.url)));

const [image, revision] = process.argv.slice(2);
if (!image || image.startsWith('-') || !/^[0-9a-f]{40}$/.test(revision || '')) throw new Error('Usage: container-smoke.mjs IMAGE FULL_SHA');
const run = promisify(execFile);
const suffix = randomUUID();
const volume = `saint-look-smoke-${suffix}`;
const token = randomBytes(32).toString('hex');
const containers = new Set();
async function docker(args) {
  const result = await run('docker', args, {
    env: { ...process.env, SAINT_LOOK_OWNER_TOKEN: token }, timeout: 90000, maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}
async function launch() {
  const name = `saint-look-smoke-${randomUUID()}`;
  containers.add(name);
  await docker(['run', '--detach', '--name', name, '--publish', '127.0.0.1::8080',
    '--mount', `type=volume,source=${volume},target=/data`, '--env', 'SAINT_LOOK_OWNER_TOKEN', image]);
  const address = await docker(['port', name, '8080/tcp']);
  const url = `http://${address}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url + '/health', { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.revision, revision);
        assert.equal(health.mode, 'demo');
        assert.equal(health.dataVersion, manifest.dataVersion);
        return { name, url };
      }
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Container did not become healthy with the expected release identity.');
}
function request(server, path, options = {}) {
  return fetch(server.url + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${token}`, ...options.headers } });
}
async function ready(server, id) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await request(server, `/v1/items/${id}`);
    assert.equal(response.status, 200);
    const item = await response.json();
    if (item.status === 'ready') return item;
    assert.notEqual(item.status, 'failed');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Controlled container processing did not finish.');
}
try {
  await docker(['volume', 'create', volume]);
  let server = await launch();
  // Fixed synthetic 16x16 PNG keeps this host-side check dependency-free.
  const photo = { itemId: randomUUID(), operationId: randomUUID(), photoVersionId: randomUUID(),
    imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4oGBAEmIY1aAwGkofhmvSAADfxkAQ0gu8xwAAAABJRU5ErkJggg==' };
  assert.equal((await request(server, '/v1/items', {
    method: 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(photo),
  })).status, 401);
  assert.equal((await request(server, '/v1/items', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(photo),
  })).status, 202);
  const first = await ready(server, photo.itemId);
  const png = Buffer.from(await (await request(server, first.resultPath)).arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  await docker(['stop', '--time', '15', server.name]);
  assert.equal(await docker(['inspect', '--format', '{{.State.ExitCode}}', server.name]), '0');
  server = await launch();
  const restored = await ready(server, photo.itemId);
  assert.equal(restored.operationId, photo.operationId);
  assert.deepEqual(Buffer.from(await (await request(server, restored.resultPath)).arrayBuffer()), png);
  assert.equal((await request(server, `/v1/items/${photo.itemId}/operations/${photo.operationId}/ack`, { method: 'POST' })).status, 204);
  assert.equal((await request(server, restored.resultPath)).status, 410);
  assert.equal((await request(server, `/v1/items/${photo.itemId}`, { method: 'DELETE' })).status, 204);
  console.log('Container release identity, authorized processing, volume restart, acknowledgement and deletion passed.');
} finally {
  for (const name of containers) await docker(['rm', '--force', name]).catch(() => {});
  await docker(['volume', 'rm', volume]).catch(() => {});
}
