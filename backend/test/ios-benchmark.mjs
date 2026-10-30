// Explicit, temporary load fixture. Never a production publication/import API.
import assert from 'node:assert/strict';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile, realpath, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clonePreparedPacket, installReceiptFixture } from './prepared-receipt-fixture.mjs';
import sharp from 'sharp';
import { canonicalFeatures, canonicalText, featureDigest, validateObserved } from '../src/publication-contract.mjs';

import { observableChoices } from '../src/illustration-features.mjs';
import { illustrationTaxonomy, illustrationVersions } from '../src/illustration-provider.mjs';
import { canonicalSingleRequestHash, createPublicBenchmarkProxy } from './ios-benchmark-public-proxy.mjs';

const SOURCE_IDS = ['light-polo', 'pub-03', 'pub-13', 'black-jeans'];
export const baseline = '73700bab547ed71113dbf27db18136e054a1cca2';
export const realSpace = 'df268e5dab58fc14040ec8d5966455e546943406bf04380d24ee8ffcf4ca7e17';
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const check = (value, code) => { if (!value) throw new Error(code); };
const pause = ms => new Promise(done => setTimeout(done, ms));
const fixtureID = (role, index) => 'b300000' + role + '-0000-4000-8000-' + String(index + 1).padStart(12, '0');
const safeAsset = name => /^[a-z0-9-]+\.(png|jpg|json)$/.test(name);
const privateWrite = (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });

async function loadSources(directory) {
  const sourceManifest = JSON.parse(await readFile(join(directory, 'sources.json'), 'utf8'));
  check(sourceManifest.schemaVersion === 1 && sourceManifest.sourceProvenance === 'public-manifest-encoder-on-runner'
    && sourceManifest.imageProviders === 'synthetic-public-photo-copies'
    && sourceManifest.items.length === 4 && SOURCE_IDS.every((id, i) => sourceManifest.items[i].id === id), 'source_provenance');
  const publicManifest = JSON.parse(await readFile(join(backend, '..', 'docs/research/epic63-public-manifest.json'), 'utf8'));
  const records = [];
  for (const [index, input] of sourceManifest.items.entries()) {
    const entry = publicManifest.items.find(item => item.id === input.id);
    check([input.sourceFile, input.representationFile, input.publicJPEGFile, input.illustrationFile].every(safeAsset), 'source_filename');
    const source = await readFile(join(directory, input.sourceFile));
    const illustrationBytes = await readFile(join(directory, input.illustrationFile));
    const imageMetadata = await sharp(illustrationBytes).metadata();
    check(sha(illustrationBytes) === input.illustrationSHA256 && illustrationBytes.length <= 6 * 1024 * 1024
      && imageMetadata.format === 'png' && imageMetadata.width === 1024 && imageMetadata.height === 1024
      && imageMetadata.hasAlpha && imageMetadata.channels === 4, 'illustration_fixture_geometry');
    const representation = await readFile(join(directory, input.representationFile));
    check(source.length > 0 && source.length <= 6 * 1024 * 1024 && sha(source) === input.sourceSHA256
      && sha(await readFile(join(directory, input.publicJPEGFile))) === entry.sha256
      && input.publicJPEG_SHA256 === entry.sha256 && sha(representation) === input.representationSHA256, 'source_digest');
    const rep = JSON.parse(representation), features = canonicalFeatures({ type: entry.type, colors: entry.colors });
    check(rep.spaceID === realSpace && rep.photoVersionID === input.photoVersionId
      && /^b4000001-0000-4000-8000-00000000000[1-4]$/.test(input.photoVersionId)
      && rep.sourceSHA256 === sha(source) && rep.textSHA256 === sha(canonicalText(features))
      && rep.vector?.length === 128 && rep.vector.every(Number.isFinite), 'source_representation');
    const effective = validateObserved({ version: 'fitting-observable-v2-photoroom-sandbox',
      type: illustrationTaxonomy.types.find(value => value.id === entry.type).label,
      colors: features.colors.map(id => illustrationTaxonomy.colors.find(value => value.id === id).label),
      traits: Object.fromEntries(Object.keys(observableChoices).map(key => [key, 'unknown'])) });
    const itemId = fixtureID(0, index), photoVersionId = input.photoVersionId, sourceSetVersionId = fixtureID(3, index);
    const illustration = { itemId, operationId: fixtureID(5, index), photoVersionId, sourceSetVersionId,
      revision: 1, status: 'ready', mode: 'test', processing: {}, observedFeatures: effective, effectiveFeatures: effective,
      observedFeaturesSHA256: featureDigest(effective), effectiveFeaturesSHA256: featureDigest(effective),
      manualType: null, manualColors: null, ...illustrationVersions, resultPath: null, resultSHA256: sha(illustrationBytes), error: null,
      preparedSources: [{ photoId: photoVersionId, sourceSHA256: sha(source), preparedSHA256: sha(source), versions: illustrationVersions }] };
    const preparation = { itemId, operationId: fixtureID(2, index), revision: 1, photoVersionId, sourceSetVersionId,
      illustrationOperationId: illustration.operationId, cutoutOperationId: fixtureID(4, index), spaceID: realSpace,
      status: 'ready', mode: 'real', imageMode: 'test', provenance: 'syntheticBenchmarkFixture', effectiveFeatures: features,
      representationJSON: representation.toString('utf8'), representationSHA256: sha(representation),
      input: { sourceSHA256: sha(source), textSHA256: rep.textSHA256 }, artifacts: { cutoutSHA256: sha(source), illustrationSHA256: sha(illustrationBytes),
        observedFeaturesSHA256: featureDigest(effective), effectiveFeaturesSHA256: featureDigest(effective) }, error: null };
    const packet = { itemId, photoVersionId, publishedVersionId: preparation.operationId, sourceSetVersionId,
      features, effectiveFeatures: effective, representationJSON: representation.toString('utf8'), representationSHA256: sha(representation) };
    records.push({ publicID: input.id, illustration, preparation, packet,
      files: { source, cutout: source, illustration: illustrationBytes, prepared: source, representation } });
  }
  return records;
}

async function exportFixture({ source, count, token, revision, bundleDirectory, publicFixture }) {
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

    return { id, author: entry.attribution.author, source: entry.attribution.source,
      license: entry.attribution.license, licenseURL: entry.attribution.licenseUrl, sourceSHA256: entry.sha256 };
  }));
  const manifest = { schemaVersion: 1, count, uniqueSources: 4, sourceRevision: baseline, benchmarkRevision: revision, sourceAttribution,
    spaceID: realSpace, ...(publicFixture ? {} : { tokenSHA256: sha(token) }), provenance: 'isolated synthetic clones of four public real-encoder inputs',
    imageProviders: 'synthetic-public-photo-copies', sourceProvenance: publicFixture
      ? 'public-manifest-encoder-on-isolated-linux-host' : 'public-manifest-encoder-on-runner',
    assets: [...assets].map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.length })), items };
  await mkdir(bundleDirectory, { mode: 0o700 });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await privateWrite(join(bundleDirectory, 'manifest.json'), manifestBytes);
  for (const [name, bytes] of assets) {
    check(safeAsset(name), 'invalid_asset_name');
    await privateWrite(join(bundleDirectory, name), bytes);
  }
  return { manifest, manifestSHA256: sha(manifestBytes), packets, sourceRecords: sources };
}

function processTreeRSS(pid) {
  try {
    if (process.platform === 'darwin') {
      // PID, parent and RSS only; never collect process arguments or environment.
      const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 1000 })
        .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      if (!rows.some(([child]) => child === pid)) return null;
      const own = new Set([pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [child, parent] of rows) if (own.has(parent) && !own.has(child)) { own.add(child); changed = true; }
      }
      return rows.filter(([child]) => own.has(child)).reduce((sum, [, , rss]) => sum + rss, 0);
    }
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    const children = readFileSync('/proc/' + pid + '/task/' + pid + '/children', 'utf8').trim().split(/\s+/).filter(Boolean);
    return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) + children.reduce((sum, id) => sum + processTreeRSS(id), 0);
  } catch { return null; }
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
  if (options.publicFixture) check(options.count === 300 && options.ttlSeconds <= 45 * 60 && process.platform === 'linux', 'public_fixture_requires_isolated_linux_300');
  const startupTimeoutMilliseconds = options.startupTimeoutMilliseconds ?? 180_000;
  check(Number.isInteger(startupTimeoutMilliseconds) && startupTimeoutMilliseconds >= 1000 && startupTimeoutMilliseconds <= 180_000, 'invalid_startup_deadline');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: backend, encoding: 'utf8' }).trim();
  check(/^[a-f0-9]{40}$/.test(revision), 'invalid_source_revision');
  const temporaryRoot = await realpath('/tmp');
  const directory = options.directory ? join(await realpath(dirname(resolve(options.directory))), resolve(options.directory).split('/').at(-1))
    : await mkdtemp(join(temporaryRoot, 'saint-look-benchmark-'));
  check(directory.startsWith(join(temporaryRoot, 'saint-look-benchmark-')) && await realpath(dirname(directory)) === temporaryRoot, 'isolated_directory_required');
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
  const sampleIntervalMilliseconds = process.platform === 'darwin' ? 1000 : 250;
  let server, privateGateway, backendProcess, closed = false, timer, peakKiB = null, sample, requests = [];
  const stop = async () => {
    if (closed) return; closed = true; clearTimeout(timer); clearInterval(sample);
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    if (privateGateway) { privateGateway.closeAllConnections(); await new Promise(done => privateGateway.close(done)); }
    if (backendProcess) await backendProcess.stop();
    await privateWrite(join(directory, 'result.json'), JSON.stringify({ provenance: 'isolated synthetic benchmark', revision,
      count: options.count, uniqueSources: 4, modelSpaceID: realSpace, requests, sampledBackendTreePeakRSSKiB: peakKiB,
      memoryScope: 'Sampled sum of owned backend process-tree RSS; may miss shorter peaks; not HWM or cgroup peak',
      memoryPlatform: process.platform, memorySampler: process.platform === 'darwin' ? 'ps pid,ppid,rss only' : 'Linux proc status/children',
      sampleIntervalMilliseconds, memoryUnavailable: peakKiB === null, paidProviderCalls: 0 }));
  };
  try {
    backendProcess = await spawnBackend({ program, database, ...options, real: false }); await backendProcess.stop();
    installReceiptFixture(database, data.packets, 'real'); // Only the new isolated stopped test DB.
    const startup = performance.now();
    const startupDeadline = startup + startupTimeoutMilliseconds;
    backendProcess = await spawnBackend({ program, database, ...options, real: true });
    const sampleMemory = () => { const value = processTreeRSS(backendProcess.child.pid);
      if (Number.isFinite(value)) peakKiB = Math.max(peakKiB ?? 0, value); };
    sampleMemory(); sample = setInterval(sampleMemory, sampleIntervalMilliseconds);
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
          modelSpaceID: realSpace, manifestSHA256: data.manifestSHA256, startupMilliseconds, transport: 'same-host loopback only', imageProviders: 'synthetic-public-photo-copies' }));
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
            wireSHA256: sha(body), wireBytes: body.length, canonicalSHA256: canonicalSingleRequestHash(input),
            elapsedMilliseconds: performance.now() - start });
        }
        send(result.status, bytes);
      } catch { send(503, '{"error":"benchmark_request_failed"}'); }
    });
    if (options.publicFixture) {
      const bottomSource = data.sourceRecords.find(record => ['jeans', 'trousers', 'shorts', 'skirt'].includes(record.packet.features.type));
      check(bottomSource, 'benchmark_bottom_missing');
      const bottomIndex = data.sourceRecords.indexOf(bottomSource);
      const bottomItemID = fixtureID(0, bottomIndex), bottomPublishedVersionID = fixtureID(2, bottomIndex);
      const body = { requestId: '00000000-0000-4000-8000-000000000001', snapshotId: '00000000-0000-4000-8000-000000000002',
        targetSlotId: '36000005-0000-4000-8000-000000000001', intent: 'complement',
        orderedSlots: [
          { slotId: '36000005-0000-4000-8000-000000000000', zone: 'head', itemId: null, publishedVersionId: null },
          { slotId: '36000005-0000-4000-8000-000000000001', zone: 'body', itemId: null, publishedVersionId: null },
          { slotId: '36000005-0000-4000-8000-000000000002', zone: 'bottom', itemId: bottomItemID,
            publishedVersionId: bottomPublishedVersionID },
          { slotId: '36000005-0000-4000-8000-000000000003', zone: 'shoes', itemId: null, publishedVersionId: null }
        ], pinnedSlotIds: ['36000005-0000-4000-8000-000000000002'], excludedItemIds: [],
        items: data.packets.map(packet => ({ itemId: packet.itemId, publishedVersionId: packet.publishedVersionId,
          photoVersionId: packet.photoVersionId, sourceSetVersionId: packet.sourceSetVersionId, features: packet.features,
          effectiveFeatures: data.sourceRecords[Number(packet.itemId.slice(-12)) > 0
            ? (Number(packet.itemId.slice(-12)) - 1) % data.sourceRecords.length : 0].illustration.effectiveFeatures,
          representationJSON: packet.representationJSON, representationSHA256: packet.representationSHA256 }))
          .sort((a, b) => a.itemId.localeCompare(b.itemId)) };
      const expectedCanonicalHash = canonicalSingleRequestHash(body);
      const originalServer = server;
      // The backend process remains private to loopback. The public-facing handler
      // is a strict projection and injects the nonce only on this local hop.
      await new Promise(done => originalServer.listen(0, '127.0.0.1', done));
      privateGateway = originalServer;
      const publicProxy = createPublicBenchmarkProxy({ backendOrigin: `http://127.0.0.1:${originalServer.address().port}`,
        ownerNonce: options.token, bundle: await readFile(zipPath), expectedCanonicalHash,
        metadata: { revision, modelSpaceID: realSpace, manifestSHA256: data.manifestSHA256, count: options.count,
          startupMilliseconds, uniqueSources: 4, provenance: 'public-pinned-fixture',
          serverEnvironment: 'isolated-linux-host', environment: 'github-hosted-macos-simulator' },
        ttlSeconds: Math.min(options.ttlSeconds, 45 * 60) });
      server = publicProxy;
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      // Keep both processes owned by this result; stop() closes the public edge before the private backend.
      const stopPublic = stop;
      timer = setTimeout(() => { void stopPublic(); }, Math.min(options.ttlSeconds, 45 * 60) * 1000);
      const origin = 'http://127.0.0.1:' + server.address().port;
      return { origin, directory, manifest: data.manifest, manifestSHA256: data.manifestSHA256, startupMilliseconds, packets: data.packets,
        expectedCanonicalHash, stop: stopPublic };
    }
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = 'http://127.0.0.1:' + server.address().port;
    timer = setTimeout(() => { void stop(); }, options.ttlSeconds * 1000);
    return { origin, directory, manifest: data.manifest, manifestSHA256: data.manifestSHA256, startupMilliseconds, packets: data.packets, stop };
  } catch (error) { await stop(); throw error; }
}

async function main() {
  const args = process.argv.slice(2), opts = {};
  if (!args.length || args.includes('--help')) {
    console.log('Local-only fixture: --source FOUR_PUBLIC_REAL_ENCODER_DIR --python PYTHON --assets MODEL_ASSETS (--token-file PRIVATE_FILE | --public-fixture) --count 4|300 [--ttl-seconds 1800] [--directory NEW_TMP_BENCHMARK_DIR]'); return;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--public-fixture') { check(!Object.hasOwn(opts, args[i]), 'invalid_arguments'); opts[args[i]] = true; continue; }
    check(['--source', '--python', '--assets', '--token-file', '--count', '--ttl-seconds', '--directory'].includes(args[i])
      && args[i + 1] && !Object.hasOwn(opts, args[i]), 'invalid_arguments');
    opts[args[i]] = args[++i];
  }
  for (const name of ['source', 'python', 'assets', 'count']) check(opts['--' + name], 'missing_argument');
  const publicFixture = opts['--public-fixture'] === true;
  check(publicFixture ? !opts['--token-file'] : Boolean(opts['--token-file']), 'benchmark_token_source_invalid');
  if (!publicFixture) check(((await stat(opts['--token-file'])).mode & 0o777) === 0o600, 'private_token_file_required');
  // Preserve a venv's interpreter symlink: dereferencing it selects base Python
  // and loses the venv's installed torch/transformers packages.
  const result = await startBenchmark({ source: await realpath(opts['--source']), python: resolve(opts['--python']),
    assets: await realpath(opts['--assets']), token: publicFixture ? 'bench-' + randomBytes(32).toString('hex')
      : (await readFile(opts['--token-file'], 'utf8')).trim(), count: Number(opts['--count']),
    ttlSeconds: Number(opts['--ttl-seconds'] ?? 1800), directory: opts['--directory'], publicFixture });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await result.stop(); process.exit(0); };
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
  console.log(JSON.stringify({ ready: true, origin: result.origin, directory: result.directory, count: result.manifest.count,
    uniqueSources: 4, modelSpaceID: realSpace, benchmarkRevision: result.manifest.benchmarkRevision,
    manifestSHA256: result.manifestSHA256, startupMilliseconds: result.startupMilliseconds,
    tokenStoredInBundle: false, paidProviderCalls: 0, ttlSeconds: Number(opts['--ttl-seconds'] ?? 1800),
    profile: opts['--public-fixture'] ? 'public-wan-fixture' : 'same-runner' }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('{"error":"benchmark_initialization_failed"}'); process.exitCode = 1; });
}
