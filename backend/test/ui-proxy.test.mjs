import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { environment } from './support.mjs';

test('native proxy forwards the public recommendation routes and preserves backend authentication', { timeout: 20_000 }, async t => {
  const env = await environment(t), backend = await env.launch({ NODE_ENV: 'test' });
  const proxy = spawn(process.execPath, [fileURLToPath(new URL('../../client-ios/scripts/ui-test-proxy.mjs', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'test', SAINT_LOOK_UI_PROXY_UPSTREAM: backend.url, SAINT_LOOK_UI_PROXY_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (proxy.exitCode === null) { proxy.kill(); await once(proxy, 'exit'); } });
  const reader = createInterface({ input: proxy.stdout });
  const [line] = await Promise.race([
    once(reader, 'line'),
    once(proxy, 'exit').then(([code]) => { throw new Error(`Native proxy exited ${code}`); }),
  ]);
  const url = JSON.parse(line).url;
  const direct = await backend.request('/v1/recommendations/config');
  assert.equal(direct.status, 200);
  const response = await fetch(url + '/v1/recommendations/config', { headers: { Authorization: `Bearer ${env.token}` } });
  assert.equal(response.status, 200, 'The app must discover full preparation capability through its configured proxy');
  assert.deepEqual(await response.json(), await direct.json());
  // Even a branch that predates a strategy must reach backend authentication,
  // rather than getting a proxy404 before that endpoint can be evaluated.
  for (const [method, path] of [['GET', 'config'], ['POST', 'single'], ['POST', 'compose']]) {
    assert.equal((await fetch(`${url}/v1/recommendations/${path}`, { method })).status, 401);
  }
  for (const [method, path] of [['POST', 'private'], ['DELETE', 'config'], ['GET', 'single'], ['GET', 'compose']]) {
    assert.equal((await fetch(`${url}/v1/recommendations/${path}`, { method })).status, 404,
      'The test proxy must not grant a broad recommendations prefix or unsupported methods');
  }
});
