// Closed vocabulary: provider text is never interpolated into correction prompts.
const corrections = {
  illustration_geometry_invalid: 'Match the shared pose and anchors. Unfold both sleeves outside the torso and both trouser legs; show exactly two sleeves/legs. Keep the entire item inside the canvas, including cuffs and hems. Do not change its cut to fit.',
  illustration_proportions_changed: 'Restore the original measured torso width relative to shoulder-to-hem length. Preserve roomy/boxy cut, hem width and sleeve proportions; do not slim or lengthen the garment.',
  illustration_identity_changed: 'Restore the exact original garment identity. Do not invent, simplify, move or remove prints, lettering, seams, pockets, cuffs or fabric patterns.',
};
const dimensions = new Set(['cut','artwork','material','construction']);
export function qualityCorrection(error) {
  if (!Object.hasOwn(corrections,error.code)) return null;
  return {code:error.code,defects:(error.defects||[]).filter(name=>dimensions.has(name))};
}
export function correctionInstructions(correction) {
  if (!correction || !Object.hasOwn(corrections,correction.code)) return '';
  const defects=(correction.defects||[]).filter(name=>dimensions.has(name));
  return ` CORRECTION: The previous completed candidate failed ${correction.code}${defects.length?` (${defects.join(', ')})`:''}. ${corrections[correction.code]} Use the original photos as the identity reference. The pose guide only controls pose. This is the single corrective attempt.`;
}
