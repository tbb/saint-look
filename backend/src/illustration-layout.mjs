import {minimumDisplayTorsoWidth} from './illustration-display.mjs';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { ProviderError } from './providers.mjs';

const taxonomy = JSON.parse(readFileSync(new URL('../../shared/wardrobe-taxonomy.json', import.meta.url)));
export const layoutVersion = 'fitting-anchors-1024-v6';
export const templateVersion = 'category-front-anchors-v6';
// Coordinates are in the existing 360×560 mannequin frame, letterboxed into
// a 560×560 square. The client draws this same frame without independently
// cropping/scaling a garment. Bounds include ease; they are validation envelopes,
// never masks used to cut off parts of a garment. A single uniform scale and
// translation register the full segmented canvas to the garment-only template.
const layouts = {
  upper: { bounds: [82, 120, 196, 210], path: 'M164 130 Q180 145 196 130 L225 148 L245 181 L264 300 L247 307 L216 206 L220 297 L139 297 L143 206 L113 307 L94 300 L116 181 L135 147 Z', anchors: { neck: [180, 132], leftShoulder: [135, 147], rightShoulder: [225, 148], waist: [180, 264], leftWrist: [103, 306], rightWrist: [257, 306] } },
  shortUpper: { bounds: [95, 120, 170, 210], path: 'M164 130 Q180 145 196 130 L225 148 L244 181 L251 212 L228 220 L216 206 L220 297 L139 297 L143 206 L132 220 L109 212 L116 181 L135 147 Z', anchors: { neck: [180, 132], leftShoulder: [135, 147], rightShoulder: [225, 148], waist: [180, 264] } },
  sleeveless: { bounds: [122, 120, 116, 210], path: 'M155 137 Q180 158 205 137 L225 148 L216 206 L220 297 L139 297 L143 206 L135 147 Z', anchors: { leftShoulder: [145, 142], rightShoulder: [215, 142], waist: [180, 264] } },
  trousers: { bounds: [100, 248, 160, 260], path: 'M139 264 L220 264 L225 316 L216 494 L195 497 L183 330 L178 330 L164 497 L145 494 L135 316 Z', anchors: { leftWaist: [139, 264], rightWaist: [220, 264], crotch: [180, 330], leftAnkle: [155, 494], rightAnkle: [205, 494] }, legs: true },
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
layouts.hooded = { ...layouts.upper, bounds: [65, 90, 230, 240],
  path: 'M157 132 Q146 106 163 96 Q180 88 197 96 Q214 106 203 132 L225 148 L245 181 L264 300 L247 307 L216 206 L220 297 L139 297 L143 206 L113 307 L94 300 L116 181 L135 147 Z',
  anchors: { ...layouts.upper.anchors, hoodTop: [180, 94] } };
// Finite shared arm poses preserve shoulder origins and bone lengths.
// The default rotates the legacy arms 13 degrees (~24 degrees from vertical).
// Rotate sleeves and gloves as well as wrist anchors. Join the rotated armhole
// back to the unchanged torso, so guides remain one connected garment.
export const fittingArmPoses=Object.freeze({relaxed:0,open:13,spread:34});
export function armPoint([x,y],side,pose='open') {
  const [cx,cy]=side==='left'?[135,147]:[225,148];
  const angle=(side==='left'?1:-1)*fittingArmPoses[pose]*Math.PI/180;
  return [cx+(x-cx)*Math.cos(angle)-(y-cy)*Math.sin(angle),
    cy+(x-cx)*Math.sin(angle)+(y-cy)*Math.cos(angle)].map(n=>Math.round(n*100)/100);
}
function posedLayouts(pose) {
const layouts=structuredClone(baseLayouts);
const armLines=(points,side)=>points.map(p=>'L'+armPoint(p,side,pose).join(' ')).join(' ');
for (const group of ['upper','hooded','full']) {
  const layout=layouts[group];
  layout.path=layout.path.replace('L245 181 L264 300 L247 307 L216 206',
    armLines([[255,174],[272,306],[240,316],[214,206]],'right')+' L216 206')
    .replace('L113 307 L94 300 L116 181',
      armLines([[146,206],[120,316],[88,306],[105,174]],'left'));
  layout.bounds=[pose==='spread'?0:45,layout.bounds[1],pose==='spread'?360:270,layout.bounds[3]];
  layout.anchors={...layout.anchors,leftWrist:armPoint([103,306],'left',pose),rightWrist:armPoint([257,306],'right',pose)};
}
layouts.shortUpper.path=layouts.shortUpper.path
  .replace('L244 181 L251 212 L228 220 L216 206',armLines([[244,181],[251,212],[228,220],[216,206]],'right')+' L216 206')
  .replace('L132 220 L109 212 L116 181',armLines([[143,206],[132,220],[109,212],[116,181]],'left'));
layouts.shortUpper.bounds=[pose==='spread'?45:75,120,pose==='spread'?270:210,210];
const glovePoints=[...[[95,288],[112,293],[110,325],[94,325]].map(p=>armPoint(p,'left',pose)),
  ...[[248,293],[265,288],[267,325],[250,325]].map(p=>armPoint(p,'right',pose))];
const gloveX=glovePoints.map(p=>p[0]),gloveY=glovePoints.map(p=>p[1]);
layouts.gloves={bounds:[Math.min(...gloveX)-5,Math.min(...gloveY)-5,Math.max(...gloveX)-Math.min(...gloveX)+10,Math.max(...gloveY)-Math.min(...gloveY)+10],
  path: ['left','right'].map((side,i)=>{
    const points=i===0?[[95,288],[112,293],[110,325],[94,325]]:[[248,293],[265,288],[267,325],[250,325]];
    return 'M'+armPoint(points[0],side,pose).join(' ')+armLines(points.slice(1),side)+' Z';
  }).join(' '),anchors:{leftWrist:armPoint([103,306],'left',pose),rightWrist:armPoint([257,306],'right',pose)}};
return layouts;
}
const baseLayouts=layouts;
const poseLayouts=Object.fromEntries(Object.keys(fittingArmPoses).map(pose=>[pose,posedLayouts(pose)]));
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
  const armPose=Object.hasOwn(fittingArmPoses,features?._armPose)?features._armPose:'open';
  const layout={ type, group, ...poseLayouts[armPose][group],armPose };
  // Ease belongs to the garment, not the wearer's waist. The old template
  // silently gave a relaxed tee exactly the same narrow torso as a fitted top.
  // Move torso side seams only; keep neck, arm direction and hem independent.
  if (['shortUpper','sleeveless','upper','hooded'].includes(group)
    && features?.traits?.silhouette === 'relaxed') {
    layout.path = layout.path.replaceAll('L216 206', 'L232 206')
      .replaceAll('L220 297 L139 297', 'L236 297 L123 297')
      .replaceAll('L143 206', 'L127 206');
  }
  if(['shortUpper','sleeveless','upper','hooded'].includes(group)
    && !['regular','cropped'].includes(features?.traits?.body_length)) {
    // Length is part of the garment design. Extend only the guide's torso;
    // shoulder/sleeve coordinates still belong to the same wearer.
    if(features?.traits?.body_length==='long') layout.path=layout.path.replace('L220 297 L139 297','L220 340 L139 340').replace('L236 297 L123 297','L236 340 L123 340');
    // Unknown is not regular: leave room for an observed long hem without
    // inventing a long design in the guide or shrinking it during registration.
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

const minimumHemY=features=>point([180,features?.traits?.body_length==='long' ? 320
  : features?.traits?.body_length==='regular' ? 270 : 132])[1];

function upperBodyValid(body, layout, features) {
  if (!['shortUpper', 'sleeveless'].includes(layout.group) || features?.traits?.body_length === 'cropped') return true;
  // Confirmed regular tops overlap the waist. Unknown length must preserve
  // the observed torso, including a cropped one; it is not regular by default.
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

function requiresWristPose(layout, features) {
  const sleeves = features?.traits?.sleeves;
  return sleeves === 'long' || (layout.type === 'hoodie'
    && !['short', 'sleeveless', 'not_applicable'].includes(sleeves));
}

// Locate each short sleeve's outer tip and its return to the torso side seam.
// The shared arm centreline must intersect that opening segment. Merely covering
// a shoulder allows a flat-lay sleeve to expose the arm through the underarm.
function shortSleeveOpenings(data,width,layout,features) {
  if(layout.group!=='shortUpper'||features?.traits?.sleeves!=='short')return true;
  const edge=(y,right)=>{
    for(let x=0;x<width/2;x++){
      const px=right?width-1-x:x;
      if(data[(y*width+px)*4+3]>=224)return x;
    }
    return null;
  };
  return [false,true].every(right=>{
    const body=[];
    for(let y=400;y<450;y++){const x=edge(y,right);if(x!==null)body.push(x);}
    if(body.length<20)return false;
    body.sort((a,b)=>a-b);const seam=body[Math.floor(body.length/2)];
    let tip=null;
    for(let y=260;y<400;y++){
      const x=edge(y,right);
      if(x!==null&&x<seam-12&&(!tip||x<tip.x))tip={x,y};
    }
    if(!tip)return false;
    let end=tip;
    for(let y=tip.y+1;y<Math.min(450,tip.y+120);y++){
      const x=edge(y,right);if(x===null)return false;
      if(x-end.x>12)break;
      end={x,y};if(x>=seam-4)break;
    }
    if(end.y-tip.y<6)return false;
    const shoulder=point(right?[225,148]:[135,147]);
    const wrist=point(armPoint(right?[257,306]:[103,306],right?'right':'left',layout.armPose));
    const sx=right?width-1-shoulder[0]:shoulder[0],sy=shoulder[1];
    const wx=right?width-1-wrist[0]:wrist[0],wy=wrist[1];
    const ax=wx-sx,ay=wy-sy,bx=end.x-tip.x,by=end.y-tip.y;
    const cross=ax*by-ay*bx;
    if(Math.abs(cross)<1)return false;
    const t=((tip.x-sx)*ay-(tip.y-sy)*ax)/cross;
    return t>=-.15&&t<=1.15;
  });
}

// Same native arm contour as FittingMannequin. Clip only the exposed hand and
// shoulder joint before rotation; garment pixels are never cropped or changed.
const armContour='M 135.0 147.0 C 130 156 119.838 163.974 117.312 182.868 L 107.758 224.958 Q 104.157 238.038 104.405 245.886 L 97.639 288.732 L 93.574 309.719 Q 92.282 319.661 99.225 322.045 Q 106.226 323.442 109.115 310.419 L 116.491 281.294 L 126.409 245.076 Q 130.663 232.926 133.015 216.997 L 140.798 180.953 Q 147.404 152.874 135.0 147.0 Z';
const armMasks=new Map();
async function coveredArmMask(pose) {
  if(!armMasks.has(pose)) {
    const angle=fittingArmPoses[pose];
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-100 0 560 560"><defs><clipPath id="sleeve"><rect x="0" y="164" width="360" height="128"/></clipPath></defs><g fill="white"><g transform="rotate(${angle} 135 147)"><path d="${armContour}" clip-path="url(#sleeve)"/></g><g transform="translate(360 1) scale(-1 1) rotate(${angle} 135 147)"><path d="${armContour}" clip-path="url(#sleeve)"/></g></g></svg>`;
    armMasks.set(pose,sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer());
  }
  return armMasks.get(pose);
}
async function armsContained(data,width,layout,features) {
  if(!['upper','hooded','full'].includes(layout.group)||!requiresWristPose(layout,features))return true;
  const mask=await coveredArmMask(layout.armPose);
  let total=0,uncovered=0;
  for(let y=0;y<1024;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4+3;
    if(mask[i]<224)continue;
    total++;
    if(data[i]<128){
      uncovered++;
      // An exposed 5×5 patch is visible even when it is a small global fraction.
      if(x>1&&y>1&&x<width-2&&y<1022){
        let exposed=true;
        for(let dy=-2;dy<=2&&exposed;dy++)for(let dx=-2;dx<=2;dx++){
          const j=((y+dy)*width+x+dx)*4+3;
          if(mask[j]<224||data[j]>=128){exposed=false;break;}
        }
        if(exposed)return false;
      }
    }
  }
  return total>0&&uncovered/total<=.02;
}

function cuffExtents(data, width, layout, features) {
  if(!['upper','hooded','full'].includes(layout.group) || !requiresWristPose(layout, features)) return [];
  return [layout.anchors.leftWrist,layout.anchors.rightWrist].map(anchor=>{
    const [cx]=point(anchor),left=cx-44,right=cx+44;
    let bottom=-1;
    for(let y=400;y<650;y++) {
      let count=0; for(let x=left;x<=right;x++) if(data[(y*width+x)*4+3]>=224) count++;
      if(count>=5) bottom=y;
    }
    return bottom;
  });
}
const minimumCuffY=layout=>Math.min(point(layout.anchors.leftWrist||[180,295])[1],point(layout.anchors.rightWrist||[180,295])[1])-8;

function wristsContactCuffs(data,width,layout,features) {
  if(!['upper','hooded','full'].includes(layout.group)||!requiresWristPose(layout,features))return true;
  return [layout.anchors.leftWrist,layout.anchors.rightWrist].every(anchor=>{
    const [cx,cy]=point(anchor);let terminalColumns=0;
    for(let x=cx-8;x<=cx+8;x++){
      let bottom=-1,contact=false;
      for(let y=400;y<650;y++)if(data[(y*width+x)*4+3]>=224){
        bottom=y;
        if(Math.abs(y-cy)<=12){
          // A broad torso can reach the wrist columns too. Only a separated
          // outer sleeve run may establish contact; never the central body.
          let edge=x;
          const inward=x<width/2?1:-1;
          while(edge!==width/2&&data[(y*width+edge)*4+3]>=224)edge+=inward;
          if(edge!==width/2){
            // An open zipper also splits the torso. The cuff must be in the
            // outermost substantial run, not an inner jacket panel.
            let outer=x;
            while(outer>=0&&outer<width&&data[(y*width+outer)*4+3]>=224)outer-=inward;
            let run=0,hasOuterRun=false;
            for(let scan=outer;scan>=0&&scan<width;scan-=inward){
              run=data[(y*width+scan)*4+3]>=224?run+1:0;
              if(run>=5){hasOuterRun=true;break;}
            }
            if(!hasOuterRun)contact=true;
          }
        }
      }
      if(contact&&bottom>=cy-8&&bottom<=cy+44)terminalColumns++;
    }
    return terminalColumns>=5;
  });
}

function unfoldedSleeves(data, width, layout, features) {
  if(!['upper','hooded','full'].includes(layout.group)||!requiresWristPose(layout,features)) return true;
  let separatedRows=0;
  for(let y=350;y<minimumCuffY(layout);y+=10){
    const runs=[];let start=-1,last=-1;
    for(let x=0;x<width;x++){
      if(data[(y*width+x)*4+3]>=224){if(start<0)start=x;last=x;}
      if(start>=0&&(x-last>=4||x===width-1)){
        if(last-start+1>=8)runs.push({left:start,right:last,centre:(start+last)/2});
        start=-1;
      }
    }
    const count=features?.traits?.body_length==='cropped'?2:3;
    if(runs.length>=count&&runs.some(r=>r.centre<430)&&runs.some(r=>r.centre>594))separatedRows++;
  }
  if(separatedRows<2)return false;
  // Extra detached sleeves are not an unfolded garment. They can otherwise
  // imitate both wrist bands and the whitespace required above.
  const seen=new Uint8Array(width*1024),queue=new Int32Array(width*1024);let total=0,largest=0;
  for(let p=0;p<seen.length;p++){
    if(seen[p]||data[p*4+3]<224)continue;
    let head=0,tail=1;queue[0]=p;seen[p]=1;
    while(head<tail){
      const i=queue[head++],x=i%width;
      for(const n of [x>0?i-1:-1,x<width-1?i+1:-1,i>=width?i-width:-1,i<seen.length-width?i+width:-1]){
        if(n>=0&&!seen[n]&&data[n*4+3]>=224){seen[n]=1;queue[tail++]=n;}
      }
    }
    total+=tail;largest=Math.max(largest,tail);
  }
  return total>0&&largest/total>=.95;
}

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

export async function registerGarmentLayout(bytes, features, torsoMeasurement) {
  const layout=garmentLayout(features);
  const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if(info.width!==1024 || info.height!==1024) throw new ProviderError('illustration_geometry_invalid');
  const source=inkBounds(data,info.width,info.height);
  if(!source || source.width<8 || source.height<8 || (layout.legs && !separatedLegs(data,info.width,source))) {
    throw new ProviderError('illustration_geometry_invalid');
  }
  const existing=await checkGarmentLayout(bytes,features);
  const torsoFloor=layout.group==='shortUpper' && torsoMeasurement
    ?minimumDisplayTorsoWidth(features)*1024/560:0;
  const minimumTorsoScale=torsoFloor && torsoMeasurement.bodyWidth>0?torsoFloor/torsoMeasurement.bodyWidth:0;
  if(existing.valid && minimumTorsoScale<=1) return bytes;
  const shift=shoulderOffset(data,info.width,layout,features);
  if(minimumTorsoScale<=1 && existing.baseValid && Number.isFinite(shift) && Math.abs(shift)<=24) {
    const translated=await transformCanvas(bytes,1024,0,shift);
    if((await checkGarmentLayout(translated,features)).valid) return translated;
  }
  const guide=await sharp(Buffer.from(guideSVG(features,false))).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const target=inkBounds(guide.data,guide.info.width,guide.info.height);
  const body=upperBody(data,info.width,info.height,source,layout,features);
  const neckY=point([180,132])[1], hemY=minimumHemY(features);
  const minimumBodyScale=body ? (hemY-neckY)/(body.bottom-body.top) : 0;
  const uncertainLength=['shortUpper','sleeveless','upper','hooded'].includes(layout.group)
    && !['regular','cropped','long'].includes(features?.traits?.body_length);
  const measuredTorso=layout.group==='hooded' && torsoMeasurement && ['regular','long'].includes(features?.traits?.body_length);
  const torsoTop=point([180,147])[1]; // hood measurement excludes hood and starts at shoulders
  const torsoHeight=point([180,features?.traits?.body_length==='long'?340:297])[1]-torsoTop;
  const scale=measuredTorso ? torsoHeight/torsoMeasurement.visibleLength : layout.legs ? target.height/source.height : Math.max(minimumBodyScale,minimumTorsoScale,
    uncertainLength ? target.width/source.width : Math.min(target.width/source.width,target.height/source.height));
  // One global similarity transform, never independent x/y stretch or per-leg warp.
  let size=Math.round(1024*scale);
  if(size<64 || size>2048) throw new ProviderError('illustration_geometry_invalid');
  const actualScale=size/1024;
  let offsetX=Math.round(target.left+target.width/2-(source.left+source.width/2)*actualScale);
  let offsetY=Math.round(measuredTorso ? torsoTop-torsoMeasurement.bodyTop*actualScale : body ? neckY-body.top*actualScale : target.top-source.top*actualScale);
  // Shoulder alignment can expose a previously hidden short hem/cuff. Resolve
  // those coupled extents with bounded uniform fits, always resampling the original.
  // These are local image operations, never additional provider requests.
  const pivotY=point([180,147])[1];
  let lastCheck=existing;
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
    lastCheck=await checkGarmentLayout(result,features);
    if(lastCheck.valid) return result;
    const measuredBody=upperBody(pixels,1024,1024,inkBounds(pixels,1024,1024),layout,features);
    const extents=[...cuffExtents(pixels,1024,layout,features).map(observed=>[observed,minimumCuffY(layout)]),
      ...(measuredBody ? [[measuredBody.bottom,hemY]] : [])];
    if(extents.some(([observed])=>observed<=pivotY)) break;
    const required=Math.max(1,...extents.map(([observed,wanted])=>(wanted-pivotY)/(observed-pivotY)));
    if(required<=1 || required>1.35) break;
    const nextSize=Math.ceil(size*(required+0.005)), factor=nextSize/size;
    offsetX=Math.round(512-(512-offsetX)*factor);
    offsetY=Math.round(pivotY-(pivotY-offsetY)*factor);
    size=nextSize;
  }
  const defects=Object.entries({sleevesUnfolded:'folded_sleeves',wristsValid:'wrist_alignment',
    armsContainedValid:'sleeve_opening',sleeveOpeningsValid:'sleeve_opening',shouldersValid:'shoulder_alignment',legsValid:'leg_pose',anchorsValid:'body_anchors'})
    .filter(([name])=>lastCheck[name]===false).map(([,defect])=>defect);
  throw Object.assign(new ProviderError('illustration_geometry_invalid'),{defects});
}

export function layoutInstructions(features) {
  const layout = garmentLayout(features);
  const anchors = Object.fromEntries(Object.entries(layout.anchors).map(([name, value]) => [name, point(value)]));
  const [x,y,w,h] = layout.bounds, [left,top] = point([x,y]), [right,bottom] = point([x+w,y+h]);
  const footwearRule=layout.group==='shoes' ? ' FOOTWEAR: use the enlarged grey footwear pose guide for the front projection and relative spacing, and the LAST full-canvas guide for placement. Show TWO separate shoes in the standing pose of the template, with their ankle openings aligned to (466,903) and (558,903). Their centres must remain about 92 pixels apart, with a visible white gap; each shoe is roughly 50 to 65 pixels wide. Use an orthographic FRONT elevation at ankle height, not overhead, top-down or flat-lay product photography. The front toe walls and soles are visible; do not expose long insoles or an elongated top view. Both face forward with a slight outward angle. Do not keep the close, overlapping arrangement of the source photo, and do not place the pair together under the body centre. No feet, legs, socks or trousers inside the shoes.' : '';
  const torsoRule = ['shortUpper', 'sleeveless', 'upper', 'hooded'].includes(layout.group)
    ? ` Fit the torso to the SAME wearer: the neckline is near (512,241), shoulders near (430,269) and (594,269), waist y=483. ${features?.traits?.body_length === 'cropped' ? 'This is deliberately cropped: preserve its short hem.' : features?.traits?.body_length === 'long' ? 'This is an elongated torso: preserve its extra length and torso-to-sleeve proportions, with the hem around y=585 to 625. It may extend below an ordinary hoodie or jacket; do not shorten or tuck it to match another layer.' : !['regular','cropped','long'].includes(features?.traits?.body_length) ? 'Body length is uncertain, NOT regular. Infer the torso-to-shoulder and torso-to-sleeve proportions from the original photo and preserve them. The grey torso hem is only a pose example: an observed long or curved hem may reach y=585 to 650 and extend below another layer. Do not shorten it to the grey hem or waist.' : ['jacket','blazer','cardigan'].includes(layout.type) ? 'Preserve its torso-to-sleeve proportions and jacket length; a hip-length hem may reach y=540 to 590.' : 'The torso hem must overlap the waist, normally y=510 to 545; do not make a regular top look cropped.'} Sleeves follow the template arm directions, not a flat-lay T pose. ${requiresWristPose(layout, features) ? 'Long sleeves reach the wrist anchors near (307,539) and (716,539); unfold the source arm pose instead of turning them into short or three-quarter sleeves.' : ''} ${layout.group === 'hooded' ? 'Keep the hood lowered behind the neckline. The neckline stays near y=241 and shoulder seams near y=269. Do not draw a head inside the hood.' : ''}` : '';
  return `Edit the LAST image: it is the placement template for a ${layout.type}, on an EXACT 1024 by 1024 canvas. Replace ONLY its grey garment placeholder with a faithful editorial illustration of the referenced garment. Keep the template's small size, position and front-facing pose inside the full canvas. Most of the canvas MUST remain plain white. DO NOT zoom, crop, enlarge to fill the square, copy the photo's pose, or draw any human/mannequin body. Coordinates in output pixels, origin top-left: anchors ${JSON.stringify(anchors)}; garment must remain within [left=${left}, top=${top}, right=${right}, bottom=${bottom}]. The anchors describe the same invisible mannequin for every item.${torsoRule}${footwearRule} Preserve the garment DESIGN: construction, colours, actual sleeve and body length, and print placement. Preserve the original chest-width to torso-length ratio and hem width: a wide or boxy T-shirt must remain wide, never tailored into a slim waist. The guide gives pose, NOT mandatory side seams or a universal garment width. Preserve the source fabric texture, irregular stripe spacing and stripe thickness; do not replace woven stripes with a few clean schematic lines. Reconstruct its unfolded front as if worn by this invisible mannequin. Incidental wrinkles, crumpling, folded sleeve openings, tilted collars, camera perspective and hems made uneven only by folds are NOT design features: straighten them. Preserve intentional asymmetric construction and designed hem shapes. ${['shortUpper','sleeveless','upper','hooded','full'].includes(layout.group) ? 'Shoulders must be level and symmetrical, neckline centred, torso vertical, and both sleeves unfolded along the template arms.' : ''} Use restrained editorial shading with visible textile detail; do not trace or emphasize the source photo's random folds. The grey template defines the wearer pose, not a replacement garment design. White outside the item, inside necklines/openings and between separated limbs; no body, head, skin, stand, extra clothing, labels, guide lines or cast shadow.${layout.legs ? ' TROUSERS: front waistband horizontal at the two waist anchors, crotch centred at the crotch anchor, two distinct uncrossed untwisted leg tubes towards the left and right ankle anchors. Straighten the pose even if the source is twisted or folded. Preserve front pockets and seams on their correct sides. Do not draw the torso above the waistband, shoes below the hems, or join/cross the two legs.' : ''}`;
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
  const cuffsValid=cuffExtents(data,info.width,layout,features).every(y=>y>=minimumCuffY(layout));
  const sleevesUnfolded=unfoldedSleeves(data,info.width,layout,features);
  const wristsValid=wristsContactCuffs(data,info.width,layout,features);
  const sleeveOpeningsValid=shortSleeveOpenings(data,info.width,layout,features);
  const armsContainedValid=await armsContained(data,info.width,layout,features);
  return { valid: baseValid && shouldersValid && cuffsValid && sleevesUnfolded && wristsValid && sleeveOpeningsValid && armsContainedValid, armsContainedValid, sleeveOpeningsValid, baseValid, shouldersValid, cuffsValid, sleevesUnfolded, wristsValid,
    outsideFraction, coverage, legsValid, anchorsValid, footAnchorsValid, bounds: { left,top,right,bottom } };
}

// One finite pose is shared by ALL visible arm-bearing layers. This records
// admissible poses; it never stretches limbs or garment pixels to chase a cuff.
export async function fittingPoses(bytes,features) {
  const poses=[];
  for(const pose of Object.keys(fittingArmPoses))if((await checkGarmentLayout(bytes,{...features,_armPose:pose})).valid)poses.push(pose);
  return poses;
}
export async function registerGarmentForFitting(bytes,features,measurement) {
  let lastError;
  for(const pose of ['open','relaxed','spread']) {
    try {
      const png=await registerGarmentLayout(bytes,{...features,_armPose:pose},measurement);
      return {png,poses:await fittingPoses(png,features)};
    }catch(error){
      if(error.code!=='illustration_geometry_invalid')throw error;
      lastError=error;
    }
  }
  throw lastError;
}
