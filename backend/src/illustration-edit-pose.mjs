import sharp from 'sharp';
import {generationBackground} from './illustration-edit.mjs';
import {garmentLayout} from './illustration-layout.mjs';

// Pose-only reference with a measured torso, never a stock slim placeholder.
export async function editPoseGuide(features, proportions) {
  if(garmentLayout(features).group!=='hooded'||!proportions
    ||features?.traits?.sleeves!=='long'||features?.traits?.body_length!=='regular')return null;
  const h=600,w=h*proportions.bodyWidthToLength,l=512-w/2,r=512+w/2,t=270,b=t+h;
  if(w<240||w>600)return null;
  // Project shared shoulder/wrist coordinates at the measured torso scale.
  // Only the torso width comes from the original. A roomy torso must not pull
  // the wrists sideways; both sleeves still target the same fixed wearer.
  const scale=h/(297-132),cx=512+(68-180)*scale,cy=t+(295-132)*scale;
  const right=1024-cx;
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${generationBackground(features)}"/><path d="M450 ${t} Q512 300 574 ${t} L${r} ${t} L${r+35} 305 L${right+33} ${cy-12} L${right-33} ${cy+12} L${r} 420 L${r} ${b} H${l} L${l} 420 L${cx+33} ${cy+12} L${cx-33} ${cy-12} L${l-35} 305 L${l} ${t} Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M450 ${t} Q400 205 450 210 Q512 190 574 210 Q624 205 574 ${t} Q512 300 450 ${t} Z" fill="#ddd" stroke="#444" stroke-width="3"/></svg>`)).png().toBuffer();
}

export function measuredPoseInstructions(features,proportions) {
  const text='Edit the LAST image, the grey unfolded garment. Replace its grey material with the exact garment design from the earlier source photo. The target already has the measured torso ratio, lowered hood and TWO unfolded sleeves ending at the shared wrist positions: keep the cuff positions and sleeve pose and lowered hood. The guide does not define torso side seams: preserve the source torso contour, designed taper, hem shape and construction. Do not copy the bent/folded source sleeves. Transfer each original sleeve print onto the SAME sleeve outside the torso. Keep every original print shape, placement, scale, lettering and distressed texture, plus fabric, pocket, cuffs and seams. Do not invent marks or copy the background. Faithful detailed editorial garment illustration on white, no person or mannequin, no guide lines. Use the measured torso width/shoulder-to-hem ratio '+proportions.bodyWidthToLength+'.';
  return generationBackground(features)==='#ffffff'?text:text.replaceAll('on white','on uniform mid-grey (#808080)');
}
