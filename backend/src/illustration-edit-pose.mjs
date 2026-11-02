import sharp from 'sharp';
import {garmentLayout} from './illustration-layout.mjs';

// Pose-only reference with a measured torso, never a stock slim placeholder.
export async function editPoseGuide(features, proportions) {
  if(garmentLayout(features).group!=='hooded'||!proportions)return null;
  const h=600,w=h*proportions.bodyWidthToLength,l=512-w/2,r=512+w/2,t=270,b=t+h;
  if(w<240||w>600)return null;
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="white"/><path d="M450 ${t} Q512 300 574 ${t} L${r} ${t} L${r+35} 305 L960 845 L890 885 L${r+10} 420 L${r} ${b} H${l} L${l-10} 420 L134 885 L64 845 L${l-35} 305 Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M450 ${t} Q400 205 450 210 Q512 190 574 210 Q624 205 574 ${t} Q512 300 450 ${t} Z" fill="#ddd" stroke="#444" stroke-width="3"/><path d="M70 820 L145 855 M879 855 L954 820" fill="none" stroke="#444" stroke-width="3"/></svg>`)).png().toBuffer();
}
