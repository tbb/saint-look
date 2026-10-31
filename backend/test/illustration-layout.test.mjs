import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createIllustrationProvider } from '../src/illustration-provider.mjs';
import { illustrationFixture } from './providers/illustration.mjs';
import { registerGarmentLayout, checkGarmentLayout, layoutGuide } from '../src/illustration-layout.mjs';

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


test('registration never crops visible sandbox watermark pixels outside the garment', async () => {
  const source = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="100" y="100" width="200" height="80" fill="#222"/><rect x="900" y="900" width="50" height="50" fill="red" opacity="0.5"/></svg>')).png().toBuffer();
  await assert.rejects(registerGarmentLayout(source, {type:'shoes'}), {code:'illustration_geometry_invalid'});
});

test('wide full-length trousers cannot pass by shrinking their hems above the ankles', async () => {
  const source = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M250 100 H750 V900 H550 L525 350 H475 L450 900 H250 Z" fill="#222"/></svg>')).png().toBuffer();
  await assert.rejects(registerGarmentLayout(source, {type:'trousers'}), {code:'illustration_geometry_invalid'});
  const shortened = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M430 483 H590 V746 H530 L520 570 H500 L490 746 H430 Z" fill="#222"/></svg>')).png().toBuffer();
  assert.equal((await checkGarmentLayout(shortened,{type:'trousers'})).valid, false);
});

const shortTee = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M480 240 Q512 260 544 240 L582 250 L650 295 L625 335 L585 315 L585 450 H439 V315 L399 335 L374 295 L442 250 Z" fill="#222"/></svg>';
test('a regular tee cannot pass with a floating hem above the waistband', async () => {
  const source = await sharp(Buffer.from(shortTee)).png().toBuffer();
  const features = {type:'t_shirt', traits:{body_length:'regular'}};
  assert.equal((await checkGarmentLayout(source, features)).valid, false);
  const registered = await registerGarmentLayout(source, features);
  assert.equal((await checkGarmentLayout(registered, features)).valid, true);
  const {data,info} = await sharp(registered).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let hem=-1;
  for(let y=0;y<info.height;y++) for(let x=480;x<=544;x++) if(data[(y*info.width+x)*4+3]>=224) hem=y;
  assert.ok(hem>=490, `Regular tee must overlap the waist; actual hem ${hem}`);
});

test('an explicitly cropped tee keeps its intended length', async () => {
  const source = await sharp(Buffer.from(shortTee)).png().toBuffer();
  const features = {type:'t_shirt', traits:{body_length:'cropped'}};
  assert.equal((await checkGarmentLayout(source, features)).valid, true);
  assert.deepEqual(await registerGarmentLayout(source,features),source);
});

// Shoulder position must not depend on how deep the designer cut the neckline.
test('a regular deep-neck top retains correct shoulders and waist without rescaling', async () => {
  const source = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M430 260 L465 260 Q472 345 512 345 Q552 345 559 260 L594 260 L586 540 L438 540 Z" fill="#222"/></svg>')).png().toBuffer();
  const features = {type:'top', traits:{body_length:'regular'}};
  assert.equal((await checkGarmentLayout(source, features)).valid, true);
  assert.deepEqual(await registerGarmentLayout(source, features), source);
});

test('real jacket and tee align their shoulders for layering with whole-image translations', async () => {
  const {readFile} = await import('node:fs/promises');
  const cases = [
    ['tee', {type:'t_shirt',traits:{neckline:'round',body_length:'regular'}}],
    ['jacket', {type:'jacket',traits:{neckline:'collar',body_length:'regular'}}],
  ];
  const layers=[];
  for(const [name,features] of cases){
    const source=await readFile(new URL(`./fixtures/fitting-shoulder-${name}.png`,import.meta.url));
    assert.equal((await checkGarmentLayout(source,features)).valid,false,`${name}: containment alone missed shoulder placement`);
    const registered=await registerGarmentLayout(source,features);
    assert.equal((await checkGarmentLayout(registered,features)).valid,true);
    assert.deepEqual(await registerGarmentLayout(registered,features),registered,'Registration must be idempotent');
    const data=await sharp(registered).ensureAlpha().raw().toBuffer();
    layers.push(data);
    const before=await sharp(source).ensureAlpha().raw().toBuffer();
    const sums=bytes=>{const out=[0,0,0,0];for(let i=0;i<bytes.length;i+=4)for(let c=0;c<4;c++)out[c]+=bytes[i+c];return out};
    assert.deepEqual(sums(data),sums(before),'A whole-image translation preserves every pixel, including all watermarks');
  }
  const first=(data,x)=>{for(let y=0;y<1024;y++)if(data[(y*1024+x)*4+3]>=224)return y;return 1024};
  for(const [left,right] of [[430,450],[574,594]]) for(let x=left;x<=right;x++) {
    assert.ok(first(layers[1],x)<=first(layers[0],x),`Outer layer must cover the inner shoulder at x=${x}`);
  }
});

test('shoulder alignment also retains regular hems and full-length sleeves', async () => {
  const {readFile}=await import('node:fs/promises');
  const polo={type:'polo',traits:{neckline:'collar',body_length:'regular',sleeves:'short'}};
  const source=await readFile(new URL('./fixtures/fitting-shoulder-polo-raw.png',import.meta.url));
  const registered=await registerGarmentLayout(source,polo);
  assert.equal((await checkGarmentLayout(registered,polo)).valid,true);
  const jacket={type:'jacket',traits:{neckline:'collar',body_length:'regular',sleeves:'long'}};
  const outer=await registerGarmentLayout(await readFile(new URL('./fixtures/fitting-shoulder-jacket.png',import.meta.url)),jacket);
  const data=await sharp(outer).ensureAlpha().raw().toBuffer();
  for(const [left,right] of [[333,420],[604,691]]) {
    let cuff=-1;
    for(let y=400;y<650;y++){let count=0;for(let x=left;x<=right;x++)if(data[(y*1024+x)*4+3]>=224)count++;if(count>=5)cuff=y;}
    assert.ok(cuff>=535,`A declared long sleeve must reach the wrist region; cuff=${cuff}`);
  }
});

test('an elongated tee keeps its proportions and remains visible below a regular hoodie', async () => {
  const {readFile}=await import('node:fs/promises');
  const longTee=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M480 240 Q512 260 544 240 L594 270 L650 320 L625 360 L585 330 L585 610 H439 V330 L399 360 L374 320 L430 269 Z" fill="#f7f2e0"/></svg>')).png().toBuffer();
  const features={type:'t_shirt',traits:{body_length:'long',neckline:'round'}};
  const longGuide=await sharp(await layoutGuide(features)).raw().toBuffer();
  const regularGuide=await sharp(await layoutGuide({type:'t_shirt',traits:{body_length:'regular'}})).raw().toBuffer();
  // Generated guide PNGs are RGBA; their lower torso must describe the longer cut.
  assert.ok(longGuide[(600*1024+512)*4]<240);
  assert.equal(regularGuide[(600*1024+512)*4],255);
  assert.equal((await checkGarmentLayout(longTee,features)).valid,true);
  const registered=await registerGarmentLayout(longTee,features);
  assert.deepEqual(registered,longTee,'An aligned long design must not be shortened, widened or tucked');
  const hoodie=await readFile(new URL('../../client-ios/SaintLook/VisualFixtures/fitting-trial-hoodie.png',import.meta.url));
  const combined=await sharp(registered).composite([{input:hoodie}]).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...combined.subarray((600*1024+512)*4,(600*1024+512)*4+4)],[247,242,224,255]);
});
