// THROWAWAY: inspect model-derived panels before using any point for image placement.
// node client-ios/prototypes/render-panel-diagnostic.mjs <decrypted-state.json> <output-dir>
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{createRequire}from'node:module';
const sharp=createRequire(new URL('../../backend/package.json',import.meta.url))('sharp');
const[statePath,out]=process.argv.slice(2),state=JSON.parse(readFileSync(statePath));mkdirSync(out,{recursive:true});
const palette={torso:'#28a745',left_sleeve:'#1b8bff',right_sleeve:'#ff7d24',hood:'#c34adc'};
for(const[name,v]of Object.entries(state.variants)){
 if(!v.segmentation)continue;
 const original=Buffer.from(v.source,'base64'),meta=await sharp(original).metadata(),w=meta.width,h=meta.height;
 const point=p=>{if(!Array.isArray(p)||p.length!==2||p.some(n=>!Number.isFinite(n)||n<0||n>1000))throw Error('Invalid point');return[p[0]*w/1000,p[1]*h/1000];};
 const overlay=[];
 for(const part of v.segmentation.parts){
  if(!palette[part.name]||part.polygon.length<3||part.polygon.length>60)throw Error('Invalid part');
  const points=part.polygon.map(p=>point(p).join(',')).join(' ');
  const mask=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><polygon points="${points}" fill="white"/></svg>`);
  await sharp(original).ensureAlpha().composite([{input:mask,blend:'dest-in'}]).png().toFile(out+'/'+name+'-'+part.name+'.png');
  overlay.push(`<polygon points="${points}" stroke="${palette[part.name]}" stroke-width="3" fill="${palette[part.name]}" fill-opacity=".15"/>`);
 }
 for(const[label,p]of Object.entries(v.segmentation.landmarks)){if(label.endsWith('_edge')){const a=point(p[0]),b=point(p[1]);overlay.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#ff00ff" stroke-width="6"/>`);continue;}const[x,y]=point(p);overlay.push(`<circle cx="${x}" cy="${y}" r="5" fill="white" stroke="black"/><text x="${x+7}" y="${y-7}" font-family="sans-serif" font-size="14" fill="white" stroke="black" paint-order="stroke" stroke-width="3">${label.replaceAll('_',' ')}</text>`);}
 await sharp(original).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${overlay.join('')}</svg>`)}]).png().toFile(out+'/'+name+'-panels.png');
 writeFileSync(out+'/'+name+'-landmarks.json',JSON.stringify(v.segmentation,null,2));
}
