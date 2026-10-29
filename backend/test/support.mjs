import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import sharp from 'sharp';

export async function environment(t) {
  const directory = await mkdtemp(join(tmpdir(), 'saint-look-api-'));
  const token = randomBytes(32).toString('hex');
  const processes = new Set();
  t.after(async () => {
    for (const process of processes) {
      if (process.exitCode === null) { process.kill('SIGTERM'); await once(process, 'exit'); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    token, directory,
    async launch(extra = {}) {
      const process = spawn(globalThis.process.execPath, ['src/server.mjs'], {
        cwd: new URL('..', import.meta.url),
        env: { ...globalThis.process.env, PORT: '0', SAINT_LOOK_DATA_DIR: directory,
          SAINT_LOOK_OWNER_TOKEN: token, SAINT_LOOK_PROVIDER: 'demo', SAINT_LOOK_DEMO_DELAY_MS: '150', ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      processes.add(process);
      let errors = '';
      process.stderr.on('data', (chunk) => { errors += chunk; });
      const reader = createInterface({ input: process.stdout });
      const ready = await Promise.race([
        once(reader, 'line').then(([line]) => JSON.parse(line)),
        once(process, 'exit').then(([code]) => { throw new Error(`Backend exited ${code}: ${errors}`); }),
      ]);
      return {
        url: ready.url, pid: process.pid,
        async stop(signal = 'SIGTERM') {
          if (process.exitCode === null) { process.kill(signal); await once(process, 'exit'); }
          processes.delete(process);
        },
        request(path, options = {}) {
          return fetch(ready.url + path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
        },
      };
    },
  };
}

export async function photoRequest() {
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#f02030' } }).png().toBuffer();
  return { itemId: randomUUID(), operationId: randomUUID(), photoVersionId: randomUUID(), imageBase64: image.toString('base64') };
}

export function upload(server, request) {
  return server.request('/v1/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
}

export async function waitForItem(server, itemId, status = 'ready') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await server.request(`/v1/items/${itemId}`);
    const item = await response.json();
    if (item.status === status) return item;
    if (item.status === 'failed' && status !== 'failed') throw new Error('Processing failed');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Item did not become ${status}`);
}
