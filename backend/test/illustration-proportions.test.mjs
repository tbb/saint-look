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
