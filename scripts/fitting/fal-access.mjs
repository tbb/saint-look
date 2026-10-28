import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const endpoint = 'fal-ai/nano-banana-pro/edit', start = '2026-10-28T12:31:00Z', end = '2026-10-28T12:33:00Z';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const report = { version: 1, sourceRunId: '40688465238', status: 'not_started' };
const knownErrors = new Map([
  ['User is locked. Reason: TOP_UP.', 'account_locked_top_up'],
  ['User is locked. Reason: TOP_UP', 'account_locked_top_up'],
  ['User is locked. Reason: Exhausted balance.', 'account_locked_exhausted_balance'],
  ['User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing', 'account_locked_exhausted_balance'],
  ['API key is disabled', 'key_disabled'], ['Key is disabled', 'key_disabled'],
  ['Access denied', 'permission_denied'], ['Permission denied', 'permission_denied'],
  ['Invalid API key', 'invalid_key'], ['Authentication required', 'authentication_required'],
]);
function summary(status, bytes, value) {
  const detail = value?.detail ?? value?.error?.message;
  return { httpStatus: status, bodyBytes: bytes.length, bodySha256: createHash('sha256').update(bytes).digest('hex'),
    classification: knownErrors.get(detail) || 'unknown',
    detailType: detail === null ? 'null' : Array.isArray(detail) ? 'array' : typeof detail };
}
async function get(url, key) {
  const response = await fetch(url, { method: 'GET', headers: { Authorization: `Key ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 65536) throw new Error('bounded_response'); chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks); let value;
  try { value = JSON.parse(bytes); } catch { /* Unknown non-JSON error bodies are never recorded. */ }
  return { status: response.status, value, safe: summary(response.status, bytes, value) };
}
try {
  const args = process.argv.slice(2), env = process.env; let api = 'https://api.fal.ai', queue = 'https://queue.fal.run', key;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--fixture-origin') throw new Error('invalid_context');
    const url = new URL(args[1]);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== args[1]) throw new Error('invalid_context');
    api = queue = url.origin; key = 'fixture-fal-key';
  } else {
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main'
      || env.GITHUB_REPOSITORY !== 'tbb/saint-look' || env.GITHUB_JOB !== 'diagnostic' || env.GITHUB_RUN_ATTEMPT !== '1'
      || env.GITHUB_WORKFLOW_REF !== 'tbb/saint-look/.github/workflows/fitting-fal-access.yml@refs/heads/main'
      || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '') || env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA) throw new Error('invalid_context');
    key = env.FAL_KEY; if (!key) throw new Error('missing_credentials');
  }
  const history = await get(`${api}/v1/models/requests/by-endpoint?${new URLSearchParams({ endpoint_id: endpoint, start, end, limit: '10' })}`, key);
  report.history = history.safe;
  if (history.status !== 200) report.status = 'history_unavailable';
  else {
    const items = history.value?.items;
    if (!Array.isArray(items) || items.length > 10 || typeof history.value.has_more !== 'boolean') throw new Error('invalid_response');
    for (const item of items) {
      const time = Date.parse(item?.sent_at);
      if (!uuid.test(item?.request_id || '') || item.endpoint_id !== endpoint || !Number.isFinite(time)
        || typeof item.sent_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(item.sent_at)
        || time < Date.parse(start) || time >= Date.parse(end)
        || !(item.status_code === null || Number.isInteger(item.status_code) && item.status_code >= 100 && item.status_code <= 599)) throw new Error('invalid_response');
    }
    report.records = items.map(item => ({ requestId: item.request_id, endpointId: endpoint, httpStatus: item.status_code }));
    report.status = history.value.has_more || items.length > 1 ? 'ambiguous_history' : items.length ? 'record_found' : 'no_record';
    if (report.status === 'record_found' && items[0].status_code >= 400) {
      const result = await get(`${queue}/fal-ai/nano-banana-pro/requests/${items[0].request_id}`, key);
      report.result = result.safe;
    }
  }
} catch (error) {
  report.status = ['invalid_context', 'invalid_response', 'missing_credentials', 'bounded_response'].includes(error.message) ? error.message : 'request_failed';
  process.exitCode = 1;
} finally {
  await writeFile('fal-access-report.json', JSON.stringify(report, null, 2) + '\n');
}
