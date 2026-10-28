import { sha256 } from './trial-plan.mjs';

const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const field = (value, key) => ({ present: own(value, key), type: kind(value?.[key]),
  ...(typeof value?.[key] === 'string' ? { stringLength: value[key].length } : {}),
  ...(typeof value?.[key] === 'number' ? { finite: Number.isFinite(value[key]) } : {}) });
function scalar(value, strings = []) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '__nonfinite_number__';
  if (typeof value === 'string') return strings.includes(value) ? value : '__unrecognized_string__';
  return Array.isArray(value) ? [] : {};
}

// Only operands read by featureAnswer are replayed. Unexpected strings, property
// names, headers, assets and free-form messages never enter the saved snapshot.
export function diagnosticResponse(response, request) {
  const snapshot = { version: 1, httpStatus: response.status, responseBytes: response.bytes.length,
    responseSha256: sha256(response.bytes), contentKind: /^application\/json(?:;|$)/i.test(response.type) ? 'json' : 'other' };
  let raw;
  try { raw = JSON.parse(response.bytes.toString('utf8')); }
  catch { return { snapshot: { ...snapshot, parsedJson: false }, raw: undefined }; }
  snapshot.parsedJson = true;
  const shape = { rootType: kind(raw), model: field(raw, 'model'), usage: field(raw, 'usage'), answers: field(raw, 'answers') };
  let replay = scalar(raw);
  if (object(raw)) {
    replay = {};
    if (own(raw, 'model')) {
      const modelId = typeof raw.model === 'string' && raw.model.length <= 20 && /^jev(?:-\d{1,3}(?:\.\d{1,3}){0,2})?$/.test(raw.model);
      replay.model = scalar(raw.model, modelId ? [raw.model] : [request.model]);
    }
    if (own(raw, 'usage')) {
      replay.usage = object(raw.usage) ? {} : scalar(raw.usage);
      shape.inputTokens = field(raw.usage, 'input_tokens');
      if (own(raw.usage, 'input_tokens')) replay.usage.input_tokens = scalar(raw.usage.input_tokens);
    }
    if (own(raw, 'answers')) {
      replay.answers = object(raw.answers) ? {} : scalar(raw.answers);
      shape.expectedAnswers = {};
      shape.extraAnswerCount = object(raw.answers) ? Object.keys(raw.answers).filter(key => !Object.hasOwn(request.questions, key)).length : 0;
      for (const [name, question] of Object.entries(request.questions)) {
        const answer = raw.answers?.[name];
        const details = { present: own(raw.answers, name), containerType: kind(answer) };
        shape.expectedAnswers[name] = details;
        if (!own(raw.answers, name)) continue;
        if (!object(answer)) { replay.answers[name] = scalar(answer); continue; }
        const projected = {};
        for (const key of ['type', 'choice', 'confidence', 'noul']) {
          details[key] = field(answer, key);
          if (own(answer, key)) projected[key] = scalar(answer[key], key === 'type' ? ['choice', 'noul'] : key === 'choice' ? Object.keys(question.criteria || {}) : []);
        }
        details.probabilities = field(answer, 'probabilities');
        if (own(answer, 'probabilities')) {
          const values = answer.probabilities, keys = Object.keys(question.criteria || {});
          if (object(values)) {
            const extras = Object.keys(values).filter(key => !keys.includes(key));
            details.probabilityKeyCount = Object.keys(values).length;
            details.extraProbabilityCount = extras.length;
            details.missingProbabilityKeys = keys.filter(key => !Object.hasOwn(values, key));
            projected.probabilities = Object.fromEntries(keys.filter(key => Object.hasOwn(values, key)).map(key => [key, scalar(values[key])]));
            // Extra key names are untrusted. Anonymous placeholders preserve the
            // count for ordinary responses; larger malformed objects stay invalid.
            for (let i = 0; i < Math.min(extras.length, 64); i++) projected.probabilities[`__extra_${i}`] = 0;
            details.extraKeysTruncated = extras.length > 64;
            details.probabilitySum = keys.every(key => typeof values[key] === 'number' && Number.isFinite(values[key]))
              ? keys.reduce((sum, key) => sum + values[key], 0) : null;
          } else projected.probabilities = scalar(values);
        }
        replay.answers[name] = projected;
      }
    }
  }
  snapshot.shape = shape; snapshot.replay = replay;
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 65536) throw new Error('Diagnostic snapshot exceeds its bounded whitelist');
  return { snapshot, raw };
}
