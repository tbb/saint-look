// The only module aware of model payloads. No downloaded assets or fallback at runtime.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sha256, canonicalText } from './publication-contract.mjs';

export function createModelBridge(env, directory) {
  const origin = env.SAINT_LOOK_TEST_MODEL_ORIGIN;
  if (origin) {
    const url = new URL(origin);
    if (env.NODE_ENV !== 'test' || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid controlled model origin');
  }
  const profile = env.SAINT_LOOK_MODEL_PROFILE || 'disabled';
  if (!['disabled', 'outfit-transformer-labse-v1'].includes(profile)) throw new Error('Invalid model profile');
  const threads = Number(env.SAINT_LOOK_MODEL_THREADS || 1);
  if (!Number.isInteger(threads) || threads < 1 || threads > 8) throw new Error('Invalid model thread count');
  const mode = origin ? 'controlled' : profile === 'disabled' ? 'disabled' : 'real';
  const timeout = 120_000, pending = new Map(), inputs = join(directory, 'model-inputs');
  let child, closed = false, descriptor = null, queue = Promise.resolve();
  const unavailable = () => new Error('encoder_unavailable');
  function fail() {
    descriptor = null;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(unavailable()); }
    pending.clear(); child?.kill('SIGKILL'); child = null;
  }
  async function exchange(operation, values = {}) {
    if (closed) throw unavailable();
    if (origin) {
      const response = await fetch(new URL('/model/' + operation, origin), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values), signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw new Error('model_failed');
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('model_failed');
      return JSON.parse(text);
    }
    if (!child) throw unavailable();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject, timer: setTimeout(() => fail(), timeout) });
      child.stdin.write(JSON.stringify({ id, operation, ...values }) + '\n', error => { if (error) fail(); });
    });
  }
  const boot = (async () => {
    await rm(inputs, { recursive: true, force: true }); await mkdir(inputs, { recursive: true, mode: 0o700 });
    if (mode === 'disabled') return;
    if (!origin) {
      if (!env.SAINT_LOOK_MODEL_PYTHON || !env.SAINT_LOOK_MODEL_ASSETS) return;
      child = spawn(env.SAINT_LOOK_MODEL_PYTHON, ['-u', fileURLToPath(new URL('../ml/worker.py', import.meta.url)),
        '--assets', env.SAINT_LOOK_MODEL_ASSETS, '--threads', String(threads)], {
        stdio: ['pipe', 'pipe', 'ignore'], env: { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' } });
      child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
      const reader = createInterface({ input: child.stdout });
      reader.on('line', line => {
        if (line.length > 2_000_000) { fail(); return; }
        try {
          const message = JSON.parse(line), entry = pending.get(message.id);
          if (!entry) return;
          clearTimeout(entry.timer); pending.delete(message.id);
          if (message.error) entry.reject(new Error('model_failed')); else entry.resolve(message.result);
        } catch { fail(); }
      });
    }
    const description = await exchange('describe');
    if (typeof description.spaceID !== 'string' || !description.spaceID.length) throw unavailable();
    descriptor = description;
  })().catch(() => fail());
  return {
    async status() {
      await boot;
      return { available: Boolean(descriptor) && !closed, mode, activeSpaceID: descriptor?.spaceID ?? null,
        supportedSpaceIDs: descriptor ? [descriptor.spaceID] : [], reason: descriptor ? null : mode === 'disabled' ? 'encoder_disabled' : 'encoder_unavailable' };
    },
    async prepare(source, photoVersionID, features) {
      const run = async () => {
        await boot; if (!descriptor || closed) throw unavailable();
        const imagePath = join(inputs, randomUUID() + '.png');
        try {
          await writeFile(imagePath, source, { mode: 0o600 });
          const result = await exchange('prepare', { imagePath, ...(origin ? { imageBase64: source.toString('base64') } : {}), photoVersionID, ...features });
          const norm = result?.vector?.reduce((sum, x) => sum + x * x, 0);
          if (result?.schemaVersion !== 1 || result.spaceID !== descriptor.spaceID || result.photoVersionID !== photoVersionID
            || result.sourceSHA256 !== sha256(source) || result.textSHA256 !== sha256(canonicalText(features))
            || !Array.isArray(result.vector) || result.vector.length !== 128
            || result.vector.some(value => typeof value !== 'number' || !Number.isFinite(value))
            || !Number.isFinite(norm) || norm < 1e-12 || norm > 1e12) throw new Error('invalid_model_output');
          const representationJSON = JSON.stringify(result);
          return { representationJSON, representationSHA256: sha256(representationJSON), input: { sourceSHA256: result.sourceSHA256, textSHA256: result.textSHA256 } };
        } finally { await rm(imagePath, { force: true }); }
      };
      const task = queue.then(run); queue = task.catch(() => {}); return task;
    },
    close() { closed = true; fail(); },
  };
}
