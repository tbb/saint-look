// Bounded operator-requested probe: two Jev calls, two clean cutouts, one sandbox cutout.
// No retries, no uploads of personal photos, no raw provider response logs.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../../backend/package.json', import.meta.url))('sharp');
import { jevRequest, jevAttributes } from '../../backend/src/jev.mjs';
const folder = 'client-ios/SaintLook/TrialPhotos';
const manifest = JSON.parse(readFileSync(`${folder}/manifest.json`));
const report = { time: new Date().toISOString(), retries: 0, photos: [] };
mkdirSync('provider-results', { recursive: true });
copyFileSync(`${folder}/ATTRIBUTION.md`, 'provider-results/ATTRIBUTION.md');
copyFileSync(`${folder}/manifest.json`, 'provider-results/manifest.json');
async function exchange(url, options, limit) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(90000) });
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('oversized');
    chunks.push(chunk);
  }
  return { status: response.status, bytes: Buffer.concat(chunks) };
}
async function account() {
  try {
    const result = await exchange('https://image-api.photoroom.com/v2/account', { headers: { 'x-api-key': process.env.PHOTOROOM_API_KEY } }, 65536);
    if (result.status !== 200) return { status: result.status };
    const data = JSON.parse(result.bytes);
    return { status: 200, available: Number.isFinite(data.images?.available) ? data.images.available : null,
      subscription: Number.isFinite(data.images?.subscription) ? data.images.subscription : null,
      plan: typeof data.plan === 'string' && /^[a-z_-]{1,24}$/.test(data.plan) ? data.plan : null };
  } catch { return { error: 'account_check_failed' }; }
}
async function cutout(source, mode, filename) {
  const key = process.env[mode === 'sandbox' ? 'PHOTOROOM_SANDBOX_API_KEY' : 'PHOTOROOM_API_KEY'];
  if (!key) return { error: 'missing_key' };
  const body = new FormData();
  body.set('image_file', new Blob([source], { type: 'image/png' }), 'item.png');
  body.set('format', 'png'); body.set('despill', 'false');
  try {
    const start = Date.now();
    const result = await exchange('https://sdk.photoroom.com/v1/segment', { method: 'POST', headers: { 'x-api-key': key }, body }, 10 * 1024 * 1024);
    if (result.status !== 200) return { status: result.status };
    const image = sharp(result.bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || !metadata.hasAlpha) return { status: 200, error: 'invalid_png' };
    const stats = await image.stats(); const alpha = stats.channels.at(-1);
    if (alpha.min === 255 || alpha.max === 0) return { status: 200, error: 'invalid_alpha' };
    // Strip metadata before publishing only the approved public-photo derivatives.
    const normalized = await image.png().toBuffer();
    writeFileSync(`provider-results/${filename}-${mode}.png`, normalized);
    return { status: 200, elapsedMs: Date.now() - start, width: metadata.width, height: metadata.height, bytes: normalized.length, usableAlpha: true };
  } catch { return { error: 'request_or_image_failed_unknown_outcome_no_retry' }; }
}
if (process.env.PHOTOROOM_API_OPT_OUT_CONFIRMED !== 'true') throw new Error('API opt-out confirmation required');
report.before = await account();
if (!(report.before.available >= 2)) throw new Error('Could not verify two available clean cutouts; no processing started');
try {
  for (const photo of manifest.photos.slice(0, 2)) {
    const bytes = readFileSync(`${folder}/${photo.file}`);
    if (createHash('sha256').update(bytes).digest('hex') !== photo.sha256) throw new Error('Public photo manifest mismatch');
    const source = await sharp(bytes).rotate().png().toBuffer();
    const entry = { file: photo.file, sha256: photo.sha256 };
    report.photos.push(entry);
    try {
      const request = await jevRequest(source);
      const start = Date.now();
      const result = await exchange('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'TypeSafe-Danger-Zone-Images': 'true',
      }, body: JSON.stringify(request) }, 65536);
      entry.jev = { status: result.status, elapsedMs: Date.now() - start };
      if (result.status === 200) {
        const payload = JSON.parse(result.bytes);
        entry.jev.model = payload.model === 'jev-1.14.0' ? payload.model : 'unexpected_model';
        const usage = payload.usage;
        entry.jev.usage = { input_tokens: Number.isFinite(usage?.input_tokens) ? usage.input_tokens : null,
          output_tokens: Number.isFinite(usage?.output_tokens) ? usage.output_tokens : null };
        try { entry.attributes = jevAttributes(payload); }
        catch (error) {
          entry.jev.validationError = ['photo_on_person', 'photo_multiple_items', 'photo_no_item', 'photo_unclear', 'invalid_provider_response'].includes(error.message) ? error.message : 'invalid_provider_response';
        }
        // Allowlisted numeric observations for tuning; never retain the full response.
        for (const question of ['suitability', 'item_type']) {
          const answer = payload.answers?.[question];
          entry.jev[question] = { confidence: Number.isFinite(answer?.confidence) ? answer.confidence : null };
        }
      }
    } catch { entry.jev = { error: 'request_or_response_failed_unknown_outcome_no_retry' }; }
    // Match the application: don't buy a clean cutout after rejected recognition.
    if (entry.attributes) {
      entry.live = await cutout(source, 'live', photo.file);
      if (photo.file === 'photo-2.jpg') entry.sandbox = await cutout(source, 'sandbox', photo.file);
    } else entry.cutout = 'skipped_after_recognition_failure';
  }
} finally {
  report.after = await account();
  const output = JSON.stringify(report, null, 2);
  writeFileSync('provider-results/report.json', output + '\n');
  console.log(output);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Bounded real provider probe (public photos, no retry).\n\n```json\n' + output + '\n```\n');
}
if (report.photos.some(photo => !photo.attributes || photo.live?.status !== 200 || photo.live?.error || (photo.sandbox && (photo.sandbox.status !== 200 || photo.sandbox.error)))) process.exitCode = 1;
