// This is an explicit product preference over published observations, not an
// undocumented capability of OutfitTransformer's projected image representation.
export const similarityRankingVersion = 'observable-context-v1';
const observed = value => typeof value === 'string' && !['unknown', 'not_applicable'].includes(value);
export function observableSimilarity(source, candidate) {
  const components = [Number(source.features.type === candidate.features.type)];
  const left = new Set(source.features.colors), right = new Set(candidate.features.colors);
  // Empty means no reliable observation, not a positive match for "no colour".
  if (left.size && right.size) components.push([...left].filter(value => right.has(value)).length / new Set([...left, ...right]).size);
  for (const name of ['silhouette', 'pattern']) {
    const a = source.effectiveFeatures.traits[name], b = candidate.effectiveFeatures.traits[name];
    if (observed(a) && observed(b)) components.push(Number(a === b));
  }
  return components.reduce((sum, value) => sum + value, 0) / components.length;
}
export function similarScore(source, candidate, contextCosine) {
  // The original metric is cosine. Clamping only contains floating-point drift;
  // it is not a quality threshold and never removes an admissible candidate.
  return 0.5 * observableSimilarity(source, candidate) + 0.5 * ((Math.max(-1, Math.min(1, contextCosine)) + 1) / 2);
}
