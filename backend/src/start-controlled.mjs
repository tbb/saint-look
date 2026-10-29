// Dev profile: real HTTP adapters, but only controlled loopback providers.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { readRevision } from './revision.mjs';

readRevision(true);
const children = new Set();
let stopping = false;
let exitCode = 0;
function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  if (!children.size) process.exit(code);
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 8000);
  timer.unref();
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
function start(path, env, stdout = 'inherit') {
  const child = spawn(process.execPath, [fileURLToPath(new URL(path, import.meta.url))], {
    env, stdio: ['ignore', stdout, 'inherit'],
  });
  children.add(child);
  child.once('error', () => { console.error('Controlled runtime child could not start.'); stop(1); });
  child.once('exit', () => {
    children.delete(child);
    if (!stopping) { console.error('Controlled runtime child stopped unexpectedly.'); stop(1); }
    else if (!children.size) process.exit(exitCode);
  });
  return child;
}
const env = {
  ...process.env, NODE_ENV: 'test', SAINT_LOOK_PROVIDER: 'live',
  SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED: 'true',
  TYPESAFE_API_KEY: 'controlled-fixture-typesafe', PHOTOROOM_API_KEY: 'controlled-fixture-photoroom',
  SAINT_LOOK_UI_PROVIDER_PORT: '0', SAINT_LOOK_UI_PROVIDER_CONTROL_TOKEN: randomBytes(32).toString('hex'),
  SAINT_LOOK_STAGE_DELAY_MS: '100', SAINT_LOOK_PROVIDER_TIMEOUT_MS: '5000',
  SAINT_LOOK_DATA_DIR: process.env.SAINT_LOOK_DATA_DIR || '/data',
  HOST: process.env.HOST || '0.0.0.0', PORT: process.env.PORT || '8080',
};
delete env.SAINT_LOOK_TEST_CLOCK_FILE;
delete env.SAINT_LOOK_TEST_PROVIDER_ORIGIN;
delete env.SAINT_LOOK_TEST_MODEL_ORIGIN;
env.SAINT_LOOK_MODEL_PROFILE = 'disabled';
const fixture = start('../test/providers/ui-server.mjs', env, 'pipe');
const startupTimeout = setTimeout(() => { console.error('Controlled provider startup timed out.'); stop(1); }, 10000);
startupTimeout.unref();
const lines = createInterface({ input: fixture.stdout });
lines.once('line', line => {
  clearTimeout(startupTimeout);
  if (stopping) return;
  try {
    const origin = new URL(JSON.parse(line).url);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    start('./server.mjs', { ...env, SAINT_LOOK_TEST_PROVIDER_ORIGIN: origin.origin, SAINT_LOOK_TEST_MODEL_ORIGIN: origin.origin });
  } catch { console.error('Controlled provider did not announce a valid loopback address.'); stop(1); }
});
