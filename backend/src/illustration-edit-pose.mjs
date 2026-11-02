import sharp from 'sharp';
import {generationBackground} from './illustration-edit.mjs';
import {garmentLayout} from './illustration-layout.mjs';

// Pose-only reference with a measured torso, never a stock slim placeholder.
export async function editPoseGuide(features, proportions) {
  if(garmentLayout(features).group!=='hooded'||!proportions
    ||features?.traits?.sleeves!=='long'||features?.traits?.body_length!=='regular')return null;
  const h=600,w=h*proportions.bodyWidthToLength,l=512-w/2,r=512+w/2,t=270,b=t+h+30;
  if(w<240||w>600)return null;
  // At the 600px torso scale, shared mannequin wrists project near x232/792,
  // y904. Fixed outer canvas corners put cuffs beside the hands instead.
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${generationBackground(features)}"/><path d="M450 ${t} Q512 300 574 ${t} L${r} ${t} L${r+30} 305 Q${r+70} 580 ${r+45} 790 L828 930 L756 920 L${r+10} 870 L${r+10} 420 L${r} ${b} H${l} L${l-10} 420 L${l-10} 870 L268 920 L196 930 L${l-45} 790 Q${l-70} 580 ${l-30} 305 Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M450 ${t} Q400 205 450 210 Q512 190 574 210 Q624 205 574 ${t} Q512 300 450 ${t} Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M191 895 L263 885 M761 885 L833 895" fill="none" stroke="#444" stroke-width="3"/></svg>`)).png().toBuffer();
}

export function measuredPoseInstructions(features,proportions) {
  const text='Edit the LAST image, the grey unfolded garment. Replace its grey material with the exact garment design from the earlier source photo. The target already has the measured torso ratio, lowered hood and TWO unfolded sleeves ending at the shared wrist positions: keep the cuff positions and sleeve pose and lowered hood. The guide does not define torso side seams: preserve the source torso contour, designed taper, hem shape and construction. Do not copy the bent/folded source sleeves. Transfer each original sleeve print onto the SAME sleeve outside the torso. Keep every original print shape, placement, scale, lettering and distressed texture, plus fabric, pocket, cuffs and seams. Do not invent marks or copy the background. Faithful detailed editorial garment illustration on white, no person or mannequin, no guide lines. Use the measured torso width/neck-to-hem ratio '+proportions.bodyWidthToLength+'.';
  return generationBackground(features)==='#ffffff'?text:text.replaceAll('on white','on uniform mid-grey (#808080)');
}
