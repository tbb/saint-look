import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './trial-plan.mjs';

export const reservationRef = 'refs/tags/fitting-trial-45-reserved';
export const continuationRef = 'refs/tags/fitting-trial-45-continuation-1';
const repository = 'tbb/saint-look';
const workflowRef = `${repository}/.github/workflows/fitting-live-trial.yml@refs/heads/main`;
const continuationWorkflow = `${repository}/.github/workflows/fitting-continuation.yml@refs/heads/main`;

export function manualContext(job) {
  const e = process.env;
  if (e.GITHUB_ACTIONS !== 'true' || e.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || e.GITHUB_REPOSITORY !== repository || e.GITHUB_REF !== 'refs/heads/main'
    || ![workflowRef, continuationWorkflow].includes(e.GITHUB_WORKFLOW_REF) || e.GITHUB_JOB !== job || e.GITHUB_RUN_ATTEMPT !== '1'
    || !/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID || '') || !/^[a-f0-9]{40}$/.test(e.GITHUB_SHA || '')
    || e.GITHUB_WORKFLOW_SHA !== e.GITHUB_SHA || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(e.GITHUB_ACTOR || '')) {
    throw new Error('Live execution is forbidden in CI except the admitted first manual workflow run on main');
  }
  return { repository, workflowRef: e.GITHUB_WORKFLOW_REF, runId: e.GITHUB_RUN_ID, runAttempt: 1, revision: e.GITHUB_SHA, actor: e.GITHUB_ACTOR };
}

export async function verifyManualAdmission(path, approvalBytes, planSha256, outputDirectory) {
  const context = manualContext('experiment');
  const admission = JSON.parse(await readFile(path, 'utf8'));
  const continuation = context.workflowRef === continuationWorkflow;
  if (admission.version !== 1 || admission.reservationRef !== (continuation ? continuationRef : reservationRef)
    || !Object.entries(context).every(([key, value]) => admission[key] === value)
    || admission.approvalSha256 !== sha256(approvalBytes) || admission.planSha256 !== planSha256
    || admission.outputDirectory !== outputDirectory) throw new Error('Manual admission does not cover this run, approval, plan or directory');
  if (continuation) {
    if (!/^[a-f0-9]{64}$/.test(admission.initialLedgerSha256 || '')
      || sha256(await readFile(join(outputDirectory, 'ledger.json'))) !== admission.initialLedgerSha256) throw new Error('Continuation seed ledger changed or already executed');
    // This run gets one executor even when its seed has no completed new operation.
    const marker = await open(join(outputDirectory, 'continuation-started.json'), 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify({ runId: context.runId })); await marker.sync(); } finally { await marker.close(); }
  }
}
