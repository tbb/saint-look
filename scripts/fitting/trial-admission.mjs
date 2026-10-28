import { readFile } from 'node:fs/promises';
import { sha256 } from './trial-plan.mjs';

export const reservationRef = 'refs/tags/fitting-trial-45-reserved';
const repository = 'tbb/saint-look';
const workflowRef = `${repository}/.github/workflows/fitting-live-trial.yml@refs/heads/main`;

export function manualContext(job) {
  const e = process.env;
  if (e.GITHUB_ACTIONS !== 'true' || e.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || e.GITHUB_REPOSITORY !== repository || e.GITHUB_REF !== 'refs/heads/main'
    || e.GITHUB_WORKFLOW_REF !== workflowRef || e.GITHUB_JOB !== job || e.GITHUB_RUN_ATTEMPT !== '1'
    || !/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID || '') || !/^[a-f0-9]{40}$/.test(e.GITHUB_SHA || '')
    || e.GITHUB_WORKFLOW_SHA !== e.GITHUB_SHA || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(e.GITHUB_ACTOR || '')) {
    throw new Error('Live execution is forbidden in CI except the admitted first manual workflow run on main');
  }
  return { repository, workflowRef, runId: e.GITHUB_RUN_ID, runAttempt: 1, revision: e.GITHUB_SHA, actor: e.GITHUB_ACTOR };
}

export async function verifyManualAdmission(path, approvalBytes, planSha256, outputDirectory) {
  const context = manualContext('experiment');
  const admission = JSON.parse(await readFile(path, 'utf8'));
  if (admission.version !== 1 || admission.reservationRef !== reservationRef
    || !Object.entries(context).every(([key, value]) => admission[key] === value)
    || admission.approvalSha256 !== sha256(approvalBytes) || admission.planSha256 !== planSha256
    || admission.outputDirectory !== outputDirectory) throw new Error('Manual admission does not cover this run, approval, plan or directory');
}
