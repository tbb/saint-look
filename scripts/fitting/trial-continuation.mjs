import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, sharp } from './trial-plan.mjs';
import { durableWrite } from './trial-ledger.mjs';
import { featureRequest, featureAnswer } from './trial-jev.mjs';
import { semanticRequest } from './jev-diagnostic-response.mjs';

const files = ['prior-ledger.json', 'prior-approval.json', 'prior-admission.json', 'admission.json', 'receipt.json', 'response.json', 'prepared.png'];
const originalRef = 'refs/tags/fitting-trial-45-reserved', diagnosticRef = 'refs/tags/fitting-trial-45-jev-diagnostic-1';

// This import has exactly one supported history. Source evidence is never edited.
export async function readContinuation(manifestPath, evidenceDirectory, planPath, loaded) {
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes);
  if (manifest.version !== 1 || manifest.originalRunId !== '40677633168' || manifest.diagnosticRunId !== '40683876977'
    || ![manifest.originalRevision, manifest.diagnosticRevision].every(x => /^[a-f0-9]{40}$/.test(x || ''))
    || manifest.planDataSha256 !== sha256(await readFile(planPath))
    || Object.keys(manifest.files || {}).length !== files.length) throw new Error('Unsupported continuation manifest');
  const bytes = {};
  for (const file of files) {
    bytes[file] = await readFile(join(evidenceDirectory, file));
    if (sha256(bytes[file]) !== manifest.files[file]) throw new Error('Continuation evidence hash mismatch');
  }
  const prior = JSON.parse(bytes['prior-ledger.json']), approval = JSON.parse(bytes['prior-approval.json']);
  const originalAdmission = JSON.parse(bytes['prior-admission.json']), diagnosticAdmission = JSON.parse(bytes['admission.json']);
  const receipt = JSON.parse(bytes['receipt.json']), snapshot = JSON.parse(bytes['response.json']);
  const source = loaded.inputs.find(input => input.item.id === 'white-tee' && input.input === 'single');
  if (!source || source.roles[0] !== 'front' || sha256(source.photos[0]) !== manifest.sourceSha256) throw new Error('Continuation source changed');
  const original = await sharp(source.photos[0]).rotate().png().toBuffer(), prepared = bytes['prepared.png'];
  if (sha256(original) !== manifest.normalizedSourceSha256) throw new Error('Continuation normalized source changed');
  const key = 'white-tee/single/attributes', prepKey = `source-${manifest.sourceSha256}/preparation`;
  const prep = prior.operations?.[prepKey], unknown = prior.operations?.[key];
  if (prior.version !== 1 || prior.mode !== 'live' || Object.keys(prior.operations || {}).length !== 2
    || prior.approvalSha256 !== sha256(bytes['prior-approval.json']) || approval.mode !== 'live' || approval.budgetMicrousd !== 5000000
    || prior.planSha256 !== approval.planSha256 || originalAdmission.planSha256 !== prior.planSha256
    || originalAdmission.approvalSha256 !== prior.approvalSha256 || originalAdmission.runId !== manifest.originalRunId
    || originalAdmission.repository !== 'tbb/saint-look' || originalAdmission.revision !== manifest.originalRevision || originalAdmission.reservationRef !== originalRef
    || prep?.key !== prepKey || prep.stage !== 'preparation' || prep.status !== 'completed' || prep.reservedMicrousd !== 0 || prep.sandbox !== true
    || prep.sha256 !== sha256(prepared) || prep.sourceSha256 !== sha256(original) || !/^[a-zA-Z0-9-]+\.png$/.test(prep.artifact || '')
    || unknown?.key !== key || unknown.stage !== 'attributes' || unknown.status !== 'unknown' || unknown.reservedMicrousd !== 2753
    || unknown.error !== 'Invalid JEV feature response' || unknown.result !== undefined || unknown.requestId !== undefined
    || diagnosticAdmission.runId !== manifest.diagnosticRunId || diagnosticAdmission.revision !== manifest.diagnosticRevision
    || diagnosticAdmission.repository !== 'tbb/saint-look' || diagnosticAdmission.reservationRef !== diagnosticRef
    || diagnosticAdmission.originalRunId !== manifest.originalRunId || diagnosticAdmission.originalLedgerSha256 !== sha256(bytes['prior-ledger.json'])
    || receipt.runId !== manifest.diagnosticRunId || receipt.revision !== manifest.diagnosticRevision || receipt.originalRunId !== manifest.originalRunId
    || receipt.admissionSha256 !== sha256(bytes['admission.json']) || receipt.originalLedgerSha256 !== sha256(bytes['prior-ledger.json'])
    || receipt.operation !== 'white-tee/single/attributes-diagnostic-1' || !['unknown', 'completed'].includes(receipt.status)
    || receipt.snapshotSha256 !== sha256(bytes['response.json']) || receipt.httpStatus !== 200 || snapshot.httpStatus !== 200 || snapshot.parsedJson !== true
    || receipt.budget?.aggregateReservedMicrousd !== 200000
    || JSON.stringify(receipt.budget.countsAfter) !== JSON.stringify({ preparation: 1, attributes: 2, generation: 0, segmentation: 0 })) {
    throw new Error('Continuation is not the measured two-attempt history');
  }
  const metadata = await sharp(prepared, { failOn: 'error', limitInputPixels: 16000000 }).metadata();
  if (metadata.format !== 'png' || metadata.width !== prep.width || metadata.height !== prep.height) throw new Error('Continuation preparation dimensions changed');
  await sharp(prepared, { failOn: 'error', limitInputPixels: 16000000 }).raw().toBuffer();
  const request = await featureRequest([prepared, original], ['prepared_front', 'original_front']);
  if (sha256(JSON.stringify(semanticRequest(request))) !== receipt.semanticRequestSha256) throw new Error('Continuation JEV request semantics changed');
  const result = featureAnswer(snapshot.replay, request);
  const operations = {
    [prepKey]: { ...prep },
    [key]: { ...unknown, reservedMicrousd: 100000, originalReservedMicrousd: 2753,
      reservationReason: 'Conservative prior attempt allowance from diagnostic admission', originalRunId: manifest.originalRunId, reconciledBy: receipt.operation },
    [receipt.operation]: { key: receipt.operation, stage: 'attributes', status: 'completed', reservedMicrousd: 100000,
      result, inputTokens: result.inputTokens, usageCostEstimateMicrousd: result.usageCostEstimateMicrousd,
      diagnosticRunId: manifest.diagnosticRunId, snapshotSha256: receipt.snapshotSha256, semanticRequestSha256: receipt.semanticRequestSha256,
      reconciledAt: new Date().toISOString() },
  };
  return { manifest, manifestSha256: sha256(manifestBytes), bytes, operations, originalAdmission, diagnosticAdmission, prep };
}

export async function verifyContinuationHistory(data, github) {
  for (const [runId, revision, ref, workflow, admitted] of [
    [data.manifest.originalRunId, data.manifest.originalRevision, originalRef, 'fitting-live-trial.yml', data.originalAdmission],
    [data.manifest.diagnosticRunId, data.manifest.diagnosticRevision, diagnosticRef, 'fitting-jev-diagnostic.yml', data.diagnosticAdmission],
  ]) {
    const marker = await github(`/repos/tbb/saint-look/git/ref/${ref.slice(5)}`), run = await github(`/repos/tbb/saint-look/actions/runs/${runId}`);
    if (marker.ref !== ref || marker.object?.sha !== revision || String(run.id) !== runId || run.head_sha !== revision
      || run.head_branch !== 'main' || run.event !== 'workflow_dispatch' || run.path !== `.github/workflows/${workflow}`
      || run.status !== 'completed' || run.conclusion !== 'failure' || run.run_attempt !== 1 || run.head_repository?.full_name !== 'tbb/saint-look'
      || run.actor?.login !== admitted.actor || run.triggering_actor?.login !== admitted.actor) throw new Error('Continuation history identity mismatch');
  }
}

export async function writeContinuation(data, directory, context) {
  const out = join(directory, 'output'); await mkdir(out, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(data.bytes)) await durableWrite(join(out, `history-${name}`), bytes);
  await durableWrite(join(out, data.prep.artifact), data.bytes['prepared.png']);
  const ledger = { version: 1, ...context, continuedFrom: { originalRunId: data.manifest.originalRunId,
    diagnosticRunId: data.manifest.diagnosticRunId, manifestSha256: data.manifestSha256 }, operations: data.operations };
  const bytes = JSON.stringify(ledger, null, 2); await durableWrite(join(out, 'ledger.json'), bytes);
  return sha256(bytes);
}
