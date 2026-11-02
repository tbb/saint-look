// THROWAWAY: original pixels only, no filled/invented torso behind folded sleeves.
// node ... <state.json> <item> <prepared.png> <output-directory>
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{createRequire}from'node:module';
const sharp=createRequire(new URL('../../backend/package.json',import.meta.url))('sharp');
const[statePath,name,preparedPath,out]=process.argv.slice(2),v=JSON.parse(readFileSync(statePath)).variants[name];
const{data,info}=await sharp(preparedPath).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const{width:w,height:h}=info,N=Math.ceil(Math.max(w,h)*1.8),ox=Math.round((N-w)/2),oy=Math.round((N-h)/2),canvas=Buffer.alloc(N*N*4),landmarks=v.segmentation.landmarks;
const pt=p=>[p[0]*w/1000,p[1]*h/1000],sub=(a,b)=>[a[0]-b[0],a[1]-b[1]],len=a=>Math.hypot(...a),angle=a=>Math.atan2(a[1],a[0]);
const masks={};
for(const part of v.segmentation.parts){const points=part.polygon.map(p=>pt(p).join(',')).join(' '),{data:m}=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><polygon points="${points}" fill="white"/></svg>`)).ensureAlpha().raw().toBuffer({resolveWithObject:true});masks[part.name]=m;}
const report={name,angleDegrees:13,occludedTorso:v.segmentation.occluded_torso,parts:[]};
for(const side of ['left','right']){
 const mask=masks[side+'_sleeve'];if(!mask)throw Error('Missing sleeve');
 const S=pt(landmarks[side+'_shoulder']),C=pt(landmarks[side+'_cuff']),E=landmarks[side+'_elbow']?pt(landmarks[side+'_elbow']):null;
 const direct=len(sub(C,S)),bent=E&&len(sub(E,S))>.2*direct&&len(sub(C,E))>.2*direct&&(len(sub(E,S))+len(sub(C,E)))/direct>1.08;
 const source=bent?[S,E,C]:[S,C],target=[S],a=(side==='left'?103:77)*Math.PI/180,u=[Math.cos(a),Math.sin(a)];
 for(let i=1;i<source.length;i++){const length=len(sub(source[i],source[i-1])),p=target.at(-1);target.push([p[0]+u[0]*length,p[1]+u[1]*length]);}
 const used=new Uint8Array(w*h);let total=0,painted=0;
 for(let i=0;i<w*h;i++)if(mask[i*4+3]>128&&data[i*4+3]>128)total++;
 const split=bent?len(sub(source[1],source[0])):Infinity;
 for(let y=0;y<N;y++)for(let x=0;x<N;x++){
  const q=[x-ox,y-oy],t=(q[0]-S[0])*u[0]+(q[1]-S[1])*u[1],segment=bent&&t>=split?1:0;
  const delta=a-angle(sub(source[segment+1],source[segment])),c=Math.cos(delta),s=Math.sin(delta),d=sub(q,target[segment]);
  const sx=Math.round(source[segment][0]+c*d[0]+s*d[1]),sy=Math.round(source[segment][1]-s*d[0]+c*d[1]);
  if(sx<0||sx>=w||sy<0||sy>=h)continue;const j=sy*w+sx;
  if(mask[j*4+3]<=128||data[j*4+3]===0)continue;
  data.copy(canvas,(y*N+x)*4,j*4,j*4+4);used[j]=1;painted++;
 }
 report.parts.push({side,bent:Boolean(bent),sourceLandmarks:source,targetLandmarks:target,sourcePixels:total,retainedSourceFraction:used.reduce((a,b)=>a+b,0)/total,destinationPixels:painted});
}
// Keep all non-sleeve original pixels. Missing torso is deliberately left empty.
for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;if(masks.left_sleeve[i+3]>128||masks.right_sleeve[i+3]>128)continue;data.copy(canvas,((y+oy)*N+x+ox)*4,i,i+4);}
mkdirSync(out,{recursive:true});await sharp(canvas,{raw:{width:N,height:N,channels:4}}).png().toFile(out+'/'+name+'-articulated.png');writeFileSync(out+'/'+name+'-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
