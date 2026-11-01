import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {generationFrame,projectGenerationCanvas,generationPoseGuide} from '../src/illustration-generation-frame.mjs';
const features={type:'t_shirt',traits:{body_length:'regular',silhouette:'relaxed'}};
async function box(width,height) {
 return sharp({create:{width:1024,height:1024,channels:4,background:'#00000000'}}).composite([
  {input:await sharp({create:{width,height,channels:4,background:'#222222ff'}}).png().toBuffer(),left:512-width/2,top:150}
 ]).png().toBuffer();
}
async function bounds(image) {
 const {data,info}=await sharp(image).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 let left=1024,right=-1,top=1024,bottom=-1;
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>200){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
 return {width:right-left+1,height:bottom-top+1};
}
test('placement retains wide, slim and elongated proportions without fitting them to one silhouette',async()=>{
 for(const [width,height] of [[500,600],[300,600],[500,750]]){
  const source=await box(width,height), result=await projectGenerationCanvas(source,features);
  const measured=await bounds(result), scale=generationFrame(features).side/1024;
  assert.ok(Math.abs(measured.width-width*scale)<=2);
  assert.ok(Math.abs(measured.height-height*scale)<=2);
  assert.ok(Math.abs(measured.width/measured.height-width/height)<0.015);
 }
});
test('pose guide does not prescribe a narrow filled torso',async()=>{
 const data=await sharp(await generationPoseGuide(features)).ensureAlpha().raw().toBuffer();
 let ink=0;for(let i=0;i<data.length;i+=4)if(data[i]<240)ink++;
 assert.ok(ink<1024*1024*0.02,'Pose markers must not become a replacement garment silhouette');
});
