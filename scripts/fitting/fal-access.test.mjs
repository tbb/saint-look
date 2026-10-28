import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const cli = new URL('./fal-access.mjs', import.meta.url).pathname;
const endpoint = 'fal-ai/nano-banana-pro/edit';
const requestId = '12345678-1234-1234-1234-123456789abc';
const record = { request_id: requestId, endpoint_id: endpoint, sent_at: '2026-10-28T12:31:41Z', status_code: 403 };
async function fixture(t, answers) {
  const dir = await mkdtemp(join(tmpdir(), 'fal-access-')); const calls = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.writeHead(404); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    calls.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).length, authorization: request.headers.authorization });
    const answer = answers[calls.length - 1] || [500, {}];
    response.writeHead(answer[0], { 'Content-Type': 'application/json', 'X-Secret': 'DO_NOT_CAPTURE_HEADER' });
    response.end(typeof answer[1] === 'string' ? answer[1] : JSON.stringify(answer[1]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = (args = ['--fixture-origin', origin], env = {}) => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { ...process.env, CI: 'true', FAL_KEY: 'DO_NOT_CAPTURE_KEY', ...env } });
    let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
    child.on('close', async code => resolve({ code, output, report: JSON.parse(await readFile(join(dir, 'fal-access-report.json')).catch(() => '{}')) }));
  });
  return { run, calls };
}

test('fal access CLI uses only the fixed read-only history window and matched error receipt', async t => {
  const f = await fixture(t, [[200, { items: [{ ...record, json_input: 'DO_NOT_CAPTURE_INPUT' }], has_more: false }],
    [403, { detail: 'User is locked. Reason: TOP_UP.', input: 'DO_NOT_CAPTURE_BODY' }]]);
  const result = await f.run(); assert.equal(result.code, 0, result.output);
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'GET']); assert.ok(f.calls.every(c => c.body === 0 && c.authorization === 'Key fixture-fal-key'));
  const url = new URL(f.calls[0].url, 'http://localhost');
  assert.equal(url.pathname, '/v1/models/requests/by-endpoint');
  assert.deepEqual(Object.fromEntries(url.searchParams), { endpoint_id: endpoint, start: '2026-10-28T12:31:00Z', end: '2026-10-28T12:33:00Z', limit: '10' });
  assert.equal(f.calls[1].url, `/fal-ai/nano-banana-pro/requests/${requestId}`);
  assert.equal(result.report.result.classification, 'account_locked_top_up');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_CAPTURE/);
});

test('history errors have a closed classification and never disclose arbitrary response text', async t => {
  for (const [detail, classification] of [
    ['User is locked. Reason: TOP_UP.', 'account_locked_top_up'],
    ['User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing', 'account_locked_exhausted_balance'],
    ['API key is disabled', 'key_disabled'], ['Permission denied', 'permission_denied'],
    ['Access denied', 'permission_denied'], ['Invalid API key', 'invalid_key'],
    ['DO_NOT_CAPTURE_ARBITRARY_ERROR', 'unknown'],
    ['User is locked. Reason: TOP_UP. DO_NOT_CAPTURE_SUFFIX', 'unknown'],
    [{ secret: 'DO_NOT_CAPTURE_OBJECT' }, 'unknown'],
  ]) await t.test(classification, async t => {
    const f = await fixture(t, [[403, { detail, headers: 'DO_NOT_CAPTURE_BODY' }]]);
    const result = await f.run(); assert.equal(result.code, 0); assert.equal(f.calls.length, 1);
    assert.equal(result.report.history.classification, classification);
    assert.match(result.report.history.bodySha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_CAPTURE/);
  });
});

test('invalid or ambiguous history never causes an additional GET', async t => {
  for (const [name, body, expectedCode, status] of [
    ['non-JSON', 'not json', 1, 'invalid_response'],
    ['missing items', {}, 1, 'invalid_response'],
    ['bad UUID', { items: [{ ...record, request_id: '../DO_NOT_CAPTURE_PATH' }], has_more: false }, 1, 'invalid_response'],
    ['wrong endpoint', { items: [{ ...record, endpoint_id: 'DO_NOT_CAPTURE_ENDPOINT' }], has_more: false }, 1, 'invalid_response'],
    ['outside fixed window', { items: [{ ...record, sent_at: '2026-10-28T12:33:00Z' }], has_more: false }, 1, 'invalid_response'],
    ['bad status', { items: [{ ...record, status_code: '403' }], has_more: false }, 1, 'invalid_response'],
    ['oversized body', 'x'.repeat(65537), 1, 'bounded_response'],
    ['multiple records', { items: [record, record], has_more: false }, 0, 'ambiguous_history'],
    ['pagination', { items: [record], has_more: true }, 0, 'ambiguous_history'],
    ['empty window', { items: [], has_more: false }, 0, 'no_record'],
    ['success record', { items: [{ ...record, status_code: 200 }], has_more: false }, 0, 'record_found'],
  ]) await t.test(name, async t => {
    const f = await fixture(t, [[200, body]]); const result = await f.run();
    assert.equal(result.code, expectedCode, result.output); assert.equal(result.report.status, status);
    assert.equal(f.calls.length, 1); assert.doesNotMatch(JSON.stringify(result), /DO_NOT_CAPTURE/);
  });
});

test('unapproved execution contexts and arbitrary target arguments are refused before a request', async t => {
  const f = await fixture(t, []);
  const manual = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'tbb/saint-look', GITHUB_JOB: 'diagnostic', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: 'tbb/saint-look/.github/workflows/fitting-fal-access.yml@refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40) };
  for (const [args, env] of [[[], {}], [[], { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' }],
    [[], { ...manual, GITHUB_EVENT_NAME: 'pull_request' }], [[], { ...manual, GITHUB_REF: 'refs/heads/topic' }],
    [[], { ...manual, GITHUB_RUN_ATTEMPT: '2' }], [[], { ...manual, GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }],
    [['--fixture-origin', 'https://example.com'], {}], [['--url', 'https://example.com'], {}],
    [['--fixture-origin', 'http://user:secret@127.0.0.1:1234'], {}]]) {
    const result = await f.run(args, env); assert.equal(result.code, 1); assert.equal(result.report.status, 'invalid_context');
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_CAPTURE/);
  }
  const admittedWithoutSecret = await f.run([], { ...manual, FAL_KEY: '' });
  assert.equal(admittedWithoutSecret.report.status, 'missing_credentials');
  assert.equal(f.calls.length, 0);
});

test('read-only fal workflow has manual main admission, one secret step and an always-safe report', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/fitting-fal-access.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /pull_request:|push:|schedule:|inputs:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/); assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write|actions: write/); assert.match(workflow, /persist-credentials: false/);
  assert.equal((workflow.match(/secrets\./g) || []).length, 1); assert.match(workflow, /secrets\.FAL_KEY/);
  assert.match(workflow, /if: always\(\)/); assert.match(workflow, /path: fal-access-report\.json/);
});
