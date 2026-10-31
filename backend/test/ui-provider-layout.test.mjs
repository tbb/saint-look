import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createIllustrationProvider } from '../src/illustration-provider.mjs';
import { checkGarmentLayout } from '../src/illustration-layout.mjs';
import { demoResult } from '../src/demo-provider.mjs';

test('Simulator provider returns the requested trousers through generation and finalization', async t => {
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
  const source = (await demoResult()).image, features={type:'Брюки',colors:['Синий']};
  const signal=new AbortController().signal;
  const generated=await provider.generate([{source,prepared:source,role:'front'}],features,signal,()=>{});
  const result=await provider.prepare(generated.png,signal,'finalization',features);
  assert.equal((await checkGarmentLayout(result,features)).valid,true);
});
