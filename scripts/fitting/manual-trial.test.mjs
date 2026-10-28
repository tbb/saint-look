import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { sharp, sha256, loadPlan } from './trial-plan.mjs';

const command = new URL('./manual-trial.mjs', import.meta.url).pathname;
const marker = 'refs/tags/fitting-trial-45-reserved';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fitting-manual-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(dir, 'checked.txt'), 'source'); git('add', '.'); git('commit', '-m', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#445566ff' } }).png().toBuffer();
  await writeFile(join(dir, 'image.png'), image);
  await writeFile(join(dir, 'template.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="560"><rect width="360" height="560" fill="white"/></svg>');
  const plan = JSON.parse(await readFile(new URL('./plan.json', import.meta.url)));
  plan.template = 'template.svg'; plan.combinations = [];
  plan.items = Array.from({ length: 8 }, (_, i) => ({ id: `shirt-${i}`, category: 'top', photos: ['image.png'], photoRoles: ['front'],
    sources: [{ path: 'image.png', sha256: sha256(image), source: 'Local fixture', author: 'Test', license: 'Test fixture' }] }));
  const planPath = join(dir, 'plan.json'); await writeFile(planPath, JSON.stringify(plan));
  const fingerprint = (await loadPlan(planPath)).planSha256;
  const inputs = { revision, plan_sha256: fingerprint, budget_usd: '5', price_checked_at: new Date().toISOString(),
    approval_reference: 'https://github.com/tbb/saint-look/issues/45#issuecomment-123', approve_paid_calls: 'true', reviewed_terms: 'true' };
  const eventPath = join(dir, 'event.json');
  const requests = [], state = { claimed: false, checked: true };
  const api = createServer(async (request, response) => {
    if (request.url === '/') { response.writeHead(404); response.end(); return; }
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    requests.push({ method: request.method, path: request.url, body: bytes ? JSON.parse(bytes) : null });
    assert.equal(request.headers.authorization, 'Bearer fixture-github-token');
    response.setHeader('Content-Type', 'application/json');
    const answer = (code, value) => { response.writeHead(code); response.end(JSON.stringify(value)); };
    if (request.url.endsWith('/git/ref/heads/main')) return answer(200, { object: { sha: revision } });
    if (request.url.includes('/fitting-experiment.yml/runs?')) return answer(200, { workflow_runs: state.checked ? [{ id: 123, head_sha: revision, head_branch: 'main', event: state.checkEvent || 'push', path: '.github/workflows/fitting-experiment.yml', status: 'completed', conclusion: 'success', head_repository: { full_name: 'tbb/saint-look' } }] : [] });
    if (request.url.endsWith('/123/jobs?filter=latest&per_page=100')) return answer(200, { jobs: [{ name: 'fitting-local', status: 'completed', conclusion: 'success' }] });
    if (request.method === 'POST' && request.url.endsWith('/git/refs')) {
      if (state.claimed) return answer(422, { message: 'Reference already exists' });
      state.claimed = true;
      if (state.loseClaimResponse) return answer(500, { message: 'Uncertain result' });
      return answer(state.claimStatus || 201, { ref: marker, object: { sha: revision } });
    }
    answer(404, {});
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.closeAllConnections(); api.close(); });
  const env = { ...process.env, NODE_ENV: 'test', CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'tbb/saint-look', GITHUB_ACTOR: 'tbb', GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: revision, GITHUB_WORKFLOW_SHA: revision, GITHUB_WORKFLOW_REF: 'tbb/saint-look/.github/workflows/fitting-live-trial.yml@refs/heads/main',
    GITHUB_JOB: 'reserve', GITHUB_EVENT_PATH: eventPath, GH_TOKEN: 'fixture-github-token', SAINT_LOOK_FITTING_TEST_API: `http://127.0.0.1:${api.address().port}` };
  async function run({ overrides = {}, inputOverrides = {}, output = join(dir, 'attempt') } = {}) {
    await writeFile(eventPath, JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'tbb/saint-look' }, sender: { login: 'tbb' }, inputs: { ...inputs, ...inputOverrides } }));
    return new Promise(resolve => {
      const child = spawn(process.execPath, [command, planPath, output], { cwd: dir, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
      child.on('close', code => resolve({ code, stdout, stderr, output }));
    });
  }
  return { dir, revision, fingerprint, inputs, env, planPath, run, requests, state, git };
}

function trial(f, output, overrides = {}, extra = []) {
  return new Promise(resolve => {
    const args = [new URL('./trial.mjs', import.meta.url).pathname, '--live', '--plan', f.planPath,
      '--out', join(output, 'output'), '--approval', join(output, 'approval.json'), '--manual-admission', join(output, 'admission.json'), ...extra];
    const child = spawn(process.execPath, args, { cwd: f.dir, env: { ...f.env, GITHUB_JOB: 'experiment',
      FAL_KEY: '', TYPESAFE_API_KEY: '', PHOTOROOM_SANDBOX_API_KEY: '', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('an approved checked manual run reserves the trial once before producing its admission', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.requests.filter(r => r.method === 'POST'), [{ method: 'POST', path: '/repos/tbb/saint-look/git/refs', body: { ref: marker, sha: f.revision } }]);
  const approval = JSON.parse(await readFile(join(result.output, 'approval.json')));
  assert.equal(approval.budgetMicrousd, 5_000_000);
  assert.equal(approval.planSha256, f.fingerprint);
  assert.deepEqual(approval.maxCalls, { preparation: 12, attributes: 14, generation: 28, segmentation: 28 });
  const admission = JSON.parse(await readFile(join(result.output, 'admission.json')));
  assert.equal(admission.runId, '456'); assert.equal(admission.revision, f.revision);
  assert.equal(admission.reservationRef, marker);
  assert.doesNotMatch(JSON.stringify({ approval, admission }), /fixture-github-token/);
});

test('only the admitted manual executor reaches the credential check; ordinary CI stays blocked', async t => {
  const f = await fixture(t), prepared = await f.run();
  assert.equal(prepared.code, 0, prepared.stderr);
  const result = await trial(f, prepared.output);
  assert.equal(result.code, 1); assert.match(result.stderr, /Provider credentials missing/);
  for (const overrides of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_WORKFLOW_REF: 'tbb/saint-look/.github/workflows/ci.yml@refs/heads/main' }, { GITHUB_RUN_ATTEMPT: '2' }]) {
    const refused = await trial(f, prepared.output, overrides);
    assert.equal(refused.code, 1); assert.match(refused.stderr, /Live execution is forbidden in CI/);
  }
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('PR, push, other workflow, branch, repository and rerun cannot reserve a paid trial', async t => {
  const f = await fixture(t);
  for (const overrides of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REPOSITORY: 'fork/saint-look' },
    { GITHUB_WORKFLOW_REF: 'tbb/saint-look/.github/workflows/ci.yml@refs/heads/main' },
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_WORKFLOW_SHA: 'a'.repeat(40) }, { GITHUB_JOB: 'fitting-local' }]) {
    const result = await f.run({ overrides });
    assert.equal(result.code, 1); assert.match(result.stderr, /Live execution is forbidden in CI/);
  }
  assert.deepEqual(f.requests, []);
});

test('wrong plan, revision, budget, stale prices and missing assent fail before reservation', async t => {
  const f = await fixture(t);
  for (const inputOverrides of [{ plan_sha256: 'a'.repeat(64) }, { revision: 'a'.repeat(40) }, { budget_usd: '10' },
    { price_checked_at: '2020-01-01T00:00:00Z' }, { price_checked_at: '2999-01-01T00:00:00Z' },
    { approve_paid_calls: 'false' }, { reviewed_terms: 'false' }, { approval_reference: '' }]) {
    const result = await f.run({ inputOverrides });
    assert.equal(result.code, 1); assert.match(result.stderr, /manual approval|fingerprint/);
  }
  assert.deepEqual(f.requests, []);
});

test('unchecked source and a different checkout cannot reserve a trial', async t => {
  const f = await fixture(t); f.state.checked = false;
  const unchecked = await f.run();
  assert.equal(unchecked.code, 1); assert.match(unchecked.stderr, /No successful fitting checks/);
  assert.equal(f.state.claimed, false);
  const wrongCheckout = await f.run({ overrides: { GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40) }, inputOverrides: { revision: 'a'.repeat(40) } });
  assert.match(wrongCheckout.stderr, /Checkout differs/);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('a reservation response without an explicit create status cannot admit the run', async t => {
  const f = await fixture(t); f.state.claimStatus = 200;
  const result = await f.run();
  assert.equal(result.code, 1); assert.match(result.stderr, /reservation/);
  await assert.rejects(access(join(result.output, 'admission.json')));
});

test('manually run local fitting checks on exact main are sufficient, but PR checks are not', async t => {
  const f = await fixture(t); f.state.checkEvent = 'pull_request';
  const rejected = await f.run();
  assert.equal(rejected.code, 1); assert.match(rejected.stderr, /No successful fitting checks/);
  assert.equal(f.state.claimed, false);
  f.state.checkEvent = 'workflow_dispatch';
  const accepted = await f.run();
  assert.equal(accepted.code, 0, accepted.stderr);
});

test('a new run and new output directory cannot reset the reserved trial budget', async t => {
  const f = await fixture(t), first = await f.run();
  assert.equal(first.code, 0, first.stderr);
  const second = await f.run({ overrides: { GITHUB_RUN_ID: '789' }, output: join(f.dir, 'new-directory') });
  assert.equal(second.code, 1); assert.match(second.stderr, /reservation failed or already exists/);
  await assert.rejects(access(join(second.output, 'admission.json')));
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
});

test('uncertain reservation response remains consumed even without an admission artifact', async t => {
  const f = await fixture(t); f.state.loseClaimResponse = true;
  const first = await f.run();
  assert.equal(first.code, 1); assert.equal(f.state.claimed, true);
  await assert.rejects(access(join(first.output, 'admission.json')));
  f.state.loseClaimResponse = false;
  const second = await f.run({ overrides: { GITHUB_RUN_ID: '790' }, output: join(f.dir, 'another-directory') });
  assert.equal(second.code, 1); assert.match(second.stderr, /reservation failed or already exists/);
  await assert.rejects(access(join(second.output, 'admission.json')));
});

test('concurrent manual reservations produce at most one admitted executor', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.run({ output: join(f.dir, 'concurrent-a') }),
    f.run({ overrides: { GITHUB_RUN_ID: '791' }, output: join(f.dir, 'concurrent-b') })]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  assert.equal(f.state.claimed, true);
});

test('admission cannot move between run, approval, fingerprint or output directory', async t => {
  const f = await fixture(t), prepared = await f.run();
  assert.equal(prepared.code, 0, prepared.stderr);
  for (const overrides of [{ GITHUB_RUN_ID: '999' }, { GITHUB_ACTOR: 'another-user' }]) {
    assert.match((await trial(f, prepared.output, overrides)).stderr, /Manual admission does not cover/);
  }
  const path = join(prepared.output, 'admission.json'), original = JSON.parse(await readFile(path));
  for (const change of [{ revision: 'a'.repeat(40) }, { planSha256: 'b'.repeat(64) }, { outputDirectory: '/another/output' },
    { approvalSha256: 'c'.repeat(64) }, { reservationRef: 'refs/tags/another-trial' }]) {
    await writeFile(path, JSON.stringify({ ...original, ...change }));
    assert.match((await trial(f, prepared.output)).stderr, /Manual admission does not cover/);
  }
});

test('manual workflow separates reservation permissions and provider credentials from ordinary CI', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/fitting-live-trial.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(workflow, /group: fitting-trial-45\n  cancel-in-progress: false/);
  const [reserve, experiment] = workflow.split('\n  experiment:\n');
  assert.doesNotMatch(reserve, /secrets\./);
  assert.match(reserve, /contents: write/);
  assert.match(experiment, /needs: reserve/); assert.doesNotMatch(experiment, /contents: write/);
  const secretReferences = [...experiment.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]);
  assert.deepEqual(secretReferences.sort(), ['FAL_KEY', 'PHOTOROOM_SANDBOX_API_KEY', 'TYPESAFE_API_KEY']);
  assert.match(experiment, /if: always\(\)/); assert.match(experiment, /output\/\*\.json/);
  const local = await readFile(new URL('../../.github/workflows/fitting-experiment.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(local, /secrets\.|--live/);
  assert.match(local, /node --test scripts\/fitting\/\*\.test\.mjs/);
});
