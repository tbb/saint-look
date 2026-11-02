import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createIllustrationProvider } from '../src/illustration-provider.mjs';
import { checkGarmentLayout } from '../src/illustration-layout.mjs';
import { compareTopProportions } from '../src/illustration-proportions.mjs';
import { createProviders } from '../src/providers.mjs';
import { demoResult } from '../src/demo-provider.mjs';

for (const type of ['Футболка', 'Брюки', 'Худи', 'Куртка', 'Свитер']) test(`Simulator provider returns requested ${type} through generation and finalization`, async t => {
  const child = spawn(process.execPath, ['test/providers/ui-server.mjs'], {
    env: { ...process.env, NODE_ENV: 'test', SAINT_LOOK_UI_PROVIDER_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  const reader = createInterface({ input: child.stdout });
  const [line] = await Promise.race([once(reader, 'line'), once(child, 'exit').then(() => { throw new Error('Fixture exited'); })]);
  const origin = JSON.parse(line).url;
  const controlled = await fetch(origin + '/__control', { method: 'POST', headers: {
    authorization: 'Bearer saint-look-ui-provider-control-token-00000001', 'Content-Type': 'application/json',
  }, body: JSON.stringify({illustrationMode:'success'}) });
  assert.equal(controlled.status, 200);
  const provider = createIllustrationProvider({ NODE_ENV:'test', SAINT_LOOK_ILLUSTRATIONS_ENABLED:'true',
    SAINT_LOOK_ILLUSTRATION_TEST_ORIGIN:origin, PHOTOROOM_SANDBOX_API_KEY:'sandbox_fixture',
    TYPESAFE_API_KEY:'fixture', GEMINI_API_KEY:'fixture' });
  const source = (await demoResult()).image, features={type,colors:['Синий']};
  const signal=new AbortController().signal;
  const prepared=await provider.prepare(source,signal);
  const generated=await provider.generate([{source,prepared,role:'front'}],features,signal,()=>{});
  const result=await provider.prepare(generated.png,signal,'finalization',features);
  assert.equal((await checkGarmentLayout(result,features)).valid,true);
  const proportions=await compareTopProportions(prepared,result,features);
  assert.ok(!proportions.measurable || proportions.valid,JSON.stringify(proportions));
});


test('typed UI setup agrees across both attribute pipelines, rejects invalid control and resets', { timeout: 30000 }, async t => {
  const child = spawn(process.execPath, ['test/providers/ui-server.mjs'], {
    env: { ...process.env, NODE_ENV: 'test', SAINT_LOOK_UI_PROVIDER_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  const reader = createInterface({ input: child.stdout });
  const [line] = await Promise.race([once(reader, 'line'), once(child, 'exit').then(() => { throw new Error('Fixture exited'); })]);
  const origin = JSON.parse(line).url;
  const control = (body, token = 'saint-look-ui-provider-control-token-00000001') => fetch(origin + '/__control', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await control({ itemType: 'trousers' }, 'wrong')).status, 401);
  for (const itemType of [null, 1, 'unknown', 'Брюки']) {
    assert.equal((await control({ itemType })).status, 400);
  }
  const env = { NODE_ENV: 'test', SAINT_LOOK_PROVIDER: 'live', SAINT_LOOK_TEST_PROVIDER_ORIGIN: origin,
    SAINT_LOOK_ILLUSTRATIONS_ENABLED: 'true', SAINT_LOOK_ILLUSTRATION_TEST_ORIGIN: origin,
    PHOTOROOM_SANDBOX_API_KEY: 'sandbox_fixture', TYPESAFE_API_KEY: 'fixture-typesafe-key', GEMINI_API_KEY: 'fixture' };
  const ingestion = createProviders(env), illustration = createIllustrationProvider(env);
  const source = (await demoResult()).image, signal = AbortSignal.timeout(20000);
  for (const [itemType, label] of [['t_shirt', 'Футболка'], ['hoodie', 'Худи'], ['jacket', 'Куртка'],
                                  ['sweater', 'Свитер'], ['trousers', 'Брюки']]) {
    assert.equal((await control({ itemType, illustrationMode: 'success' })).status, 200);
    assert.equal((await ingestion.attributes(source, signal)).type, label);
    const features = await illustration.attributes([{ source, prepared: source, role: 'front' }], signal);
    assert.equal(features.type, label);
    const generated = await illustration.generate([{ source, prepared: source, role: 'front' }], features, signal, () => {});
    const result = await illustration.prepare(generated.png, signal, 'finalization', features);
    assert.equal((await checkGarmentLayout(result, features)).valid, true);
  }
  assert.equal((await control({ reset: true })).status, 200);
  assert.equal((await ingestion.attributes(source, signal)).type, 'Футболка');
  assert.equal((await illustration.attributes([{ source, prepared: source, role: 'front' }], signal)).type, 'Футболка');
});
