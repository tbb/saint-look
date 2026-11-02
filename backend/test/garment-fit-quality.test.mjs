import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { layoutGuide, checkGarmentLayout } from '../src/illustration-layout.mjs';

async function pixels(features) {
  return sharp(await layoutGuide(features)).ensureAlpha().raw().toBuffer();
}
const at = (x,y) => (Math.round(y*1024/560)*1024+Math.round((x+100)*1024/560))*4;
function torsoWidth(data, y) {
  let width=0;
  for(let x=120;x<=240;x++) if(data[at(x,y)]<240) width++;
  return width;
}

test('a relaxed tee guide preserves extra torso ease instead of supplying a slim silhouette', async () => {
  const regular=await pixels({type:'t_shirt',traits:{silhouette:'straight',body_length:'regular'}});
  const relaxed=await pixels({type:'t_shirt',traits:{silhouette:'relaxed',body_length:'regular'}});
  assert.ok(torsoWidth(relaxed,260)>=torsoWidth(regular,260)*1.25,
    `relaxed/straight torso widths: ${torsoWidth(relaxed,260)}/${torsoWidth(regular,260)}`);
});

test('a lowered hood guide leaves room for the foreground head and keeps the neckline', async () => {
  const guide=await pixels({type:'hoodie',traits:{sleeves:'long'}});
  assert.equal(guide[at(180,44)],255,'A lowered hood must not prescribe fabric over the head crown');
  assert.ok(guide[at(180,150)]<240,'Torso must remain below the neckline');
});

test('folded-in hoodie cuffs cannot pass as a usable arm pose', async () => {
  // Independent silhouette reproduces the source-photo pose: forearms folded
  // toward the centre, cuffs over the torso, no fabric at the mannequin wrists.
  const folded=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M470 240 Q450 185 512 172 Q574 185 554 240 L605 270 L660 390 L590 520 L570 505 L590 540 H434 L414 505 L434 520 L364 390 L419 270 Z" fill="#222"/></svg>')).png().toBuffer();
  const result=await checkGarmentLayout(folded,{type:'hoodie',traits:{sleeves:'unknown'}});
  assert.equal(result.valid,false,'Unknown sleeve classification must not silently accept crossed/folded arm pose');
});

test('a wide torso is not mistaken for two unfolded sleeves at the wrist bands',async()=>{
  const source=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M475 240 Q460 185 512 172 Q564 185 549 240 L630 280 L665 390 L625 550 H399 L359 390 L394 280 Z" fill="#222"/></svg>')).png().toBuffer();
  const check=await checkGarmentLayout(source,{type:'hoodie',traits:{sleeves:'long',body_length:'regular'}});
  assert.equal(check.valid,false,'Torso pixels inside wrist bands are not evidence of unfolded sleeves');
});

test('measured hood pose does not impose long sleeves or cuff-level hems on other cuts',async()=>{
 const {editPoseGuide}=await import('../src/illustration-edit-pose.mjs');
 const {garmentEditInstructions}=await import('../src/illustration-edit.mjs');
 for(const [sleeves,body_length] of [['short','regular'],['sleeveless','regular'],['long','cropped'],['long','long'],['unknown','regular']]) {
  const features={type:'hoodie',traits:{sleeves,body_length}},proportions={bodyWidthToLength:.8};
  assert.equal(await editPoseGuide(features,proportions),null,`${sleeves}/${body_length} cannot use a regular long-sleeve pose`);
  if(sleeves==='short'||sleeves==='sleeveless')assert.doesNotMatch(garmentEditInstructions(features,proportions),/Exactly TWO sleeves and TWO cuffs|Long cuffs end/);
 }
});
