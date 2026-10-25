import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, photoRequest, upload, waitForItem } from './support.mjs';
import { providerFixture } from './providers/fixture.mjs';
import { jevAnswer } from './providers/jev.mjs';
import sharp from 'sharp';

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
  const jev = JSON.parse(fixture.calls.attributes[0].body);
  assert.equal(jev.model, 'jev-1.14.0');
  assert.equal(jev.questions.item_type.criteria.shirt.length > 0, true);
  assert.equal(fixture.calls.attributes.length, 1);
  assert.equal(fixture.calls.attributes[0].headers.authorization, 'Bearer fixture-typesafe-key');
  const multipart = await new Request('http://fixture', { method: 'POST', headers: fixture.calls.cutout[0].headers, body: fixture.calls.cutout[0].body }).formData();
  assert.equal(multipart.get('format'), 'png');
  assert.equal(multipart.get('despill'), 'false');
  assert.equal(multipart.get('image_file').type, 'image/png');
  assert.equal(fixture.calls.cutout[0].headers['x-api-key'], 'fixture-photoroom-key');
});

test('missing credentials or preflight approval fails without contacting either provider or falling back to demo', async (t) => {
  const fixture = await providerFixture(t);
  for (const [override, code] of [[{ TYPESAFE_API_KEY: '' }, 'provider_not_configured'], [{ SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED: '' }, 'provider_preflight_required']]) {
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

test('incomplete or unsuitable Jev answers never publish a card or call cutout', async (t) => {
  const incomplete = jevAnswer(); delete incomplete.answers.color_black;
  const invalidColor = jevAnswer(); invalidColor.answers.color_red.noul = '0.99';
  const invalidChoice = jevAnswer(); invalidChoice.answers.item_type.choice = 'invented-type';
  const invalidDistribution = jevAnswer(); invalidDistribution.answers.item_type.probabilities.shirt = 0.3;
  const uncertainPhoto = jevAnswer(); uncertainPhoto.answers.suitability.confidence = 0.69;
  for (const [payload, expected] of [
    [incomplete, 'invalid_provider_response'], [invalidColor, 'invalid_provider_response'],
    [invalidChoice, 'invalid_provider_response'], [invalidDistribution, 'invalid_provider_response'],
    [{ ...jevAnswer(), model: 'jev-1.13.0' }, 'invalid_provider_response'],
    [uncertainPhoto, 'photo_unclear'], [jevAnswer({ colors: {} }), 'photo_unclear'],
    ...['on_person', 'multiple_items', 'no_item', 'unclear'].map(reason => [jevAnswer({ reason }), `photo_${reason}`]),
  ]) {
    const fixture = await providerFixture(t, { attributes(_request, response) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); } });
    const env = await environment(t);
    const server = await env.launch(fixture.env);
    const request = await photoRequest(); await upload(server, request);
    const failed = await waitForItem(server, request.itemId, 'failed');
    assert.equal(failed.error, expected);
    assert.equal(failed.type, null); assert.deepEqual(failed.colors, []); assert.equal(failed.resultPath, null);
    assert.equal(fixture.calls.attributes.length, 1); assert.equal(fixture.calls.cutout.length, 0);
    await server.stop();
  }
});

test('uncertain type stays unknown and main colors use canonical labels in score order, limited to five', async t => {
  const fixture = await providerFixture(t, { attributes(_request, response) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(jevAnswer({ confidence: 0.69,
      colors: { red: 0.99, blue: 0.98, black: 0.97, white: 0.96, gray: 0.7, beige: 0.7, yellow: 0.69 } })));
  } });
  const env = await environment(t); const server = await env.launch(fixture.env);
  const request = await photoRequest(); await upload(server, request);
  const ready = await waitForItem(server, request.itemId);
  assert.equal(ready.type, 'Не определён');
  assert.deepEqual(ready.colors, ['Красный', 'Синий', 'Чёрный', 'Белый', 'Серый']);
  assert.equal(fixture.calls.attributes.length, 1); assert.equal(fixture.calls.cutout.length, 1);
});

test('wide and small sources fit Jev limits without stretching or changing the Photoroom source', async t => {
  for (const [width, height, expectedWidth, expectedHeight] of [[2048, 100, 1568, 280], [100, 2048, 280, 1568], [16, 16, 280, 280]]) {
    const source = await sharp({ create: { width, height, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const fixture = await providerFixture(t); const env = await environment(t); const server = await env.launch(fixture.env);
    const request = { ...await photoRequest(), imageBase64: source.toString('base64') }; await upload(server, request);
    await waitForItem(server, request.itemId);
    const payload = JSON.parse(fixture.calls.attributes[0].body);
    const image = Buffer.from(payload.assets[payload.state.photo].data_base64, 'base64');
    const metadata = await sharp(image).metadata();
    assert.deepEqual([metadata.width, metadata.height], [expectedWidth, expectedHeight]);
    const { data } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 3)], [255, 255, 255]);
    const center = ((Math.floor(expectedHeight / 2) * expectedWidth) + Math.floor(expectedWidth / 2)) * 3;
    assert.deepEqual([...data.subarray(center, center + 3)], [255, 0, 0]);
    const multipart = await new Request('http://fixture', { method: 'POST', headers: fixture.calls.cutout[0].headers, body: fixture.calls.cutout[0].body }).formData();
    const cutoutInput = await sharp(Buffer.from(await multipart.get('image_file').arrayBuffer())).metadata();
    assert.deepEqual([cutoutInput.width, cutoutInput.height], [width, height]);
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

test('a compact JPEG that expands past the provider upload limit is rejected before external I/O', async (t) => {
  const { randomBytes } = await import('node:crypto');
  const { default: sharp } = await import('sharp');
  const jpeg = await sharp(randomBytes(1500 * 1500 * 3), { raw: { width: 1500, height: 1500, channels: 3 } }).jpeg({ quality: 65 }).toBuffer();
  assert.ok(jpeg.length < 5 * 1024 * 1024);
  assert.ok((await sharp(jpeg).png().toBuffer()).length > 5 * 1024 * 1024);
  const fixture = await providerFixture(t); const env = await environment(t); const server = await env.launch(fixture.env);
  const request = { ...await photoRequest(), imageBase64: jpeg.toString('base64') };
  assert.equal((await upload(server, request)).status, 202);
  const failed = await waitForItem(server, request.itemId, 'failed');
  assert.equal(failed.error, 'image_too_large');
  assert.equal(fixture.calls.attributes.length, 0); assert.equal(fixture.calls.cutout.length, 0);
});

test('a delayed provider leaves the card pending while the API remains usable', async (t) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const fixture = await providerFixture(t, { async attributes(_request, response, { attributes }) {
    await pending;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(attributes));
  } });
  const env = await environment(t); const server = await env.launch(fixture.env);
  const request = await photoRequest(); await upload(server, request);
  for (let n = 0; n < 50 && fixture.calls.attributes.length === 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fixture.calls.attributes.length, 1);
  const item = await (await server.request(`/v1/items/${request.itemId}`)).json();
  assert.equal(item.status, 'pending'); assert.equal(item.processing.attributes, 'in_flight');
  assert.equal(item.type, null); assert.equal(item.resultPath, null);
  assert.equal((await server.request('/health')).status, 200);
  release(); assert.equal((await waitForItem(server, request.itemId)).status, 'ready');
});

test('live mode with missing credentials stays live and fails closed instead of silently using demo', async (t) => {
  const env = await environment(t);
  const server = await env.launch({ SAINT_LOOK_PROVIDER: 'live', SAINT_LOOK_TEST_PROVIDER_ORIGIN: '', NODE_ENV: 'production', TYPESAFE_API_KEY: '', PHOTOROOM_API_KEY: '', SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED: '' });
  assert.equal((await (await server.request('/health')).json()).mode, 'live');
  const request = await photoRequest(); await upload(server, request);
  const item = await waitForItem(server, request.itemId, 'failed');
  assert.equal(item.mode, 'live'); assert.equal(item.error, 'provider_not_configured'); assert.equal(item.resultPath, null);
});

test('test transport cannot contact a remote origin or run outside explicit test mode', async (t) => {
  const fixture = await providerFixture(t);
  for (const override of [{ NODE_ENV: 'production' }, { SAINT_LOOK_TEST_PROVIDER_ORIGIN: 'https://example.invalid' }, { SAINT_LOOK_TEST_PROVIDER_ORIGIN: '' }]) {
    const env = await environment(t); const server = await env.launch({ ...fixture.env, ...override });
    const request = await photoRequest(); await upload(server, request);
    assert.equal((await waitForItem(server, request.itemId, 'failed')).error, 'provider_not_configured');
    await server.stop();
  }
  assert.equal(fixture.calls.attributes.length, 0); assert.equal(fixture.calls.cutout.length, 0);
});

test('a queued controlled-provider operation cannot silently resume as synthetic demo after restart', async (t) => {
  const fixture = await providerFixture(t); const env = await environment(t);
  let server = await env.launch({ ...fixture.env, SAINT_LOOK_STAGE_DELAY_MS: '10000' });
  const request = await photoRequest(); await upload(server, request);
  await server.stop(); server = await env.launch({ SAINT_LOOK_DEMO_DELAY_MS: '10' });
  const failed = await waitForItem(server, request.itemId, 'failed');
  assert.equal(failed.error, 'provider_configuration_changed'); assert.equal(failed.resultPath, null);
  assert.equal(fixture.calls.attributes.length, 0); assert.equal(fixture.calls.cutout.length, 0);
});
