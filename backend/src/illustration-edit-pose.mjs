import sharp from 'sharp';
import {generationBackground} from './illustration-edit.mjs';
import {garmentLayout} from './illustration-layout.mjs';

export async function editPoseGuide(features,proportions){
 if(garmentLayout(features).group!=='hooded'||!proportions||features?.traits?.sleeves!=='long')return null;
 return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${generationBackground(features)}"/><g fill="none" stroke="#00887a" stroke-width="8" stroke-linecap="round"><path d="M350 300 Q270 570 232 904 M674 300 Q754 570 792 904"/><circle cx="232" cy="904" r="18"/><circle cx="792" cy="904" r="18"/><path d="M490 270 H534"/></g></svg>`)).png().toBuffer();
}
export function measuredPoseInstructions(features,proportions){
 return 'Edit the ORIGINAL GARMENT PHOTO, keeping this exact item. The last image contains only green arm centre lines and cuff centres, NOT clothing: use it only to understand the new arm pose, then omit every green mark. Unfold both existing sleeves and let them hang naturally along these arm directions, cuffs centred near (232,904) and (792,904). Keep the torso centred at x512 with shoulders near y270 and hem near y870; preserve its original width-to-shoulder-to-hem length ratio '+proportions.bodyWidthToLength+'. Preserve the actual broad cut and natural contour, shoulder drop, fabric texture, distressed print shapes and positions, pocket and ribbed waistband. Do not turn the torso into a rectangle or invent seams. Keep each sleeve print on the same sleeve. Lower the hood behind the neckline, with no face or body inside it. Change only the clothing pose, not its design or artwork. The source is the design authority; the green marks have no garment silhouette and must never replace the cut. Faithful high-detail garment image on plain white, front view, no mannequin or human, no extra sleeves, no folded arms, no geometric template panels. One isolated garment, same 1024 square.';
}
