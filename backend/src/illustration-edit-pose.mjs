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
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${generationBackground(features)}"/><path d="M450 ${t} Q512 300 574 ${t} L${r} ${t} L${r+90} 320 Q${r+120} 550 ${r+100} 740 L828 960 L756 950 L${r+40} 820 L${r+35} 420 L${r} 420 L${r} ${b} H${l} L${l} 420 L${l-35} 420 L${l-40} 820 L268 950 L196 960 L${l-100} 740 Q${l-120} 550 ${l-90} 320 L${l} ${t} Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M450 ${t} Q400 205 450 210 Q512 190 574 210 Q624 205 574 ${t} Q512 300 450 ${t} Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M${l} ${b-55} H${r}" fill="none" stroke="#444" stroke-width="3"/><path d="M187 920 L254 910 M770 910 L837 920" fill="none" stroke="#444" stroke-width="3"/></svg>`)).png().toBuffer();
}

export function measuredPoseInstructions(features,proportions) {
  const width=Math.round(600*proportions.bodyWidthToLength);
  const text='Image 1 is a fabric and design reference. Image 2 (LAST) is the image to edit. Repaint the grey garment in image 2 using the colours, textile, stitching, pocket and exact artwork of image 1. Output the edited image 2 at its existing scale on the 1024x1024 canvas: do not zoom or fill the empty top margin. Torso side seams are x='+(512-width/2)+' and x='+(512+width/2)+', shoulder line y=270, bottom of the ribbed waistband y=870: keep this broad flat body. The waistband is INSIDE the bottom 55 pixels of that body, never added below it. Do not drape or squeeze it into a narrow waist. Keep an uninterrupted white air gap at least 20 pixels wide between each sleeve and torso below the underarm. Both sleeves must end at the template cuffs: left cuff centre (232, 940), right cuff centre (792, 940), each about 70 pixels wide. Below the elbows the forearms turn gently INWARD toward these cuffs, outside the torso and below its hem; they must not keep spreading outward. The sleeve tops can retain the original roomy width, but the cuff centres are fixed. Its two hanging sleeves and low collar hood MUST stay in place. Do not reproduce the pose of image 1. Do not add sleeves: repaint the two that are already present in image 2. The torso width / SHOULDER-LINE-TO-HEM length is '+proportions.bodyWidthToLength+'; measure length from the horizontal shoulder line, not from the bottom of the collar V; retain that ratio and the source garment\'s designed hem/taper. Place original sleeve artwork on the same hanging sleeve. Preserve all printed shapes, lettering, relative scale and worn ink texture. Detailed editorial garment illustration, plain white background, no person or mannequin, no grey guide lines.';
  return generationBackground(features)==='#ffffff'?text:text.replaceAll('on white','on uniform mid-grey (#808080)');
}
