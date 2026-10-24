import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { providerFixture } from './providers/fixture.mjs';

test('a photo gets validated attributes and a cutout through both external HTTP protocols', async (t) => {
  const fixture = await providerFixture(t);
  const env = await environment(t);
  const server = await env.launch(fixture.env);
  const request = await photoRequest();
  assert.equal((await upload(server, request)).status, 202);
  const ready = await waitForItem(server, request.itemId);
  assert.equal(ready.type, 'Рубашка');
  assert.deepEqual(ready.colors, ['Красный']);
  assert.equal(ready.mode, 'demo'); // Controlled transport must not claim real AI.
  assert.deepEqual(ready.processing, { attributes: 'done', cutout: 'done' });
  assert.deepEqual(Buffer.from(await (await server.request(ready.resultPath)).arrayBuffer()), fixture.cutout);
  const gemini = JSON.parse(fixture.calls.attributes[0].body);
  assert.equal(gemini.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(gemini.generationConfig.responseMimeType, 'application/json');
  assert.equal(fixture.calls.attributes[0].headers['x-goog-api-key'], 'fixture-gemini-key');
  const multipart = await new Request('http://fixture', { method: 'POST', headers: fixture.calls.cutout[0].headers, body: fixture.calls.cutout[0].body }).formData();
  assert.equal(multipart.get('format'), 'png');
  assert.equal(multipart.get('despill'), 'false');
  assert.equal(multipart.get('image_file').type, 'image/png');
  assert.equal(fixture.calls.cutout[0].headers['x-api-key'], 'fixture-photoroom-key');
});

test('missing credentials or preflight approval fails without contacting either provider or falling back to demo', async (t) => {
  const fixture = await providerFixture(t);
  for (const [override, code] of [[{ GEMINI_API_KEY: '' }, 'provider_not_configured'], [{ SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED: '' }, 'provider_preflight_required']]) {
    const env = await environment(t);
    const server = await env.launch({ ...fixture.env, ...override });
    const request = await photoRequest();
    await upload(server, request);
    const failed = await waitForItem(server, request.itemId, 'failed');
    assert.equal(failed.error, code);
    assert.equal(failed.resultPath, null);
    assert.equal(failed.type, null);
    await server.stop();
  }
  assert.equal(fixture.calls.attributes.length, 0);
  assert.equal(fixture.calls.cutout.length, 0);
});

test('incomplete, blocked or unsuitable attributes never publish a card or call cutout', async (t) => {
  for (const [payload, expected] of [
    [{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"suitable":true,"reason":null,"type":"","colors":[]}' }] } }] }, 'invalid_provider_response'],
    [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"suitable":true,"reason":null,"type":"Рубашка","colors":["Красный"]}' }] } }] }, 'invalid_provider_response'],
    [{ promptFeedback: { blockReason: 'SAFETY' } }, 'inappropriate_photo'],
    [{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"suitable":false,"reason":"multiple_items","type":null,"colors":[]}' }] } }] }, 'inappropriate_photo'],
  ]) {
    const fixture = await providerFixture(t, { attributes(_request, response) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); } });
    const env = await environment(t);
    const server = await env.launch(fixture.env);
    const request = await photoRequest(); await upload(server, request);
    const failed = await waitForItem(server, request.itemId, 'failed');
    assert.equal(failed.error, expected);
    assert.equal(failed.type, null); assert.deepEqual(failed.colors, []); assert.equal(failed.resultPath, null);
    assert.equal(fixture.calls.cutout.length, 0);
    await server.stop();
  }
});

test('a corrupt, opaque or empty cutout never becomes ready even when attributes succeeded', async (t) => {
  const { default: sharp } = await import('sharp');
  for (const bytes of [Buffer.from('not a png'),
    await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000ff' } }).png().toBuffer(),
    await sharp({ create: { width: 16, height: 16, channels: 4, background: '#00000000' } }).png().toBuffer()]) {
    const fixture = await providerFixture(t, { cutout(_request, response) { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(bytes); } });
    const env = await environment(t); const server = await env.launch(fixture.env);
    const request = await photoRequest(); await upload(server, request);
    const failed = await waitForItem(server, request.itemId, 'failed');
    assert.equal(failed.error, 'invalid_provider_response');
    assert.equal(failed.type, null); assert.equal(failed.resultPath, null);
    assert.deepEqual(failed.processing, { attributes: 'done', cutout: 'failed' });
    await server.stop();
  }
});

test('provider quota and authorization refusals are explicit and never retried or replaced with demo', async (t) => {
  for (const [stage, status, expected] of [['attributes', 429, 'provider_quota_exceeded'], ['cutout', 402, 'provider_quota_exceeded'], ['attributes', 401, 'provider_unauthorized']]) {
    const fixture = await providerFixture(t, { [stage](_request, response) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end('{"error":"private upstream details"}'); } });
    const env = await environment(t); const server = await env.launch(fixture.env);
    const request = await photoRequest(); await upload(server, request);
    const failed = await waitForItem(server, request.itemId, 'failed');
    assert.equal(failed.error, expected); assert.equal(failed.resultPath, null);
    assert.equal((await upload(server, request)).status, 200);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fixture.calls[stage].length, 1);
    await server.stop();
  }
});

test('timeout after a request was sent persists unknown and duplicate uploads do not call the provider again', async (t) => {
  const fixture = await providerFixture(t, { attributes() {} });
  const env = await environment(t); let server = await env.launch({ ...fixture.env, SAINT_LOOK_PROVIDER_TIMEOUT_MS: '100' });
  const request = await photoRequest(); await upload(server, request);
  const failed = await waitForItem(server, request.itemId, 'failed');
  assert.equal(failed.error, 'processing_unknown');
  assert.deepEqual(failed.processing, { attributes: 'unknown', cutout: 'pending' });
  await server.stop(); server = await env.launch(fixture.env);
  assert.equal((await upload(server, request)).status, 200);
  assert.deepEqual(await (await server.request(`/v1/items/${request.itemId}`)).json(), failed);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fixture.calls.attributes.length, 1); assert.equal(fixture.calls.cutout.length, 0);
});
