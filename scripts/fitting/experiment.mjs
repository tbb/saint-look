#!/usr/bin/env node
// Local experiment transport only. No live adapter, credentials or provider fallback.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { request } from 'node:http';

const args = Object.fromEntries(Array.from({ length: Math.floor((process.argv.length - 2) / 2) }, (_, i) =>
  [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hash = value => createHash('sha256').update(value).digest('hex');

async function main() {
  const allowed = ['--plan', '--out', '--fixture-url', '--max-requests', '--max-cost-microusd', '--timeout-ms'];
  if ((process.argv.length - 2) % 2 || Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported or incomplete CLI option');
  const timeoutMs = Number(args['--timeout-ms'] || 10000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Timeout must be 1..60000 ms');
  const endpoint = new URL(args['--fixture-url']);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password
    || args['--fixture-url'] !== endpoint.origin) {
    throw new Error('Fixture URL must be an exact loopback origin http://127.0.0.1:PORT');
  }
  const planPath = resolve(args['--plan']);
  const plan = JSON.parse(await readFile(planPath));
  const categories = ['head', 'top', 'bottom', 'shoes'];
  const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
  if (plan.version !== 1 || typeof plan.seed !== 'string' || !plan.seed || !Array.isArray(plan.items)
    || plan.items.length < 1 || plan.items.length > 12 || new Set(plan.items.map(i => i.id)).size !== plan.items.length
    || plan.items.some(i => !identifier(i.id) || !categories.includes(i.category) || !i.source || !i.license
      || !Array.isArray(i.photos) || i.photos.length < 1 || i.photos.length > 3
      || i.photos.some(file => typeof file !== 'string' || !/\.(png|jpe?g)$/i.test(file)))
    || !Array.isArray(plan.combinations) || plan.combinations.some(c => !identifier(c.id) || !Array.isArray(c.items)
      || c.items.length < 1 || new Set(c.items).size !== c.items.length || c.items.some(id => !plan.items.some(i => i.id === id)))) {
    throw new Error('Invalid experiment plan');
  }
  const prepared = new Map(), sourceHashes = [];
  for (const item of plan.items) {
    const photos = [];
    for (const file of item.photos) {
      const bytes = await readFile(resolve(dirname(planPath), file));
      if (bytes.length > 5 * 1024 * 1024) throw new Error('Source image exceeds 5 MiB');
      const digest = hash(bytes), declared = item.sources?.find(source => source.path === file)?.sha256;
      if (declared && declared !== digest) throw new Error('Source hash mismatch');
      sourceHashes.push({ itemId: item.id, path: file, sha256: digest });
      photos.push(`data:image/${extname(file).toLowerCase() === '.png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`);
    }
    prepared.set(item.id, photos);
  }
  const maxRequests = Number(args['--max-requests']);
  const maxCost = Number(args['--max-cost-microusd']);
  const rates = [plan.ratesMicrousd?.attributes, plan.ratesMicrousd?.generation, ...(plan.requiresSegmentation ? [plan.ratesMicrousd?.segmentation] : [])];
  if (![maxRequests, maxCost, ...rates].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Positive integer request/cost limits and stage reservations are required');
  }
  const sets = plan.items.reduce((sum, item) => sum + (item.photos.length > 1 ? 2 : 1), 0);
  const templateSvg = await readFile(resolve(dirname(planPath), plan.template), 'utf8');
  const forecast = { requests: sets * (plan.requiresSegmentation ? 5 : 3), reservedEstimateMicrousd: sets * (rates[0] + rates[1] * 2 + (rates[2] || 0) * 2) };
  if (forecast.requests > maxRequests || forecast.reservedEstimateMicrousd > maxCost) throw new Error('Plan exceeds request or reserved-cost ceiling');
  const out = resolve(args['--out']);
  await mkdir(out, { mode: 0o700 });
  await writeFile(join(out, 'plan.json'), JSON.stringify({ plan, sourceHashes, templateSha256: hash(templateSvg) }, null, 2));
  const results = [], key = {}, events = [];
  let reserved = 0;
  function record(event) {
    const descriptor = openSync(join(out, 'journal.jsonl'), 'a', 0o600);
    try { writeSync(descriptor, JSON.stringify(event) + '\n'); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    events.push(event);
  }
  async function call(stage, body) {
    const sequence = events.filter(e => e.status === 'started').length + 1;
    const reserve = plan.ratesMicrousd[stage];
    if (sequence > maxRequests || reserved + reserve > maxCost) throw new Error('Runtime budget exhausted');
    reserved += reserve;
    const started = Date.now();
    const context = { sequence, stage, itemId: body.itemId, reservedMicrousd: reserve };
    record({ ...context, status: 'started' });
    try {
      const result = await new Promise((resolveResult, reject) => {
        // Native HTTP has no automatic redirects, proxy environment or provider fallback.
        const req = request(new URL({ attributes: '/attributes', generation: '/generate', segmentation: '/segment' }[stage], endpoint),
          { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
            let raw = '', size = 0;
            response.on('data', chunk => {
              size += chunk.length;
              if (size > 8 * 1024 * 1024) { req.destroy(new Error('Response too large')); return; }
              raw += chunk;
            });
            response.on('error', reject);
            response.on('end', () => {
              if (response.statusCode !== 200) return reject(Object.assign(new Error('Fixture refused request'), { outcome: 'failed' }));
              try { resolveResult(JSON.parse(raw)); }
              catch { reject(Object.assign(new Error('Invalid fixture response'), { outcome: 'failed' })); }
            });
          });
        req.on('error', () => reject(new Error('Fixture response unknown')));
        const deadline = setTimeout(() => req.destroy(new Error('Timed out')), timeoutMs);
        req.on('close', () => clearTimeout(deadline));
        req.end(JSON.stringify(body));
      });
      const features = result?.features;
      if (stage === 'attributes' && (!features || Array.isArray(features) || typeof features !== 'object'
        || Object.keys(features).length > 64 || Object.values(features).some(value =>
          !(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
            || (typeof value === 'string' && value.length <= 200))))) {
        throw Object.assign(new Error('Invalid fixture attributes'), { outcome: 'failed' });
      }
      if (stage !== 'attributes') {
        const encoded = result?.pngBase64;
        const bytes = typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
        if (bytes.length < 45 || bytes.length > 5 * 1024 * 1024
          || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
          || bytes.subarray(12, 16).toString() !== 'IHDR'
          || ![bytes.readUInt32BE(16), bytes.readUInt32BE(20)].every(n => n > 0 && n <= 4096)
          || bytes.subarray(-8, -4).toString() !== 'IEND') {
          throw Object.assign(new Error('Invalid fixture PNG envelope'), { outcome: 'failed' });
        }
      }
      record({ ...context, status: 'completed', elapsedMs: Date.now() - started });
      return result;
    } catch (error) {
      record({ ...context, status: error.outcome || 'unknown', elapsedMs: Date.now() - started });
      throw error;
    }
  }
  let failure;
  try {
  for (const item of plan.items) {
    const originals = prepared.get(item.id);
    for (const input of originals.length > 1 ? ['single', 'multi'] : ['single']) {
      const photos = input === 'single' ? originals.slice(0, 1) : originals;
      const photoRoles = (item.photoRoles || item.photos.map((_, i) => i === 0 ? 'front' : 'unspecified-detail')).slice(0, photos.length);
      const { features } = await call('attributes', { itemId: item.id, input, photos, photoRoles });
      for (const variant of ['without-features', 'with-features']) {
        let result = await call('generation', { itemId: item.id, input, photos, photoRoles, templateSvg,
          templateVersion: plan.templateVersion, model: plan.model, parameters: plan.parameters,
          ...(variant === 'with-features' ? { features } : {}) });
        if (plan.requiresSegmentation) result = await call('segmentation', { itemId: item.id, input, pngBase64: result.pngBase64 });
        const id = hash(`${plan.seed}:${item.id}:${input}:${variant}`).slice(0, 12);
        results.push({ id, itemId: item.id, category: item.category, input, variant, original: photos[0], png: result.pngBase64 });
        key[id] = { itemId: item.id, input, variant };
      }
    }
  }
  } catch (error) { failure = error; }
  results.sort((a, b) => a.id.localeCompare(b.id));
  const compositions = [];
  for (const combination of plan.combinations) {
    for (const variant of ['without-features', 'with-features']) {
      for (const input of ['single', 'multi']) {
        const hasMultiple = combination.items.some(itemId => plan.items.find(i => i.id === itemId).photos.length > 1);
        if (input === 'multi' && !hasMultiple) continue;
        const layers = combination.items.map(itemId => {
          const resolvedInput = input === 'multi' && plan.items.find(i => i.id === itemId).photos.length > 1 ? 'multi' : 'single';
          return results.find(r => r.itemId === itemId && r.variant === variant && r.input === resolvedInput);
        });
        if (layers.some(r => !r)) continue;
        const id = hash(`${plan.seed}:combination:${combination.id}:${input}:${variant}`).slice(0, 12);
        compositions.push({ id, layers });
        key[id] = { combinationId: combination.id, input, variant, inputs: layers.map(r => ({ itemId: r.itemId, input: r.input, resultId: r.id })) };
      }
    }
  }
  compositions.sort((a, b) => a.id.localeCompare(b.id));
  const template = `data:image/svg+xml;base64,${Buffer.from(templateSvg).toString('base64')}`;
  const layerOrder = { bottom: 0, shoes: 1, top: 2, head: 3 };
  for (const composition of compositions) composition.layers.sort((a, b) => layerOrder[a.category] - layerOrder[b.category]);
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <title>Примерочная — сравнение</title><style>
  body{font:16px system-ui;background:#faf7f1;color:#282223;margin:24px;max-width:1200px}h1{font-size:24px}
  .grid{display:flex;flex-wrap:wrap;gap:24px}section{padding:16px;border:1px solid #d0c6be;max-width:520px}
  .photo{width:220px;height:260px;object-fit:contain}h2{font-size:16px}.mannequin{position:relative;width:288px;height:448px}
  .mannequin>img:first-child{width:100%;height:100%;object-fit:contain}.garment-layer{position:absolute;object-fit:contain;inset:0;width:100%;height:100%}
  </style><h1>Тестовые ответы — не доказательство качества генерации</h1>
  <p>Проверка транспорта, бюджета и отчёта. Размещение слоёв условное; реальная посадка ещё не подтверждена.
  Оценивайте варианты по кодам; расшифровка хранится отдельно. ${failure ? 'Прогон НЕ завершён.' : 'Локальный прогон завершён.'}</p>
  <h2>Отдельные вещи</h2><div class="grid">
  ${results.map(r => `<section><h2>${escape(r.id)}</h2><p>${escape(plan.items.find(i => i.id === r.itemId).author || '')} · ${escape(plan.items.find(i => i.id === r.itemId).license)}<br>${escape(plan.items.find(i => i.id === r.itemId).source)}<br>Результат: тестовый ответ, не производная AI-иллюстрация.</p><img class="photo" src="${r.original}" alt="Оригинал"><img class="photo" src="data:image/png;base64,${r.png}" alt="Результат"></section>`).join('\n')}</div>
  <h2>Сочетания</h2><div class="grid">${compositions.map(c => `<section><h2>${escape(c.id)}</h2><div class="mannequin"><img src="${template}" alt="Общий манекен">${c.layers.map(r => {
    return `<img class="garment-layer" src="data:image/png;base64,${r.png}" alt="Слой ${escape(r.itemId)}">`;
  }).join('')}</div></section>`).join('')}</div></html>`;
  await writeFile(join(out, 'review.html'), html);
  await writeFile(join(out, 'answer-key.json'), JSON.stringify(key, null, 2));
  await writeFile(join(out, 'report.json'), JSON.stringify({ mode: 'local-fixture', qualityEvidence: false,
    plan, sourceHashes, coordinateSpace: 'full-canvas-360x560', templateSha256: hash(templateSvg), comparisons: results.length, combinations: compositions.length, actualCostMicrousd: 0, reservedEstimateMicrousd: reserved, forecast, status: failure ? 'incomplete' : 'completed',
    completed: events.filter(e => e.status === 'completed').length, unknown: events.filter(e => e.status === 'unknown').length }, null, 2));
  if (failure) throw failure;
  console.log(JSON.stringify({ mode: 'local-fixture', report: join(out, 'review.html') }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
