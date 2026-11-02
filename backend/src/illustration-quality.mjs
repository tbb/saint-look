// Closed vocabulary: provider text is never interpolated into correction prompts.
const corrections = {
  illustration_geometry_invalid: 'Match the shared pose and anchors. Unfold both sleeves outside the torso and both trouser legs; show exactly two sleeves/legs. Keep the entire item inside the canvas, including cuffs and hems. Do not change its cut to fit.',
  illustration_proportions_changed: 'Restore the original measured torso width relative to shoulder-to-hem length. Preserve roomy/boxy cut, hem width and sleeve proportions; do not slim or lengthen the garment.',
  illustration_identity_changed: 'Restore the exact original garment identity. Do not invent, simplify, move or remove prints, lettering, seams, pockets, cuffs or fabric patterns.',
};
const dimensions = new Set(['cut','artwork','material','construction',
  'duplicated_parts','raised_hood','sleeve_opening','folded_sleeves','wrist_alignment','shoulder_alignment','leg_pose','body_anchors']);
export function qualityCorrection(error) {
  if (!Object.hasOwn(corrections,error.code)) return null;
  return {code:error.code,defects:(error.defects||[]).filter(name=>dimensions.has(name))};
}
export function correctionInstructions(correction) {
  if (!correction || !Object.hasOwn(corrections,correction.code)) return '';
  const defects=(correction.defects||[]).filter(name=>dimensions.has(name));
  return ` CORRECTION: The previous completed candidate failed ${correction.code}${defects.length?` (${defects.join(', ')})`:''}. ${corrections[correction.code]} ${defects.includes('wrist_alignment')?'Long cuffs must meet the guide wrists: do not stop sleeves above them or place cuffs outside the hands. ':''}${defects.includes('sleeve_opening')?'Rotate the existing short sleeves downward along the guide arms; each arm must exit through its sleeve opening, never the armpit. ':''}${defects.includes('raised_hood')?'Lower the existing hood behind the neck; do not keep the upright pointed hood. ':''}${defects.includes('duplicated_parts')?'Remove duplicated sleeves and cuffs; there must be exactly two sleeves total. ':''}${defects.includes('folded_sleeves')?'Remove the folded sleeve pose completely; exactly two unfolded sleeves, with no cuffs on the stomach. ':''}Use the original photos as the identity reference. The pose guide only controls pose. This is the single corrective attempt.`;
}
