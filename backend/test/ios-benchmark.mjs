// Explicit, temporary load fixture. Never a production publication/import API.
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile, realpath, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clonePreparedPacket, installReceiptFixture } from './prepared-receipt-fixture.mjs';
import { canonicalFeatures, canonicalText, featureDigest, validateObserved } from '../src/publication-contract.mjs';

const SOURCE_IDS = ['light-polo', 'pub-03', 'pub-13', 'black-jeans'];
export const baseline = '73700bab547ed71113dbf27db18136e054a1cca2';
export const realSpace = '5232e383c329cb71cea3217bfd78b7f36128b1abb6657c94e2909635b638a24b';
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const check = (value, code) => { if (!value) throw new Error(code); };
const pause = ms => new Promise(done => setTimeout(done, ms));
const fixtureID = (role, index) => 'b300000' + role + '-0000-4000-8000-' + String(index + 1).padStart(12, '0');
const safeAsset = name => /^[a-z0-9-]+\.(png|jpg|json)$/.test(name);
const privateWrite = (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });

async function loadSources(directory) {
  const records = [];
  for (const publicID of SOURCE_IDS) {
    const folder = join(directory, publicID);
    const [item, illustration, preparation, packet] = await Promise.all(
      ['item-response.json', 'illustration-response.json', 'preparation-response.json', 'recommendation-item.json']
        .map(async name => JSON.parse(await readFile(join(folder, name), 'utf8'))));
    const files = {};
    for (const [key, name] of Object.entries({ source: 'encoder-and-upload-input.png', cutout: 'cutout.png',
      illustration: 'illustration.png', prepared: 'prepared-source.png', representation: 'representation.json' })) {
      files[key] = await readFile(join(folder, name));
      check(files[key].length > 0 && files[key].length <= 6 * 1024 * 1024, 'source_size');
    }
    const rep = JSON.parse(files.representation);
    const observed = validateObserved(illustration.observedFeatures), effective = validateObserved(illustration.effectiveFeatures);
    assert.deepEqual(canonicalFeatures(effective, true), packet.features);
    check(item.mode === 'live' && illustration.mode === 'live' && preparation.mode === 'real'
      && preparation.imageMode === 'live' && preparation.provenance === 'pipeline', 'non_real_source');
    check(illustration.modelVersion === 'gemini-3-pro-image'
      && illustration.templateVersion === 'front-360x560-proposed-v1'
      && illustration.geometryVersion === 'fitting-square-1024-v1', 'image_version');
    check(preparation.status === 'ready' && preparation.spaceID === realSpace && rep.spaceID === realSpace
      && rep.photoVersionID === packet.photoVersionId && rep.sourceSHA256 === sha(files.source)
      && rep.textSHA256 === sha(canonicalText(packet.features)), 'representation_binding');
    check(files.representation.toString('utf8') === packet.representationJSON
      && sha(files.representation) === packet.representationSHA256
      && preparation.representationSHA256 === packet.representationSHA256
      && preparation.representationJSON === packet.representationJSON, 'representation_digest');
    check(rep.vector?.length === 128 && rep.vector.every(Number.isFinite), 'invalid_vector');
    check(sha(files.cutout) === item.resultSHA256 && sha(files.illustration) === illustration.resultSHA256
      && featureDigest(observed) === illustration.observedFeaturesSHA256
      && featureDigest(effective) === illustration.effectiveFeaturesSHA256, 'artifact_digest');
    assert.deepEqual(preparation.artifacts, { cutoutSHA256: sha(files.cutout), illustrationSHA256: sha(files.illustration),
      observedFeaturesSHA256: featureDigest(observed), effectiveFeaturesSHA256: featureDigest(effective) });
    const prepared = illustration.preparedSources?.[0];
    check(illustration.preparedSources?.length === 1 && prepared.photoId === packet.photoVersionId
      && prepared.sourceSHA256 === sha(files.source) && prepared.preparedSHA256 === sha(files.prepared), 'prepared_source_binding');
    check(item.itemId === packet.itemId && preparation.itemId === packet.itemId
      && item.photoVersionId === packet.photoVersionId
      && illustration.itemId === packet.itemId && illustration.photoVersionId === packet.photoVersionId
      && illustration.sourceSetVersionId === packet.sourceSetVersionId
      && preparation.operationId === packet.publishedVersionId && preparation.photoVersionId === packet.photoVersionId
      && preparation.sourceSetVersionId === packet.sourceSetVersionId
      && preparation.illustrationOperationId === illustration.operationId && preparation.cutoutOperationId === item.operationId, 'source_identity');
    check(preparation.input.sourceSHA256 === rep.sourceSHA256 && preparation.input.textSHA256 === rep.textSHA256, 'input_binding');
    assert.deepEqual(packet.effectiveFeatures, effective);
    records.push({ publicID, item, illustration, preparation, packet, files });
  }
  return records;
}

async function exportFixture({ source, count, token, revision, bundleDirectory }) {
  check([4, 300].includes(count), 'unsupported_item_count');
  const sources = await loadSources(source), assets = new Map(), items = [], packets = [];
  for (const original of sources) for (const kind of ['source', 'cutout', 'illustration', 'prepared']) {
    assets.set(original.publicID + '-' + kind + '.png', original.files[kind]);
  }
  for (let index = 0; index < count; index++) {
    const original = sources[index % sources.length], cloned = clonePreparedPacket(original.packet);
    const itemId = fixtureID(0, index), photoVersionId = fixtureID(1, index), publishedVersionId = fixtureID(2, index);
    const sourceSetVersionId = fixtureID(3, index), cutoutOperationId = fixtureID(4, index), illustrationOperationId = fixtureID(5, index);
    const representationJSON = JSON.stringify({ ...JSON.parse(cloned.representationJSON), photoVersionID: photoVersionId });
    const packet = { ...cloned, itemId, photoVersionId, publishedVersionId, sourceSetVersionId,
      representationJSON, representationSHA256: sha(representationJSON) };
    assert.deepEqual(JSON.parse(representationJSON).vector, JSON.parse(original.packet.representationJSON).vector);
    const illustration = { ...original.illustration, itemId, operationId: illustrationOperationId, photoVersionId,
      sourceSetVersionId, preparedSources: original.illustration.preparedSources.map(value => ({ ...value,
        photoId: photoVersionId, preparedPath: '/unused-benchmark-prepared-source' })), resultPath: '/unused-benchmark-illustration' };
    const preparation = { ...original.preparation, itemId, operationId: publishedVersionId, photoVersionId, sourceSetVersionId,
      illustrationOperationId, cutoutOperationId, representationJSON, representationSHA256: packet.representationSHA256 };
    const representationFile = 'representation-' + String(index + 1).padStart(3, '0') + '.json';
    assets.set(representationFile, Buffer.from(representationJSON));
    items.push({ itemId, photoVersionId, sourceSetVersionId, cutoutOperationId,
      sourceFile: original.publicID + '-source.png', cutoutFile: original.publicID + '-cutout.png',
      illustrationFile: original.publicID + '-illustration.png', preparedSourceFile: original.publicID + '-prepared.png',
      representationFile, illustration, preparation });
    packets.push(packet);
  }
  const publicManifest = JSON.parse(await readFile(join(backend, '..', 'docs/research/epic63-public-manifest.json'), 'utf8'));
  const sourceAttribution = await Promise.all(SOURCE_IDS.map(async id => {
    const entry = publicManifest.items.find(item => item.id === id);
    check(entry?.attribution && entry.sha256, 'public_attribution_missing');
    check(sha(await readFile(join(source, id, 'public-input.jpg'))) === entry.sha256, 'public_source_digest');
    return { id, author: entry.attribution.author, source: entry.attribution.source,
      license: entry.attribution.license, licenseURL: entry.attribution.licenseUrl, sourceSHA256: entry.sha256 };
  }));
  const manifest = { schemaVersion: 1, count, uniqueSources: 4, sourceRevision: baseline, benchmarkRevision: revision, sourceAttribution,
    spaceID: realSpace, tokenSHA256: sha(token), provenance: 'isolated synthetic clones of four real public-photo packets',
    assets: [...assets].map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.length })), items };
  await mkdir(bundleDirectory, { mode: 0o700 });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await privateWrite(join(bundleDirectory, 'manifest.json'), manifestBytes);
  for (const [name, bytes] of assets) {
    check(safeAsset(name), 'invalid_asset_name');
    await privateWrite(join(bundleDirectory, name), bytes);
  }
  return { manifest, manifestSHA256: sha(manifestBytes), packets };
}

function processTreeRSS(pid) {
  try {
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    const children = readFileSync('/proc/' + pid + '/task/' + pid + '/children', 'utf8').trim().split(/\s+/).filter(Boolean);
    return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) + children.reduce((sum, id) => sum + processTreeRSS(id), 0);
  } catch { return 0; }
}

export async function spawnBackend({ program, database, token, python, assets, real }) {
  const child = spawn(process.execPath, [join(program, 'src/server.mjs')], { cwd: program, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', SAINT_LOOK_OWNER_TOKEN: token,
      SAINT_LOOK_PROVIDER: 'demo', SAINT_LOOK_DATA_DIR: database, SAINT_LOOK_MODEL_PROFILE: real ? 'outfit-transformer-labse-v1' : 'disabled',
      SAINT_LOOK_MODEL_PYTHON: python, SAINT_LOOK_MODEL_ASSETS: assets, SAINT_LOOK_MODEL_THREADS: '1',
      SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'false', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
  child.stderr.on('data', () => {}); // Never forward process environment or credential-bearing errors.
  let closed = false, stopping;
  const ended = new Promise(done => child.once('close', () => { closed = true; done(); }));
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (closed || child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      await ended; clearTimeout(kill);
    })();
    return stopping;
  };
  let origin;
  try { origin = await new Promise((done, reject) => {
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('backend_listen_timeout')); }, 15_000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('backend_start_failed')); });
    child.once('close', () => { clearTimeout(timeout); reject(new Error('backend_exited')); });
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try { const message = JSON.parse(line); if (/^http:\/\/127\.0\.0\.1:\d+$/.test(message.url)) { clearTimeout(timeout); done(message.url); } } catch {}
      }
    });
  }); } catch (error) { await stop(); throw error; }
  return { child, origin, stop };
}

export async function startBenchmark(options) {
  check(/^bench-[a-f0-9]{64}$/.test(options.token), 'invalid_benchmark_token');
  check([4, 300].includes(options.count), 'unsupported_item_count');
  check(Number.isInteger(options.ttlSeconds) && options.ttlSeconds >= 30 && options.ttlSeconds <= 3600, 'invalid_ttl');
  const startupTimeoutMilliseconds = options.startupTimeoutMilliseconds ?? 180_000;
  check(Number.isInteger(startupTimeoutMilliseconds) && startupTimeoutMilliseconds >= 1000 && startupTimeoutMilliseconds <= 180_000, 'invalid_startup_deadline');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: backend, encoding: 'utf8' }).trim();
  check(/^[a-f0-9]{40}$/.test(revision), 'invalid_source_revision');
  const directory = options.directory ? resolve(options.directory) : await mkdtemp('/tmp/saint-look-benchmark-');
  check(directory.startsWith('/tmp/saint-look-benchmark-') && await realpath(dirname(directory)) === '/tmp', 'isolated_directory_required');
  if (options.directory) { check(!existsSync(directory), 'new_directory_required'); await mkdir(directory, { mode: 0o700 }); }
  const program = join(directory, 'program'), database = join(directory, 'database');
  await mkdir(program, { mode: 0o700 }); await mkdir(database, { mode: 0o700 });
  await cp(join(backend, 'src'), join(program, 'src'), { recursive: true });
  await cp(join(backend, 'release.json'), join(program, 'release.json'));
  await cp(join(backend, '..', 'shared'), join(directory, 'shared'), { recursive: true });
  await mkdir(join(program, 'ml'));
  for (const file of ['worker.py', 'adapter.py', 'contract.py', 'head.py', 'assets.json']) await cp(join(backend, 'ml', file), join(program, 'ml', file));
  await symlink(await realpath(join(backend, 'node_modules')), join(program, 'node_modules'), 'dir');
  await privateWrite(join(program, 'package.json'), '{"type":"module"}');
  await privateWrite(join(program, 'REVISION'), revision);
  const data = await exportFixture({ ...options, revision, bundleDirectory: join(directory, 'bundle') });
  const zipPath = join(directory, 'benchmark.zip');
  execFileSync('python3', ['-c', 'import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"x",compression=zipfile.ZIP_DEFLATED); [z.write(f,f.name) for f in sorted(p.iterdir())]; z.close()', join(directory, 'bundle'), zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let server, backendProcess, closed = false, timer, peakKiB = 0, sample, requests = [];
  const stop = async () => {
    if (closed) return; closed = true; clearTimeout(timer); clearInterval(sample);
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    if (backendProcess) await backendProcess.stop();
    await privateWrite(join(directory, 'result.json'), JSON.stringify({ provenance: 'isolated synthetic benchmark', revision,
      count: options.count, uniqueSources: 4, modelSpaceID: realSpace, requests, sampledBackendTreePeakRSSKiB: peakKiB,
      memoryScope: '250ms sampled concurrent backend+worker RSS; may miss shorter peaks; not cgroup peak', paidProviderCalls: 0 }));
  };
  try {
    backendProcess = await spawnBackend({ program, database, ...options, real: false }); await backendProcess.stop();
    installReceiptFixture(database, data.packets, 'real'); // Only the new isolated stopped test DB.
    const startup = performance.now();
    const startupDeadline = startup + startupTimeoutMilliseconds;
    backendProcess = await spawnBackend({ program, database, ...options, real: true });
    sample = setInterval(() => { peakKiB = Math.max(peakKiB, processTreeRSS(backendProcess.child.pid)); }, 250);
    let config;
    while (performance.now() < startupDeadline) {
      const remaining = Math.max(1, Math.ceil(startupDeadline - performance.now()));
      const response = await fetch(backendProcess.origin + '/v1/recommendations/config', { headers: { Authorization: 'Bearer ' + options.token },
        signal: AbortSignal.timeout(Math.min(5000, remaining)) });
      if (response.ok) { config = await response.json(); if (config.encoder.available) break; }
      await pause(Math.max(0, Math.min(500, startupDeadline - performance.now())));
    }
    check(config?.encoder.available && config.encoder.mode === 'real' && config.encoder.activeSpaceID === realSpace, 'real_model_not_ready');
    const startupMilliseconds = performance.now() - startup;
    const digest = Buffer.from(sha('Bearer ' + options.token));
    server = createServer(async (request, response) => {
      const send = (status, value, type = 'application/json') => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(value); };
      try {
        const supplied = Buffer.from(sha(request.headers.authorization ?? ''));
        if (!timingSafeEqual(supplied, digest)) return send(401, '{"error":"unauthorized"}');
        if (request.method === 'GET' && request.url === '/benchmark/bundle') {
          response.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store' }); createReadStream(zipPath).pipe(response); return;
        }
        if (request.method === 'GET' && request.url === '/benchmark/metadata') return send(200, JSON.stringify({ revision, count: options.count, uniqueSources: 4,
          modelSpaceID: realSpace, manifestSHA256: data.manifestSHA256, startupMilliseconds, transport: 'local fixture; external tunnel managed separately' }));
        if (request.method === 'GET' && request.url === '/benchmark/metrics') return send(200, JSON.stringify({ requests }));
        const allowed = (request.method === 'GET' && ['/health', '/v1/recommendations/config'].includes(request.url))
          || (request.method === 'POST' && ['/v1/recommendations/single', '/v1/recommendations/compose'].includes(request.url));
        if (!allowed) return send(405, '{"error":"benchmark_route_disabled"}');
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; check(size <= 4 * 1024 * 1024, 'request_too_large'); chunks.push(chunk); }
        const body = Buffer.concat(chunks), start = performance.now();
        const result = await fetch(backendProcess.origin + request.url, { method: request.method,
          headers: { Authorization: 'Bearer ' + options.token, 'Content-Type': 'application/json' },
          body: request.method === 'POST' ? body : undefined, signal: AbortSignal.timeout(120_000), redirect: 'error' });
        const bytes = Buffer.from(await result.arrayBuffer());
        if (request.method === 'POST') {
          const input = JSON.parse(body);
          let outcome; try { outcome = JSON.parse(bytes).outcome; } catch {}
          requests.push({ requestId: input.requestId, snapshotId: input.snapshotId, items: input.items?.length, path: request.url,
            endpoint: request.url, outcome, status: result.status, payloadBytes: body.length, responseBytes: bytes.length,
            elapsedMilliseconds: performance.now() - start });
        }
        send(result.status, bytes);
      } catch { send(503, '{"error":"benchmark_request_failed"}'); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = 'http://127.0.0.1:' + server.address().port;
    timer = setTimeout(() => { void stop(); }, options.ttlSeconds * 1000);
    return { origin, directory, manifest: data.manifest, manifestSHA256: data.manifestSHA256, startupMilliseconds, packets: data.packets, stop };
  } catch (error) { await stop(); throw error; }
}

async function main() {
  const args = process.argv.slice(2), opts = {};
  if (!args.length || args.includes('--help')) {
    console.log('Local-only fixture: --source PUBLIC_HTTP4_DIR --python PYTHON --assets MODEL_ASSETS --token-file PRIVATE_FILE --count 4|300 [--ttl-seconds 1800] [--directory NEW_TMP_BENCHMARK_DIR]'); return;
  }
  for (let i = 0; i < args.length; i += 2) {
    check(['--source', '--python', '--assets', '--token-file', '--count', '--ttl-seconds', '--directory'].includes(args[i]) && args[i + 1] && !Object.hasOwn(opts, args[i]), 'invalid_arguments');
    opts[args[i]] = args[i + 1];
  }
  for (const name of ['source', 'python', 'assets', 'token-file', 'count']) check(opts['--' + name], 'missing_argument');
  check(((await stat(opts['--token-file'])).mode & 0o777) === 0o600, 'private_token_file_required');
  const result = await startBenchmark({ source: await realpath(opts['--source']), python: await realpath(opts['--python']),
    assets: await realpath(opts['--assets']), token: (await readFile(opts['--token-file'], 'utf8')).trim(), count: Number(opts['--count']),
    ttlSeconds: Number(opts['--ttl-seconds'] ?? 1800), directory: opts['--directory'] });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await result.stop(); process.exit(0); };
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
  console.log(JSON.stringify({ ready: true, origin: result.origin, directory: result.directory, count: result.manifest.count,
    uniqueSources: 4, modelSpaceID: realSpace, benchmarkRevision: result.manifest.benchmarkRevision,
    manifestSHA256: result.manifestSHA256, startupMilliseconds: result.startupMilliseconds,
    tokenStoredInBundle: false, paidProviderCalls: 0, ttlSeconds: Number(opts['--ttl-seconds'] ?? 1800) }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('{"error":"benchmark_initialization_failed"}'); process.exitCode = 1; });
}
