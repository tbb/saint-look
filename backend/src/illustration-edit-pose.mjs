import sharp from 'sharp';
import {generationBackground} from './illustration-edit.mjs';
import {garmentLayout} from './illustration-layout.mjs';

// Pose-only reference with a measured torso, never a stock slim placeholder.
export async function editPoseGuide(features, proportions) {
  if(garmentLayout(features).group!=='hooded'||!proportions
    ||features?.traits?.sleeves!=='long'||features?.traits?.body_length!=='regular')return null;
  const h=600,w=h*proportions.bodyWidthToLength,l=512-w/2,r=512+w/2,t=270,b=t+h;
  if(w<240||w>600)return null;
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${generationBackground(features)}"/><path d="M450 ${t} Q512 300 574 ${t} L${r} ${t} L${r+35} 305 L960 845 L890 885 L${r+10} 420 L${r} ${b} H${l} L${l-10} 420 L134 885 L64 845 L${l-35} 305 Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M450 ${t} Q400 205 450 210 Q512 190 574 210 Q624 205 574 ${t} Q512 300 450 ${t} Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M70 820 L145 855 M879 855 L954 820" fill="none" stroke="#444" stroke-width="3"/></svg>`)).png().toBuffer();
}

export function measuredPoseInstructions(features,proportions) {
  const text='Edit the LAST image, the grey unfolded garment. Replace its grey material with the exact garment design from the earlier source photo. The target already has the measured torso ratio, lowered hood and TWO fully straight sleeves: keep the sleeve pose and lowered hood. The guide does not define torso side seams: preserve the source torso contour, designed taper, hem shape and construction. Do not copy the bent/folded source sleeves. Transfer each original sleeve print onto the SAME sleeve outside the torso. Keep every original print shape, placement, scale, lettering and distressed texture, plus fabric, pocket, cuffs and seams. Do not invent marks or copy the background. Faithful detailed editorial garment illustration on white, no person or mannequin, no guide lines. Use the measured torso width/neck-to-hem ratio '+proportions.bodyWidthToLength+'.';
  return generationBackground(features)==='#ffffff'?text:text.replaceAll('on white','on uniform mid-grey (#808080)');
}

export function poseCorrectionInstructions(features) {
  const text='The last result still has folded sleeves over the stomach. Correct ONLY that pose: straighten BOTH existing sleeves downward and outward, with both cuffs completely outside the body silhouette and visible air gaps. Replace the old folded sleeves, do not add extra arms. Keep exactly two sleeves, the same torso proportions and designed hem, all original artwork shapes and worn ink texture, and each print on its original sleeve. Lower the hood behind the neckline. Preserve all other design details, colours, fabric and construction. One garment only, white background.';
  return generationBackground(features)==='#ffffff'?text:text.replaceAll('white background','uniform mid-grey (#808080) background');
}
