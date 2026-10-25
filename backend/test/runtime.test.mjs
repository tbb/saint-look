import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';


test('startup refuses a newer data format instead of pretending rollback succeeded', async t => {
  const env = await environment(t);
  // Historical/future database is input to the public process boundary, not an assertion side channel.
  const future = new DatabaseSync(join(env.directory, 'wardrobe.sqlite'));
  future.exec('PRAGMA user_version=2; CREATE TABLE future_only (value TEXT);');
  future.close();
  await assert.rejects(env.launch(), /Unsupported data version/);
});


async function controlledRelease(t) {
  const directory = await mkdtemp(join(tmpdir(), 'saint-look-release-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(root, 'test/providers'), join(directory, 'test/providers'), { recursive: true });
  await cp(join(root, 'release.json'), join(directory, 'release.json'));
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const revision = '1234567890abcdef1234567890abcdef12345678';
  await writeFile(join(directory, 'REVISION'), revision + '\n');
  const token = randomBytes(32).toString('hex');
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, revision,
    async launch(extra = {}, entry = 'start-controlled.mjs') {
      const child = spawn(process.execPath, [join(directory, 'src', entry)], {
        env: { ...process.env, PORT: '0', SAINT_LOOK_DATA_DIR: join(directory, 'data'),
          SAINT_LOOK_OWNER_TOKEN: token, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      let errors = '';
      child.stderr.on('data', data => { errors += data; });
      const reader = createInterface({ input: child.stdout });
      const ready = await Promise.race([
        once(reader, 'line').then(([line]) => JSON.parse(line)),
        once(child, 'exit').then(([code]) => { throw new Error(`Runtime exited ${code}: ${errors}`); }),
      ]);
      return {
        child, url: ready.url,
        request(path, options = {}) { return fetch(ready.url + path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } }); },
        async stop() { child.kill('SIGTERM'); const [code] = await once(child, 'exit'); children.delete(child); return code; },
      };
    },
  };
}

test('controlled release changes deployment identity while retaining its revision and result across restart', async t => {
  const release = await controlledRelease(t);
  const server = await release.launch({
    SAINT_LOOK_PROVIDER: 'live', NODE_ENV: 'production',
    SAINT_LOOK_TEST_PROVIDER_ORIGIN: 'https://example.invalid',
    GEMINI_API_KEY: 'must-not-be-used', PHOTOROOM_API_KEY: 'must-not-be-used',
    SAINT_LOOK_TEST_CLOCK_FILE: '/must-not-be-read', FLY_IMAGE_REF: 'registry.fly.io/example:untrusted-environment-value',
    SAINT_LOOK_DEPLOYMENT_ID: 'b10826ef-458b-4caa-9ee1-9402e94071cb',
  });
  const health = await (await server.request('/health')).json();
  assert.equal(health.revision, release.revision);
  assert.equal(health.deploymentId, 'b10826ef-458b-4caa-9ee1-9402e94071cb');
  assert.equal(health.dataVersion, 1);
  assert.equal(health.mode, 'demo');
  assert.equal((await server.request('/__control')).status, 404);
  const item = await photoRequest();
  assert.equal((await upload(server, item)).status, 202);
  const ready = await waitForItem(server, item.itemId);
  assert.equal(ready.mode, 'demo');
  assert.equal(ready.type, 'Футболка');
  const before = Buffer.from(await (await server.request(ready.resultPath)).arrayBuffer());
  assert.ok(before.length > 0);
  assert.equal(await server.stop(), 0);
  const restarted = await release.launch({ SAINT_LOOK_DEPLOYMENT_ID: '71068c38-726b-448a-a206-f6f3d8d973d4' });
  const restartedHealth = await (await restarted.request('/health')).json();
  assert.equal(restartedHealth.revision, release.revision);
  assert.equal(restartedHealth.deploymentId, '71068c38-726b-448a-a206-f6f3d8d973d4');
  const persisted = await waitForItem(restarted, item.itemId);
  assert.equal(persisted.operationId, item.operationId);
  assert.deepEqual(Buffer.from(await (await restarted.request(persisted.resultPath)).arrayBuffer()), before);
});

test('a controlled release refuses missing or invalid baked identity', async t => {
  const release = await controlledRelease(t);
  await rm(join(release.directory, 'REVISION'));
  await assert.rejects(release.launch(), /baked release revision is required/);
  await writeFile(join(release.directory, 'REVISION'), 'not-a-git-revision\n');
  await assert.rejects(release.launch(), /Invalid baked release revision/);
});

test('an unexpected provider process exit stops the controlled runtime instead of leaving a healthy API', async t => {
  const release = await controlledRelease(t);
  const server = await release.launch();
  // Process supervision is observed through the operating system's process API.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,args=']);
  const provider = stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .find(match => match && Number(match[2]) === server.child.pid && match[3].endsWith('/test/providers/ui-server.mjs'));
  assert.ok(provider, 'The runtime must own its loopback provider process');
  const stopped = once(server.child, 'exit');
  process.kill(Number(provider[1]), 'SIGKILL');
  const [code] = await stopped;
  assert.equal(code, 1);
  await assert.rejects(fetch(server.url + '/health', { signal: AbortSignal.timeout(1000) }));
});


test('release entry stays controlled by default even when real provider credentials are configured', async t => {
  const release = await controlledRelease(t);
  const server = await release.launch({ GEMINI_API_KEY: 'unused-real-key', PHOTOROOM_API_KEY: 'unused-real-key' }, 'start-release.mjs');
  assert.equal((await (await server.request('/health')).json()).mode, 'demo');
  const item = await photoRequest();
  assert.equal((await upload(server, item)).status, 202);
  assert.equal((await waitForItem(server, item.itemId)).mode, 'demo');
});

test('explicit live entry requires preflight and credentials and announces live without making an upload', async t => {
  const release = await controlledRelease(t);
  const live = { SAINT_LOOK_DEPLOYMENT_PROFILE: 'live', SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED: 'true', GEMINI_API_KEY: 'fixture-unused', PHOTOROOM_API_KEY: 'fixture-unused' };
  await assert.rejects(release.launch({ ...live, GEMINI_API_KEY: '' }, 'start-release.mjs'), /Live provider configuration is incomplete/);
  await assert.rejects(release.launch({ ...live, SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED: 'false' }, 'start-release.mjs'), /Live provider configuration is incomplete/);
  await assert.rejects(release.launch({ ...live, SAINT_LOOK_TEST_PROVIDER_ORIGIN: 'http:\/\/127.0.0.1:1' }, 'start-release.mjs'), /Test overrides are not allowed/);
  const server = await release.launch(live, 'start-release.mjs');
  const health = await (await server.request('/health')).json();
  assert.equal(health.mode, 'live');
  assert.equal(health.revision, release.revision);
});

test('switching deployed provider profiles refuses pending work instead of mutating it', async t => {
  const env = await environment(t);
  const old = await env.launch({ SAINT_LOOK_DEMO_DELAY_MS: '60000' });
  const item = await photoRequest();
  assert.equal((await upload(old, item)).status, 202);
  await old.stop();
  const release = await controlledRelease(t);
  await assert.rejects(release.launch({ SAINT_LOOK_DATA_DIR: env.directory }, 'start-release.mjs'), /Pending work belongs to another provider profile/);
  const original = await env.launch({ SAINT_LOOK_DEMO_DELAY_MS: '60000' });
  const state = await (await original.request(`/v1/items/${item.itemId}`)).json();
  assert.equal(state.status, 'pending');
  assert.equal(state.operationId, item.operationId);
});
