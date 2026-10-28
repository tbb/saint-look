import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { sharp } from './trial-plan.mjs';

export function fixtureOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || value !== url.origin) throw new Error('Fixture origin must be exact loopback origin');
  return url.origin;
}

export function exchange(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, limit = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url), transport = parsed.protocol === 'https:' ? https : http;
    const binary = Buffer.isBuffer(body);
    const data = body === undefined ? undefined : binary ? body : JSON.stringify(body);
    if (data && Buffer.byteLength(data) > 32 * 1024 * 1024) return reject(new Error('Request exceeds transport limit'));
    const req = transport(parsed, { method, headers: { ...headers, ...(data && !binary ? { 'Content-Type': 'application/json' } : {}) } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { req.destroy(); reject(new Error('Provider response exceeds limit')); } else chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('Provider response interrupted')));
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'] || '', bytes: Buffer.concat(chunks) }));
    });
    req.on('error', () => reject(new Error('Provider request outcome unknown')));
    const deadline = setTimeout(() => req.destroy(new Error('Deadline exceeded')), timeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.end(data);
  });
}

export function jsonResponse(response) {
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Provider HTTP ${response.status}`), { knownFailure: true });
  try { return JSON.parse(response.bytes.toString('utf8')); }
  catch { throw new Error('Invalid provider JSON'); }
}

export function receipt(payload, app, origin) {
  if (typeof payload?.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.request_id)) throw new Error('Invalid fal receipt');
  const base = `${origin}/${app}/requests/${payload.request_id}`;
  for (const [key, suffix] of [['status_url', '/status'], ['response_url', ''], ['cancel_url', '/cancel']]) {
    if (payload[key] !== base + suffix) throw new Error('Invalid fal receipt URL');
  }
  return payload.request_id;
}

export async function downloadImage(value, { origin, timeoutMs, requireAlpha }) {
  if (typeof value?.url !== 'string') throw new Error('Missing image URL');
  const url = new URL(value.url);
  const allowed = origin ? url.origin === origin && url.pathname.startsWith('/files/')
    : url.protocol === 'https:' && ['fal.media', 'v3.fal.media', 'v3b.fal.media'].includes(url.hostname) && !url.port;
  if (!allowed || url.username || url.password || url.hash) throw new Error('Unapproved image URL');
  // Deliberately no provider authorization on CDN requests. Native HTTP never follows redirects.
  const response = await exchange(url, { timeoutMs, limit: 8 * 1024 * 1024 });
  return decodeImage(response, requireAlpha);
}

export async function decodeImage(response, requireAlpha) {
  if (response.status !== 200 || !/^image\/(png|jpeg|webp)(;|$)/i.test(response.type)) throw new Error('Invalid image download response');
  const image = sharp(response.bytes, { limitInputPixels: 16_000_000, failOn: 'error' });
  const meta = await image.metadata();
  if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) !== 1 || meta.width > 4096 || meta.height > 4096) throw new Error('Invalid image format or dimensions');
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let min = 255, max = 0;
  for (let i = info.channels - 1; i < data.length; i += info.channels) { min = Math.min(min, data[i]); max = Math.max(max, data[i]); }
  if (max === 0) throw new Error('Image has no visible pixels');
  const usableAlpha = Boolean(meta.hasAlpha && min < max && min < 255);
  if (requireAlpha && !usableAlpha) throw new Error('Segmentation lacks usable alpha');
  return { png: await sharp(data, { raw: info }).png().toBuffer(), width: info.width, height: info.height, usableAlpha };
}
