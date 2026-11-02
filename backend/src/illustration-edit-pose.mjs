import sharp from 'sharp';
import {generationBackground} from './illustration-edit.mjs';
import {garmentLayout} from './illustration-layout.mjs';
export async function editPoseGuide(features,proportions){
 if(garmentLayout(features).group!=='hooded'||!proportions||features?.traits?.sleeves!=='long')return null;
 const h=600,w=h*proportions.bodyWidthToLength,l=512-w/2,r=512+w/2,t=270;
 if(w<240||w>600)return null;
 return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${generationBackground(features)}"/><path d="M450 ${t} Q512 300 574 ${t} L${r} ${t} Q${r+40} 280 ${r+90} 320 Q${r+110} 550 970 840 L950 915 L860 885 L880 820 L${r+35} 420 L${r} 420 L${r} 850 Q512 890 ${l} 850 L${l} 420 L${l-35} 420 L144 820 L164 885 L74 915 L54 840 Q${l-110} 550 ${l-90} 320 Q${l-40} 280 ${l} ${t} Z" fill="#ddd" stroke="#777" stroke-width="2"/><path d="M450 ${t} Q400 205 450 210 Q512 190 574 210 Q624 205 574 ${t} Q512 300 450 ${t} Z" fill="#ddd" stroke="#777" stroke-width="2"/></svg>`)).png().toBuffer();
}
export function measuredPoseInstructions(features,proportions){
 return 'Reconstruct the original garment in the unfolded relaxed A-pose of the last grey guide. Produce a faithful PRODUCT PHOTO of the SAME actual item, with its original textile, ink and construction; do not draw an illustration or simplify its details. The extra closeups are zoomed DETAIL REFERENCES of the same source, not additional garments. Preserve every visible symbol contour, asymmetric stroke length, distressed ink texture and print placement from those closeups. Transfer the visible sleeve artwork to that same unfolded sleeve. Do not invent symbols where the original is hidden. The guide supplies only pose: two unfolded long sleeves angled outward, lowered hood, shoulders near y270, body hem near y870; original torso width/shoulder-to-hem ratio '+proportions.bodyWidthToLength+'. Preserve the original natural body contour and roomy cut; never make the garment narrower or longer to match a mannequin. Keep the guide arm pose; do not copy the folded original sleeves. Soft natural fabric, not stiff rectangular panels. No guide lines, body or person. White background, 1024 square.';
}
