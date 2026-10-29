// Opt-in HTTP evidence with real cached vectors; fixture receipts are NOT live image readiness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { environment } from './support.mjs';
import { slot } from './recommendation-support.mjs';
import { clonePreparedPacket, installReceiptFixture } from './prepared-receipt-fixture.mjs';
import { createModelBridge } from '../src/model-bridge.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const milliseconds = start => Math.round((performance.now() - start) * 100) / 100;

// A sampled sum of concurrent process RSS, not a cgroup peak or independent VM limit.
function monitorTree(pid) {
  let peakKiB = 0;
  function rss(root) {
    try {
      const status = readFileSync(`/proc/${root}/status`, 'utf8');
      const children = readFileSync(`/proc/${root}/task/${root}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) + children.reduce((sum, child) => sum + rss(child), 0);
    } catch { return 0; }
  }
  const sample = () => { peakKiB = Math.max(peakKiB, rss(pid)); };
  sample(); const timer = setInterval(sample, 25);
  return () => { clearInterval(timer); sample(); return { sampledTreePeakRSSMiB: Math.round(peakKiB / 1024 * 100) / 100, sampleIntervalMilliseconds: 25 }; };
}

test('real HTTP composition starts from empty context and bounds layered search over 300 cached packets',
  { skip: process.env.SAINT_LOOK_REAL_MODEL_TEST !== '1', timeout: 180_000 }, async t => {
    for (const key of ['SAINT_LOOK_REAL_MODEL_PHOTOS_DIR', 'SAINT_LOOK_MODEL_PYTHON', 'SAINT_LOOK_MODEL_ASSETS']) assert.ok(process.env[key], `${key} is required`);
    const directory = process.env.SAINT_LOOK_REAL_MODEL_PHOTOS_DIR;
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const modelEnv = { SAINT_LOOK_MODEL_PYTHON: process.env.SAINT_LOOK_MODEL_PYTHON, SAINT_LOOK_MODEL_ASSETS: process.env.SAINT_LOOK_MODEL_ASSETS,
      SAINT_LOOK_TEST_MODEL_ORIGIN: '', SAINT_LOOK_MODEL_PROFILE: 'outfit-transformer-labse-v1', SAINT_LOOK_MODEL_THREADS: '1' };
    const env = await environment(t), preparationMemory = monitorTree(process.pid);
    t.after(preparationMemory);
    const prepareStart = performance.now(), model = createModelBridge({ ...process.env, ...modelEnv }, env.directory);
    t.after(() => model.close());
    const status = await model.status(); assert.equal(status.available, true); assert.equal(status.mode, 'real');
    const modelStartupMilliseconds = milliseconds(prepareStart);
    const items = [], inputs = [];
    for (const [file, type, colors] of [['photo-1.png', 't_shirt', ['white']], ['photo-2.jpg', 'jeans', ['blue']], ['photo-3.jpg', 'polo', ['white']]]) {
      const source = await readFile(join(directory, file)), publicSHA256 = digest(source);
      assert.equal(publicSHA256, manifest.photos.find(photo => photo.file === file)?.sha256);
      const png = await sharp(source).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      const photoVersionId = randomUUID(), started = performance.now();
      const prepared = await model.prepare(png, photoVersionId, { type, colors });
      items.push({ itemId: randomUUID(), publishedVersionId: randomUUID(), photoVersionId, sourceSetVersionId: randomUUID(),
        features: { type, colors }, representationJSON: prepared.representationJSON, representationSHA256: prepared.representationSHA256 });
      inputs.push({ file, publicSHA256, encoderInputSHA256: digest(png), type, colors, prepareMilliseconds: milliseconds(started),
        representationSHA256: prepared.representationSHA256, representationBytes: Buffer.byteLength(prepared.representationJSON) });
    }
    const preparation = { modelStartupMilliseconds, totalMilliseconds: milliseconds(prepareStart), ...preparationMemory(), inputs };
    model.close();
    // Initialize the real schema, then seed explicit delivered-receipt fixtures while stopped.
    const initial = await env.launch({ SAINT_LOOK_MODEL_PROFILE: 'disabled', SAINT_LOOK_TEST_MODEL_ORIGIN: '' }); await initial.stop();
    const clones = Array.from({ length: 299 }, (_, i) => clonePreparedPacket(items[i % 2 ? 0 : 2]));
    installReceiptFixture(env.directory, [...items, ...clones], 'real');
    const startupStart = performance.now(), server = await env.launch(modelEnv), backendMemory = monitorTree(server.pid);
    t.after(backendMemory);
    const listeningMilliseconds = milliseconds(startupStart);
    const config = await (await server.request('/v1/recommendations/config')).json();
    assert.equal(config.encoder.available, true); assert.equal(config.encoder.mode, 'real');
    assert.equal(config.encoder.activeSpaceID, status.activeSpaceID);
    const modelReadyMilliseconds = milliseconds(startupStart);
    const simpleSlots = [slot('body'), slot('bottom')];
    async function measure(label, packets, orderedSlots, mode = 'rebuild', pins = []) {
      const request = { requestId: randomUUID(), snapshotId: randomUUID(), mode, orderedSlots,
        pinnedSlotIds: pins, excludedItemIds: [], items: packets };
      const started = performance.now(), body = JSON.stringify(request);
      const response = await server.request('/v1/recommendations/compose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const result = await response.json(), elapsedMilliseconds = milliseconds(started);
      assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.outcome, 'proposed'); assert.equal(result.modelMode, 'real');
      assert.equal(result.mode, mode); assert.equal(result.snapshotId, request.snapshotId); assert.equal(result.spaceID, status.activeSpaceID);
      assert.deepEqual(result.placements.map(p => p.slotId), orderedSlots.map(s => s.slotId));
      assert.equal(new Set(result.placements.map(p => p.itemId)).size, orderedSlots.length);
      assert.ok(result.placements.every(p => packets.some(item => item.itemId === p.itemId && item.publishedVersionId === p.publishedVersionId)));
      for (const pinned of orderedSlots.filter(s => pins.includes(s.slotId))) assert.equal(result.placements.find(p => p.slotId === pinned.slotId).itemId, pinned.itemId);
      const editable = orderedSlots.filter(s => !pins.includes(s.slotId) && !(mode === 'fillEmpty' && s.itemId)).length;
      return { label, totalItems: packets.length, slots: orderedSlots.length, maximumRankCalls: Math.max(0, editable * 2 - 1),
        payloadBytes: Buffer.byteLength(body), elapsedMilliseconds, selectedTypes: result.placements.map(p => packets.find(item => item.itemId === p.itemId).features.type), placements: result.placements };
    }
    const first = await measure('fresh-worker-empty-context-warm-filesystem-cache', items, simpleSlots);
    const warm = await measure('warm-empty-context', items, simpleSlots);
    assert.deepEqual(first.placements, warm.placements);
    const pinned = slot('body', { item: items[0] });
    const fill = await measure('warm-fill-empty-pinned-body', items, [pinned, slot('bottom')], 'fillEmpty', [pinned.slotId]);
    const synthetic = await measure('warm-synthetic-300-eight-body-layers-plus-bottom', [items[1], ...clones],
      [...Array.from({ length: 8 }, () => slot('body')), slot('bottom')]);
    const evidence = { evidence: 'real-model-http-compose', model: 'real', imageProvidersCalled: 0,
      receipts: 'syntheticReceiptFixture, not proof of live image publication', spaceID: status.activeSpaceID,
      hardware: { cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, os: os.platform(), kernel: os.release(), architecture: os.arch(),
        hostMemoryMiB: Math.round(os.totalmem() / 1024 ** 2), node: process.version, modelThreads: 1 },
      preparation, backend: { listeningMilliseconds, modelReadyMilliseconds, ...backendMemory() }, requests: [first, warm, fill, synthetic],
      limitations: ['Filesystem cache warmed by offline preparation before fresh HTTP worker.', 'RSS is sampled process-tree memory; not a cgroup maximum.',
        'Synthetic 300 packets repeat two body vectors plus one jeans vector; eight body layers test bounded search, not a realistic outfit or taste quality.', 'maximumRankCalls is an algorithmic bound, not instrumented model call telemetry.', 'Empty-context head is numerically valid; quality without context is not established.', 'HTTP upload, validation, rank and response measured; iOS first display and WAN not measured.'] };
    if (process.env.SAINT_LOOK_COMPOSE_EVIDENCE) await writeFile(process.env.SAINT_LOOK_COMPOSE_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  });
