import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createIllustrationProvider } from '../src/illustration-provider.mjs';
import { illustrationFixture } from './providers/illustration.mjs';
import { registerGarmentLayout, checkGarmentLayout } from '../src/illustration-layout.mjs';

async function rectangle(left, top, width, height) {
  return sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width, height, channels: 4, background: '#222222ff' } }).png().toBuffer(), left, top }]).png().toBuffer();
}

test('finalization refuses full-canvas trousers that would cover the mannequin head and torso', async t => {
  const invalid = await rectangle(360, 40, 300, 940);
  const fixture = await illustrationFixture(t, { finalization: async (_, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(invalid);
  } });
  await assert.rejects(createIllustrationProvider(fixture.env).prepare(invalid, new AbortController().signal,
    'finalization', { type: 'Брюки', colors: ['Чёрный'] }), { code: 'illustration_geometry_invalid' });
  assert.equal(fixture.calls.finalization.length, 1, 'A bad fit never triggers an automatic paid retry');
});

test('finalization accepts a waist-to-ankle garment without cropping or changing its pixels', async t => {
  const valid = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M435 485 H585 V900 H530 L515 620 H505 L490 900 H435 Z" fill="#222"/></svg>')).png().toBuffer();
  const fixture = await illustrationFixture(t, { finalization: async (_, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(valid);
  } });
  const result = await createIllustrationProvider(fixture.env).prepare(valid, new AbortController().signal,
    'finalization', { type: 'Брюки', colors: ['Чёрный'] });
  assert.deepEqual(await sharp(result).raw().toBuffer(), await sharp(valid).raw().toBuffer());
});

// Independent silhouettes, deliberately not generated from the production template.
test('a front-facing pair of trousers is placed below the waist with one uniform scale', async () => {
  const source = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M350 100 H674 V920 H560 L524 340 H500 L464 920 H350 Z" fill="#222"/></svg>')).png().toBuffer();
  const features = { type: 'Брюки' };
  assert.equal((await checkGarmentLayout(source, features)).valid, false);
  const registered = await registerGarmentLayout(source, features);
  const check = await checkGarmentLayout(registered, features);
  assert.equal(check.valid, true);
  const alpha = await sharp(registered).ensureAlpha().raw().toBuffer();
  for (let y=0; y<440; y++) for (let x=0; x<1024; x++) assert.equal(alpha[(y*1024+x)*4+3],0);
});

test('unseparated leg silhouettes fail instead of being warped into trousers', async () => {
  await assert.rejects(registerGarmentLayout(await rectangle(350,100,320,820),{type:'Брюки'}), {code:'illustration_geometry_invalid'});
});
