// PROTOTYPE: contrasting visible details, for inspection only; never edits the garment.
import{createRequire}from'node:module';const sharp=createRequire(new URL('../../../backend/package.json',import.meta.url))('sharp');
export async function contrastDetails(source,mask){
 const metadata=await sharp(source).metadata(),{data,info}=await sharp(mask).resize({width:256,height:256,fit:'inside'}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const {width:w,height:h}=info,channels=[[],[],[]];
 for(let p=0;p<w*h;p++)if(data[p*4+3]>=224)for(let c=0;c<3;c++)channels[c].push(data[p*4+c]);
 const median=channels.map(v=>v.sort((a,b)=>a-b)[Math.floor(v.length/2)]||0),seed=new Uint8Array(w*h),grown=new Uint8Array(w*h);
 for(let p=0;p<w*h;p++)if(data[p*4+3]>=224&&Math.hypot(...median.map((m,c)=>data[p*4+c]-m))>105)seed[p]=1;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(seed[y*w+x])for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){const a=x+dx,b=y+dy;if(a>=0&&a<w&&b>=0&&b<h)grown[b*w+a]=1;}
 const boxes=[],seen=new Uint8Array(w*h);
 for(let p=0;p<w*h;p++){if(!grown[p]||seen[p])continue;const q=[p];seen[p]=1;let left=w,right=-1,top=h,bottom=-1,n=0;
  for(let k=0;k<q.length;k++){const i=q[k],x=i%w,y=Math.floor(i/w);if(seed[i]){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);n++;}
   for(const[a,b]of[[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){const j=b*w+a;if(a>=0&&a<w&&b>=0&&b<h&&!seen[j]&&grown[j]){seen[j]=1;q.push(j);}}}
  if(n>=12&&(right-left+1)*(bottom-top+1)<w*h*.35)boxes.push({left:Math.max(0,left-2),top:Math.max(0,top-2),right:Math.min(w-1,right+2),bottom:Math.min(h-1,bottom+2),n});
 }
 return Promise.all(boxes.sort((a,b)=>b.n-a.n).slice(0,4).map(async b=>{const left=Math.floor(b.left*metadata.width/w),top=Math.floor(b.top*metadata.height/h),right=Math.min(metadata.width,Math.ceil((b.right+1)*metadata.width/w)),bottom=Math.min(metadata.height,Math.ceil((b.bottom+1)*metadata.height/h));return{box:{left,top,width:right-left,height:bottom-top},png:await sharp(source).extract({left,top,width:right-left,height:bottom-top}).resize({width:600,height:600,fit:'inside'}).png().toBuffer()};}));
}
