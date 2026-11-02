import sharp from 'sharp';
import {generationBackground} from './illustration-edit.mjs';
import {garmentLayout} from './illustration-layout.mjs';

// Pose-only reference with a measured torso, never a stock slim placeholder.
export async function editPoseGuide(features, proportions) {
  if(garmentLayout(features).group!=='hooded'||!proportions
    ||features?.traits?.sleeves!=='long'||features?.traits?.body_length!=='regular')return null;
  const h=600,w=h*proportions.bodyWidthToLength,l=512-w/2,r=512+w/2,t=270,b=t+h;
  if(w<240||w>600)return null;
  // At the 600px torso scale, shared mannequin wrists project near x232/792,
  // y904. Fixed outer canvas corners put cuffs beside the hands instead.
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${generationBackground(features)}"/><path d="M450 ${t} Q512 300 574 ${t} L${r} ${t} L${r+90} 320 Q${r+120} 550 ${r+100} 740 L828 960 L756 950 L${r+40} 820 L${r+35} 420 L${r} 420 L${r} ${b} H${l} L${l} 420 L${l-35} 420 L${l-40} 820 L268 950 L196 960 L${l-100} 740 Q${l-120} 550 ${l-90} 320 L${l} ${t} Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M450 ${t} Q400 205 450 210 Q512 190 574 210 Q624 205 574 ${t} Q512 300 450 ${t} Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M187 920 L254 910 M770 910 L837 920" fill="none" stroke="#444" stroke-width="3"/></svg>`)).png().toBuffer();
}

export function measuredPoseInstructions(features,proportions) {
  const text='Edit the LAST image, the grey unfolded garment. Replace its grey material with the exact garment design from the earlier source photo. The target already has the measured torso ratio, lowered hood and TWO unfolded sleeves ending at the shared wrist positions: keep the cuff positions and sleeve pose and lowered hood. The guide does not define torso side seams: preserve the source torso contour, designed taper, hem shape and construction. Do not copy the bent/folded source sleeves. Transfer each original sleeve print onto the SAME sleeve outside the torso. Keep every original print shape, placement, scale, lettering and distressed texture, plus fabric, pocket, cuffs and seams. Do not invent marks or copy the background. Faithful detailed editorial garment illustration on white, no person or mannequin, no guide lines. Use the measured torso width/shoulder-to-hem ratio '+proportions.bodyWidthToLength+'.';
  return generationBackground(features)==='#ffffff'?text:text.replaceAll('on white','on uniform mid-grey (#808080)');
}
