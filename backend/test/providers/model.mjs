import { createHash } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const controlledSpaceID = 'controlled-outfit-v2';
// Controlled external model boundary: never imported by the application runtime.
export async function modelFixture(request, response, body, handlers = {}, calls = []) {
  if (!request.url.startsWith('/model/')) return false;
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/model/describe') { response.end(JSON.stringify({ spaceID: controlledSpaceID })); return true; }
  if (request.url !== '/model/prepare') { response.writeHead(404); response.end(); return true; }
  const input = JSON.parse(body); calls.push(input);
  if (handlers.model) { await handlers.model(request, response, input); return true; }
  const text = input.type.replaceAll('_', ' ') + (input.colors.length ? '. Colors: ' + [...input.colors].sort().join(', ') : '') + '.';
  response.end(JSON.stringify({ schemaVersion: 1, spaceID: controlledSpaceID, photoVersionID: input.photoVersionID,
    sourceSHA256: digest(Buffer.from(input.imageBase64, 'base64')), textSHA256: digest(text), vector: Array(128).fill(0.125) }));
  return true;
}
