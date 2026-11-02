import sharp from 'sharp';
import {generationBackground} from './illustration-edit.mjs';
import {garmentLayout, armPoint} from './illustration-layout.mjs';

// The guide and the client share shoulder/arm coordinates. Body width is measured
// independently: ease may move the side seams, never the wearer's shoulders.
export function measuredGuideSVG(features, proportions) {
  const layout=garmentLayout(features), {group}=layout;
  if(!proportions || !['shortUpper','upper','hooded'].includes(group)
    ||!['short','long'].includes(features?.traits?.sleeves))return null;
  const hooded=group==='hooded', long=features?.traits?.sleeves==='long';
  const hem=features?.traits?.body_length==='long'?340:features?.traits?.body_length==='cropped'?250:297;
  const top=hooded?147:132;
  const width=(hem-top)*proportions.bodyWidthToLength;
  if(width<65||width>180)return null;
  const left=180-width/2,right=180+width/2;
  const points=long?[[245,181],[264,304],[247,311],[216,206]]:[[244,181],[251,212],[228,220],[216,206]];
  const arm=(pts,side)=>pts.map(p=>'L'+armPoint(p,side).join(' ')).join(' ');
  const leftPoints=points.map(([x,y])=>[360-x,y]).reverse();
  const torso=`M164 132 Q180 145 196 132 L225 148 ${hooded&&right>225?`L${right} 148`:''} L${right} 206 L${right} ${hem} L${left} ${hem} L${left} 206 ${hooded&&left<135?`L${left} 147`:''} L135 147 Z`;
  // Union separate filled panels: moving a side seam must not create a
  // self-intersecting underarm polygon or draw false seams inside the guide.
  const rightSleeve=`M225 148 ${hooded&&right>225?`L${right} 148`:''} ${arm(points,'right')} L${right} 206 Z`;
  const leftSleeve=`M135 147 L${left} 206 ${arm(leftPoints,'left')} ${hooded&&left<135?`L${left} 147`:''} Z`;
  const hood=hooded?'<path d="M164 132 Q145 117 155 115 Q180 108 205 115 Q215 117 196 132 Q180 145 164 132 Z"/>':'';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-100 0 560 560"><g fill="#ccc"><path d="${torso}"/><path d="${rightSleeve}"/><path d="${leftSleeve}"/>${hood}</g></svg>`;

}

export async function editPoseGuide(features, proportions) {
  const svg=measuredGuideSVG(features,proportions);
  if(!svg)return null;
  // Enlarge the same pose by ONE scale. The model gets enough detail; registration
  // later restores shared coordinates without changing width/height separately.
  const trimmed=await sharp(Buffer.from(svg)).trim().png().toBuffer();
  const enlarged=await sharp(trimmed).resize(900,900,{fit:'inside'}).png().toBuffer();
  return sharp(enlarged).resize(1024,1024,{fit:'contain',background:generationBackground(features)})
    .flatten({background:generationBackground(features)}).png().toBuffer();
}

export function measuredPoseInstructions(features,proportions) {
  return 'Edit the LAST image, the grey garment pose guide. Dress its exact silhouette in the design of the earlier original garment. Keep the guide neckline, sloped shoulders, sleeve directions and cuff endpoints. The source defines all fabric, colour, artwork, lettering, pockets, seams and the torso contour; the guide defines only the unfolded pose. Preserve the actual sleeve length. Exactly TWO sleeves: replace folded sleeves, never retain them and append another pair. Arms must run along the sleeve centre and emerge through cuff openings, never through the underarm or side seam. The hood, if present, stays lowered behind the neck. Preserve the original roomy or fitted cut, designed taper and hem shape. Keep every print on its original panel and preserve distressed ink texture, not a clean replacement logo. No added labels, guide lines, person or mannequin. Subtle editorial finish, with fidelity to the real garment taking priority over stylization. One complete garment, entirely visible on a plain '+generationBackground(features)+' background. Measured torso width / '+proportions.lengthReference+' length = '+proportions.bodyWidthToLength+'. Do not change this ratio to fit a stock body.';
}
