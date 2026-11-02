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

test('unfolded sleeves beside the wrists do not qualify as aligned cuffs',async()=>{
 const source=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M470 240 Q450 185 512 172 Q574 185 554 240 L610 270 L680 340 L710 565 L680 575 L640 390 L614 280 L614 540 H410 V280 L384 390 L344 575 L314 565 L344 340 L414 270 Z" fill="#222"/></svg>')).png().toBuffer();
 const check=await checkGarmentLayout(source,{type:'hoodie',traits:{sleeves:'long',body_length:'regular'}});
 assert.equal(check.valid,false,'Both sleeves can be long and unfolded while hands miss their cuffs');
});

test('measured hoodie pose keeps body ratios and reaches the same mannequin wrists',async()=>{
 const {editPoseGuide}=await import('../src/illustration-edit-pose.mjs');
 const {registerGarmentLayout}=await import('../src/illustration-layout.mjs');
 const {measureTopProportions}=await import('../src/illustration-proportions.mjs');
 const features={type:'hoodie',colors:['Чёрный'],traits:{sleeves:'long',body_length:'regular'}};
 for(const ratio of [.55,.884]){
  const {data,info}=await sharp(await editPoseGuide(features,{bodyWidthToLength:ratio})).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  for(let i=0;i<data.length;i+=4)if(data[i]>250&&data[i+1]>250&&data[i+2]>250)data[i+3]=0;
  const source=await sharp(data,{raw:info}).png().toBuffer(),measured=await measureTopProportions(source,features);
  assert.ok(Math.abs(measured.bodyWidthToLength/ratio-1)<.02,'Guide must preserve the measured torso, including its neckline');
  const result=await registerGarmentLayout(source,features,measured),check=await checkGarmentLayout(result,features);
  assert.equal(check.wristsValid,true);assert.equal(check.valid,true);
 }
});

 test('a broad torso hem cannot substitute for cuffs outside the wrists',async()=>{
 const source=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><g fill="#222"><rect x="360" y="270" width="304" height="305"/><path d="M450 280 V240 Q430 172 512 172 Q594 172 574 240 V280Z"/><path d="M430 270 L344 320 L314 565 L344 575 L354 390 L410 300Z M594 270 L680 320 L710 565 L680 575 L670 390 L614 300Z"/></g></svg>')).png().toBuffer();
 const check=await checkGarmentLayout(source,{type:'hoodie',traits:{sleeves:'long',body_length:'regular'}});
 assert.equal(check.wristsValid,false);assert.equal(check.valid,false);
});

test('open jacket panels cannot substitute for cuffs outside the wrists',async()=>{
 const source=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><g fill="#222"><path d="M360 270 H664 V575 H524 V300 H500 V575 H360Z"/><path d="M450 280 V240 Q430 172 512 172 Q594 172 574 240 V280Z"/><path d="M430 270 L344 320 L314 565 L344 575 L354 390 L410 300Z M594 270 L680 320 L710 565 L680 575 L670 390 L614 300Z"/></g></svg>')).png().toBuffer();
 const check=await checkGarmentLayout(source,{type:'jacket',traits:{hood:'yes',sleeves:'long',body_length:'regular',fastening:'zip'}});
 assert.equal(check.wristsValid,false);assert.equal(check.valid,false);
});
