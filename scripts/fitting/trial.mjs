#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadPlan, models, rates, sha256, sharp } from './trial-plan.mjs';
import { openLedger, durableWrite } from './trial-ledger.mjs';
import { fixtureOrigin, exchange, jsonResponse, receipt, downloadImage } from './trial-http.mjs';
import { featureRequest, featureAnswer } from './trial-jev.mjs';
import { cutout } from './trial-photoroom.mjs';
import { saveReport } from './trial-report.mjs';

const flagNames = new Set(['--live', '--describe', '--recover-lock']);
const valueNames = new Set(['--plan', '--out', '--approval', '--fixture-origin', '--timeout-ms', '--poll-ms', '--max-polls']);
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (flagNames.has(key)) args[key] = true;
  else if (valueNames.has(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[key] = process.argv[++i];
  else { console.error('Unsupported or incomplete option'); process.exit(1); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataUri = bytes => `data:image/png;base64,${bytes.toString('base64')}`;

async function main() {
  if (args['--live'] && (process.env.CI || process.env.GITHUB_ACTIONS)) throw new Error('Live execution is forbidden in CI');
  if (!args['--plan']) throw new Error('Plan required');
  const loaded = await loadPlan(args['--plan']);
  if (args['--describe']) {
    console.log(JSON.stringify({ planSha256: loaded.planSha256, forecast: loaded.forecast, reservedMicrousd: loaded.reservedMicrousd,
      models, runtimeSha256: loaded.runtimeSha256, sourceHashes: loaded.hashes, templateSha256: loaded.templateSha256, qualityVerdict: null })); return;
  }
  if (Boolean(args['--live']) === Boolean(args['--fixture-origin'])) throw new Error('Choose explicit live or local-fixture execution');
  const local = args['--fixture-origin'] ? fixtureOrigin(args['--fixture-origin']) : null;
  const mode = local ? 'local-fixture' : 'live';
  if (!args['--approval'] || !args['--out']) throw new Error('Approval file and output directory required');
  const out = resolve(args['--out']), approvalBytes = await readFile(args['--approval']), approval = JSON.parse(approvalBytes);
  if (approval.mode !== mode || approval.planSha256 !== loaded.planSha256 || approval.outputDirectory !== out
    || approval.sourceTermsReviewed !== true || approval.providerTermsReviewed !== true
    || !Number.isSafeInteger(approval.budgetMicrousd) || approval.budgetMicrousd <= 0 || approval.budgetMicrousd > 5_000_000
    || !Object.keys(rates).every(k => Number.isSafeInteger(approval.maxCalls?.[k]) && approval.maxCalls[k] >= loaded.forecast[k]
      && approval.maxCalls[k] <= ({ preparation: 12, attributes: 14, generation: 28, segmentation: 28 })[k])
    || loaded.reservedMicrousd > approval.budgetMicrousd) throw new Error('Approval does not cover this plan, directory or budget');
  if (!local && (approval.paidCallsAllowed !== true || typeof approval.approvedBy !== 'string' || !approval.approvedBy.trim()
    || !Number.isFinite(Date.parse(approval.priceCheckedAt)) || Date.now() - Date.parse(approval.priceCheckedAt) > 86400000
    || Date.parse(approval.priceCheckedAt) > Date.now() || loaded.plan.items.length < 8)) throw new Error('Explicit current live approval required');
  const timeoutMs = Number(args['--timeout-ms'] || 30000), pollMs = Number(args['--poll-ms'] || 1000), maxPolls = Number(args['--max-polls'] || 120);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isSafeInteger(pollMs)
    || pollMs < 1 || pollMs > 10000 || !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 300) throw new Error('Invalid bounded polling configuration');
  // Read actual credentials only after explicit manual authorization. Fixtures never read these variables.
  const falKey = local ? 'fixture-fal-key' : process.env.FAL_KEY;
  const jevKey = local ? 'fixture-jev-key' : process.env.TYPESAFE_API_KEY;
  const photoroomKey = local ? 'sandbox_fixture_key' : process.env.PHOTOROOM_SANDBOX_API_KEY;
  if (!falKey || !jevKey || !photoroomKey) throw new Error('Provider credentials missing');
  if (!photoroomKey.startsWith('sandbox_')) throw new Error('Photoroom requires the dedicated sandbox key');
  const origin = local || 'https://queue.fal.run', jevUrl = local ? `${local}/v1/systemone` : 'https://api.typesafe.ai/v1/systemone';
  const ledger = await openLedger(out, { mode, planSha256: loaded.planSha256, approvalSha256: sha256(approvalBytes) }, args['--recover-lock']);
  const results = [];
  let failure;
  try {
    await durableWrite(join(out, 'plan.json'), JSON.stringify({ ...loaded.plan, fingerprint: loaded.planSha256, runtimeSha256: loaded.runtimeSha256, sourceHashes: loaded.hashes }, null, 2));
    const falHeaders = { Authorization: `Key ${falKey}`, 'X-Fal-No-Retry': '1', 'x-app-fal-disable-fallback': 'true',
      'X-Fal-Store-IO': '0', 'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: 3600 }), 'X-Fal-Request-Start-Timeout': '120' };
    async function attributes(input) {
      const key = `${input.item.id}/${input.input}/attributes`, existing = ledger.data.operations[key];
      if (existing?.status === 'completed') return existing.result;
      if (existing) throw new Error('Existing JEV attempt requires reconciliation; no automatic retry');
      const request = await featureRequest(input.photos, input.roles);
      const op = await ledger.reserve(key, 'attributes', approval);
      try {
        const raw = jsonResponse(await exchange(jevUrl, { method: 'POST', headers: { Authorization: `Bearer ${jevKey}`, 'TypeSafe-Danger-Zone-Images': 'true' }, body: request, timeoutMs }));
        const result = featureAnswer(raw, request);
        Object.assign(op, { status: 'completed', result, inputTokens: result.inputTokens, usageCostEstimateMicrousd: result.usageCostEstimateMicrousd,
          completedAt: new Date().toISOString() }); await ledger.save(); return result;
      } catch (e) { op.status = e.knownFailure ? 'failed' : 'unknown'; op.error = e.message; await ledger.save(); throw e; }
    }
    async function generate(key, payload) {
      const stage = 'generation';
      if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024 * 1024) throw new Error('Payload exceeds transport limit before reservation');
      let op = ledger.data.operations[key];
      if (op?.status === 'completed') return { op, png: await ledger.readArtifact(op) };
      if (op && !op.requestId) throw new Error('Existing fal attempt requires reconciliation; no automatic retry');
      const app = 'fal-ai/nano-banana-pro';
      try {
        if (!op) {
          op = await ledger.reserve(key, stage, approval);
          op.payloadSha256 = sha256(JSON.stringify(payload)); await ledger.save();
          const answer = jsonResponse(await exchange(`${origin}/${models[stage]}`, { method: 'POST', headers: falHeaders, body: payload, timeoutMs }));
          op.requestId = receipt(answer, app, origin); op.status = 'pending'; op.submittedAt = new Date().toISOString(); await ledger.save();
        }
        const base = `${origin}/${app}/requests/${op.requestId}`;
        let output;
        for (let i = 0; i < maxPolls; i++) {
          const response = await exchange(`${base}/status`, { headers: { Authorization: `Key ${falKey}` }, timeoutMs });
          if (response.status >= 500) { if (i + 1 < maxPolls) await sleep(pollMs); continue; }
          const status = jsonResponse(response);
          if (status.status === 'IN_PROGRESS' && !op.firstInProgressAt) { op.firstInProgressAt = new Date().toISOString(); await ledger.save(); }
          if (status.status === 'COMPLETED') {
            if (!op.providerCompletedAt) { op.providerCompletedAt = new Date().toISOString(); await ledger.save(); }
            if (status.error || status.error_type) throw Object.assign(new Error('Fal completed with an error'), { knownFailure: true });
            const result = await exchange(base, { headers: { Authorization: `Key ${falKey}` }, timeoutMs });
            if (result.status === 400 || result.status >= 500) { if (i + 1 < maxPolls) await sleep(pollMs); continue; }
            output = jsonResponse(result); break;
          }
          if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new Error('Invalid fal queue status');
          if (i + 1 < maxPolls) await sleep(pollMs);
        }
        if (!output) throw new Error('Polling limit reached; resume the saved receipt');
        const image = Array.isArray(output.images) && output.images.length === 1 ? output.images[0] : null;
        const downloaded = await downloadImage(image, { origin: local, timeoutMs, requireAlpha: false });
        if (downloaded.width !== downloaded.height) throw new Error('Output canvas dimensions changed');
        await ledger.artifact(op, downloaded.png, { width: downloaded.width, height: downloaded.height, usableAlpha: downloaded.usableAlpha });
        return { op, png: downloaded.png };
      } catch (e) {
        if (op) { op.status = e.knownFailure ? 'failed' : op.requestId ? 'pending' : 'unknown'; op.error = e.message; await ledger.save(); }
        throw e;
      }
    }
    const photoroom = (key, stage, image) => cutout({ key, stage, image, ledger, approval, origin: local || 'https://sdk.photoroom.com', apiKey: photoroomKey, timeoutMs });
    for (const input of loaded.inputs) {
      const originals = await Promise.all(input.photos.map(b => sharp(b).rotate().png().toBuffer()));
      const images = [];
      for (let i = 0; i < originals.length; i++) images.push((await photoroom(`source-${sha256(input.photos[i])}/preparation`, 'preparation', originals[i])).png);
      const featureResult = await attributes({ ...input, photos: images.flatMap((b, i) => [b, originals[i]]), roles: input.roles.flatMap(r => [`prepared_${r}`, `original_${r}`]) });
      const front = `${input.item.id}-original.png`; await durableWrite(join(out, front), originals[0]);
      for (const variant of ['without-features', 'with-features']) {
        const prefix = `${input.item.id}/${input.input}/${variant}`;
        const prompt = `Ignore the PHOTOROOM sandbox watermark: it is a processing artifact, never garment lettering or a print. Create a faithful restrained editorial illustration of ONLY the garment in the first images. Image pairs in order: ${input.roles.map(r => `original_${r}, prepared_${r}`).join('; ')}. Use originals as the fidelity reference for any detail obscured by processing watermarks. The LAST image is the common mannequin pose/style reference, never the item. Preserve silhouette, proportions, color, construction and prints; never invent lettering, brands, body or an underlayer. Render the FRONT view on the full square canvas with shoulders, waist and feet aligned to the reference; preserve its white letterbox margins and empty canvas around the garment. Use a plain white background for segmentation. Do not independently center or crop the garment. ${variant === 'with-features' ? 'Observed features: ' + JSON.stringify(featureResult.features) : ''}`;
        const generation = await generate(`${prefix}/generation`, { prompt, image_urls: [...images.flatMap((b, i) => [dataUri(originals[i]), dataUri(b)]), dataUri(loaded.templatePng)],
          num_images: 1, aspect_ratio: '1:1', output_format: 'png', resolution: '1K', limit_generations: true, enable_web_search: false,
          seed: parseInt(sha256(`${loaded.plan.seed}:${input.item.id}:${input.input}`).slice(0, 8), 16) & 0x7fffffff });
        let segmentation;
        if (generation.op.usableAlpha) {
          const key = `${prefix}/segmentation`;
          ledger.data.operations[key] = { key, stage: 'segmentation', status: 'skipped', reason: 'usable-alpha', reservedMicrousd: 0 };
          await ledger.save(); segmentation = generation;
        } else segmentation = await photoroom(`${prefix}/segmentation`, 'segmentation', generation.png);
        results.push({ id: sha256(prefix).slice(0, 12), itemId: input.item.id, input: input.input, variant, original: front, artifact: segmentation.op.artifact });
      }
    }
  } catch (error) { failure = error; }
  try {
    const operations = Object.values(ledger.data.operations);
    const report = { mode, models, photoroomMode: 'sandbox', frameVersion: 'square-letterbox-1024-v1', planSha256: loaded.planSha256, status: failure ? 'incomplete' : 'completed', qualityVerdict: null,
      actualCostMicrousd: local ? 0 : null, reservedMicrousd: operations.reduce((sum, op) => sum + op.reservedMicrousd, 0),
      attemptCounts: Object.fromEntries(Object.keys(rates).map(stage => [stage, operations.filter(op => op.stage === stage && op.status !== 'skipped').length])),
      results, operations, error: failure?.message || null };
    await saveReport(out, loaded, report);
  } finally { await ledger.close(); }
  if (failure) throw failure;
  console.log(JSON.stringify({ mode, status: 'completed', report: join(out, 'report.json') }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
