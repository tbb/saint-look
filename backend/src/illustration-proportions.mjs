import sharp from 'sharp';
import {garmentLayout} from './illustration-layout.mjs';

// A conservative dimensionless ratio for a visible, upright torso. A stable
// lower-body outline is required; hooded items also need a shoulder transition.
// Ambiguous, folded or layered outlines return no measurement, not a size guess.
export async function measureTopProportions(bytes, features) {
  const {group}=garmentLayout(features);
  if(!['shortUpper','sleeveless','upper','hooded'].includes(group)) return null;
  const hooded=group==='hooded';
  const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let left=info.width,right=-1,top=info.height,bottom=-1;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>=224){
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
  if(right<left||bottom-top<40)return null;
  const centre=Math.round((left+right)/2);
  // Sleeves may end below the hem after unfolding. Only the central torso
  // contributes to body length; cuff position must not change its proportions.
  const stripLeft=Math.round(left+(right-left)*.35),stripRight=Math.round(left+(right-left)*.65);
  let hem=-1;
  for(let y=top;y<=bottom;y++){
    let opaque=0;
    for(let x=stripLeft;x<=stripRight;x++)if(data[(y*info.width+x)*4+3]>=224)opaque++;
    if(opaque>=(stripRight-stripLeft+1)*.5)hem=y;
  }
  if(hem-top<40)return null;
  bottom=hem;
  const height=bottom-top+1,widths=[];
  for(let y=Math.ceil(top+height*(hooded?.75:.55));y<top+height*(hooded?.9:.85);y++){
    if(data[(y*info.width+centre)*4+3]<224)continue;
    let l=centre,r=centre;
    while(l>0&&data[(y*info.width+l-1)*4+3]>=224)l--;
    while(r<info.width-1&&data[(y*info.width+r+1)*4+3]>=224)r++;
    widths.push(r-l+1);
  }
  if(widths.length<height*(hooded?.1:.2))return null;
  widths.sort((a,b)=>a-b);
  const median=widths[Math.floor(widths.length/2)],low=widths[Math.floor(widths.length*.1)],high=widths[Math.floor(widths.length*(hooded?.7:.9))];
  // Wide upper outliers can be sleeve attachments. The lower 70% of the
  // hoodie band still spans at least 10% of its height and must be stable.
  if((high-low)/median>.15)return null;
  let bodyTop=top;
  if(hooded){
    // The hood above the neckline changes height when raised. Its crown must
    // not be counted as torso length or compensated by narrowing the body.
    bodyTop=-1;
    const shoulderXs=[Math.round(centre-median*.475),Math.round(centre+median*.475)];
    for(let y=top;y<top+height*.5;y++){
      // Shoulder height is independent of a transparent collar opening.
      // Observe both body edges; the centre can be empty down to a deep V.
      if(!shoulderXs.every(x=>data[(y*info.width+x)*4+3]>=224))continue;
      let supported=0;
      for(let x=shoulderXs[0];x<=shoulderXs[1];x++)if(data[(y*info.width+x)*4+3]>=224)supported++;
      // A thin, open hood rim can reach both probes before the shoulders.
      if(supported>=median*.5){bodyTop=y;break;}
    }
    if(bodyTop<top+height*.03||bodyTop>top+height*.45)return null;
  }
  const length=bottom-bodyTop+1;
  return {bodyWidthToLength:Number((median/length).toFixed(3)),bodyWidth:median,visibleLength:length,
    lengthReference:hooded?'shoulder-to-hem, excluding hood':'shoulder-to-hem',bodyTop};
}

export async function compareTopProportions(reference, result, features) {
  const source=await measureTopProportions(reference,features), actual=await measureTopProportions(result,features);
  if(!source)return {measurable:false,reason:'ambiguous-source-outline'};
  if(!actual)return {measurable:true,valid:false,sourceRatio:source.bodyWidthToLength,resultRatio:null,reason:'ambiguous-result-outline'};
  const relativeError=Math.abs(actual.bodyWidthToLength/source.bodyWidthToLength-1);
  return {measurable:true,valid:relativeError<=0.08,sourceRatio:source.bodyWidthToLength,
    resultRatio:actual.bodyWidthToLength,relativeError};
}
