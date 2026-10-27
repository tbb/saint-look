import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const cli = resolve('scripts/fitting/experiment.mjs');
const png = await readFile(new URL('../deploy/synthetic.png', import.meta.url));
async function setup(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'saint-fitting-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'photo.png'), png);
  await writeFile(join(dir, 'template.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="560"></svg>');
  const plan = { version: 1, seed: 'fixed-review-order', template: 'template.svg',
    ratesMicrousd: { attributes: 1000, generation: 20000 },
    items: [{ id: 'shirt', category: 'top', photos: ['photo.png'], source: 'Synthetic test image; not a quality sample', license: 'Project-owned test fixture' }],
    combinations: [{ id: 'single-layer-test', items: ['shirt'] }] };
  const planPath = join(dir, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (!raw) { response.writeHead(404); response.end(); return; }
    const body = JSON.parse(raw); calls.push({ path: request.url, body });
    if (handler) return handler(request, response, body, calls);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/attributes'
      ? { features: { silhouette: 'wide', neckline: 'unknown' } }
      : { pngBase64: png.toString('base64') }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const out = join(dir, 'result');
  const run = (extra = []) => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, '--plan', planPath, '--out', out,
      '--fixture-url', url, '--max-requests', '20', '--max-cost-microusd', '1000000', ...extra],
    { env: { ...process.env, CI: 'true', FAL_KEY: 'unused-fixture-key', TYPESAFE_API_KEY: 'unused-fixture-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { dir, plan, planPath, calls, url, out, run };
}

test('one photo produces a blinded local comparison and a separate answer key, without a quality claim', async t => {
  const f = await setup(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.map(c => c.path), ['/attributes', '/generate', '/generate']);
  assert.equal(f.calls[1].body.features, undefined);
  assert.deepEqual(f.calls[2].body.features, { silhouette: 'wide', neckline: 'unknown' });
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.mode, 'local-fixture');
  assert.equal(report.qualityEvidence, false);
  assert.equal(report.actualCostMicrousd, 0);
  assert.equal(report.reservedEstimateMicrousd, 41000);
  assert.equal(report.completed, 3);
  const html = await readFile(join(f.out, 'review.html'), 'utf8');
  assert.match(html, /data:image\/png;base64/);
  assert.match(html, /Тестовые ответы/);
  assert.doesNotMatch(html, /with-features|without-features|silhouette/);
  const key = JSON.parse(await readFile(join(f.out, 'answer-key.json')));
  assert.deepEqual(Object.values(key).filter(x => x.itemId).map(x => x.variant).sort(), ['with-features', 'without-features']);
});

test('a fixture URL with a path is rejected before any request; no alternate routes exist', async t => {
  const f = await setup(t);
  const result = await f.run(['--fixture-url', f.url + '/other']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exact loopback origin/);
  assert.equal(f.calls.length, 0);
});

test('an insufficient request or reserved-cost ceiling refuses the experiment before sending photos', async t => {
  for (const limits of [['--max-requests', '2'], ['--max-cost-microusd', '40999']]) {
    const f = await setup(t);
    const result = await f.run(limits);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Plan exceeds/);
    assert.equal(f.calls.length, 0);
  }
});

test('a lost response persists its reservation and unknown outcome without automatic retry or resume', async t => {
  const f = await setup(t, request => request.socket.destroy());
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 1);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.status, 'incomplete');
  assert.equal(report.reservedEstimateMicrousd, 1000);
  assert.equal(report.unknown, 1);
  const events = (await readFile(join(f.out, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.status), ['started', 'unknown']);
  assert.equal(events[0].reservedMicrousd, 1000);
  assert.equal((await f.run()).code, 1);
  assert.equal(f.calls.length, 1, 'An existing result directory cannot silently resume uncertain calls');
});

test('additional photos compare single and multi inputs with the same versioned template and recorded sources', async t => {
  const f = await setup(t);
  await writeFile(join(f.dir, 'detail.png'), png);
  f.plan.items[0].photos.push('detail.png');
  f.plan.templateVersion = 'front-v1';
  f.plan.model = 'local-fixture-v1';
  f.plan.parameters = { pose: 'front', style: 'editorial illustration' };
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.map(c => c.body.photos.length), [1, 1, 1, 2, 2, 2]);
  assert.ok(f.calls.filter(c => c.path === '/generate').every(c => c.body.templateSvg.includes('<svg')));
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.reservedEstimateMicrousd, 82000);
  assert.equal(report.plan.templateVersion, 'front-v1');
  assert.equal(report.plan.model, 'local-fixture-v1');
  assert.equal(report.plan.items[0].license, 'Project-owned test fixture');
  assert.match(report.templateSha256, /^[a-f0-9]{64}$/);
  const key = JSON.parse(await readFile(join(f.out, 'answer-key.json')));
  assert.equal(Object.values(key).filter(x => x.itemId).length, 4);
  assert.deepEqual(Object.values(key).filter(x => x.itemId).map(x => x.input).sort(), ['multi', 'multi', 'single', 'single']);
});

test('the review includes original photos and independent layers on the common mannequin for each combination', async t => {
  const f = await setup(t);
  f.plan.items.push({ ...f.plan.items[0], id: 'trousers', category: 'bottom' });
  f.plan.combinations = [{ id: 'shirt-trousers', items: ['shirt', 'trousers'] }];
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const html = await readFile(join(f.out, 'review.html'), 'utf8');
  assert.match(html, /Сочетания/);
  assert.equal((html.match(/class="mannequin"/g) || []).length, 2);
  assert.equal((html.match(/class="garment-layer"/g) || []).length, 4);
  assert.match(html, /data:image\/svg\+xml;base64/);
  assert.doesNotMatch(html, /with-features|without-features/);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.comparisons, 4);
  assert.equal(report.combinations, 2);
});

test('optional segmentation is reserved and counted for both variants instead of being a free hidden step', async t => {
  const f = await setup(t);
  f.plan.requiresSegmentation = true;
  f.plan.ratesMicrousd.segmentation = 18000;
  await writeFile(f.planPath, JSON.stringify(f.plan));
  assert.equal((await f.run(['--max-requests', '4'])).code, 1);
  assert.equal(f.calls.length, 0);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.map(c => c.path), ['/attributes', '/generate', '/segment', '/generate', '/segment']);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.reservedEstimateMicrousd, 77000);
  assert.equal(report.completed, 5);
});

test('malformed attributes stop before generation and are recorded as failed instead of usable features', async t => {
  const f = await setup(t, (_request, response) => response.end(JSON.stringify({ features: [] })));
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 1);
  const journal = (await readFile(join(f.out, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).status, 'failed');
});

test('invalid image output cannot become a review candidate or trigger another generation', async t => {
  const f = await setup(t, (request, response) => response.end(JSON.stringify(request.url === '/attributes'
    ? { features: {} } : { pngBase64: Buffer.from('<script>bad</script>').toString('base64') })));
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 2);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.comparisons, 0);
  assert.equal(report.status, 'incomplete');
});

test('remote hosts and malformed limits are rejected even when credentials happen to exist in the environment', async t => {
  const f = await setup(t);
  for (const url of ['https://api.photoroom.com', 'http://localhost:8787', f.url + '?redirect=1', f.url.replace('127.0.0.1', 'user:secret@127.0.0.1')]) {
    const result = await f.run(['--fixture-url', url]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /exact loopback origin/);
  }
  for (const value of ['NaN', 'Infinity', '0', '-1', '1.2']) {
    assert.equal((await f.run(['--max-requests', value])).code, 1);
  }
  assert.equal(f.calls.length, 0);
});

test('redirect responses never leave the local fixture and retain the attempted reservation', async t => {
  const f = await setup(t, (_request, response) => {
    response.writeHead(302, { Location: 'https://example.invalid/paid-api' }); response.end('{}');
  });
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 1);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.reservedEstimateMicrousd, 1000);
  const events = (await readFile(join(f.out, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).status, 'failed');
});

test('a response timeout is unknown, bounded and never retried', async t => {
  const f = await setup(t, () => {});
  const started = Date.now();
  const result = await f.run(['--timeout-ms', '100']);
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 1);
  assert.ok(Date.now() - started < 5000);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.unknown, 1);
});

test('changed source bytes fail provenance validation before any photo is sent', async t => {
  const f = await setup(t);
  f.plan.items[0].sources = [{ path: 'photo.png', sha256: '0'.repeat(64) }];
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Source hash mismatch/);
  assert.equal(f.calls.length, 0);
});

test('a multi-photo top can be compared with single-photo trousers without dropping the composition', async t => {
  const f = await setup(t);
  await writeFile(join(f.dir, 'detail.png'), png);
  f.plan.items[0].photos.push('detail.png');
  f.plan.items.push({ ...f.plan.items[0], id: 'trousers', category: 'bottom', photos: ['photo.png'] });
  f.plan.combinations = [{ id: 'mixed-inputs', items: ['shirt', 'trousers'] }];
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const key = JSON.parse(await readFile(join(f.out, 'answer-key.json')));
  const mixed = Object.values(key).filter(x => x.combinationId && x.input === 'multi');
  assert.equal(mixed.length, 2);
  for (const entry of mixed) {
    assert.equal(entry.inputs.find(x => x.itemId === 'shirt').input, 'multi');
    assert.equal(entry.inputs.find(x => x.itemId === 'trousers').input, 'single');
  }
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.combinations, 4);
});

test('the committed licensed dataset completes offline and repeats the same blinded review', async t => {
  const f = await setup(t);
  const planPath = resolve('scripts/fitting/plan.json');
  const result = await f.run(['--plan', planPath, '--max-requests', '72', '--max-cost-microusd', '3633036']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.sourceHashes.length, 12);
  assert.equal(report.comparisons, 24);
  assert.equal(report.combinations, 14);
  assert.equal(report.completed, 72);
  assert.equal(report.preparedSources.length, 12);
  assert.equal(report.plan.pipelineVersion, 'photoroom-first-v2');
  assert.equal(report.qualityEvidence, false);
  const repeat = join(f.dir, 'repeat');
  const second = await f.run(['--plan', planPath, '--out', repeat, '--max-requests', '72', '--max-cost-microusd', '3633036']);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await readFile(join(f.out, 'review.html'), 'utf8'), await readFile(join(repeat, 'review.html'), 'utf8'));
});

test('free preparation consumes slots once per unique photo before either A/B input set', async t => {
  const f = await setup(t);
  await writeFile(join(f.dir, 'detail.png'), await readFile(new URL('./fixtures/white-tee.png', import.meta.url)));
  f.plan.items[0].photos.push('detail.png');
  f.plan.items[0].photoRoles = ['front', 'back'];
  f.plan.preparationEndpoint = 'photoroom-sandbox/v1/segment';
  f.plan.ratesMicrousd.preparation = 0;
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const tooFew = await f.run(['--max-requests', '7']);
  assert.equal(tooFew.code, 1);
  assert.equal(f.calls.length, 0, 'Free preparation still reserves quota slots before dispatch');
  const result = await f.run(['--max-requests', '8']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.map(c => c.path), ['/prepare', '/prepare', '/attributes', '/generate', '/generate', '/attributes', '/generate', '/generate']);
  assert.deepEqual(f.calls[2].body.photoRoles, ['front:original', 'front:prepared']);
  assert.deepEqual(f.calls[5].body.photoRoles, ['front:original', 'front:prepared', 'back:original', 'back:prepared']);
  assert.equal(f.calls[3].body.photos.length, 2);
  assert.equal(f.calls[6].body.photos.length, 4);
  assert.deepEqual(f.calls[3].body.photos, f.calls[4].body.photos);
  assert.deepEqual(f.calls[3].body.photos, f.calls[6].body.photos.slice(0, 2), 'Prepared front is reused across single/multi');
  assert.match(f.calls[2].body.watermarkGuidance, /not.*garment/i);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.completed, 8);
  assert.equal(report.reservedEstimateMicrousd, 82000);
  assert.equal(report.preparedSources.length, 2);
});

test('identical source bytes are prepared once even when reused by another item', async t => {
  const f = await setup(t);
  f.plan.items.push({ ...f.plan.items[0], id: 'second-shirt' });
  f.plan.preparationEndpoint = 'photoroom-sandbox/v1/segment';
  f.plan.ratesMicrousd.preparation = 0;
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const result = await f.run(['--max-requests', '7']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls.filter(c => c.path === '/prepare').length, 1);
  assert.equal(f.calls.length, 7);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.preparedSources.length, 1);
  assert.equal(report.sourceHashes.length, 2);
});

test('an unknown free preparation consumes its slot and stops all dependent requests without retry', async t => {
  const f = await setup(t, request => request.socket.destroy());
  f.plan.preparationEndpoint = 'photoroom-sandbox/v1/segment';
  f.plan.ratesMicrousd.preparation = 0;
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.deepEqual(f.calls.map(c => c.path), ['/prepare']);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.unknown, 1);
  assert.equal(report.reservedEstimateMicrousd, 0);
  assert.equal(report.preparedSources.length, 0);
  const journal = (await readFile(join(f.out, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.map(e => [e.stage, e.status]), [['preparation', 'started'], ['preparation', 'unknown']]);
  assert.equal((await f.run()).code, 1);
  assert.equal(f.calls.length, 1);
});

test('free final segmentation also consumes bounded quota slots', async t => {
  const f = await setup(t);
  f.plan.preparationEndpoint = 'photoroom-sandbox/v1/segment';
  f.plan.segmentationEndpoint = 'photoroom-sandbox/v1/segment';
  f.plan.requiresSegmentation = true;
  f.plan.ratesMicrousd.preparation = 0;
  f.plan.ratesMicrousd.segmentation = 0;
  await writeFile(f.planPath, JSON.stringify(f.plan));
  assert.equal((await f.run(['--max-requests', '5'])).code, 1);
  assert.equal(f.calls.length, 0);
  const result = await f.run(['--max-requests', '6']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.map(c => c.path), ['/prepare', '/attributes', '/generate', '/segment', '/generate', '/segment']);
  const report = JSON.parse(await readFile(join(f.out, 'report.json')));
  assert.equal(report.reservedEstimateMicrousd, 41000);
});
