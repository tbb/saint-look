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
test('lowering a hood preserves the same neck-to-hem body ratio',async()=>{
 async function garment(hoodTop){return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="M312 200 H712 V800 H312 Z M432 ${hoodTop} H592 V220 H432 Z" fill="#222"/></svg>`)).png().toBuffer();}
 const checked=await compareTopProportions(await garment(20),await garment(160),{type:'hoodie',traits:{sleeves:'long'}});
 assert.equal(checked.valid,true,'Lowered hood must not need 15% extra height above unchanged shoulders');
 assert.ok(checked.relativeError<.01);
});
