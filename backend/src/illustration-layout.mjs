import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { ProviderError } from './providers.mjs';

const taxonomy = JSON.parse(readFileSync(new URL('../../shared/wardrobe-taxonomy.json', import.meta.url)));
export const layoutVersion = 'fitting-anchors-1024-v3';
export const templateVersion = 'category-front-anchors-v3';
// Coordinates are in the existing 360×560 mannequin frame, letterboxed into
// a 560×560 square. The client draws this same frame without independently
// cropping/scaling a garment. Bounds include ease; they are validation envelopes,
// never masks used to cut off parts of a garment. A single uniform scale and
// translation register the full segmented canvas to the garment-only template.
const layouts = {
  upper: { bounds: [82, 120, 196, 210], path: 'M164 130 Q180 145 196 130 L225 148 L245 181 L264 300 L247 307 L216 206 L220 297 L139 297 L143 206 L113 307 L94 300 L116 181 L135 147 Z', anchors: { neck: [180, 132], leftShoulder: [135, 147], rightShoulder: [225, 148], waist: [180, 264], leftWrist: [103, 306], rightWrist: [257, 306] } },
  shortUpper: { bounds: [95, 120, 170, 210], path: 'M164 130 Q180 145 196 130 L225 148 L244 181 L251 212 L228 220 L216 206 L220 297 L139 297 L143 206 L132 220 L109 212 L116 181 L135 147 Z', anchors: { neck: [180, 132], leftShoulder: [135, 147], rightShoulder: [225, 148], waist: [180, 264] } },
  sleeveless: { bounds: [122, 120, 116, 210], path: 'M155 137 Q180 158 205 137 L225 148 L216 206 L220 297 L139 297 L143 206 L135 147 Z', anchors: { leftShoulder: [145, 142], rightShoulder: [215, 142], waist: [180, 264] } },
  trousers: { bounds: [122, 248, 116, 260], path: 'M139 264 L220 264 L225 316 L216 494 L195 497 L183 330 L178 330 L164 497 L145 494 L135 316 Z', anchors: { leftWaist: [139, 264], rightWaist: [220, 264], crotch: [180, 330], leftAnkle: [155, 494], rightAnkle: [205, 494] }, legs: true },
  shorts: { bounds: [122, 248, 116, 135], path: 'M139 264 L220 264 L225 316 L220 360 L190 360 L183 325 L178 325 L170 360 L139 360 L135 316 Z', anchors: { leftWaist: [139, 264], rightWaist: [220, 264], crotch: [180, 325] } },
  skirt: { bounds: [108, 248, 144, 260], path: 'M139 264 L220 264 L242 475 Q180 492 118 475 Z', anchors: { leftWaist: [139, 264], rightWaist: [220, 264], centreHem: [180, 480] } },
  full: { bounds: [80, 120, 200, 390], path: 'M164 130 Q180 145 196 130 L225 148 L245 181 L264 300 L247 307 L216 206 L220 264 L240 480 Q180 498 120 480 L139 264 L143 206 L113 307 L94 300 L116 181 L135 147 Z', anchors: { leftShoulder: [135, 147], rightShoulder: [225, 148], waist: [180, 264], ankles: [180, 494] } },
  shoes: { bounds: [128, 440, 104, 85], path: 'M146 486 Q155 480 164 486 L173 505 Q175 517 155 517 Q135 517 137 505 Z M196 486 Q205 480 214 486 L223 505 Q225 517 205 517 Q185 517 187 505 Z', anchors: { leftAnkle: [155, 494], rightAnkle: [205, 494] } },
  head: { bounds: [135, 25, 90, 110], path: 'M154 76 Q150 40 180 40 Q210 40 206 76 L218 83 L142 83 Z', anchors: { crown: [180, 44], forehead: [180, 76] } },
  scarf: { bounds: [125, 120, 110, 195], path: 'M156 130 Q180 147 204 130 L210 158 L202 290 L183 290 L184 164 L154 155 Z', anchors: { neck: [180, 132], chest: [180, 175] } },
  belt: { bounds: [125, 248, 110, 40], path: 'M137 260 L222 260 L222 279 L137 279 Z', anchors: { leftWaist: [139, 264], rightWaist: [220, 264] } },
  gloves: { bounds: [80, 270, 200, 65], path: 'M95 288 L112 293 L110 325 L94 325 Z M248 293 L265 288 L267 325 L250 325 Z', anchors: { leftWrist: [103, 306], rightWrist: [257, 306] } },
  socks: { bounds: [130, 380, 100, 140], path: 'M146 402 L165 402 L166 506 L136 510 L145 490 Z M195 402 L215 402 L215 490 L225 510 L196 506 Z', anchors: { leftAnkle: [155, 494], rightAnkle: [205, 494] } },
  bag: { bounds: [210, 160, 110, 200], path: 'M245 215 L245 190 Q263 163 282 190 L282 215 M230 214 L300 214 L304 320 L226 320 Z', anchors: { handle: [263, 180], bagCentre: [265, 270] } },
};
layouts.hooded = { ...layouts.upper, bounds: [82, 90, 196, 240],
  path: 'M157 132 Q146 106 163 96 Q180 88 197 96 Q214 106 203 132 L225 148 L245 181 L264 300 L247 307 L216 206 L220 297 L139 297 L143 206 L113 307 L94 300 L116 181 L135 147 Z',
  anchors: { ...layouts.upper.anchors, hoodTop: [180, 94] } };
const groups = {
  t_shirt: 'shortUpper', polo: 'shortUpper', shirt: 'upper', blouse: 'upper', top: 'sleeveless', sweater: 'upper',
  cardigan: 'upper', sweatshirt: 'upper', hoodie: 'hooded', vest: 'sleeveless', blazer: 'upper', jacket: 'upper',
  coat: 'full', raincoat: 'full', jeans: 'trousers', trousers: 'trousers', shorts: 'shorts', skirt: 'skirt',
  dress: 'full', jumpsuit: 'full', sneakers: 'shoes', shoes: 'shoes', boots: 'shoes', sandals: 'shoes', slippers: 'shoes',
  bag: 'bag', headwear: 'head', scarf: 'scarf', belt: 'belt', gloves: 'gloves', socks: 'socks', underwear: 'shorts', swimwear: 'full',
};

export function garmentLayout(features) {
  const type = taxonomy.types.find(type => type.label === features?.type || type.id === features?.type)?.id;
  let group = groups[type];
  if (group === 'shortUpper' && features?.traits?.sleeves === 'long') group = 'upper';
  if (['shirt', 'blouse'].includes(type) && features?.traits?.sleeves === 'short') group = 'shortUpper';
  if (!group) throw new ProviderError('illustration_type_unsupported');
  if (group === 'upper' && features?.traits?.hood === 'yes') group = 'hooded';
  const layout={ type, group, ...layouts[group] };
  if(features?.traits?.body_length==='long' && ['shortUpper','sleeveless','upper','hooded'].includes(group)) {
    // Length is part of the garment design. Extend only the guide's torso;
    // shoulder/sleeve coordinates still belong to the same wearer.
    layout.path=layout.path.replace('L220 297 L139 297','L220 340 L139 340');
    layout.bounds=[...layout.bounds]; layout.bounds[3]=365-layout.bounds[1];
  }
  return layout;
}

const point = ([x, y]) => [Math.round((x + 100) * 1024 / 560), Math.round(y * 1024 / 560)];
function guideSVG(features, background = true) {
  const layout = garmentLayout(features);
  // A garment-only placeholder avoids asking the image model to copy a body.
  // No background/body/pose from the user's photograph is a placement reference.
  const footwearProjection=layout.group==='shoes'
    ? '<path d="M137 507 Q155 514 173 507 M187 507 Q205 514 223 507 M138 511 Q155 518 172 511 M188 511 Q205 518 222 511 M147 488 Q155 491 163 488 M197 488 Q205 491 213 488 M147 493 H163 M146 496 H164 M197 493 H213 M196 496 H214" fill="none" stroke="#555" stroke-width="1"/>' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-100 0 560 560">${background ? '<rect x="-100" width="560" height="560" fill="white"/>' : ''}<path d="${layout.path}" fill="#d5d5d5" stroke="#555" stroke-width="1"/>${footwearProjection}</svg>`;
}
export async function layoutGuide(features) {
  return sharp(Buffer.from(guideSVG(features))).png().toBuffer();
}

export async function layoutPoseGuide(features) {
  if(garmentLayout(features).group!=='shoes') return null;
  // Tiny footwear occupies only a few dozen pixels in the placement guide.
  // A second, enlarged guide conveys the front projection and relative stance;
  // the full-canvas guide remains last and controls final placement.
  return sharp(Buffer.from(guideSVG(features)))
    .extract({left:400,top:850,width:220,height:120}).resize(880,480)
    .extend({left:72,right:72,top:272,bottom:272,background:'white'}).png().toBuffer();
}

function inkBounds(data, width, height) {
  let left=width, top=height, right=-1, bottom=-1;
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    if (data[(y*width+x)*4+3] < 224) continue;
    left=Math.min(left,x); top=Math.min(top,y); right=Math.max(right,x); bottom=Math.max(bottom,y);
  }
  return right < left ? null : { left, top, width:right-left+1, height:bottom-top+1 };
}

function upperBody(data, width, height, bounds, layout, features) {
  if (!['shortUpper', 'sleeveless'].includes(layout.group) || features?.traits?.body_length === 'cropped' || !bounds) return null;
  // The central strip measures the hem independently of sleeves. The upper
  // edge comes from the whole silhouette: a deep neckline is not a low shoulder.
  const left = Math.round(bounds.left + bounds.width * 0.35), right = Math.round(bounds.left + bounds.width * 0.65);
  const top=bounds.top; let bottom=-1;
  for(let y=0;y<height;y++) {
    let count=0; for(let x=left;x<=right;x++) if(data[(y*width+x)*4+3]>=224) count++;
    if(count >= (right-left+1)*0.5) { bottom=y; }
  }
  return bottom>top ? { top, bottom } : null;
}

const minimumHemY=features=>point([180,features?.traits?.body_length==='long' ? 320 : 270])[1];

function upperBodyValid(body, layout, features) {
  if (!['shortUpper', 'sleeveless'].includes(layout.group) || features?.traits?.body_length === 'cropped') return true;
  // Regular tops overlap the waist; explicit cropped garments may expose it.
  return body && body.top <= point([180,155])[1] && body.top >= point([180,120])[1]
    && body.bottom >= minimumHemY(features)-3;
}

// Compare the two shoulder bands, away from the neckline. All supported
// templates share these shoulder edges; collar depth is deliberately excluded.
// Underlayers stay inside that edge; outer layers cover it. This is one vertical
// translation of the whole image, not a mask or a deformation of the shoulder.
function shoulderOffset(data, width, layout, features) {
  const traits=features?.traits;
  if (!['shortUpper','upper'].includes(layout.group) || !['round','collar'].includes(traits?.neckline)
    || traits?.body_length==='cropped' || traits?.dropped_shoulders==='yes') return null;
  const corrections=[];
  for(const [left,right] of [[430,450],[574,594]]) for(let x=left;x<=right;x++) {
    let observed=-1;
    for(let y=0;y<400;y++) {
      let count=0;
      for(let dx=-1;dx<=1;dx++) if(data[(y*width+x+dx)*4+3]>=224) count++;
      if(count>=2) {observed=y;break;}
    }
    if(observed<0) return NaN;
    const localX=x*560/1024-100;
    const localY=x<512 ? 147-(localX-135)*17/29 : 130+(localX-196)*18/29;
    corrections.push(Math.floor(localY*1024/560)-observed);
  }
  return ['jacket','blazer','cardigan'].includes(layout.type) ? Math.min(...corrections) : Math.max(...corrections);
}

function cuffExtents(data, width, layout, features) {
  if(!['upper','hooded'].includes(layout.group) || features?.traits?.sleeves!=='long') return [];
  return [[333,420],[604,691]].map(([left,right])=>{
    let bottom=-1;
    for(let y=400;y<650;y++) {
      let count=0; for(let x=left;x<=right;x++) if(data[(y*width+x)*4+3]>=224) count++;
      if(count>=5) bottom=y;
    }
    return bottom;
  });
}
const minimumCuffY=point([180,306])[1]-25;

function feetValid(data, width, layout) {
  if(layout.group!=='shoes') return true;
  const sides=[{count:0,x:0},{count:0,x:0}];
  for(let y=0;y<1024;y++) for(let x=0;x<width;x++) if(data[(y*width+x)*4+3]>=224) {
    const side=sides[x<width/2 ? 0 : 1]; side.count++;side.x+=x;
  }
  return sides.every((side,index)=>side.count>64
    && Math.abs(side.x/side.count-point(index===0 ? layout.anchors.leftAnkle : layout.anchors.rightAnkle)[0])<=24);
}

function separatedLegs(data, width, bounds) {
  if (!bounds) return false;
  const middle=Math.round(bounds.left+bounds.width/2);
  return [0.65,0.8,0.9].every(fraction => {
    const y=Math.round(bounds.top+bounds.height*fraction);
    let left=0, right=0, gap=0;
    for (let x=bounds.left; x<bounds.left+bounds.width; x++) {
      const alpha=data[(y*width+x)*4+3];
      if (alpha>=224) { if(x<middle) left++; else right++; }
      if (Math.abs(x-middle)<bounds.width*0.1 && alpha<128) gap++;
    }
    return left>bounds.width*0.08 && right>bounds.width*0.08 && gap>bounds.width*0.015;
  });
}

async function transformCanvas(bytes,size,offsetX,offsetY) {
  const left=Math.max(0,offsetX), top=Math.max(0,offsetY);
  const sourceLeft=Math.max(0,-offsetX), sourceTop=Math.max(0,-offsetY);
  const width=Math.min(size-sourceLeft,1024-left), height=Math.min(size-sourceTop,1024-top);
  if(width<=0 || height<=0) throw new ProviderError('illustration_geometry_invalid');
  const resized=size===1024 ? bytes : await sharp(bytes).resize(size,size).png().toBuffer();
  const pixels=await sharp(resized).ensureAlpha().raw().toBuffer();
  if (sourceLeft || sourceTop || width<size || height<size) {
    for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
      if((x<sourceLeft || x>=sourceLeft+width || y<sourceTop || y>=sourceTop+height)
        && pixels[(y*size+x)*4+3]!==0) throw new ProviderError('illustration_geometry_invalid');
    }
  }
  // Copy RGBA rows directly. Compositing a translucent pixel onto transparent
  // black can round its RGB values; a pure translation must preserve them.
  const canvas=Buffer.alloc(1024*1024*4);
  for(let y=0;y<height;y++) {
    const begin=((sourceTop+y)*size+sourceLeft)*4;
    pixels.copy(canvas,((top+y)*1024+left)*4,begin,begin+width*4);
  }
  return sharp(canvas,{raw:{width:1024,height:1024,channels:4}}).png().toBuffer();
}

export async function registerGarmentLayout(bytes, features) {
  const layout=garmentLayout(features);
  const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if(info.width!==1024 || info.height!==1024) throw new ProviderError('illustration_geometry_invalid');
  const source=inkBounds(data,info.width,info.height);
  if(!source || source.width<8 || source.height<8 || (layout.legs && !separatedLegs(data,info.width,source))) {
    throw new ProviderError('illustration_geometry_invalid');
  }
  const existing=await checkGarmentLayout(bytes,features);
  if(existing.valid) return bytes;
  const shift=shoulderOffset(data,info.width,layout,features);
  if(existing.baseValid && Number.isFinite(shift) && Math.abs(shift)<=24) {
    const translated=await transformCanvas(bytes,1024,0,shift);
    if((await checkGarmentLayout(translated,features)).valid) return translated;
  }
  const guide=await sharp(Buffer.from(guideSVG(features,false))).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const target=inkBounds(guide.data,guide.info.width,guide.info.height);
  const body=upperBody(data,info.width,info.height,source,layout,features);
  const neckY=point([180,132])[1], hemY=minimumHemY(features);
  const minimumBodyScale=body ? (hemY-neckY)/(body.bottom-body.top) : 0;
  const scale=layout.legs ? target.height/source.height : Math.max(minimumBodyScale,Math.min(target.width/source.width,target.height/source.height));
  // One global similarity transform, never independent x/y stretch or per-leg warp.
  let size=Math.round(1024*scale);
  if(size<64 || size>2048) throw new ProviderError('illustration_geometry_invalid');
  const actualScale=size/1024;
  let offsetX=Math.round(target.left+target.width/2-(source.left+source.width/2)*actualScale);
  let offsetY=Math.round(body ? neckY-body.top*actualScale : target.top-source.top*actualScale);
  // Shoulder alignment can expose a previously hidden short hem/cuff. Resolve
  // those coupled extents with bounded uniform fits, always resampling the original.
  // These are local image operations, never additional provider requests.
  const pivotY=point([180,147])[1];
  for(let attempt=0;attempt<4;attempt++) {
    if(size<64 || size>2048) break;
    let result=await transformCanvas(bytes,size,offsetX,offsetY);
    let pixels=await sharp(result).ensureAlpha().raw().toBuffer();
    const adjustment=shoulderOffset(pixels,1024,layout,features);
    if(adjustment!==null) {
      if(!Number.isFinite(adjustment) || Math.abs(adjustment)>24) break;
      if(Math.abs(adjustment)>1) {
        offsetY+=adjustment;
        result=await transformCanvas(result,1024,0,adjustment);
        pixels=await sharp(result).ensureAlpha().raw().toBuffer();
      }
    }
    if((await checkGarmentLayout(result,features)).valid) return result;
    const measuredBody=upperBody(pixels,1024,1024,inkBounds(pixels,1024,1024),layout,features);
    const extents=[...cuffExtents(pixels,1024,layout,features).map(observed=>[observed,minimumCuffY]),
      ...(measuredBody ? [[measuredBody.bottom,hemY]] : [])];
    if(extents.some(([observed])=>observed<=pivotY)) break;
    const required=Math.max(1,...extents.map(([observed,wanted])=>(wanted-pivotY)/(observed-pivotY)));
    if(required<=1 || required>1.35) break;
    const nextSize=Math.ceil(size*(required+0.005)), factor=nextSize/size;
    offsetX=Math.round(512-(512-offsetX)*factor);
    offsetY=Math.round(pivotY-(pivotY-offsetY)*factor);
    size=nextSize;
  }
  throw new ProviderError('illustration_geometry_invalid');
}

export function layoutInstructions(features) {
  const layout = garmentLayout(features);
  const anchors = Object.fromEntries(Object.entries(layout.anchors).map(([name, value]) => [name, point(value)]));
  const [x,y,w,h] = layout.bounds, [left,top] = point([x,y]), [right,bottom] = point([x+w,y+h]);
  const footwearRule=layout.group==='shoes' ? ' FOOTWEAR: use the enlarged grey footwear pose guide for the front projection and relative spacing, and the LAST full-canvas guide for placement. Show TWO separate shoes in the standing pose of the template, with their ankle openings aligned to (466,903) and (558,903). Their centres must remain about 92 pixels apart, with a visible white gap; each shoe is roughly 50 to 65 pixels wide. Use an orthographic FRONT elevation at ankle height, not overhead, top-down or flat-lay product photography. The front toe walls and soles are visible; do not expose long insoles or an elongated top view. Both face forward with a slight outward angle. Do not keep the close, overlapping arrangement of the source photo, and do not place the pair together under the body centre. No feet, legs, socks or trousers inside the shoes.' : '';
  const torsoRule = ['shortUpper', 'sleeveless', 'upper', 'hooded'].includes(layout.group)
    ? ` Fit the torso to the SAME wearer: the neckline is near (512,241), shoulders near (430,269) and (594,269), waist y=483. ${features?.traits?.body_length === 'cropped' ? 'This is deliberately cropped: preserve its short hem.' : features?.traits?.body_length === 'long' ? 'This is an elongated torso: preserve its extra length and torso-to-sleeve proportions, with the hem around y=585 to 625. It may extend below an ordinary hoodie or jacket; do not shorten or tuck it to match another layer.' : ['jacket','blazer','cardigan'].includes(layout.type) ? 'Preserve its torso-to-sleeve proportions and jacket length; a hip-length hem may reach y=540 to 590.' : 'The torso hem must overlap the waist, normally y=510 to 545; do not make a regular top look cropped.'} Sleeves follow the template arm directions, not a flat-lay T pose. ${features?.traits?.sleeves === 'long' ? 'Long sleeves reach the wrist anchors near y=560; unfold the source arm pose instead of turning them into short or three-quarter sleeves.' : ''} ${layout.group === 'hooded' ? 'The hood is behind the neckline; its crown may extend up to y=172, while the shoulder seams remain at y=269. Do not align the hood crown to the neckline or add a head inside it.' : ''}` : '';
  return `Edit the LAST image: it is the placement template for a ${layout.type}, on an EXACT 1024 by 1024 canvas. Replace ONLY its grey garment placeholder with a faithful editorial illustration of the referenced garment. Keep the template's small size, position and front-facing pose inside the full canvas. Most of the canvas MUST remain plain white. DO NOT zoom, crop, enlarge to fill the square, copy the photo's pose, or draw any human/mannequin body. Coordinates in output pixels, origin top-left: anchors ${JSON.stringify(anchors)}; garment must remain within [left=${left}, top=${top}, right=${right}, bottom=${bottom}]. The anchors describe the same invisible mannequin for every item.${torsoRule}${footwearRule} Preserve the garment DESIGN: construction, colours, actual sleeve and body length, and print placement. Reconstruct its unfolded front as if worn by this invisible mannequin. Incidental wrinkles, crumpling, folded sleeve openings, tilted collars, camera perspective and hems made uneven only by folds are NOT design features: straighten them. Preserve intentional asymmetric construction and designed hem shapes. ${['shortUpper','sleeveless','upper','hooded','full'].includes(layout.group) ? 'Shoulders must be level and symmetrical, neckline centred, torso vertical, and both sleeves unfolded along the template arms.' : ''} Use restrained flat editorial shading; do not trace or emphasize the source photo's random folds. The grey template defines the wearer pose, not a replacement garment design. White outside the item, inside necklines/openings and between separated limbs; no body, head, skin, stand, extra clothing, labels, guide lines or cast shadow.${layout.legs ? ' TROUSERS: front waistband horizontal at the two waist anchors, crotch centred at the crotch anchor, two distinct uncrossed untwisted leg tubes towards the left and right ankle anchors. Straighten the pose even if the source is twisted or folded. Preserve front pockets and seams on their correct sides. Do not draw the torso above the waistband, shoes below the hems, or join/cross the two legs.' : ''}`;
}

export async function checkGarmentLayout(bytes, features) {
  const layout = garmentLayout(features);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 1024 || info.height !== 1024) return { valid: false, reason: 'canvas' };
  const [x,y,w,h] = layout.bounds, [left,top] = point([x,y]), [right,bottom] = point([x+w,y+h]);
  let solid = 0, outside = 0;
  for (let py=0; py<info.height; py++) for (let px=0; px<info.width; px++) {
    // Ignore antialiasing and translucent sandbox watermarks. They remain in
    // the image; validation never removes watermark pixels or deforms clothing.
    if (data[(py*info.width+px)*4+3] < 224) continue;
    solid++;
    if (px<left || px>right || py<top || py>bottom) outside++;
  }
  const outsideFraction = solid ? outside/solid : 1;
  const coverage = solid / ((right-left)*(bottom-top));
  const ink = inkBounds(data,info.width,info.height);
  const legsValid = !layout.legs || separatedLegs(data,info.width,ink);
  // Full-length trousers must reach both waist and ankles. Containment alone
  // would silently turn a wide silhouette into cropped trousers.
  const body=upperBody(data,info.width,info.height,ink,layout,features);
  const anchorsValid = upperBodyValid(body,layout,features) && (!layout.legs || (ink && Math.abs(ink.top-point(layout.anchors.leftWaist)[1])<=24
    && Math.abs(ink.top+ink.height-1-point(layout.anchors.leftAnkle)[1])<=28));
  const footAnchorsValid=feetValid(data,info.width,layout);
  const baseValid=solid > 256 && outsideFraction <= 0.04 && coverage >= 0.08 && legsValid && anchorsValid && footAnchorsValid;
  const shift=shoulderOffset(data,info.width,layout,features);
  const shouldersValid=shift===null || (Number.isFinite(shift) && Math.abs(shift)<=1);
  const cuffsValid=cuffExtents(data,info.width,layout,features).every(y=>y>=minimumCuffY);
  return { valid: baseValid && shouldersValid && cuffsValid, baseValid, shouldersValid, cuffsValid,
    outsideFraction, coverage, legsValid, anchorsValid, footAnchorsValid, bounds: { left,top,right,bottom } };
}
