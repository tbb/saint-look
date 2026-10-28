import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, access, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { sha256, sharp } from './trial-plan.mjs';
import { featureRequest, featureAnswer } from './trial-jev.mjs';

const cli = new URL('./jev-diagnostic.mjs', import.meta.url).pathname;
const originalMarker = 'refs/tags/fitting-trial-45-reserved';
const marker = 'refs/tags/fitting-trial-45-jev-diagnostic-1';
const contractFiles = ['scripts/fitting/trial-jev.mjs', 'scripts/fitting/trial-http.mjs', 'backend/src/jev.mjs', 'backend/package-lock.json', 'shared/wardrobe-taxonomy.json'];
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-diagnostic-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  for (const file of contractFiles) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await copyFile(new URL('../../' + file, import.meta.url), join(dir, file));
  }
  const image = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#aabbccff' } }).png().toBuffer();
  const sourcePath = 'scripts/fitting/fixtures/white-tee.png';
  await mkdir(dirname(join(dir, sourcePath)), { recursive: true }); await writeFile(join(dir, sourcePath), image);
  git('add', '.'); git('commit', '-m', 'original contract'); const originalRevision = git('rev-parse', 'HEAD');
  const prior = join(dir, 'prior'); await mkdir(join(prior, 'output'), { recursive: true });
  const oldPlan = 'a'.repeat(64), sourceSha = sha256(image);
  const approval = { mode: 'live', planSha256: oldPlan, outputDirectory: '/old/approved/output', budgetMicrousd: 5_000_000,
    maxCalls: { preparation: 12, attributes: 14, generation: 28, segmentation: 28 } };
  const approvalBytes = JSON.stringify(approval), approvalSha = sha256(approvalBytes);
  await writeFile(join(prior, 'approval.json'), approvalBytes);
  const admission = { version: 1, runId: '40677633168', revision: originalRevision, repository: 'tbb/saint-look',
    planSha256: oldPlan, approvalSha256: approvalSha, reservationRef: originalMarker };
  const admissionBytes = JSON.stringify(admission); await writeFile(join(prior, 'admission.json'), admissionBytes);
  const prepKey = `source-${sourceSha}/preparation`, attrKey = 'white-tee/single/attributes';
  const ledger = { version: 1, mode: 'live', planSha256: oldPlan, approvalSha256: approvalSha, operations: {
    [prepKey]: { key: prepKey, stage: 'preparation', status: 'completed', reservedMicrousd: 0, sourceSha256: sourceSha,
      artifact: 'prepared.png', sha256: sourceSha, width: 16, height: 16, sandbox: true },
    [attrKey]: { key: attrKey, stage: 'attributes', status: 'unknown', reservedMicrousd: 2753, error: 'Invalid JEV feature response' },
  } };
  const ledgerBytes = JSON.stringify(ledger); await writeFile(join(prior, 'output/ledger.json'), ledgerBytes);
  await writeFile(join(prior, 'output/prepared.png'), image);
  const manifest = { version: 1, originalRunId: '40677633168', originalRevision, originalPlanSha256: oldPlan,
    originalApprovalSha256: approvalSha, originalAdmissionSha256: sha256(admissionBytes), originalLedgerSha256: sha256(ledgerBytes),
    preparedFile: 'prepared.png', preparedSha256: sourceSha, sourcePath, sourceSha256: sourceSha, normalizedSourceSha256: sourceSha };
  const planPath = join(dir, 'diagnostic-plan.json'); await writeFile(planPath, JSON.stringify(manifest));
  git('add', 'diagnostic-plan.json'); git('commit', '-m', 'diagnostic manifest'); const revision = git('rev-parse', 'HEAD');
  const requests = [], providerRequests = [], state = { claimed: false, checked: true };
  const api = createServer(async (request, response) => {
    if (request.url === '/') { response.writeHead(404); response.end(); return; }
    let bytes = ''; for await (const b of request) bytes += b;
    requests.push({ method: request.method, path: request.url, body: bytes ? JSON.parse(bytes) : null });
    assert.equal(request.headers.authorization, 'Bearer fixture-github-token');
    const answer = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.url.endsWith('/git/ref/heads/main')) return answer(200, { object: { sha: revision } });
    if (request.url.endsWith('/git/ref/tags/fitting-trial-45-reserved')) return answer(200, { ref: originalMarker, object: { sha: state.originalRefSha || originalRevision } });
    if (request.url.endsWith('/actions/runs/40677633168')) return answer(200, { id: 40677633168, head_sha: originalRevision, head_branch: 'main',
      event: 'workflow_dispatch', path: '.github/workflows/fitting-live-trial.yml', status: 'completed', conclusion: 'failure', run_attempt: 1, head_repository: { full_name: 'tbb/saint-look' } });
    if (request.url.includes('/fitting-experiment.yml/runs?')) return answer(200, { workflow_runs: state.checked ? [{ id: 123, head_sha: revision,
      head_branch: 'main', event: 'push', path: '.github/workflows/fitting-experiment.yml', status: 'completed', conclusion: 'success', head_repository: { full_name: 'tbb/saint-look' } }] : [] });
    if (request.url.endsWith('/123/jobs?filter=latest&per_page=100')) return answer(200, { jobs: [{ name: 'fitting-local', status: 'completed', conclusion: 'success' }] });
    if (request.method === 'POST' && request.url.endsWith('/git/refs')) {
      if (state.claimed) return answer(422, {});
      state.claimed = true; return answer(201, { ref: marker, object: { sha: revision } });
    }
    answer(404, {});
  });
  const provider = createServer(async (request, response) => {
    if (request.url === '/') { response.writeHead(404); response.end(); return; }
    let bytes = ''; for await (const b of request) bytes += b;
    const body = JSON.parse(bytes); providerRequests.push({ method: request.method, path: request.url, body, headers: request.headers });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
      if (question.type === 'noul') return [key, { type: 'noul', noul: 0.9 }];
      const choice = key === 'suitability' ? 'suitable' : Object.keys(question.criteria)[0];
      return [key, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(k => [k, k === choice ? 1 : 0])) }];
    }));
    const payload = { model: 'jev-1.14.0', usage: { input_tokens: 1000 }, answers, untrusted_text: 'DO_NOT_CAPTURE_PRIVATE_TEXT', assets: { secret: 'DO_NOT_CAPTURE_IMAGE' } };
    if (state.mutateResponse) state.mutateResponse(payload);
    response.writeHead(state.httpStatus || 200, { 'Content-Type': 'application/json', 'x-private-secret': 'DO_NOT_CAPTURE_HEADER' });
    const serialized = JSON.stringify(payload);
    response.end(state.rawResponse ? state.rawResponse(serialized) : serialized);
  });
  await Promise.all([new Promise(resolve => api.listen(0, '127.0.0.1', resolve)), new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))]);
  t.after(() => { api.closeAllConnections(); api.close(); provider.closeAllConnections(); provider.close(); });
  const eventPath = join(dir, 'event.json'), output = join(dir, 'diagnostic');
  const input = { revision, diagnostic_plan_sha256: sha256(await readFile(planPath)), price_checked_at: new Date().toISOString(),
    approve_single_probe: 'true', reviewed_terms: 'true', plan_reference: 'https://github.com/tbb/saint-look/issues/45#issuecomment-6455068166' };
  const env = { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', NODE_ENV: 'test', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'tbb/saint-look', GITHUB_ACTOR: 'tbb', GITHUB_RUN_ID: '500', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: revision, GITHUB_WORKFLOW_SHA: revision,
    GITHUB_WORKFLOW_REF: 'tbb/saint-look/.github/workflows/fitting-jev-diagnostic.yml@refs/heads/main', GITHUB_EVENT_PATH: eventPath,
    GH_TOKEN: 'fixture-github-token', TYPESAFE_API_KEY: 'MUST_NOT_USE_REAL_KEY', SAINT_LOOK_FITTING_TEST_API: `http://127.0.0.1:${api.address().port}`,
    SAINT_LOOK_JEV_DIAGNOSTIC_TEST_ORIGIN: `http://127.0.0.1:${provider.address().port}` };
  async function run(mode, overrides = {}, inputOverrides = {}, target = output) {
    await writeFile(eventPath, JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'tbb/saint-look' }, sender: { login: 'tbb' }, inputs: { ...input, ...inputOverrides } }));
    const args = mode === 'reserve' ? [cli, mode, planPath, prior, target] : [cli, mode, planPath, target];
    return new Promise(resolve => {
      const child = spawn(process.execPath, args, { cwd: dir, env: { ...env, GITHUB_JOB: mode, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  }
  return { dir, prior, output, manifest, planPath, revision, originalRevision, ledgerBytes, requests, providerRequests, state, env, run, image };
}

test('one admitted probe reuses the prior images, preserves old unknown and captures a replayable safe response', async t => {
  const f = await fixture(t);
  const reserve = await f.run('reserve'); assert.equal(reserve.code, 0, reserve.stderr);
  assert.equal(f.providerRequests.length, 0);
  const probe = await f.run('probe'); assert.equal(probe.code, 0, probe.stderr);
  assert.equal(f.providerRequests.length, 1);
  assert.equal(f.providerRequests[0].path, '/v1/systemone'); assert.equal(f.providerRequests[0].method, 'POST');
  assert.equal(f.providerRequests[0].headers.authorization, 'Bearer fixture-jev-key');
  assert.equal(await readFile(join(f.output, 'prior-ledger.json'), 'utf8'), f.ledgerBytes);
  const snapshotText = await readFile(join(f.output, 'response.json'), 'utf8'), snapshot = JSON.parse(snapshotText);
  assert.doesNotMatch(snapshotText, /DO_NOT_CAPTURE|MUST_NOT_USE|data_base64|Bearer/);
  const replayed = featureAnswer(snapshot.replay, f.providerRequests[0].body);
  assert.equal(replayed.inputTokens, 1000);
  const receipt = JSON.parse(await readFile(join(f.output, 'receipt.json')));
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.budget.aggregateReservedMicrousd, 200000);
  assert.equal(receipt.budget.countsAfter.attributes, 2); assert.equal(receipt.budget.countsAfter.generation, 0);
  assert.deepEqual(JSON.parse(await readFile(join(f.output, 'features.json'))), replayed);
  // Restored allowlisted artifacts contain the receipt but no hidden runner files.
  for (const name of await readdir(f.output)) if (name.startsWith('.')) await rm(join(f.output, name));
  const again = await f.run('probe'); assert.equal(again.code, 1); assert.equal(f.providerRequests.length, 1);
});

test('a missing usage field is captured before the unchanged feature validator rejects it', async t => {
  const f = await fixture(t); f.state.mutateResponse = payload => { delete payload.usage; };
  assert.equal((await f.run('reserve')).code, 0);
  const result = await f.run('probe'); assert.equal(result.code, 1); assert.match(result.stderr, /Invalid JEV feature response/);
  const snapshot = JSON.parse(await readFile(join(f.output, 'response.json')));
  assert.equal(snapshot.shape.usage.present, false);
  assert.throws(() => featureAnswer(snapshot.replay, f.providerRequests[0].body), /Invalid JEV feature response/);
  const offline = await f.run('replay');
  assert.equal(offline.code, 1); assert.match(offline.stderr, /Invalid JEV feature response/);
  await assert.rejects(access(join(f.output, 'features.json')));
  assert.equal(JSON.parse(await readFile(join(f.output, 'receipt.json'))).status, 'unknown');
  assert.equal(f.providerRequests.length, 1);
});

test('unsafe strings, extra answer names and probability names never enter replay evidence', async t => {
  const f = await fixture(t);
  f.state.mutateResponse = payload => {
    payload.answers.sleeves.confidence = 'DO_NOT_CAPTURE_SECRET';
    payload.answers['DO_NOT_CAPTURE_ANSWER_NAME'] = 'DO_NOT_CAPTURE_TEXT';
    payload.answers.sleeves.probabilities['DO_NOT_CAPTURE_PROBABILITY_NAME'] = 'DO_NOT_CAPTURE_VALUE';
  };
  assert.equal((await f.run('reserve')).code, 0);
  const result = await f.run('probe'); assert.equal(result.code, 1);
  const bytes = await readFile(join(f.output, 'response.json'), 'utf8'), snapshot = JSON.parse(bytes);
  assert.doesNotMatch(bytes + result.stdout + result.stderr, /DO_NOT_CAPTURE|MUST_NOT_USE|data_base64|Bearer/);
  assert.equal(snapshot.shape.extraAnswerCount, 1);
  assert.equal(snapshot.shape.expectedAnswers.sleeves.confidence.type, 'string');
  assert.equal(snapshot.shape.expectedAnswers.sleeves.extraProbabilityCount, 1);
  assert.throws(() => featureAnswer(snapshot.replay, f.providerRequests[0].body), /Invalid JEV feature response/);
});

test('nonfinite JSON numbers retain their observed type without passing the usage guard', async t => {
  const f = await fixture(t);
  f.state.mutateResponse = payload => { payload.usage.input_tokens = '__OVERFLOW__'; };
  f.state.rawResponse = json => json.replace('"__OVERFLOW__"', '1e999');
  assert.equal((await f.run('reserve')).code, 0);
  assert.equal((await f.run('probe')).code, 1);
  const snapshot = JSON.parse(await readFile(join(f.output, 'response.json')));
  assert.equal(snapshot.shape.inputTokens.type, 'number'); assert.equal(snapshot.shape.inputTokens.finite, false);
  assert.equal(snapshot.replay.usage.input_tokens, '__nonfinite_number__');
  assert.throws(() => featureAnswer(snapshot.replay, f.providerRequests[0].body), /Invalid JEV feature response/);
});

test('bounded JEV model identifiers remain inspectable while secret-like strings are redacted', async t => {
  for (const model of ['jev', 'jev-1.14', 'jev-1.14.0', 'jev-999.999.999', 'jev-secret-like/key', 'jev-1.14.0-DO_NOT_CAPTURE_SECRET']) {
    const f = await fixture(t); f.state.mutateResponse = payload => { payload.model = model; };
    assert.equal((await f.run('reserve')).code, 0);
    const result = await f.run('probe'), snapshot = JSON.parse(await readFile(join(f.output, 'response.json')));
    const allowed = ['jev', 'jev-1.14', 'jev-1.14.0', 'jev-999.999.999'].includes(model);
    assert.equal(snapshot.replay.model, allowed ? model : '__unrecognized_string__');
    if (!allowed) assert.ok(!JSON.stringify(snapshot).includes(model));
    if (model === 'jev-1.14.0') {
      assert.equal(result.code, 0); assert.equal(featureAnswer(snapshot.replay, f.providerRequests[0].body).inputTokens, 1000);
    } else {
      assert.equal(result.code, 1); assert.throws(() => featureAnswer(snapshot.replay, f.providerRequests[0].body), /Invalid JEV feature response/);
    }
    assert.equal(f.providerRequests.length, 1);
  }
});

test('large malformed probability objects are bounded and remain invalid in replay', async t => {
  const f = await fixture(t);
  f.state.mutateResponse = payload => {
    for (let i = 0; i < 2000; i++) payload.answers.sleeves.probabilities[`DO_NOT_CAPTURE_${i}`] = i;
  };
  assert.equal((await f.run('reserve')).code, 0); assert.equal((await f.run('probe')).code, 1);
  const bytes = await readFile(join(f.output, 'response.json'), 'utf8'), snapshot = JSON.parse(bytes);
  assert.ok(Buffer.byteLength(bytes) <= 65536); assert.doesNotMatch(bytes, /DO_NOT_CAPTURE/);
  assert.equal(snapshot.shape.expectedAnswers.sleeves.extraProbabilityCount, 2000);
  assert.equal(snapshot.shape.expectedAnswers.sleeves.extraKeysTruncated, true);
  assert.throws(() => featureAnswer(snapshot.replay, f.providerRequests[0].body), /Invalid JEV feature response/);
});

test('a non-JSON error envelope saves only shape-free transport evidence, not its message', async t => {
  const f = await fixture(t); f.state.httpStatus = 500; f.state.rawResponse = () => 'DO_NOT_CAPTURE_PRIVATE_ERROR';
  assert.equal((await f.run('reserve')).code, 0);
  const result = await f.run('probe'); assert.equal(result.code, 1);
  const bytes = await readFile(join(f.output, 'response.json'), 'utf8'), snapshot = JSON.parse(bytes);
  assert.equal(snapshot.httpStatus, 500); assert.equal(snapshot.parsedJson, false);
  assert.doesNotMatch(bytes + result.stdout + result.stderr, /DO_NOT_CAPTURE/);
  const receipt = JSON.parse(await readFile(join(f.output, 'receipt.json')));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.budget.aggregateReservedMicrousd, 200000);
  assert.equal(f.providerRequests.length, 1);
});

test('tampered prior ledger or prepared bytes cannot reserve the diagnostic', async t => {
  const f = await fixture(t);
  await writeFile(join(f.prior, 'output/ledger.json'), f.ledgerBytes + '\n');
  const changedLedger = await f.run('reserve'); assert.equal(changedLedger.code, 1); assert.match(changedLedger.stderr, /artifact hash mismatch/);
  await writeFile(join(f.prior, 'output/ledger.json'), f.ledgerBytes);
  await writeFile(join(f.prior, 'output/prepared.png'), Buffer.from('wrong-image'));
  const changedImage = await f.run('reserve'); assert.equal(changedImage.code, 1); assert.match(changedImage.stderr, /artifact hash mismatch/);
  assert.deepEqual(f.requests, []); assert.equal(f.providerRequests.length, 0);
});

test('wrong manual context, missing consent and missing exact fitting check cannot reserve', async t => {
  const f = await fixture(t);
  for (const overrides of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_WORKFLOW_REF: 'tbb/saint-look/.github/workflows/fitting-live-trial.yml@refs/heads/main' }]) {
    assert.equal((await f.run('reserve', overrides)).code, 1);
  }
  assert.equal((await f.run('reserve', {}, { approve_single_probe: 'false' })).code, 1);
  assert.equal((await f.run('reserve', {}, { diagnostic_plan_sha256: 'b'.repeat(64) })).code, 1);
  assert.equal((await f.run('reserve', {}, { price_checked_at: '2020-01-01T00:00:00Z' })).code, 1);
  assert.deepEqual(f.requests, []);
  f.state.checked = false;
  assert.match((await f.run('reserve')).stderr, /No successful fitting checks/);
  assert.equal(f.state.claimed, false); assert.equal(f.providerRequests.length, 0);
});

test('the original reservation stays intact and a new run cannot reserve another diagnostic', async t => {
  const f = await fixture(t); f.state.originalRefSha = 'b'.repeat(40);
  assert.equal((await f.run('reserve')).code, 1); assert.equal(f.state.claimed, false);
  delete f.state.originalRefSha;
  assert.equal((await f.run('reserve')).code, 0);
  const next = await f.run('reserve', { GITHUB_RUN_ID: '501' }, {}, join(f.dir, 'fresh-output'));
  assert.equal(next.code, 1); assert.match(next.stderr, /reservation already exists/);
  const mutations = f.requests.filter(r => r.method !== 'GET');
  assert.equal(mutations.length, 2);
  assert.ok(mutations.every(r => r.method === 'POST' && r.body.ref === marker));
  assert.equal(f.providerRequests.length, 0);
});

test('an admitted fixture never falls back to live and a copied admission cannot authorize a new run', async t => {
  const f = await fixture(t); assert.equal((await f.run('reserve')).code, 0);
  assert.match((await f.run('probe', { SAINT_LOOK_JEV_DIAGNOSTIC_TEST_ORIGIN: '' })).stderr, /no live fallback/);
  assert.match((await f.run('probe', { GITHUB_RUN_ID: '502' })).stderr, /admission does not cover/);
  assert.match((await f.run('probe', { GITHUB_RUN_ATTEMPT: '2' })).stderr, /first manual workflow run/);
  await writeFile(join(f.output, 'prepared.png'), 'changed');
  assert.match((await f.run('probe')).stderr, /artifact hash mismatch/);
  assert.equal(f.providerRequests.length, 0);
});

test('concurrent invocations of the admitted probe send only one JEV POST', async t => {
  const f = await fixture(t); assert.equal((await f.run('reserve')).code, 0);
  const results = await Promise.all([f.run('probe'), f.run('probe')]);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  assert.equal(f.providerRequests.length, 1);
  assert.equal(await readFile(join(f.output, 'prior-ledger.json'), 'utf8'), f.ledgerBytes);
});

test('diagnostic workflow fetches the original contract and gives only JEV credentials to its probe step', async () => {
  const text = await readFile(new URL('../../.github/workflows/fitting-jev-diagnostic.yml', import.meta.url), 'utf8');
  assert.match(text, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(text, /^  (push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(text, /group: fitting-trial-45\n  cancel-in-progress: false/);
  const [reserve, probe] = text.split('\n  probe:\n');
  assert.doesNotMatch(reserve, /secrets\./); assert.match(reserve, /contents: write/);
  assert.match(reserve, /fetch-depth: 0/); assert.match(probe, /fetch-depth: 0/);
  assert.match(probe, /needs: reserve/); assert.doesNotMatch(probe, /contents: write/);
  assert.deepEqual([...probe.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['TYPESAFE_API_KEY']);
  assert.match(probe, /if: always\(\)/); assert.match(probe, /response\.json/); assert.match(probe, /receipt\.json/);
  assert.doesNotMatch(text, /trial\.mjs --live|--recover-lock|git\/refs.*DELETE|cancel-in-progress: true/);
});
