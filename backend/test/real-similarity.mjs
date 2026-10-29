// Opt-in public-photo observation, outside ordinary CI and all paid providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import { environment, waitForModelConfiguration } from './support.mjs';
import { slot, singleInput, postJSON } from './recommendation-support.mjs';
import { installReceiptFixture } from './prepared-receipt-fixture.mjs';
import { createModelBridge } from '../src/model-bridge.mjs';
import { observableChoices } from '../src/illustration-features.mjs';
import { illustrationTaxonomy } from '../src/illustration-provider.mjs';
import { sha256 } from '../src/publication-contract.mjs';
import { observableSimilarity, similarScore } from '../src/recommendation-similarity.mjs';

test('public photographs exercise both replacement intentions with actual checkpoint context',
  { skip: process.env.SAINT_LOOK_REAL_MODEL_TEST !== '1', timeout: 180_000 }, async t => {
    const directory = process.env.SAINT_LOOK_PUBLIC_DATASET;
    assert.ok(directory); assert.ok(process.env.SAINT_LOOK_MODEL_ASSETS); assert.ok(process.env.SAINT_LOOK_MODEL_PYTHON);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const modelEnv = { SAINT_LOOK_MODEL_PROFILE: 'outfit-transformer-labse-v1', SAINT_LOOK_TEST_MODEL_ORIGIN: '',
      SAINT_LOOK_MODEL_ASSETS: process.env.SAINT_LOOK_MODEL_ASSETS, SAINT_LOOK_MODEL_PYTHON: process.env.SAINT_LOOK_MODEL_PYTHON, SAINT_LOOK_MODEL_THREADS: '1' };
    const env = await environment(t), model = createModelBridge({ ...process.env, ...modelEnv }, env.directory);
    t.after(() => model.close()); await model.waitForStartup();
    const status = await model.status(); assert.equal(status.mode, 'real'); assert.equal(status.available, true);
    const items = [], examples = [];
    // These explicit, agent-reviewed observations are input fixtures, not JEV
    // output, a production publication, human taste ratings or training labels.
    const traitsByID = { 'light-polo': { silhouette: 'straight', pattern: 'graphic' }, 'pub-03': { silhouette: 'straight', pattern: 'plain' },
      'pub-13': { silhouette: 'straight', pattern: 'plain' }, 'pub-22': { silhouette: 'fitted', pattern: 'plain' } };
    for (const id of ['white-tee', 'blue-jeans', 'light-polo', 'pub-03', 'pub-13', 'pub-22']) {
      const photo = manifest.items.find(item => item.id === id), bytes = await readFile(join(directory, photo.image));
      assert.equal(sha256(bytes), photo.sha256);
      const png = await sharp(bytes).rotate().png().toBuffer(), photoVersionId = randomUUID();
      const features = { type: photo.type, colors: [...photo.colors].sort() };
      const prepared = await model.prepare(png, photoVersionId, features);
      const effectiveFeatures = { version: 'fitting-observable-v2-photoroom-sandbox',
        type: illustrationTaxonomy.types.find(type => type.id === features.type).label,
        colors: features.colors.map(color => illustrationTaxonomy.colors.find(entry => entry.id === color).label),
        traits: { ...Object.fromEntries(Object.keys(observableChoices).map(name => [name, 'unknown'])), ...traitsByID[id] } };
      items.push({ itemId: randomUUID(), publishedVersionId: randomUUID(), photoVersionId, sourceSetVersionId: randomUUID(), features,
        effectiveFeatures, representationJSON: prepared.representationJSON, representationSHA256: prepared.representationSHA256 });
      examples.push({ id, photoSHA256: photo.sha256, type: features.type, colors: features.colors, reviewedTraits: traitsByID[id] ?? {} });
    }
    const candidates = items.slice(2), cosines = await model.rank([JSON.parse(items[1].representationJSON)], candidates.map(item => JSON.parse(item.representationJSON)));
    const diagnosticScores = candidates.map((item, i) => ({ id: examples[i + 2].id, contextCosine: cosines[i],
      style: observableSimilarity(items[0], item), combined: similarScore(items[0], item, cosines[i]) }));
    model.close();
    const initial = await env.launch({ SAINT_LOOK_MODEL_PROFILE: 'disabled', SAINT_LOOK_TEST_MODEL_ORIGIN: '' }); await initial.stop();
    installReceiptFixture(env.directory, items, 'real');
    const server = await env.launch(modelEnv), config = await waitForModelConfiguration(server, 120_000);
    assert.equal(config.encoder.activeSpaceID, status.activeSpaceID);
    const target = slot('body', { item: items[0] }), context = slot('bottom', { item: items[1] });
    const results = [];
    for (const intent of ['complement', 'similar']) {
      const input = singleInput(items.map(item => ({ item })), [target, context], target, { intent });
      const started = performance.now(), response = await postJSON(server, '/v1/recommendations/single', input), body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.outcome, 'proposed'); assert.equal(body.intent, intent);
      const index = items.findIndex(item => item.itemId === body.proposal.itemId); assert.ok(index >= 2);
      results.push({ intent, selected: examples[index].id, elapsedMilliseconds: Math.round((performance.now() - started) * 100) / 100 });
    }
    const evidence = { evidence: 'public-photo-two-intentions-real-context', spaceID: status.activeSpaceID,
      modelRevision: '7eaf8d92beb709db20498614b1bc04e43f08136a', modelThreads: 1,
      source: 'white-tee', context: ['blue-jeans'], inputs: examples, diagnosticScores, results, imageProviderCalls: 0,
      limitations: ['Effective traits are manually specified input fixtures after agent visual inspection, not actual JEV extraction.',
        'Receipt fixtures do not prove live full item preparation or iOS acceptance.',
        'No second t_shirt exists: any selected candidate is a permitted imperfect analogue.',
        'Outcomes may match across intentions; neither score is a human taste rating.',
        'Local HTTP timing excludes network to device and first displayed frame.'] };
    if (process.env.SAINT_LOOK_SIMILAR_EVIDENCE) await writeFile(process.env.SAINT_LOOK_SIMILAR_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  });
