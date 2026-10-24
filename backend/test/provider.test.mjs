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
