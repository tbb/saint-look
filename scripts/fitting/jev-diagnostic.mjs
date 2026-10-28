// One additional, explicitly admitted JEV POST. This never resumes trial.mjs.
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256, sharp } from './trial-plan.mjs';
import { featureRequest, featureAnswer } from './trial-jev.mjs';
import { exchange, fixtureOrigin } from './trial-http.mjs';
import { durableWrite } from './trial-ledger.mjs';
import { diagnosticResponse } from './jev-diagnostic-response.mjs';

const repository = 'tbb/saint-look', workflow = '.github/workflows/fitting-jev-diagnostic.yml';
const marker = 'refs/tags/fitting-trial-45-jev-diagnostic-1', originalMarker = 'refs/tags/fitting-trial-45-reserved';
const contractFiles = ['scripts/fitting/trial-jev.mjs', 'scripts/fitting/trial-http.mjs', 'backend/src/jev.mjs', 'backend/package-lock.json', 'shared/wardrobe-taxonomy.json'];
const budget = { batchLimitMicrousd: 5_000_000, priorConservativeReserveMicrousd: 100_000,
  diagnosticReserveMicrousd: 100_000, aggregateReservedMicrousd: 200_000,
  countsBefore: { preparation: 1, attributes: 1, generation: 0, segmentation: 0 },
  countsAfter: { preparation: 1, attributes: 2, generation: 0, segmentation: 0 },
  maxCalls: { preparation: 12, attributes: 14, generation: 28, segmentation: 28 }, actualCostMicrousd: null };
const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });

function context(job) {
  const e = process.env;
  if (e.GITHUB_ACTIONS !== 'true' || e.GITHUB_EVENT_NAME !== 'workflow_dispatch' || e.GITHUB_REF !== 'refs/heads/main'
    || e.GITHUB_REPOSITORY !== repository || e.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/main`
    || e.GITHUB_JOB !== job || e.GITHUB_RUN_ATTEMPT !== '1' || !/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID || '')
    || !/^[a-f0-9]{40}$/.test(e.GITHUB_SHA || '') || e.GITHUB_WORKFLOW_SHA !== e.GITHUB_SHA
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(e.GITHUB_ACTOR || '')) throw new Error('Diagnostic requires its first manual workflow run on main');
  if (git('rev-parse', 'HEAD').toString().trim() !== e.GITHUB_SHA) throw new Error('Diagnostic checkout differs from admitted revision');
  git('diff', '--exit-code', 'HEAD');
  return { repository, workflow, runId: e.GITHUB_RUN_ID, runAttempt: 1, revision: e.GITHUB_SHA, actor: e.GITHUB_ACTOR };
}

function localGithubOrigin() {
  const value = process.env.SAINT_LOOK_FITTING_TEST_API;
  if (!value) return null;
  if (process.env.NODE_ENV !== 'test') throw new Error('Invalid diagnostic fixture context');
  return fixtureOrigin(value);
}
async function github(path, body) {
  if (!process.env.GH_TOKEN) throw new Error('GitHub verification token required');
  const response = await fetch((localGithubOrigin() || 'https://api.github.com') + `/repos/${repository}` + path, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok || (body && response.status !== 201)) throw new Error(body
    ? 'Diagnostic reservation already exists or is uncertain; reconcile without retry'
    : 'Diagnostic GitHub verification failed');
  return response.json();
}

async function baseline(planPath, prior, copied = false, verifyContract = true) {
  const bytes = await readFile(planPath), plan = JSON.parse(bytes);
  const digestKeys = ['originalPlanSha256', 'originalApprovalSha256', 'originalAdmissionSha256', 'originalLedgerSha256', 'preparedSha256', 'sourceSha256', 'normalizedSourceSha256'];
  if (plan.version !== 1 || plan.originalRunId !== '40677633168' || !/^[a-f0-9]{40}$/.test(plan.originalRevision || '')
    || !digestKeys.every(key => /^[a-f0-9]{64}$/.test(plan[key] || '')) || plan.sourcePath !== 'scripts/fitting/fixtures/white-tee.png'
    || !/^[a-zA-Z0-9-]+\.png$/.test(plan.preparedFile || '')) throw new Error('Unsupported diagnostic baseline');
  for (const file of verifyContract ? contractFiles : []) {
    if (sha256(await readFile(file)) !== sha256(git('show', `${plan.originalRevision}:${file}`))) throw new Error('Original JEV request or validation contract changed');
  }
  const ledgerBytes = await readFile(join(prior, copied ? 'prior-ledger.json' : 'output/ledger.json'));
  const approvalBytes = await readFile(join(prior, copied ? 'prior-approval.json' : 'approval.json'));
  const admissionBytes = await readFile(join(prior, copied ? 'prior-admission.json' : 'admission.json'));
  const prepared = await readFile(join(prior, copied ? 'prepared.png' : `output/${plan.preparedFile}`));
  const source = await readFile(plan.sourcePath);
  if (sha256(ledgerBytes) !== plan.originalLedgerSha256 || sha256(approvalBytes) !== plan.originalApprovalSha256
    || sha256(admissionBytes) !== plan.originalAdmissionSha256 || sha256(prepared) !== plan.preparedSha256
    || sha256(source) !== plan.sourceSha256) throw new Error('Diagnostic baseline artifact hash mismatch');
  const ledger = JSON.parse(ledgerBytes), approval = JSON.parse(approvalBytes), admitted = JSON.parse(admissionBytes);
  const prepKey = `source-${plan.sourceSha256}/preparation`, attributesKey = 'white-tee/single/attributes';
  const operations = ledger.operations, prep = operations?.[prepKey], attributes = operations?.[attributesKey];
  if (ledger.version !== 1 || ledger.mode !== 'live' || ledger.planSha256 !== plan.originalPlanSha256
    || ledger.approvalSha256 !== plan.originalApprovalSha256 || !operations || Object.keys(operations).length !== 2
    || prep?.key !== prepKey || prep.stage !== 'preparation' || prep.status !== 'completed' || prep.sandbox !== true
    || prep.reservedMicrousd !== 0 || prep.sha256 !== plan.preparedSha256 || prep.sourceSha256 !== plan.normalizedSourceSha256
    || prep.artifact !== plan.preparedFile || attributes?.key !== attributesKey || attributes.stage !== 'attributes'
    || attributes.status !== 'unknown' || attributes.reservedMicrousd !== 2753 || attributes.error !== 'Invalid JEV feature response'
    || attributes.result !== undefined || attributes.requestId !== undefined || attributes.inputTokens !== undefined
    || approval.mode !== 'live' || approval.planSha256 !== plan.originalPlanSha256 || approval.budgetMicrousd !== budget.batchLimitMicrousd
    || !Object.keys(budget.maxCalls).every(key => approval.maxCalls?.[key] === budget.maxCalls[key])
    || admitted.version !== 1 || admitted.runId !== plan.originalRunId || admitted.revision !== plan.originalRevision || admitted.repository !== repository
    || admitted.reservationRef !== originalMarker || admitted.planSha256 !== plan.originalPlanSha256
    || admitted.approvalSha256 !== plan.originalApprovalSha256) throw new Error('Original attempt is not the admitted unresolved JEV-only failure');
  const original = await sharp(source).rotate().png().toBuffer();
  if (sha256(original) !== plan.normalizedSourceSha256) throw new Error('Normalized original no longer matches the completed preparation');
  const metadata = await sharp(prepared, { failOn: 'error', limitInputPixels: 16_000_000 }).metadata();
  if (metadata.format !== 'png' || metadata.width !== prep.width || metadata.height !== prep.height) throw new Error('Prepared image dimensions changed');
  await sharp(prepared, { failOn: 'error', limitInputPixels: 16_000_000 }).raw().toBuffer();
  return { plan, planSha256: sha256(bytes), ledgerBytes, approvalBytes, admissionBytes, prepared, original };
}

function semanticRequest(request) {
  // Asset UUIDs change on every jevRequest. Compare their content through the
  // labeled state instead of claiming byte-for-byte equality with the lost request.
  const images = Object.fromEntries(Object.entries(request.state).sort(([a], [b]) => a.localeCompare(b)).map(([role, ref]) => {
    const asset = request.assets[ref];
    return [role, { type: asset.type, format: asset.format, sha256: sha256(Buffer.from(asset.data_base64, 'base64')) }];
  }));
  return { model: request.model, images, questions: request.questions };
}

async function reserve(planPath, prior, output) {
  const ctx = context('reserve');
  const data = await baseline(planPath, prior);
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')), inputs = event.inputs || {};
  const yes = value => value === true || value === 'true';
  const checkedAt = Date.parse(inputs.price_checked_at);
  if (event.repository?.full_name !== repository || event.sender?.login !== ctx.actor || !['main', 'refs/heads/main'].includes(event.ref)
    || inputs.revision !== ctx.revision || inputs.diagnostic_plan_sha256 !== data.planSha256
    || !yes(inputs.approve_single_probe) || !yes(inputs.reviewed_terms)
    || !/^https:\/\/github\.com\/tbb\/saint-look\/issues\/45#issuecomment-[0-9]+$/.test(inputs.plan_reference || '')
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(inputs.price_checked_at || '')
    || !Number.isFinite(checkedAt) || checkedAt > Date.now() || Date.now() - checkedAt > 86400000) throw new Error('Explicit current single-probe consent required');
  const main = await github('/git/ref/heads/main');
  const oldRef = await github('/git/ref/tags/fitting-trial-45-reserved');
  const oldRun = await github(`/actions/runs/${data.plan.originalRunId}`);
  if (main.object?.sha !== ctx.revision || oldRef.ref !== originalMarker || oldRef.object?.sha !== data.plan.originalRevision
    || String(oldRun.id) !== data.plan.originalRunId || oldRun.head_sha !== data.plan.originalRevision || oldRun.head_branch !== 'main'
    || oldRun.event !== 'workflow_dispatch' || oldRun.path !== '.github/workflows/fitting-live-trial.yml'
    || oldRun.status !== 'completed' || oldRun.conclusion !== 'failure' || oldRun.run_attempt !== 1
    || oldRun.head_repository?.full_name !== repository) throw new Error('Original trial identity or current main could not be verified');
  const checked = await github(`/actions/workflows/fitting-experiment.yml/runs?head_sha=${ctx.revision}&branch=main&status=success&per_page=100`);
  const run = checked.workflow_runs?.find(run => run.head_sha === ctx.revision && run.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run.event) && run.path === '.github/workflows/fitting-experiment.yml'
    && run.status === 'completed' && run.conclusion === 'success' && run.head_repository?.full_name === repository && Number.isSafeInteger(run.id));
  if (!run) throw new Error('No successful fitting checks for diagnostic revision');
  const jobs = await github(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  const fitting = jobs.jobs?.filter(job => job.name === 'fitting-local') || [];
  if (fitting.length !== 1 || fitting[0].status !== 'completed' || fitting[0].conclusion !== 'success') throw new Error('Diagnostic fitting checks did not pass');
  await mkdir(output, { mode: 0o700 });
  for (const [name, bytes] of [['prior-ledger.json', data.ledgerBytes], ['prior-approval.json', data.approvalBytes],
    ['prior-admission.json', data.admissionBytes], ['prepared.png', data.prepared]]) {
    await writeFile(join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  const claim = await github('/git/refs', { ref: marker, sha: ctx.revision });
  if (claim.ref !== marker || claim.object?.sha !== ctx.revision) throw new Error('Uncertain diagnostic reservation; stop without retry');
  const admission = { version: 1, ...ctx, mode: localGithubOrigin() ? 'local-fixture' : 'live', reservationRef: marker,
    originalRunId: data.plan.originalRunId, originalLedgerSha256: data.plan.originalLedgerSha256, diagnosticPlanSha256: data.planSha256,
    outputDirectory: output, budget, priceCheckedAt: inputs.price_checked_at, planReference: inputs.plan_reference, fittingChecksRunId: run.id };
  await writeFile(join(output, 'admission.json'), JSON.stringify(admission, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ reservationRef: marker, runId: ctx.runId, diagnosticPlanSha256: data.planSha256 }));
}

async function probe(planPath, output) {
  const ctx = context('probe'), data = await baseline(planPath, output, true);
  const admissionBytes = await readFile(join(output, 'admission.json')), admission = JSON.parse(admissionBytes);
  if (admission.version !== 1 || !Object.entries(ctx).every(([key, value]) => admission[key] === value)
    || admission.reservationRef !== marker || admission.originalRunId !== data.plan.originalRunId
    || admission.originalLedgerSha256 !== data.plan.originalLedgerSha256 || admission.diagnosticPlanSha256 !== data.planSha256
    || admission.outputDirectory !== output || JSON.stringify(admission.budget) !== JSON.stringify(budget)
    || !Number.isFinite(Date.parse(admission.priceCheckedAt)) || Date.now() - Date.parse(admission.priceCheckedAt) > 86400000
    || Date.parse(admission.priceCheckedAt) > Date.now()) throw new Error('Diagnostic admission does not cover this run or baseline');
  let origin, key;
  if (admission.mode === 'local-fixture') {
    if (process.env.NODE_ENV !== 'test' || !process.env.SAINT_LOOK_JEV_DIAGNOSTIC_TEST_ORIGIN) throw new Error('Diagnostic fixture requires explicit loopback provider; no live fallback');
    origin = fixtureOrigin(process.env.SAINT_LOOK_JEV_DIAGNOSTIC_TEST_ORIGIN); key = 'fixture-jev-key';
  } else {
    if (admission.mode !== 'live' || process.env.SAINT_LOOK_FITTING_TEST_API || process.env.SAINT_LOOK_JEV_DIAGNOSTIC_TEST_ORIGIN) throw new Error('Invalid live diagnostic context');
    origin = 'https://api.typesafe.ai'; key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error('Diagnostic JEV credential missing');
  }
  const request = await featureRequest([data.prepared, data.original], ['prepared_front', 'original_front']);
  const receiptPath = join(output, 'receipt.json');
  const receipt = { version: 1, operation: 'white-tee/single/attributes-diagnostic-1', status: 'reserved',
    originalRunId: data.plan.originalRunId, originalLedgerSha256: data.plan.originalLedgerSha256,
    runId: ctx.runId, revision: ctx.revision, admissionSha256: sha256(admissionBytes), budget,
    requestSha256: sha256(JSON.stringify(request)), semanticRequestSha256: sha256(JSON.stringify(semanticRequest(request))),
    semanticHashMeaning: 'Current request with random asset UUIDs replaced by role-labeled image hashes; original request bytes were not captured',
    requestBytes: Buffer.byteLength(JSON.stringify(request)), questionCount: Object.keys(request.questions).length, startedAt: new Date().toISOString() };
  let reservation;
  try { reservation = await open(receiptPath, 'wx', 0o600); }
  catch { throw new Error('This admitted diagnostic was already started; do not repeat its POST'); }
  try { await reservation.writeFile(JSON.stringify(receipt, null, 2)); await reservation.sync(); }
  finally { await reservation.close(); }
  await durableWrite(receiptPath, JSON.stringify(receipt, null, 2));
  let failed;
  try {
    receipt.status = 'submitted'; receipt.submittedAt = new Date().toISOString();
    await durableWrite(receiptPath, JSON.stringify(receipt, null, 2));
    const response = await exchange(`${origin}/v1/systemone`, { method: 'POST', timeoutMs: 30000,
      headers: { Authorization: `Bearer ${key}`, 'TypeSafe-Danger-Zone-Images': 'true' }, body: request });
    const { snapshot, raw } = diagnosticResponse(response, request);
    const snapshotBytes = JSON.stringify(snapshot);
    await durableWrite(join(output, 'response.json'), snapshotBytes);
    receipt.httpStatus = response.status; receipt.responseSha256 = snapshot.responseSha256; receipt.snapshotSha256 = sha256(snapshotBytes);
    if (response.status < 200 || response.status >= 300) {
      receipt.status = 'failed'; throw new Error('JEV diagnostic returned a non-success HTTP status');
    }
    if (!snapshot.parsedJson) throw new Error('JEV diagnostic response was not JSON');
    const features = featureAnswer(raw, request);
    await durableWrite(join(output, 'features.json'), JSON.stringify(features, null, 2));
    receipt.status = 'completed'; receipt.inputTokens = features.inputTokens;
    receipt.usageCostEstimateMicrousd = features.usageCostEstimateMicrousd;
  } catch (error) {
    if (receipt.status !== 'failed') receipt.status = 'unknown';
    const safeErrors = ['Invalid JEV feature response', 'JEV item suitability not confirmed',
      'JEV diagnostic returned a non-success HTTP status', 'JEV diagnostic response was not JSON'];
    receipt.error = safeErrors.includes(error.message) ? error.message : 'Diagnostic outcome incomplete; inspect the bounded snapshot and reconcile';
    failed = receipt.error;
  }
  receipt.completedAt = new Date().toISOString();
  await durableWrite(receiptPath, JSON.stringify(receipt, null, 2));
  if (failed) throw new Error(failed);
  console.log(JSON.stringify({ status: receipt.status, snapshot: join(output, 'response.json') }));
}

async function replay(planPath, output) {
  // Offline only: a candidate parser can change while the recorded request must
  // still match the measured semantic hash. No admission can reach a POST here.
  const data = await baseline(planPath, output, true, false);
  const receipt = JSON.parse(await readFile(join(output, 'receipt.json'))), bytes = await readFile(join(output, 'response.json'));
  if (bytes.length > 65536 || sha256(bytes) !== receipt.snapshotSha256 || receipt.originalLedgerSha256 !== data.plan.originalLedgerSha256) throw new Error('Replay evidence hash mismatch');
  const request = await featureRequest([data.prepared, data.original], ['prepared_front', 'original_front']);
  if (sha256(JSON.stringify(semanticRequest(request))) !== receipt.semanticRequestSha256) throw new Error('Replay request semantics changed');
  const snapshot = JSON.parse(bytes);
  if (snapshot.httpStatus < 200 || snapshot.httpStatus >= 300 || snapshot.parsedJson !== true) throw new Error('Recorded response was not successful JEV JSON');
  console.log(JSON.stringify(featureAnswer(snapshot.replay, request)));
}

async function main() {
  const [mode, planPath, first, second, ...extra] = process.argv.slice(2);
  if (!planPath || !first || extra.length || !['reserve', 'probe', 'replay'].includes(mode)
    || (mode === 'reserve' ? !second : second !== undefined)) throw new Error('Use reserve <plan> <prior-artifact> <output>, probe <plan> <output> or replay <plan> <output>');
  if (mode === 'reserve') await reserve(planPath, resolve(first), resolve(second));
  else if (mode === 'probe') await probe(planPath, resolve(first));
  else await replay(planPath, resolve(first));
}
main().catch(error => {
  console.error(error instanceof Error && !error.message.includes('Command failed') ? error.message : 'Diagnostic verification failed');
  process.exitCode = 1;
});
