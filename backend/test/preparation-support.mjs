import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const taxonomy = JSON.parse(readFileSync(new URL('../../shared/wardrobe-taxonomy.json', import.meta.url), 'utf8'));
export async function commitIllustration(server, photo, illustration, revision = 1) {
  const path = `/v1/items/${photo.itemId}/illustrations/${illustration.operationId}`;
  const result = await (await server.request(path)).json();
  const config = await (await server.request('/v1/recommendations/config')).json();
  const operationId = randomUUID();
  const input = { operationId, revision, photoVersionId: photo.photoVersionId, sourceSetVersionId: illustration.sourceSetVersionId,
    illustrationOperationId: illustration.operationId, cutoutOperationId: photo.operationId, spaceID: config.encoder.activeSpaceID,
    mode: 'fromIllustration', imageBase64: photo.imageBase64,
    features: { type: taxonomy.types.find(entry => entry.label === result.effectiveFeatures.type).id,
      colors: result.effectiveFeatures.colors.map(label => taxonomy.colors.find(entry => entry.label === label).id) } };
  const accepted = await server.request(`/v1/items/${photo.itemId}/preparations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(accepted.status, 202, JSON.stringify(await accepted.json()));
  let ready;
  for (let i = 0; i < 200; i++) {
    ready = await (await server.request(`/v1/items/${photo.itemId}/preparations/${operationId}`)).json();
    if (ready.status === 'ready') break;
    assert.notEqual(ready.status, 'failed', JSON.stringify(ready));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(ready.status, 'ready');
  const ack = { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicationProtocol: 'prepared-item-v1', preparationOperationId: operationId }) };
  const response = await server.request(path + '/ack', ack);
  return { response, ack, ready };
}
