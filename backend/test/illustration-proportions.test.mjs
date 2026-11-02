import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {compareTopProportions,measureTopProportions} from '../src/illustration-proportions.mjs';
const features={type:'t_shirt',traits:{sleeves:'short',silhouette:'unknown'}};
async function torso(width,height){
 return sharp({create:{width:1024,height:1024,channels:4,background:'#00000000'}}).composite([
  {input:await sharp({create:{width,height,channels:4,background:'#222222ff'}}).png().toBuffer(),left:Math.floor((1024-width)/2),top:30}
 ]).png().toBuffer();
}
test('a wide source turned into a slim result fails even when the classifier calls silhouette unknown',async()=>{
 const source=await torso(668,858), result=await torso(539,909);
 const check=await compareTopProportions(source,result,features);
 assert.equal(check.measurable,true);assert.equal(check.valid,false);
 assert.ok(check.relativeError>.23);
});
test('uniformly resizing regular, fitted and long bodies preserves identity ratios',async()=>{
 for(const [w,h]of[[660,850],[420,850],[440,980]]){
  const check=await compareTopProportions(await torso(w,h),await torso(Math.round(w/2),Math.round(h/2)),features);
  assert.equal(check.valid,true);
 }
});
test('a folded lower-body garment is not measured using a short-sleeve torso assumption',async()=>{
 assert.equal(await measureTopProportions(await torso(500,800),{type:'trousers'}),null);
 assert.equal(await measureTopProportions(await torso(500,800),{type:'hoodie',traits:{sleeves:'long'}}),null);
});
test('an ambiguous generated outline cannot evade a measurable source proportion constraint',async()=>{
 const source=await torso(660,850);
 const output=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M400 30 H624 L950 950 H74 Z" fill="#222"/></svg>')).png().toBuffer();
 const check=await compareTopProportions(source,output,features);
 assert.equal(check.measurable,true);assert.equal(check.valid,false);
 assert.equal(check.reason,'ambiguous-result-outline');
});

test('unfolding long sleeves does not change the measured torso hem',async()=>{
 async function garment(cuffY){return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M312 100 H712 V700 H312 Z M312 110 H230 V${cuffY} H290 V200 H312 Z M712 110 H794 V${cuffY} H734 V200 H712 Z" fill="#222"/></svg>`)).png().toBuffer();}
 const checked=await compareTopProportions(await garment(650),await garment(850),{type:'sweater',traits:{sleeves:'long'}});
 assert.equal(checked.valid,true,'Same body must pass independently of cuffs below its hem');
 assert.ok(checked.relativeError<.01);
});
test('lowering a hood preserves the same shoulder-to-hem body ratio',async()=>{
 async function garment(hoodTop){return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M312 200 H712 V800 H312 Z M432 ${hoodTop} H592 V220 H432 Z" fill="#222"/></svg>`)).png().toBuffer();}
 const checked=await compareTopProportions(await garment(20),await garment(160),{type:'hoodie',traits:{sleeves:'long'}});
 assert.equal(checked.valid,true,'Lowered hood must not need 15% extra height above unchanged shoulders');
 assert.ok(checked.relativeError<.01);
});

test('upper sleeve attachments do not outweigh the stable lower hoodie torso',async()=>{
 async function garment(attachedUntil){return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M312 200 H712 V800 H312 Z M432 100 H592 V220 H432 Z M312 220 H220 V${attachedUntil} H312 Z M712 220 H804 V${attachedUntil} H712 Z" fill="#222"/></svg>`)).png().toBuffer();}
 const checked=await compareTopProportions(await garment(500),await garment(650),{type:'hoodie',traits:{sleeves:'long'}});
 assert.equal(checked.valid,true);
 assert.ok(checked.relativeError<.01);
});

test('ten-percent narrowing is rejected while a five-percent drawing variation passes',async()=>{
 const source=await torso(640,800);
 assert.equal((await compareTopProportions(source,await torso(576,800),features)).valid,false);
 assert.equal((await compareTopProportions(source,await torso(608,800),features)).valid,true);
});

test('a transparent hood neckline does not move the shoulder reference into the torso',async()=>{
 const hood={type:'hoodie',traits:{sleeves:'long'}};
 const closed=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M312 200 H712 V800 H312 Z M432 100 H592 V220 H432 Z" fill="#222"/></svg>')).png().toBuffer();
 const opening=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M432 200 L512 300 L592 200Z" fill="white"/></svg>');
 const open=await sharp(closed).composite([{input:opening,blend:'dest-out'}]).png().toBuffer();
 const original=await measureTopProportions(closed,hood),candidate=await measureTopProportions(open,hood);
 assert.equal(candidate.bodyTop,original.bodyTop,'An opening changes neither shoulder line nor torso length');
 assert.equal(candidate.bodyWidthToLength,original.bodyWidthToLength);
});

test('an open hood rim is not substantial shoulder support',async()=>{
 const hood={type:'hoodie',traits:{sleeves:'long'}};
 const torso='<path d="M312 200 H712 V800 H312Z" fill="#222"/>';
 const image=async path=>sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">'+path+torso+'</svg>')).png().toBuffer();
 const narrow=await image('<path d="M432 100 H592 V220 H432Z" fill="#222"/>');
 const open=await image('<path fill="#222" fill-rule="evenodd" d="M432 40 H592 L712 100 V220 H312 V100Z M442 60 H582 L692 110 V200 H332 V110Z"/>');
 const original=await measureTopProportions(narrow,hood),candidate=await measureTopProportions(open,hood);
 assert.equal(candidate.bodyTop,original.bodyTop);
 assert.equal(candidate.bodyWidthToLength,original.bodyWidthToLength);
});
