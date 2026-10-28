import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const cli = new URL('./trial.mjs', import.meta.url).pathname;
function run(args, env = {}, onSpawn) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, CI: 'true', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onSpawn) onSpawn(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CI refuses live execution before loading any approval or credentials', async () => {
  const result = await run(['--live', '--approval', '/must-not-read']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Live execution is forbidden in CI/);
});

import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../../backend/package.json', import.meta.url))('sharp');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, behavior = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fitting-live-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 16, height: 16, channels: 4, background: '#4455ffff' } }).png().toBuffer(), left: 8, top: 8 }]).png().toBuffer();
  await writeFile(join(dir, 'photo.png'), png);
  await writeFile(join(dir, 'mannequin.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="560"><rect x="150" y="100" width="60" height="400" fill="#aaaaaa"/></svg>');
  const plan = { version: 1, pipelineVersion: 'photoroom-first-v2', seed: 'trial-test', template: 'mannequin.svg', templateVersion: 'test-1',
    candidateEndpoint: 'fal-ai/nano-banana-pro/edit', preparationEndpoint: 'photoroom-sandbox/v1/segment', segmentationEndpoint: 'photoroom-sandbox/v1/segment', requiresSegmentation: true,
    ratesMicrousd: { preparation: 0, attributes: 2753, generation: 150000, segmentation: 0 },
    parameters: { style: 'restrained-editorial-illustration', pose: 'front-arms-slightly-away', output: 'garment-only', preserve: 'silhouette, color, details' },
    items: [{ id: 'shirt', category: 'top', photos: ['photo.png'], photoRoles: ['front'], author: 'Test', license: 'Test fixture', source: 'Local synthetic',
      sources: [{ path: 'photo.png', sha256: digest(png), source: 'Local synthetic', author: 'Test', license: 'Test fixture' }] }],
    combinations: [{ id: 'shirt-only', items: ['shirt'] }] };
  const planPath = join(dir, 'plan.json'); await writeFile(planPath, JSON.stringify(plan));
  const calls = [], requests = new Map();
  let origin;
  const server = createServer(async (request, response) => {
    // The workspace probes newly opened ports with GET /. These are not provider calls.
    if (request.method === 'GET' && request.url === '/') { response.writeHead(404); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = raw.length ? (request.headers['content-type']?.startsWith('multipart/') ? { raw } : JSON.parse(raw)) : null;
    if (body?.raw) {
      const boundary = request.headers['content-type'].split('boundary=')[1];
      const parts = raw.toString('latin1').split('--' + boundary);
      body = Object.fromEntries(parts.filter(p => p.includes('Content-Disposition')).map(p => [p.match(/name="([^"]+)"/)[1], Buffer.from(p.split('\r\n\r\n')[1].slice(0, -2), 'latin1')]));
    }
    const call = { method: request.method, path: request.url, headers: request.headers, body }; calls.push(call);
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (behavior.handle && await behavior.handle({ call, request, response, json, calls, requests, origin, png })) return;
    if (request.url === '/v1/segment') {
      const size = await sharp(body.image_file).metadata();
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(await sharp(png).resize(size.width, size.height).tint('#339944').png().toBuffer()); return;
    }
    if (request.url === '/v1/systemone') {
      const answers = Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
        if (q.type === 'noul') return [key, { type: 'noul', noul: 0.9 }];
        const choice = key === 'suitability' ? 'suitable' : ('unknown' in q.criteria ? 'unknown' : Object.keys(q.criteria)[0]);
        return [key, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
      }));
      const payload = { model: body.model, answers, usage: { input_tokens: 1000 } };
      if (behavior.jevAnswer) behavior.jevAnswer(payload);
      json(200, payload); return;
    }
    if (request.method === 'POST') {
      const id = randomUUID();
      const app = '/fal-ai/nano-banana-pro';
      requests.set(id, app);
      json(200, { request_id: id, status_url: `${origin}${app}/requests/${id}/status`, response_url: `${origin}${app}/requests/${id}`, cancel_url: `${origin}${app}/requests/${id}/cancel` }); return;
    }
    if (request.url.endsWith('/status')) { json(200, { status: 'COMPLETED' }); return; }
    if (request.url.startsWith('/files/')) { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(await sharp(png).flatten({ background: '#fff' }).png().toBuffer()); return; }
    const image = { url: `${origin}/files/result.png`, content_type: 'image/png' };
    json(200, { images: [image] });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const out = join(dir, 'result'), approvalPath = join(dir, 'fixture-approval.json');
  async function approve(overrides = {}) {
    const described = await run(['--describe', '--plan', planPath]);
    assert.equal(described.code, 0, described.stderr);
    const info = JSON.parse(described.stdout);
    const approval = { mode: 'local-fixture', outputDirectory: out, planSha256: info.planSha256, budgetMicrousd: 1000000,
      maxCalls: { preparation: 12, attributes: 1, generation: 2, segmentation: 2 }, sourceTermsReviewed: true,
      providerTermsReviewed: true, priceCheckedAt: '2026-10-27', ...overrides };
    await writeFile(approvalPath, JSON.stringify(approval));
    return info;
  }
  const execute = (extra, onSpawn) => run(['--fixture-origin', origin, '--plan', planPath, '--approval', approvalPath, '--out', out, '--poll-ms', '1', '--max-polls', '3', '--timeout-ms', '1000', ...(extra || [])], {}, onSpawn);
  return { dir, png, plan, planPath, calls, requests, origin, out, approvalPath, approve, execute };
}

test('approved fixture trial preserves exact provider payloads, strips CDN auth, and saves A/B results once', async t => {
  const f = await fixture(t); await f.approve();
  const result = await f.execute(); assert.equal(result.code, 0, result.stderr);
  const posts = f.calls.filter(c => c.method === 'POST');
  assert.deepEqual(posts.map(c => c.path), ['/v1/segment', '/v1/systemone', '/fal-ai/nano-banana-pro/edit', '/v1/segment', '/fal-ai/nano-banana-pro/edit', '/v1/segment']);
  assert.equal(posts[1].headers['typesafe-danger-zone-images'], 'true');
  assert.equal(Object.keys(posts[1].body.assets).length, 2);
  for (const c of posts.filter(c => c.path.includes('nano'))) {
    assert.equal(c.headers['x-fal-no-retry'], '1'); assert.equal(c.headers['x-app-fal-disable-fallback'], 'true');
    assert.equal(c.headers['x-fal-store-io'], '0');
  }
  for (const c of posts.filter(c => c.path.includes('nano'))) {
    assert.equal(c.body.resolution, '1K'); assert.equal(c.body.num_images, 1);
    assert.equal(c.body.enable_web_search, false); assert.equal(c.body.image_urls.length, 3);
  }
  for (const call of posts.filter(c => c.path === '/v1/segment')) {
    assert.equal(call.headers['x-api-key'], 'sandbox_fixture_key');
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.body.format.toString(), 'png'); assert.equal(call.body.despill.toString(), 'false');
    assert.equal(call.body.channels.toString(), 'rgba'); assert.equal(call.body.size.toString(), 'full');
    assert.equal(call.body.crop.toString(), 'false'); assert.equal(call.body.bg_color, undefined);
    assert.equal((await sharp(call.body.image_file).metadata()).format, 'png');
  }
  assert.match(posts[1].body.questions.pattern.instructions, /watermark/);
  assert.match(posts[2].body.prompt, /original_front, prepared_front/);
  assert.notEqual(posts[2].body.image_urls[0], posts[2].body.image_urls[1]);
  assert.deepEqual(Buffer.from(posts[2].body.image_urls[0].split(',')[1], 'base64'), f.png);
  assert.doesNotMatch(posts[2].body.prompt, /Observed features:/);
  assert.match(posts[4].body.prompt, /Observed features:/);
  assert.equal(posts[3].body.prompt, undefined);
  assert.ok(f.calls.some(c => /^\/fal-ai\/nano-banana-pro\/requests\/[\w-]+\/status$/.test(c.path)));
  assert.ok(f.calls.filter(c => c.path.startsWith('/files/')).every(c => c.headers.authorization === undefined));
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.status, 'completed'); assert.equal(report.results.length, 2);
  assert.equal(report.actualCostMicrousd, 0); assert.equal(report.reservedMicrousd, 302753);
  assert.equal(report.operations.find(o => o.stage === 'attributes').usageCostEstimateMicrousd, 42);
  assert.ok(report.operations.every(o => o.status === 'completed'));
  const repeat = await f.execute(); assert.equal(repeat.code, 0, repeat.stderr);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 6);
});

test('a pending receipt resumes status/result without a second paid submit', async t => {
  let pending = true;
  const f = await fixture(t, { handle({ call, json }) {
    if (pending && call.path.endsWith('/status')) { json(202, { status: 'IN_PROGRESS' }); return true; }
  } });
  await f.approve();
  const first = await f.execute(['--max-polls', '1']);
  assert.equal(first.code, 1); assert.match(first.stderr, /Polling limit reached/);
  let report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.operations.find(o => o.stage === 'generation').status, 'pending');
  assert.equal(report.reservedMicrousd, 152753);
  pending = false;
  const second = await f.execute(); assert.equal(second.code, 0, second.stderr);
  assert.equal(f.calls.filter(c => c.method === 'POST' && c.path.includes('nano')).length, 2);
  assert.equal(f.calls.filter(c => c.path === '/v1/systemone').length, 1);
});

test('lost submit response reserves the attempt and refuses replay instead of paying twice', async t => {
  const f = await fixture(t, { handle({ call, request }) {
    if (call.method === 'POST' && call.path.includes('nano')) { request.socket.destroy(); return true; }
  } });
  await f.approve();
  const first = await f.execute(); assert.equal(first.code, 1);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.operations.find(o => o.stage === 'generation').status, 'unknown');
  assert.equal(report.reservedMicrousd, 152753);
  const second = await f.execute(); assert.equal(second.code, 1);
  assert.match(second.stderr, /reconciliation/);
  assert.equal(f.calls.filter(c => c.method === 'POST' && c.path.includes('nano')).length, 1);
});

test('invalid approval or a ceiling beyond the proposed bounded trial cannot authorize sending photos', async t => {
  const f = await fixture(t);
  const maxCalls = { preparation: 12, attributes: 14, generation: 28, segmentation: 28 };
  const invalid = [{ sourceTermsReviewed: 'false' }, { budgetMicrousd: 5_000_001 },
    { maxCalls: { attributes: 14, generation: 28, segmentation: 28 } },
    ...Object.keys(maxCalls).map(stage => ({ maxCalls: { ...maxCalls, [stage]: maxCalls[stage] + 1 } }))];
  for (const override of invalid) {
    await f.approve(override);
    const result = await f.execute(); assert.equal(result.code, 1, JSON.stringify(override));
    assert.match(result.stderr, /Approval does not cover/); assert.equal(f.calls.length, 0);
  }
  await f.approve({ budgetMicrousd: 5_000_000, maxCalls });
  const accepted = await f.execute(); assert.equal(accepted.code, 0, accepted.stderr);
});

test('blind review shows the mannequin compositions and attribution without exposing variant names', async t => {
  const f = await fixture(t); await f.approve();
  const result = await f.execute(); assert.equal(result.code, 0, result.stderr);
  const html = await readFile(join(f.out, 'review.html'), 'utf8');
  assert.match(html, /Сочетания/);
  assert.match(html, /Test fixture/);
  assert.match(html, /garment-layer/);
  assert.doesNotMatch(html, /with-features|without-features/);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.compositions.length, 2);
  assert.equal(report.qualityVerdict, null);
});

test('generation and composition use the same padded square reference without stretching the mannequin', async t => {
  const f = await fixture(t); await f.approve();
  const result = await f.execute(); assert.equal(result.code, 0, result.stderr);
  const generation = f.calls.find(c => c.path.includes('nano') && c.method === 'POST').body;
  assert.equal(generation.aspect_ratio, '1:1');
  const reference = Buffer.from(generation.image_urls.at(-1).split(',')[1], 'base64');
  const metadata = await sharp(reference).metadata();
  assert.deepEqual([metadata.width, metadata.height], [1024, 1024]);
  assert.deepEqual(await readFile(join(f.out, 'mannequin.png')), reference);
  const { data, info } = await sharp(reference).raw().toBuffer({ resolveWithObject: true });
  const leftMiddle = (512 * info.width) * info.channels;
  assert.deepEqual([...data.subarray(leftMiddle, leftMiddle + 3)], [255, 255, 255]);
});

test('concurrent recovery after a killed process preserves one lock and never resubmits its receipt', async t => {
  let reachedStatus, block = true;
  const waiting = new Promise(resolve => reachedStatus = resolve);
  const f = await fixture(t, { handle({ call }) {
    if (block && call.path.endsWith('/status')) { reachedStatus(); return true; }
  } });
  await f.approve();
  let processHandle;
  const killed = f.execute(['--timeout-ms', '5000'], child => processHandle = child);
  await waiting;
  processHandle.kill('SIGKILL'); await killed;
  block = false;
  const attempts = await Promise.all(Array.from({ length: 4 }, () => f.execute(['--recover-lock'])));
  assert.ok(attempts.some(a => a.code === 0), attempts.map(a => a.stderr).join('\n'));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 6);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.status, 'completed'); assert.equal(report.reservedMicrousd, 302753);
  await writeFile(join(f.out, '.recovery'), 'interrupted recovery');
  const blocked = await f.execute(); assert.equal(blocked.code, 1); assert.match(blocked.stderr, /guard remains/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 6);
});

test('unexpected receipt URLs never receive a forwarded provider key or trigger another submit', async t => {
  const f = await fixture(t, { handle({ call, json }) {
    if (call.method === 'POST' && call.path.includes('nano')) {
      json(200, { request_id: randomUUID(), status_url: 'https://queue.fal.run.evil.invalid/status', response_url: 'http://127.0.0.1/private', cancel_url: 'https://example.invalid/cancel' }); return true;
    }
  } });
  await f.approve();
  const result = await f.execute(); assert.equal(result.code, 1); assert.match(result.stderr, /receipt URL/);
  assert.equal(f.calls.length, 3, JSON.stringify(f.calls.map(c => [c.method, c.path])));
  await f.execute(); assert.equal(f.calls.length, 3, JSON.stringify(f.calls.map(c => [c.method, c.path])));
});

test('missing JEV usage stops before generation and never invent actual cost', async t => {
  const f = await fixture(t, { handle({ call, json }) {
    if (call.path === '/v1/systemone') { json(200, { model: 'jev-1.14.0', answers: {}, usage: {} }); return true; }
  } });
  await f.approve();
  const result = await f.execute(); assert.equal(result.code, 1); assert.match(result.stderr, /Invalid JEV/);
  assert.equal(f.calls.length, 2);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.reservedMicrousd, 2753);
  assert.equal(report.operations[0].usageCostEstimateMicrousd, undefined);
  const attributes = report.operations.find(op => op.stage === 'attributes');
  const snapshot = JSON.parse(await readFile(join(f.out, attributes.responseArtifact)));
  assert.equal(snapshot.httpStatus, 200);
  assert.equal(snapshot.shape.inputTokens.present, false);
  assert.match(attributes.semanticRequestSha256, /^[a-f0-9]{64}$/);
  assert.equal(digest(await readFile(join(f.out, attributes.responseArtifact))), attributes.snapshotSha256);
});

test('opaque segmentation is not accepted as a prepared layer and generation stays charged in the ledger', async t => {
  let segments = 0;
  const f = await fixture(t, { async handle({ call, response }) {
    if (call.path === '/v1/segment' && ++segments > 1) {
      const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffffff' } }).png().toBuffer();
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(image); return true;
    }
  } });
  await f.approve();
  const result = await f.execute(); assert.equal(result.code, 1); assert.match(result.stderr, /usable alpha/);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.results.length, 0); assert.equal(report.reservedMicrousd, 152753);
  await f.execute();
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 4);
});

test('changed sources, changed approvals, and insufficient budgets fail before any additional paid call', async t => {
  const f = await fixture(t); await f.approve({ budgetMicrousd: 302752 });
  let result = await f.execute(); assert.equal(result.code, 1); assert.equal(f.calls.length, 0);
  await f.approve();
  await writeFile(join(f.dir, 'photo.png'), Buffer.from('changed source'));
  result = await f.execute(); assert.equal(result.code, 1); assert.equal(f.calls.length, 0);
  await writeFile(join(f.dir, 'photo.png'), f.png);
  result = await f.execute(); assert.equal(result.code, 0, result.stderr);
  await f.approve({ budgetMicrousd: 999999 });
  result = await f.execute(); assert.equal(result.code, 1); assert.match(result.stderr, /Ledger does not match/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 6);
});

test('segmentation may not crop the full canvas even when its alpha is valid', async t => {
  let segments = 0;
  const f = await fixture(t, { async handle({ call, response, png }) {
    if (call.path === '/v1/segment' && ++segments > 1) {
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(await sharp(png).resize(16, 32).png().toBuffer()); return true;
    }
  } });
  await f.approve();
  const result = await f.execute(); assert.equal(result.code, 1); assert.match(result.stderr, /canvas dimensions/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 4);
});

test('multiple views keep their roles and only the feature variant receives uncertain attributes as unknown', async t => {
  const f = await fixture(t);
  f.plan.items[0].photos.push('back.png'); f.plan.items[0].photoRoles.push('back');
  await writeFile(join(f.dir, 'back.png'), f.png);
  f.plan.items[0].sources.push({ ...f.plan.items[0].sources[0], path: 'back.png' });
  await writeFile(f.planPath, JSON.stringify(f.plan));
  await f.approve({ maxCalls: { preparation: 12, attributes: 2, generation: 4, segmentation: 4 } });
  const result = await f.execute(); assert.equal(result.code, 0, result.stderr);
  const jev = f.calls.filter(c => c.path === '/v1/systemone');
  assert.equal(jev.length, 2); assert.equal(Object.keys(jev[1].body.assets).length, 4);
  assert.deepEqual(Object.keys(jev[1].body.state), ['photo_0_prepared_front', 'photo_1_original_front', 'photo_2_prepared_back', 'photo_3_original_back']);
  assert.equal(new Set(Object.values(jev[1].body.state)).size, 4);
  const generation = f.calls.filter(c => c.method === 'POST' && c.path.includes('nano'));
  assert.deepEqual(generation.map(c => c.body.image_urls.length), [3, 3, 5, 5]);
  assert.deepEqual(generation.map(c => c.body.prompt.includes('Observed features:')), [false, true, false, true]);
  assert.match(generation[3].body.prompt, /"silhouette":"unknown"/);
  assert.equal(JSON.parse(await readFile(join(f.out, 'report.json'))).compositions.length, 4);
});

test('a CDN redirect is rejected rather than followed with credentials', async t => {
  const f = await fixture(t, { handle({ call, response, origin }) {
    if (call.path.startsWith('/files/')) { response.writeHead(302, { Location: origin + '/forbidden' }); response.end(); return true; }
  } });
  await f.approve(); const result = await f.execute();
  assert.equal(result.code, 1); assert.match(result.stderr, /image download response/);
  assert.ok(!f.calls.some(c => c.path === '/forbidden'));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 3);
});

test('the committed ten-item dataset completes through local provider contracts with 24 comparisons and 14 compositions', async t => {
  const f = await fixture(t);
  const base = new URL('./', import.meta.url).pathname;
  const plan = JSON.parse(await readFile(new URL('./plan.json', import.meta.url), 'utf8'));
  plan.template = join(base, plan.template);
  for (const item of plan.items) {
    item.photos = item.photos.map(p => join(base, p));
    for (const source of item.sources) source.path = join(base, source.path);
  }
  await writeFile(f.planPath, JSON.stringify(plan));
  await f.approve({ budgetMicrousd: 3633036, maxCalls: { preparation: 12, attributes: 12, generation: 24, segmentation: 24 } });
  const result = await f.execute(['--timeout-ms', '2000']); assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.results.length, 24); assert.equal(report.compositions.length, 14);
  const key = JSON.parse(await readFile(join(f.out, 'answer-key.json')));
  const jacket = report.compositions.find(c => key[c.id].combinationId === 'open-jacket-over-tee');
  assert.deepEqual(jacket.layers.map(l => l.itemId), ['jeans', 'creepers', 'white-tee', 'open-denim-jacket']);
  assert.equal(report.reservedMicrousd, 3633036); assert.equal(report.actualCostMicrousd, 0);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 72);
});


test('a lost Photoroom sandbox response consumes its slot and is never submitted again', async t => {
  const f = await fixture(t, { handle({ call, request }) {
    if (call.path === '/v1/segment') { request.socket.destroy(); return true; }
  } });
  await f.approve();
  const first = await f.execute(); assert.equal(first.code, 1);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.operations.length, 1); assert.equal(report.operations[0].stage, 'preparation');
  assert.equal(report.operations[0].status, 'unknown'); assert.equal(report.operations[0].reservedMicrousd, 0);
  const again = await f.execute(); assert.equal(again.code, 1); assert.match(again.stderr, /reconciliation/);
  assert.equal(f.calls.length, 1);
});


test('Photoroom quota denial keeps the sandbox slot and never falls back or calls JEV', async t => {
  const f = await fixture(t, { handle({ call, json }) {
    if (call.path === '/v1/segment') { json(429, { error: 'quota' }); return true; }
  } });
  await f.approve(); const first = await f.execute(); assert.equal(first.code, 1); assert.match(first.stderr, /Photoroom HTTP 429/);
  const again = await f.execute(); assert.equal(again.code, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].headers['x-api-key'], 'sandbox_fixture_key');
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.operations[0].status, 'failed'); assert.equal(report.operations[0].stage, 'preparation');
});

test('malformed JEV probabilities are rejected before generation despite valid model and usage', async t => {
  const f = await fixture(t, { jevAnswer(payload) { payload.answers.silhouette.probabilities.unknown = -0.1; } });
  await f.approve(); const result = await f.execute(); assert.equal(result.code, 1); assert.match(result.stderr, /Invalid JEV/);
  assert.deepEqual(f.calls.map(c => c.path), ['/v1/segment', '/v1/systemone']);
});

test('captured JEV rounded probabilities preserve usable features through the trial CLI', async t => {
  const captured = JSON.parse(await readFile(new URL('./fixtures/jev-rounded-response.json', import.meta.url)));
  const f = await fixture(t, { jevAnswer(payload) { Object.assign(payload, structuredClone(captured)); } });
  await f.approve(); const result = await f.execute(); assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.status, 'completed');
  const attributes = report.operations.find(o => o.stage === 'attributes');
  assert.equal(attributes.status, 'completed');
  assert.equal(attributes.result.inputTokens, 13787);
  assert.equal(attributes.result.features.item_type, 't_shirt');
  assert.deepEqual(attributes.result.features.colors, ['white']);
  assert.equal(attributes.result.features.surface, 'unknown');
  assert.equal(captured.answers.item_type.probabilities.t_shirt, 0.93);
});

test('rounded JEV distributions are accepted when their intervals contain a total of one', async t => {
  for (const [name, mutate] of [
    ['34 options totaling 0.98', p => { p.answers.item_type.probabilities.t_shirt = 0.92; }],
    ['34 options totaling 1.02', p => {
      for (const key of Object.keys(p.answers.item_type.probabilities)) p.answers.item_type.probabilities[key] = 0.03;
    }],
    ['three options totaling 0.99', p => {
      p.answers.hood = { type: 'choice', choice: 'unknown', confidence: 0.1, probabilities: { yes: 0.33, no: 0.33, unknown: 0.33 } };
    }],
  ]) await t.test(name, async t => {
    const captured = JSON.parse(await readFile(new URL('./fixtures/jev-rounded-response.json', import.meta.url)));
    mutate(captured);
    const f = await fixture(t, { jevAnswer(payload) { Object.assign(payload, captured); } });
    await f.approve(); const result = await f.execute(); assert.equal(result.code, 0, result.stderr);
  });
});

test('rounding compatibility still rejects malformed JEV answers before generation', async t => {
  for (const [name, mutate] of [
    ['missing option', p => { delete p.answers.item_type.probabilities.polo; }],
    ['extra option', p => { p.answers.item_type.probabilities.extra = 0; }],
    ['replaced option', p => { delete p.answers.item_type.probabilities.polo; p.answers.item_type.probabilities.extra = 0; }],
    ['negative probability', p => { p.answers.item_type.probabilities.polo = -0.01; }],
    ['probability above one', p => { p.answers.item_type.probabilities.t_shirt = 1.01; }],
    ['nonfinite probability', p => { p.answers.item_type.probabilities.polo = 'NONFINITE'; }],
    ['string probability', p => { p.answers.item_type.probabilities.polo = '0'; }],
    ['choice outside options', p => { p.answers.item_type.choice = 'invented'; }],
    ['choice is not maximum', p => { p.answers.item_type.choice = 'blouse'; }],
    ['impossible low total', p => { p.answers.item_type.probabilities.t_shirt = 0.7; }],
    ['impossible high total', p => { p.answers.item_type.probabilities.t_shirt = 1; }],
    ['finer precision does not gain rounding tolerance', p => { p.answers.item_type.probabilities.t_shirt = 0.9301; }],
    ['three options totaling 0.98 cannot round from one', p => {
      p.answers.hood = { type: 'choice', choice: 'unknown', confidence: 0.1, probabilities: { yes: 0.32, no: 0.33, unknown: 0.33 } };
    }],
  ]) await t.test(name, async t => {
    const captured = JSON.parse(await readFile(new URL('./fixtures/jev-rounded-response.json', import.meta.url)));
    mutate(captured);
    const f = await fixture(t, { handle({ call, response }) {
      if (call.path !== '/v1/systemone') return false;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(captured).replace('"NONFINITE"', '1e999')); return true;
    } });
    await f.approve(); const result = await f.execute();
    assert.equal(result.code, 1); assert.match(result.stderr, /Invalid JEV feature response/);
    assert.deepEqual(f.calls.map(c => c.path), ['/v1/segment', '/v1/systemone']);
  });
});


test('a usable alpha Nano result skips final Photoroom without consuming its quota slot', async t => {
  const f = await fixture(t, { handle({ call, response, png }) {
    if (call.path.startsWith('/files/')) { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); return true; }
  } });
  await f.approve(); const result = await f.execute(); assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls.filter(c => c.path === '/v1/segment').length, 1);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.operations.filter(o => o.stage === 'segmentation' && o.status === 'skipped').length, 2);
  assert.equal(report.attemptCounts.segmentation, 0); assert.equal(report.attemptCounts.preparation, 1);
  assert.equal(report.results.length, 2);
  await f.execute(); assert.equal(f.calls.filter(c => c.method === 'POST').length, 4);
});


test('a fully transparent Nano image is rejected before final sandbox processing', async t => {
  const f = await fixture(t, { async handle({ call, response }) {
    if (call.path.startsWith('/files/')) {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(await sharp({ create: { width: 32, height: 32, channels: 4, background: '#00000000' } }).png().toBuffer()); return true;
    }
  } });
  await f.approve(); const result = await f.execute(); assert.equal(result.code, 1); assert.match(result.stderr, /no visible pixels/);
  assert.equal(f.calls.filter(c => c.path === '/v1/segment').length, 1);
});

async function reconciledFixture(t, budgetMicrousd = 1000000, fullDataset = false) {
  let originalAttempt = true;
  const f = await fixture(t, { jevAnswer(payload) { if (originalAttempt) delete payload.usage; } });
  if (fullDataset) {
    const base = new URL('./', import.meta.url).pathname;
    const plan = JSON.parse(await readFile(new URL('./plan.json', import.meta.url)));
    plan.template = join(base, plan.template);
    for (const item of plan.items) {
      item.photos = item.photos.map(p => join(base, p));
      for (const source of item.sources) source.path = join(base, source.path);
    }
    await writeFile(f.planPath, JSON.stringify(plan));
  }
  await f.approve({ budgetMicrousd, maxCalls: fullDataset ? { preparation: 12, attributes: 14, generation: 28, segmentation: 28 }
    : { preparation: 12, attributes: 2, generation: 2, segmentation: 2 } });
  assert.equal((await f.execute()).code, 1); originalAttempt = false;
  const ledger = JSON.parse(await readFile(join(f.out, 'ledger.json')));
  const prep = Object.values(ledger.operations).find(op => op.stage === 'preparation');
  const { featureRequest, featureAnswer } = await import('./trial-jev.mjs');
  const { semanticRequest } = await import('./jev-diagnostic-response.mjs');
  const first = JSON.parse(await readFile(f.planPath)).items[0];
  const original = await sharp(await readFile(first.photos[0].startsWith('/') ? first.photos[0] : join(f.dir, first.photos[0]))).rotate().png().toBuffer();
  const request = await featureRequest([await readFile(join(f.out, prep.artifact)), original], ['prepared_front', 'original_front']);
  const answers = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => {
    if (q.type === 'noul') return [name, { type: 'noul', noul: .8 }];
    const choice = name === 'suitability' ? 'suitable' : Object.keys(q.criteria)[0];
    return [name, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
  }));
  const key = `${first.id}/single/attributes`, reconciledBy = `${key}-diagnostic-1`;
  Object.assign(ledger.operations[key], { reservedMicrousd: 100000, originalReservedMicrousd: 2753, reconciledBy });
  ledger.operations[reconciledBy] = { key: reconciledBy, stage: 'attributes', status: 'completed', reservedMicrousd: 100000,
    result: featureAnswer({ model: request.model, answers, usage: { input_tokens: 1000 } }, request),
    semanticRequestSha256: digest(JSON.stringify(semanticRequest(request))) };
  await writeFile(join(f.out, 'ledger.json'), JSON.stringify(ledger));
  return f;
}

test('reconciled attributes preserve both attempts and reuse preparation without another JEV POST', async t => {
  const f = await reconciledFixture(t), before = f.calls.length;
  const result = await f.execute(); assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.slice(before).filter(c => c.method === 'POST').map(c => c.path),
    ['/fal-ai/nano-banana-pro/edit', '/v1/segment', '/fal-ai/nano-banana-pro/edit', '/v1/segment']);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.deepEqual(report.attemptCounts, { preparation: 1, attributes: 2, generation: 2, segmentation: 2 });
  assert.equal(report.reservedMicrousd, 500000);
  assert.equal(report.operations.find(op => op.key === 'shirt/single/attributes').status, 'unknown');
  assert.equal(report.results.length, 2);
});

test('historical conservative reservations consume the continuation budget before the next submit', async t => {
  const f = await reconciledFixture(t, 400000), before = f.calls.length;
  const result = await f.execute(); assert.equal(result.code, 1); assert.match(result.stderr, /budget\/call limit exhausted/);
  assert.equal(f.calls.slice(before).filter(c => c.method === 'POST' && c.path.includes('nano')).length, 1);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.reservedMicrousd, 350000);
  assert.equal(report.attemptCounts.attributes, 2); assert.equal(report.attemptCounts.generation, 1);
});

test('reconciliation cannot be applied to a different semantic image request', async t => {
  const f = await reconciledFixture(t), before = f.calls.length;
  const path = join(f.out, 'ledger.json'), ledger = JSON.parse(await readFile(path));
  ledger.operations['shirt/single/attributes-diagnostic-1'].semanticRequestSha256 = 'f'.repeat(64);
  await writeFile(path, JSON.stringify(ledger));
  const result = await f.execute(); assert.equal(result.code, 1); assert.match(result.stderr, /does not match this input/);
  assert.equal(f.calls.length, before);
});


test('the full continued dataset keeps 13 historical JEV attempts and the aggregate reserve', async t => {
  const f = await reconciledFixture(t, 5000000, true), before = f.calls.length;
  const result = await f.execute(['--timeout-ms', '2000']); assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.deepEqual(report.attemptCounts, { preparation: 12, attributes: 13, generation: 24, segmentation: 24 });
  assert.equal(report.reservedMicrousd, 3830283); assert.equal(report.results.length, 24);
  assert.equal(f.calls.slice(before).filter(c => c.method === 'POST' && c.path === '/v1/systemone').length, 11);
  assert.equal(f.calls.slice(before).filter(c => c.method === 'POST' && c.path === '/v1/segment').length, 35);
});
