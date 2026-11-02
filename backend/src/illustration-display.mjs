// Display-size convention, not an estimate of the garment's physical size.
// The mannequin torso is about 85 units wide. Straight/unknown tops get 20
// units of display ease; already wider garments are never narrowed to this floor.
export function minimumDisplayTorsoWidth(features) {
  if(features?.traits?.body_length==='cropped')return 0;
  return features?.traits?.silhouette==='fitted'?85
    : features?.traits?.silhouette==='relaxed'?113:105;
}
