import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSingleRequestHash, createPublicBenchmarkProxy, swiftUUIDRequestTemplate } from './ios-benchmark-public-proxy.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const request = () => ({
  requestId: '00000000-0000-4000-8000-000000000001',
  snapshotId: '00000000-0000-4000-8000-000000000002',
  targetSlotId: '00000000-0000-4000-8000-000000000003',
  intent: 'complement',
  orderedSlots: [{ slotId: '00000000-0000-4000-8000-000000000004', zone: 'head', itemId: null, publishedVersionId: null }],
  pinnedSlotIds: ['00000000-0000-4000-8000-000000000004'],
  excludedItemIds: [],
  items: [{ itemId: '00000000-0000-4000-8000-000000000005',
    representationJSON: '{"spaceID":"b-space","vector":[1,0]}',
    representationSHA256: 'a'.repeat(64) }],
});

test('canonical single payload binds every field except distinct UUID correlation IDs', () => {
  const first = request(), reordered = Object.fromEntries(Object.entries(first).reverse());
  reordered.requestId = '10000000-0000-4000-8000-000000000001';
  reordered.snapshotId = '10000000-0000-4000-8000-000000000002';
  assert.equal(canonicalSingleRequestHash(first), '9c11b1cbcbfbe4033969811dba42584a392c535daca636618bb2d989291f6030');
  assert.equal(canonicalSingleRequestHash(reordered), canonicalSingleRequestHash(first));
  const changed = request(); changed.pinnedSlotIds = [];
  assert.notEqual(canonicalSingleRequestHash(changed), canonicalSingleRequestHash(first));
  assert.throws(() => canonicalSingleRequestHash({ ...request(), snapshotId: request().requestId }), /correlation/);
  assert.throws(() => canonicalSingleRequestHash({ ...request(), extra: 'not-bound' }), /shape/);
});

test('fixed scenario UUID fields use the Foundation Codable wire representation', () => {
  const uuid = index => `b3000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const input = request();
  input.requestId = uuid(101); input.snapshotId = uuid(102); input.targetSlotId = uuid(3);
  input.orderedSlots = [{ slotId: uuid(4), zone: 'head', itemId: uuid(5), publishedVersionId: uuid(6) }];
  input.pinnedSlotIds = [uuid(4)]; input.excludedItemIds = [uuid(9)];
  input.items = [{ itemId: uuid(5), publishedVersionId: uuid(6), photoVersionId: uuid(7), sourceSetVersionId: uuid(8),
    features: { type: 'shirt', colors: [] }, effectiveFeatures: { version: 'fixture-v1', type: 'shirt', colors: [], traits: {} },
    representationJSON: '{"spaceID":"fixture-space","vector":[1,0]}', representationSHA256: 'a'.repeat(64) }];
  const wire = swiftUUIDRequestTemplate(input);
  assert.equal(JSON.stringify(wire.items[0].itemId), '"B3000000-0000-4000-8000-000000000005"');
  assert.equal(wire.items[0].representationJSON, input.items[0].representationJSON,
    'Opaque representation bytes remain unchanged');
  assert.deepEqual(Object.fromEntries(['requestId', 'snapshotId', 'targetSlotId'].map(key => [key, wire[key]])), {
    requestId: 'B3000000-0000-4000-8000-000000000101',
    snapshotId: 'B3000000-0000-4000-8000-000000000102',
    targetSlotId: 'B3000000-0000-4000-8000-000000000003' });
  assert.deepEqual(wire.pinnedSlotIds, ['B3000000-0000-4000-8000-000000000004']);
  assert.deepEqual(wire.orderedSlots[0], { slotId: 'B3000000-0000-4000-8000-000000000004', zone: 'head',
    itemId: 'B3000000-0000-4000-8000-000000000005', publishedVersionId: 'B3000000-0000-4000-8000-000000000006' });
  assert.deepEqual([wire.items[0].publishedVersionId, wire.items[0].photoVersionId, wire.items[0].sourceSetVersionId],
    ['B3000000-0000-4000-8000-000000000006', 'B3000000-0000-4000-8000-000000000007', 'B3000000-0000-4000-8000-000000000008']);
  assert.equal(canonicalSingleRequestHash(wire), '53de32e89d78bb79ed804a1b018b38f85d322b6107982080aa5f6cbf074e9bb0');
  assert.notEqual(canonicalSingleRequestHash(wire), canonicalSingleRequestHash(input),
    'Typed UUID strings are case-sensitive fields in the canonical payload');
});

test('public proxy reserves two exact single attempts and exposes no owner credential or arbitrary route', async t => {
  const ownerNonce = 'bench-' + 'b'.repeat(64), modelSpaceID = 'e'.repeat(64), payload = request();
  let preparationReason = 'illustration_unavailable';
  const upstreamCalls = [], upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    upstreamCalls.push({ path: req.url, auth: req.headers.authorization, cookie: req.headers.cookie, bytes });
    if (req.url === '/v1/recommendations/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocolVersion: 1, publicationProtocol: 'prepared-item-v1', preparationRequired: true,
        representationEncoding: 'opaque-json-string-v1', encoder: { available: true, mode: 'real', activeSpaceID: modelSpaceID,
        supportedSpaceIDs: [modelSpaceID], reason: null, ownerNonce }, newItemPreparation: { available: false, reason: preparationReason },
        encoderRefresh: { available: true, reason: null }, ownerSecret: ownerNonce }));
      return;
    }
    if (req.url === '/v1/recommendations/single' && upstreamCalls.filter(value => value.path === req.url).length === 1) {
      res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'model_failed', detail: ownerNonce })); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requestId: JSON.parse(bytes).requestId, snapshotId: JSON.parse(bytes).snapshotId,
      targetSlotId: JSON.parse(bytes).targetSlotId, outcome: 'proposed', proposal: { itemId: '00000000-0000-4000-8000-000000000005',
        publishedVersionId: '00000000-0000-4000-8000-000000000006' }, reason: null, conflictingSlotIds: [], spaceID: modelSpaceID,
      mode: 'real', policyVersion: 'outfit-placement-v1', intent: 'complement', ownerNonce }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createPublicBenchmarkProxy({ backendOrigin: `http://127.0.0.1:${upstream.address().port}`,
    ownerNonce, bundle: Buffer.from('public-bundle-sentinel'), expectedCanonicalHash: canonicalSingleRequestHash(payload),
    metadata: { revision: 'c'.repeat(40), modelSpaceID, manifestSHA256: 'd'.repeat(64), count: 300, startupMilliseconds: 123.4,
          uniqueSources: 4, provenance: 'public-pinned-fixture', environment: 'github-hosted-macos-simulator',
          serverEnvironment: 'isolated-linux-host', ownerNonce,
      tokenSHA256: createHash('sha256').update(ownerNonce).digest('hex') }, ttlSeconds: 45 });
  t.after(async () => { proxy.closeAllConnections(); upstream.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => upstream.close(resolve)); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const publicMetadata = await fetch(origin + '/benchmark/metadata');
  const metadataText = await publicMetadata.text();
  assert.equal(publicMetadata.status, 200);
  assert.doesNotMatch(metadataText, new RegExp(ownerNonce));
  assert.doesNotMatch(metadataText, /tokenSHA256/);
  const config = await fetch(origin + '/v1/recommendations/config');
  const configText = await config.text();
  assert.equal(config.status, 200);
  assert.doesNotMatch(configText, new RegExp(ownerNonce));
  assert.deepEqual(JSON.parse(configText).newItemPreparation, { available: false, reason: 'illustration_unavailable' });
  preparationReason = 'owner-secret';
  const unsupportedConfig = await fetch(origin + '/v1/recommendations/config');
  assert.equal(unsupportedConfig.status, 500);
  assert.doesNotMatch(await unsupportedConfig.text(), /owner-secret/);
  preparationReason = 'illustration_unavailable';
  const bundle = await fetch(origin + '/benchmark/bundle');
  const bundleText = await bundle.text();
  assert.equal(bundleText, 'public-bundle-sentinel');
  assert.doesNotMatch(bundleText, new RegExp(ownerNonce));

  const firstWire = Buffer.from(JSON.stringify(payload));
  const duplicateField = Buffer.from(firstWire.toString('utf8').slice(0, -1)
    + ',"requestId":"' + payload.requestId + '"}');
  const ambiguous = await fetch(origin + '/v1/recommendations/single', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: duplicateField });
  assert.equal(ambiguous.status, 400, 'Duplicate fields must not collapse into an accepted canonical request');
  const failed = await fetch(origin + '/v1/recommendations/single', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: firstWire });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), new RegExp(ownerNonce));
  const retry = { ...payload, requestId: '10000000-0000-4000-8000-000000000001',
    snapshotId: '10000000-0000-4000-8000-000000000002' };
  const retryWire = Buffer.from(JSON.stringify(retry));
  const succeeded = await fetch(origin + '/v1/recommendations/single', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: retryWire });
  const safeResult = await succeeded.text();
  assert.equal(succeeded.status, 200);
  assert.doesNotMatch(safeResult, new RegExp(ownerNonce));

  const third = { ...payload, requestId: '20000000-0000-4000-8000-000000000001',
    snapshotId: '20000000-0000-4000-8000-000000000002' };
  const exhausted = await fetch(origin + '/v1/recommendations/single', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(third) });
  assert.equal(exhausted.status, 429);
  for (const path of ['/v1/recommendations/compose', '/v1/items', '/anything']) {
    const denied = await fetch(origin + path, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 405);
  }
  const leaked = await fetch(origin + '/v1/recommendations/single', { method: 'POST',
    headers: { authorization: 'Bearer external-secret', cookie: 'session=external-secret', 'content-type': 'application/json' },
    body: firstWire });
  assert.equal(leaked.status, 400);
  assert.equal(upstreamCalls.filter(value => value.path === '/v1/recommendations/single').length, 2);
  assert.ok(upstreamCalls.every(value => value.auth === `Bearer ${ownerNonce}` && value.cookie === undefined));
  const metricsResponse = await fetch(origin + '/benchmark/metrics');
  const metricsText = await metricsResponse.text(), metrics = JSON.parse(metricsText);
  assert.equal(metrics.reservedAttempts, 2);
  assert.equal(metrics.requests.length, 2);
  assert.equal(metrics.requests[0].wireSHA256, createHash('sha256').update(firstWire).digest('hex'));
  assert.equal(metrics.requests[0].wireBytes, firstWire.length);
  assert.equal(metrics.requests[0].canonicalSHA256, canonicalSingleRequestHash(payload));
  assert.doesNotMatch(metricsText, new RegExp(ownerNonce));
});
