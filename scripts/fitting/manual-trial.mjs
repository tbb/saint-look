// A public CLI boundary: verify a manual dispatch, then atomically reserve the one #45 trial.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadPlan, sha256 } from './trial-plan.mjs';
import { manualContext, reservationRef, continuationRef } from './trial-admission.mjs';
import { readContinuation, verifyContinuationHistory, writeContinuation } from './trial-continuation.mjs';

function apiOrigin() {
  const configured = process.env.SAINT_LOOK_FITTING_TEST_API;
  if (!configured) return 'https://api.github.com';
  const url = new URL(configured);
  if (process.env.NODE_ENV !== 'test' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid local GitHub fixture origin');
  return url.origin;
}

async function github(path, body) {
  const response = await fetch(apiOrigin() + path, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok || (body && response.status !== 201)) throw new Error(body ? 'Trial reservation failed or already exists; stop and reconcile without retrying'
    : 'GitHub verification failed');
  return response.json();
}

async function main() {
  const context = manualContext('reserve');
  const [planPath, directory, manifestPath, evidenceDirectory, ...extra] = process.argv.slice(2);
  const continuation = context.workflowRef.includes('/fitting-continuation.yml@');
  const selectedRef = continuation ? continuationRef : reservationRef;
  if (!planPath || !directory || extra.length || (continuation ? !manifestPath || !evidenceDirectory : manifestPath || evidenceDirectory)
    || !process.env.GH_TOKEN) throw new Error('Plan, fresh output directory and GitHub verification token required');
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')), input = event.inputs || {};
  const confirmed = value => value === true || value === 'true';
  if (event.repository?.full_name !== context.repository || event.sender?.login !== context.actor
    || !['main', 'refs/heads/main'].includes(event.ref) || input.revision !== context.revision
    || input.budget_usd !== '5' || !confirmed(input.approve_paid_calls) || !confirmed(input.reviewed_terms)
    || !/^https:\/\/github\.com\/tbb\/saint-look\/issues\/45#issuecomment-[0-9]+$/.test(input.approval_reference || '')
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(input.price_checked_at || '')
    || !Number.isFinite(Date.parse(input.price_checked_at)) || Date.now() - Date.parse(input.price_checked_at) > 86400000
    || Date.parse(input.price_checked_at) > Date.now()) throw new Error('Explicit current manual approval required');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', 'HEAD') !== context.revision) throw new Error('Checkout differs from approved revision');
  git('diff', '--exit-code', 'HEAD', '--', 'scripts/fitting', 'backend/src/jev.mjs', 'backend/package-lock.json',
    'shared/wardrobe-taxonomy.json', '.github/workflows/fitting-live-trial.yml', '.github/workflows/fitting-continuation.yml');
  const loaded = await loadPlan(planPath);
  if (input.plan_sha256 !== loaded.planSha256 || loaded.plan.items.length < 8 || loaded.reservedMicrousd > 5_000_000) throw new Error('Manual plan fingerprint or dataset does not match');
  const imported = continuation ? await readContinuation(manifestPath, evidenceDirectory, planPath, loaded) : null;
  if (imported && input.continuation_sha256 !== imported.manifestSha256) throw new Error('Continuation manifest fingerprint mismatch');
  const api = `/repos/${context.repository}`;
  const mainRef = await github(`${api}/git/ref/heads/main`);
  if (mainRef.object?.sha !== context.revision) throw new Error('Approved revision is not current main');
  if (imported) await verifyContinuationHistory(imported, github);
  const checks = await github(`${api}/actions/workflows/fitting-experiment.yml/runs?head_sha=${context.revision}&branch=main&status=success&per_page=100`);
  const checked = checks.workflow_runs?.find(run => run.head_sha === context.revision && run.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run.event) && run.path === '.github/workflows/fitting-experiment.yml' && run.status === 'completed'
    && run.conclusion === 'success' && run.head_repository?.full_name === context.repository && Number.isSafeInteger(run.id));
  if (!checked) throw new Error('No successful fitting checks for the exact main revision');
  const jobs = await github(`${api}/actions/runs/${checked.id}/jobs?filter=latest&per_page=100`);
  const fitting = jobs.jobs?.filter(job => job.name === 'fitting-local') || [];
  if (fitting.length !== 1 || fitting[0].status !== 'completed' || fitting[0].conclusion !== 'success') throw new Error('Fitting checks did not pass');
  const destination = resolve(directory), outputDirectory = join(destination, 'output');
  const approval = { mode: 'live', planSha256: loaded.planSha256, outputDirectory, budgetMicrousd: 5_000_000,
    maxCalls: { preparation: 12, attributes: 14, generation: 28, segmentation: 28 }, sourceTermsReviewed: true,
    providerTermsReviewed: true, paidCallsAllowed: true, approvedBy: context.actor, planReference: input.approval_reference,
    priceCheckedAt: input.price_checked_at };
  await mkdir(destination, { mode: 0o700 });
  const approvalBytes = JSON.stringify(approval, null, 2);
  await writeFile(join(destination, 'approval.json'), approvalBytes, { flag: 'wx', mode: 0o600 });
  const initialLedgerSha256 = imported ? await writeContinuation(imported, destination,
    { mode: 'live', planSha256: loaded.planSha256, approvalSha256: sha256(approvalBytes) }) : null;
  // Never delete or replace this fixed ref. A lost runner/response still consumes the admission.
  const claimed = await github(`${api}/git/refs`, { ref: selectedRef, sha: context.revision });
  if (claimed.ref !== selectedRef || claimed.object?.sha !== context.revision) throw new Error('Uncertain trial reservation; stop and reconcile');
  const admission = { version: 1, ...context, reservationRef: selectedRef, planSha256: loaded.planSha256,
    approvalSha256: sha256(approvalBytes), outputDirectory, fittingChecksRunId: checked.id,
    ...(imported ? { initialLedgerSha256, continuationManifestSha256: imported.manifestSha256 } : {}) };
  await writeFile(join(destination, 'admission.json'), JSON.stringify(admission, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ reservationRef: selectedRef, runId: context.runId, revision: context.revision, planSha256: loaded.planSha256 }));
}

main().catch(error => {
  console.error(error instanceof Error && !error.message.includes('Command failed') ? error.message : 'Manual trial verification failed');
  process.exitCode = 1;
});
