import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { photoRequest, upload, waitForItem } from './support.mjs';
import { commitIllustration } from './preparation-support.mjs';
const taxonomy = JSON.parse(readFileSync(new URL('../../shared/wardrobe-taxonomy.json', import.meta.url)));
export const postJSON = (server, path, body) => server.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export async function awaitReady(server, path) {
  for (let i = 0; i < 150; i++) {
    const response = await server.request(path), body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    if (body.status === 'ready') return body;
    assert.notEqual(body.status, 'failed', JSON.stringify(body));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Preparation did not complete');
}
export async function publishedItem(server, type, colors = ['red']) {
  const photo = await photoRequest(); assert.equal((await upload(server, photo)).status, 202); await waitForItem(server, photo.itemId);
  const illustration = { operationId: randomUUID(), revision: 1, photoVersionId: photo.photoVersionId, sourceSetVersionId: randomUUID(),
    manualType: taxonomy.types.find(entry => entry.id === type).label, manualColors: colors.map(id => taxonomy.colors.find(entry => entry.id === id).label),
    photos: [{ id: photo.photoVersionId, role: 'front', imageBase64: photo.imageBase64 }] };
  assert.equal((await postJSON(server, `/v1/items/${photo.itemId}/illustrations`, illustration)).status, 202);
  const illustrationReady = await awaitReady(server, `/v1/items/${photo.itemId}/illustrations/${illustration.operationId}`);
  const { ready, response } = await commitIllustration(server, photo, illustration); assert.equal(response.status, 204);
  return { photo, illustration, effectiveFeatures: illustrationReady.effectiveFeatures, prepared: ready, item: { itemId: photo.itemId, publishedVersionId: ready.operationId,
    photoVersionId: photo.photoVersionId, sourceSetVersionId: illustration.sourceSetVersionId,
    features: ready.effectiveFeatures, representationJSON: ready.representationJSON, representationSHA256: ready.representationSHA256 } };
}
export function slot(zone, publication = null) {
  return { slotId: randomUUID(), zone, itemId: publication?.item.itemId ?? null, publishedVersionId: publication?.item.publishedVersionId ?? null };
}
export function singleInput(publications, orderedSlots, targetSlot, changes = {}) {
  return { requestId: randomUUID(), snapshotId: randomUUID(), targetSlotId: targetSlot.slotId,
    orderedSlots, pinnedSlotIds: [], excludedItemIds: [], items: publications.map(p => p.item), ...changes };
}

export async function refreshedItem(server, publication, commit = true) {
  const config = await (await server.request('/v1/recommendations/config')).json();
  const operationId = randomUUID(), photo = publication.photo, illustration = publication.illustration;
  const input = { operationId, revision: publication.prepared.revision + 1, photoVersionId: photo.photoVersionId,
    sourceSetVersionId: illustration.sourceSetVersionId, illustrationOperationId: illustration.operationId, cutoutOperationId: photo.operationId,
    spaceID: config.encoder.activeSpaceID, mode: 'reusePublication', imageBase64: photo.imageBase64, features: publication.item.features,
    reuse: { publicationId: publication.item.publishedVersionId, artifacts: publication.prepared.artifacts } };
  const accepted = await postJSON(server, `/v1/items/${photo.itemId}/preparations`, input);
  assert.equal(accepted.status, 202, JSON.stringify(await accepted.json()));
  const ready = await awaitReady(server, `/v1/items/${photo.itemId}/preparations/${operationId}`);
  const acknowledge = () => postJSON(server, `/v1/items/${photo.itemId}/illustrations/${illustration.operationId}/ack`,
    { publicationProtocol: 'prepared-item-v1', preparationOperationId: operationId });
  if (commit) assert.equal((await acknowledge()).status, 204);
  return { ...publication, prepared: ready, acknowledge, item: { ...publication.item, publishedVersionId: operationId,
    representationJSON: ready.representationJSON, representationSHA256: ready.representationSHA256 } };
}
