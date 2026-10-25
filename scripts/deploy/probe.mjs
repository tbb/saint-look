// Public HTTPS probe. Tokens stay in the environment and never follow redirects.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const env = process.env;
function origin() {
  const url = new URL(env.SAINT_LOOK_DEV_URL);
  const testHTTP = env.NODE_ENV === 'test' && env.SAINT_LOOK_DEPLOY_TEST_ALLOW_HTTP === '1'
    && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !testHTTP) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS origin without credentials, path, query or fragment.');
  }
  return url.origin;
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
  const mode = process.argv[2] || 'smoke';
  const stateFile = process.argv[3];
  if (!['smoke', 'seed', 'verify', 'cleanup'].includes(mode) || (mode !== 'smoke' && !stateFile)) throw new Error('Use smoke, seed FILE, verify FILE or cleanup FILE.');
  if (mode === 'seed' && existsSync(stateFile)) throw new Error('Canary state file already exists.');
  const base = origin();
  const revision = env.SAINT_LOOK_EXPECTED_REVISION;
  const deploymentId = env.SAINT_LOOK_EXPECTED_DEPLOYMENT_ID;
  if (!/^[a-f0-9]{40}$/.test(revision || '') || !deploymentId) throw new Error('Expected release identity is incomplete.');
  const timeout = env.NODE_ENV === 'test' ? Number(env.SAINT_LOOK_PROBE_TIMEOUT_MS || 10000) : 600000;
  if (!Number.isSafeInteger(timeout) || timeout < 50 || timeout > 600000) throw new Error('Invalid probe timeout.');
  const deadline = Date.now() + timeout;
  let ready = false;
  do {
    try {
      const response = await fetch(base + '/health', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const health = response.ok ? await response.json() : null;
      if (health?.status === 'ok' && health.mode === 'demo' && health.revision === revision && health.dataVersion === 1 && health.deploymentId === deploymentId) {
        ready = true; break;
      }
    } catch { /* The existing Machine may restart while the new version is deployed. */ }
    await pause(env.NODE_ENV === 'test' ? 20 : 2000);
  } while (Date.now() < deadline);
  if (!ready) throw new Error('Selected deployment did not become ready.');
  if (!env.SAINT_LOOK_DEV_OWNER_TOKEN || env.SAINT_LOOK_DEV_OWNER_TOKEN.length < 32) throw new Error('Owner token is missing or too short.');
  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${env.SAINT_LOOK_DEV_OWNER_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const chunks = []; let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) throw new Error('Probe response is too large.');
      chunks.push(chunk);
    }
    return { status: response.status, data: Buffer.concat(chunks) };
  }
  const json = data => {
    try { return JSON.parse(data); } catch { throw new Error('Invalid JSON response.'); }
  };
  const digest = data => createHash('sha256').update(data).digest('hex');
  if (mode === 'verify' || mode === 'cleanup') {
    const state = json(readFileSync(stateFile));
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
    if (state.format !== 1 || state.status !== 'ready' || !['itemId', 'operationId', 'photoVersionId'].every(key => uuid.test(state[key] || ''))
      || !/^[a-f0-9]{64}$/.test(state.resultSha256 || '')) throw new Error('Invalid synthetic canary state.');
    const path = `/v1/items/${state.itemId}/operations/${state.operationId}`;
    if (mode === 'cleanup') {
      if ((await api(`/v1/items/${state.itemId}`, 'DELETE')).status !== 204) throw new Error('Canary cleanup failed.');
    } else {
      const reply = await api(path);
      const current = json(reply.data);
      if (reply.status !== 200 || current.status !== 'ready' || current.mode !== 'demo'
        || !['itemId', 'operationId', 'photoVersionId'].every(key => state[key] === current[key])) throw new Error('Canary operation did not survive.');
      const result = await api(path + '/result');
      if (result.status !== 200 || digest(result.data) !== state.resultSha256) throw new Error('Canary result did not survive.');
    }
    console.log(JSON.stringify({ revision, deploymentId, continuity: mode === 'verify' ? 'passed' : 'cleaned', observedStatus: state.status }));
    process.exit(0);
  }
  let retainCanary = false;
  const item = { itemId: randomUUID(), operationId: randomUUID(), photoVersionId: randomUUID(),
    imageBase64: readFileSync(new URL('./synthetic.png', import.meta.url)).toString('base64') };
  const path = `/v1/items/${item.itemId}/operations/${item.operationId}`;
  try {
    let reply = await api('/v1/items', 'POST', item);
    if (![200, 202].includes(reply.status)) throw new Error('Synthetic upload failed.');
    const until = Date.now() + (env.NODE_ENV === 'test' ? 1000 : 120000);
    while (true) {
      const state = json(reply.data);
      if (state.itemId !== item.itemId || state.operationId !== item.operationId || state.photoVersionId !== item.photoVersionId || state.mode !== 'demo') {
        throw new Error('Unexpected processing identity or provider mode.');
      }
      if (state.status === 'ready') {
        if (!state.type || !state.colors?.length || state.resultPath !== path + '/result') throw new Error('Incomplete synthetic result.');
        break;
      }
      if (state.status !== 'pending' || Date.now() >= until) throw new Error('Synthetic processing did not finish.');
      await pause(env.NODE_ENV === 'test' ? 20 : 1000);
      reply = await api(path);
      if (reply.status !== 200) throw new Error('Synthetic status request failed.');
    }
    const result = await api(path + '/result');
    if (result.status !== 200 || !result.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Synthetic PNG was not delivered.');
    if (mode === 'seed') {
      writeFileSync(stateFile, JSON.stringify({ format: 1, itemId: item.itemId, operationId: item.operationId,
        photoVersionId: item.photoVersionId, status: 'ready', resultSha256: digest(result.data),
        seedRevision: revision, seedDeploymentId: deploymentId }) + '\n', { flag: 'wx', mode: 0o600 });
      retainCanary = true;
    } else {
    if ((await api(path + '/ack', 'POST')).status !== 204) throw new Error('Synthetic result acknowledgement failed.');
    const cleared = await api(path + '/result');
    if (cleared.status !== 410 || json(cleared.data).error !== 'result_delivered') throw new Error('Acknowledged result was not cleared.');
    }
  } finally {
    if (!retainCanary && (await api(`/v1/items/${item.itemId}`, 'DELETE')).status !== 204) throw new Error('Synthetic thing cleanup failed.');
  }
  console.log(JSON.stringify({ revision, deploymentId, ready: true, ...(mode === 'seed' ? { continuity: 'seeded', observedStatus: 'ready' } : { smoke: 'passed' }) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Deployment probe failed.');
  process.exitCode = 1;
}
