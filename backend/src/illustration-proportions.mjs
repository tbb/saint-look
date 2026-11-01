import sharp from 'sharp';

// A conservative measurement for an unfolded, upright short-sleeve front.
// This is not a size estimate: it records a dimensionless visible body ratio.
// Folded/hooded/layered views need semantic landmarks, not a bounding-box guess.
export async function measureTopProportions(bytes, features) {
  if(!['t_shirt','polo','Футболка','Поло'].includes(features?.type)
    || features?.traits?.sleeves!=='short') return null;
  const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let left=info.width,right=-1,top=info.height,bottom=-1;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>=224){
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
  if(right<left||bottom-top<40)return null;
  const centre=Math.round((left+right)/2),height=bottom-top+1,widths=[];
  for(let y=Math.ceil(top+height*.55);y<top+height*.85;y++){
    if(data[(y*info.width+centre)*4+3]<224)continue;
    let l=centre,r=centre;
    while(l>0&&data[(y*info.width+l-1)*4+3]>=224)l--;
    while(r<info.width-1&&data[(y*info.width+r+1)*4+3]>=224)r++;
    widths.push(r-l+1);
  }
  if(widths.length<height*.2)return null;
  widths.sort((a,b)=>a-b);
  const median=widths[Math.floor(widths.length/2)],low=widths[Math.floor(widths.length*.1)],high=widths[Math.floor(widths.length*.9)];
  if((high-low)/median>.15)return null;
  return {bodyWidthToLength:Number((median/height).toFixed(3)),bodyWidth:median,visibleLength:height};
}

export async function compareTopProportions(reference, result, features) {
  const source=await measureTopProportions(reference,features), actual=await measureTopProportions(result,features);
  if(!source || !actual)return {measurable:false,reason:'ambiguous-body-outline'};
  const relativeError=Math.abs(actual.bodyWidthToLength/source.bodyWidthToLength-1);
  return {measurable:true,valid:relativeError<=0.12,sourceRatio:source.bodyWidthToLength,
    resultRatio:actual.bodyWidthToLength,relativeError};
}
