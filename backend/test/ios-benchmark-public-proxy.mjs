import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { URL } from 'node:url';

const singleKeys = new Set(['requestId', 'snapshotId', 'targetSlotId', 'intent', 'orderedSlots',
  'pinnedSlotIds', 'excludedItemIds', 'items']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('invalid_json_value');
  }
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
}

function parseUniqueJSON(source) {
  let offset = 0;
  const whitespace = () => { while (/\s/.test(source[offset] ?? '') && offset < source.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === '\\') { offset += 2; continue; }
      if (source[offset++] === '"') return JSON.parse(source.slice(start, offset));
    }
    throw new Error('invalid_json');
  };
  const value = depth => {
    if (depth > 64) throw new Error('json_depth_exceeded');
    whitespace();
    if (source[offset] === '"') { string(); return; }
    if (source[offset] === '{') {
      offset++; whitespace();
      if (source[offset] === '}') { offset++; return; }
      const keys = new Set();
      while (true) {
        whitespace();
        if (source[offset] !== '"') throw new Error('invalid_json');
        const key = string();
        if (keys.has(key)) throw new Error('duplicate_json_key');
        keys.add(key); whitespace();
        if (source[offset++] !== ':') throw new Error('invalid_json');
        value(depth + 1); whitespace();
        if (source[offset] === '}') { offset++; return; }
        if (source[offset++] !== ',') throw new Error('invalid_json');
      }
    }
    if (source[offset] === '[') {
      offset++; whitespace();
      if (source[offset] === ']') { offset++; return; }
      while (true) {
        value(depth + 1); whitespace();
        if (source[offset] === ']') { offset++; return; }
        if (source[offset++] !== ',') throw new Error('invalid_json');
      }
    }
    const start = offset;
    while (offset < source.length && !/[\s,}\]]/.test(source[offset])) offset++;
    if (start === offset) throw new Error('invalid_json');
  };
  value(0); whitespace();
  if (offset !== source.length) throw new Error('invalid_json');
  return JSON.parse(source);
}

export function canonicalSingleRequestHash(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).length !== singleKeys.size || Object.keys(request).some(key => !singleKeys.has(key))) {
    throw new Error('invalid_single_request_shape');
  }
  if (typeof request.requestId !== 'string' || !uuidPattern.test(request.requestId)
    || typeof request.snapshotId !== 'string' || !uuidPattern.test(request.snapshotId)
    || request.requestId.toLowerCase() === request.snapshotId.toLowerCase()) {
    throw new Error('invalid_single_request_correlation');
  }
  const { requestId: _requestId, snapshotId: _snapshotId, ...payload } = request;
  return createHash('sha256').update(canonicalJSON(payload)).digest('hex');
}

const singleResponseKeys = ['requestId', 'snapshotId', 'targetSlotId', 'outcome', 'proposal', 'reason',
  'conflictingSlotIds', 'spaceID', 'mode', 'policyVersion', 'intent', 'rankingVersion'];
const outcomes = new Set(['proposed', 'no_alternative', 'constraints_conflict', 'empty_context']);
const reasons = new Set(['duplicate_item', 'target_pinned', 'fixed_category_mismatch', 'fixed_layer_order',
  'context_required', 'no_category_candidates', 'excluded_or_occupied', 'layer_constraints']);
const uuid = value => typeof value === 'string' && uuidPattern.test(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff' };
const MAX_BODY_BYTES = 4 * 1024 * 1024, MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024, MAX_GET_BYTES = 128 * 1024 * 1024;
const MAX_REQUESTS = 64, MAX_ATTEMPTS = 2, MAX_TTL_SECONDS = 45 * 60;

function safeMetadata(input) {
  if (!/^[a-f0-9]{40}$/.test(input.revision ?? '') || !/^[a-f0-9]{64}$/.test(input.manifestSHA256 ?? '')
    || !/^[a-f0-9]{64}$/.test(input.modelSpaceID ?? '') || input.count !== 300 || input.uniqueSources !== 4
    || !Number.isFinite(input.startupMilliseconds) || input.startupMilliseconds < 0
    || input.serverEnvironment !== 'isolated-linux-host'
    || input.provenance !== 'public-pinned-fixture' || input.environment !== 'github-hosted-macos-simulator') {
    throw new Error('invalid_public_metadata');
  }
  return { revision: input.revision, count: 300, uniqueSources: 4, modelSpaceID: input.modelSpaceID,
    manifestSHA256: input.manifestSHA256, transport: 'remote-public-https',
    startupMilliseconds: input.startupMilliseconds,
    provenance: 'public-pinned-fixture-synthetic-receipts', serverEnvironment: input.serverEnvironment,
    clientEnvironment: 'github-hosted-macos-simulator',
    imageProviders: 'synthetic-public-photo-copies' };
}

function sanitizeHealth(value) {
  if (value?.status !== 'ok' || !/^[a-f0-9]{40}$/.test(value.revision ?? '')
    || !Number.isSafeInteger(value.dataVersion) || typeof value.encoderAvailable !== 'boolean'
    || typeof value.preparationAvailable !== 'boolean' || typeof value.illustrationAvailable !== 'boolean'
    || value.publicationProtocol !== 'prepared-item-v1' || typeof value.mode !== 'string') throw new Error('invalid_health');
  return { status: 'ok', mode: value.mode, revision: value.revision, dataVersion: value.dataVersion,
    illustrationAvailable: value.illustrationAvailable, encoderAvailable: value.encoderAvailable,
    preparationAvailable: value.preparationAvailable, publicationProtocol: value.publicationProtocol };
}

function sanitizeConfiguration(value, modelSpaceID) {
  const encoder = value?.encoder;
  if (value?.protocolVersion !== 1 || value.publicationProtocol !== 'prepared-item-v1'
    || value.preparationRequired !== true || value.representationEncoding !== 'opaque-json-string-v1'
    || encoder?.available !== true || encoder.mode !== 'real' || encoder.activeSpaceID !== modelSpaceID
    || !Array.isArray(encoder.supportedSpaceIDs) || !encoder.supportedSpaceIDs.includes(modelSpaceID)) {
    throw new Error('invalid_configuration');
  }
  const capability = value => {
    if (typeof value?.available !== 'boolean' || value.reason !== null) throw new Error('invalid_capability');
    return { available: value.available, reason: null };
  };
  return { protocolVersion: 1, publicationProtocol: 'prepared-item-v1', preparationRequired: true,
    representationEncoding: 'opaque-json-string-v1', encoder: { available: true, mode: 'real',
      activeSpaceID: modelSpaceID, supportedSpaceIDs: [modelSpaceID], reason: null },
    newItemPreparation: capability(value.newItemPreparation), encoderRefresh: capability(value.encoderRefresh) };
}

function sanitizeSingleResponse(value, request, modelSpaceID) {
  if (!uuid(value?.requestId) || value.requestId.toLowerCase() !== request.requestId.toLowerCase()
    || !uuid(value?.snapshotId) || value.snapshotId.toLowerCase() !== request.snapshotId.toLowerCase()
    || value.targetSlotId !== request.targetSlotId || !outcomes.has(value.outcome)
    || (value.reason !== null && !reasons.has(value.reason)) || !Array.isArray(value.conflictingSlotIds)
    || !value.conflictingSlotIds.every(uuid) || value.spaceID !== modelSpaceID || value.mode !== 'real'
    || value.policyVersion !== 'outfit-placement-v1' || value.intent !== 'complement'
    || (value.rankingVersion !== undefined && value.rankingVersion !== null)) throw new Error('invalid_recommendation');
  let proposal = null;
  if (value.proposal !== null) {
    if (!uuid(value.proposal?.itemId) || !uuid(value.proposal?.publishedVersionId)) throw new Error('invalid_proposal');
    proposal = { itemId: value.proposal.itemId.toLowerCase(), publishedVersionId: value.proposal.publishedVersionId.toLowerCase() };
  }
  if ((value.outcome === 'proposed') !== (proposal !== null)) throw new Error('invalid_outcome_proposal');
  return Object.fromEntries(singleResponseKeys.filter(key => key in value).map(key => [key,
    key === 'proposal' ? proposal : value[key]]));
}

async function readBounded(request, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function responseBytes(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new Error('upstream_response_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export function createPublicBenchmarkProxy({ backendOrigin, ownerNonce, bundle, expectedCanonicalHash,
  metadata, ttlSeconds = MAX_TTL_SECONDS, now = Date.now }) {
  const backend = new URL(backendOrigin);
  if (backend.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname)
    || backend.username || backend.password || backend.search || backend.hash || !['', '/'].includes(backend.pathname)
    || !/^bench-[a-f0-9]{64}$/.test(ownerNonce) || !Buffer.isBuffer(bundle) || bundle.length > MAX_BUNDLE_BYTES
    || !/^[a-f0-9]{64}$/.test(expectedCanonicalHash ?? '') || !Number.isInteger(ttlSeconds)
    || ttlSeconds < 30 || ttlSeconds > MAX_TTL_SECONDS) throw new Error('invalid_public_proxy_configuration');
  const publicInfo = safeMetadata(metadata), started = now(), expiresAt = started + ttlSeconds * 1000;
  const records = [], seenIDs = new Set();
  let totalRequests = 0, reservedAttempts = 0, active = false, servedGetBytes = 0;
  const send = (response, status, body, type = 'application/json; charset=utf-8') => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Length': bytes.length });
    response.end(bytes);
  };
  const json = (response, status, value) => send(response, status, Buffer.from(JSON.stringify(value)), JSON_HEADERS['Content-Type']);

  return createServer(async (request, response) => {
    try {
      if (now() >= expiresAt) return json(response, 410, { error: 'benchmark_expired' });
      if (++totalRequests > MAX_REQUESTS) return json(response, 429, { error: 'benchmark_request_limit' });
      if (request.headers.authorization !== undefined || request.headers.cookie !== undefined
        || request.headers['proxy-authorization'] !== undefined) return json(response, 400, { error: 'public_credentials_forbidden' });
      const route = request.url;
      if (request.method === 'GET' && route === '/benchmark/bundle') {
        if (bundle.length > MAX_BUNDLE_BYTES || servedGetBytes + bundle.length > MAX_GET_BYTES) return json(response, 429, { error: 'benchmark_get_limit' });
        servedGetBytes += bundle.length;
        return send(response, 200, bundle, 'application/zip');
      }
      if (request.method === 'GET' && route === '/benchmark/metadata') {
        const bytes = Buffer.from(JSON.stringify({ ...publicInfo, startupMilliseconds: metadata.startupMilliseconds }));
        if (servedGetBytes + bytes.length > MAX_GET_BYTES) return json(response, 429, { error: 'benchmark_get_limit' });
        servedGetBytes += bytes.length; return send(response, 200, bytes);
      }
      if (request.method === 'GET' && route === '/benchmark/metrics') {
        const bytes = Buffer.from(JSON.stringify({ reservedAttempts, maxAttempts: MAX_ATTEMPTS,
          requests: records.map(record => ({ ...record })) }));
        if (servedGetBytes + bytes.length > MAX_GET_BYTES) return json(response, 429, { error: 'benchmark_get_limit' });
        servedGetBytes += bytes.length; return send(response, 200, bytes);
      }
      if (request.method === 'GET' && ['/health', '/v1/recommendations/config'].includes(route)) {
        const upstream = await fetch(new URL(route, backend), { headers: { Authorization: `Bearer ${ownerNonce}` },
          signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!upstream.ok) return json(response, 502, { error: 'benchmark_upstream_failed' });
        const bytes = await responseBytes(upstream, 1024 * 1024), value = JSON.parse(bytes);
        const safe = route === '/health' ? sanitizeHealth(value) : sanitizeConfiguration(value, publicInfo.modelSpaceID);
        const output = Buffer.from(JSON.stringify(safe));
        if (servedGetBytes + output.length > MAX_GET_BYTES) return json(response, 429, { error: 'benchmark_get_limit' });
        servedGetBytes += output.length; return send(response, 200, output);
      }
      if (request.method !== 'POST' || route !== '/v1/recommendations/single') {
        return json(response, 405, { error: 'benchmark_route_disabled' });
      }
      if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return json(response, 415, { error: 'benchmark_content_type_required' });
      }
      let body, input, canonicalSHA256;
      try {
        body = await readBounded(request, MAX_BODY_BYTES);
        input = parseUniqueJSON(body.toString('utf8'));
        canonicalSHA256 = canonicalSingleRequestHash(input);
      } catch { return json(response, 400, { error: 'benchmark_invalid_request' }); }
      if (canonicalSHA256 !== expectedCanonicalHash) return json(response, 400, { error: 'benchmark_scenario_mismatch' });
      const correlationIDs = [input.requestId.toLowerCase(), input.snapshotId.toLowerCase()];
      if (correlationIDs.some(id => seenIDs.has(id))) return json(response, 409, { error: 'benchmark_request_replayed' });
      if (reservedAttempts >= MAX_ATTEMPTS) return json(response, 429, { error: 'benchmark_quota_exhausted' });
      const attempt = ++reservedAttempts;
      correlationIDs.forEach(id => seenIDs.add(id));
      const record = { attempt, requestId: input.requestId.toLowerCase(), snapshotId: input.snapshotId.toLowerCase(),
        canonicalSHA256, wireSHA256: sha256(body), wireBytes: body.length, payloadBytes: body.length,
        items: input.items.length, endpoint: route, status: null, outcome: 'pending', elapsedMilliseconds: null };
      records.push(record); // Reservation and wire evidence precede any upstream POST.
      if (active) { record.status = 429; record.outcome = 'concurrency_rejected'; return json(response, 429, { error: 'benchmark_busy' }); }
      active = true;
      const requestStarted = performance.now();
      try {
        const upstream = await fetch(new URL(route, backend), { method: 'POST',
          headers: { Authorization: `Bearer ${ownerNonce}`, 'Content-Type': 'application/json' }, body,
          signal: AbortSignal.timeout(120_000), redirect: 'error' });
        const bytes = await responseBytes(upstream, MAX_RESPONSE_BYTES);
        record.status = upstream.status;
        record.elapsedMilliseconds = performance.now() - requestStarted;
        record.responseBytes = bytes.length;
        if (!upstream.ok) { record.outcome = 'upstream_failure'; return json(response, 502, { error: 'benchmark_upstream_failed' }); }
        const safe = sanitizeSingleResponse(JSON.parse(bytes), input, publicInfo.modelSpaceID);
        record.outcome = safe.outcome;
        return json(response, 200, safe);
      } catch {
        record.status = 502; record.outcome = 'unknown'; record.elapsedMilliseconds = performance.now() - requestStarted;
        return json(response, 502, { error: 'benchmark_upstream_unknown' });
      } finally { active = false; }
    } catch {
      return json(response, 500, { error: 'benchmark_proxy_failed' });
    }
  });
}
