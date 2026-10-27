import { randomUUID } from 'node:crypto';
import { sharp, sha256 } from './trial-plan.mjs';
import { exchange, decodeImage } from './trial-http.mjs';

// Synchronous sandbox operation. A lost response has no resumable provider receipt.
export async function cutout({ key, stage, image, ledger, approval, origin, apiKey, timeoutMs }) {
  const existing = ledger.data.operations[key];
  if (existing?.status === 'completed') return { op: existing, png: await ledger.readArtifact(existing) };
  if (existing) throw new Error('Existing Photoroom attempt requires reconciliation; no automatic retry');
  const frame = await sharp(image).metadata();
  const boundary = `trial-${randomUUID()}`;
  const body = Buffer.concat([
    ...Object.entries({ channels: 'rgba', size: 'full', crop: 'false' }).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="format"\r\n\r\npng\r\n--${boundary}\r\nContent-Disposition: form-data; name="despill"\r\n\r\nfalse\r\n--${boundary}\r\nContent-Disposition: form-data; name="image_file"; filename="item.png"\r\nContent-Type: image/png\r\n\r\n`),
    image, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  if (body.length > 32 * 1024 * 1024) throw new Error('Photoroom payload exceeds transport limit');
  const op = await ledger.reserve(key, stage, approval);
  op.sourceSha256 = sha256(image); await ledger.save();
  try {
    const response = await exchange(`${origin}/v1/segment`, { method: 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, timeoutMs, limit: 8 * 1024 * 1024 });
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Photoroom HTTP ${response.status}`), { knownFailure: true });
    const result = await decodeImage(response, true);
    if (result.width !== frame.width || result.height !== frame.height) throw new Error('Photoroom output canvas dimensions changed');
    await ledger.artifact(op, result.png, { width: result.width, height: result.height, sandbox: true });
    return { op, png: result.png };
  } catch (e) { op.status = e.knownFailure ? 'failed' : 'unknown'; op.error = e.message; await ledger.save(); throw e; }
}
