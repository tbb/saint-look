import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { signingConfiguration, appleToken, appleClient, provision } from '../testflight-signing.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const env = {
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', IOS_TESTFLIGHT_ENABLED: 'true',
  GITHUB_RUN_ATTEMPT: '1', ASC_KEY_ID: 'ABCDEFGHIJ', ASC_ISSUER_ID: '01234567-89ab-cdef-0123-456789abcdef',
  ASC_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), IOS_IPA_AGE_RECIPIENT: 'age1' + 'a'.repeat(58),
};
const config = signingConfiguration(env);

test('setup refuses PRs, branches, retries and existing assets', () => {
  for (const patch of [ { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_RUN_ATTEMPT: '2' }, { IOS_TESTFLIGHT_ENABLED: '' }, { IOS_DISTRIBUTION_P12_BASE64: 'existing' },
    { IOS_APP_STORE_PROFILE_BASE64: 'existing' }, { ASC_PRIVATE_KEY: '' } ]) {
    assert.throws(() => signingConfiguration({ ...env, ...patch }));
  }
});

test('Apple JWT is verifiable ES256 with five-minute lifetime', () => {
  const [header, payload, signature] = appleToken(config, 1000).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    iss: env.ASC_ISSUER_ID, iat: 1000, exp: 1300, aud: 'appstoreconnect-v1',
  });
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url')));
});

test('HTTP failures never retry, revoke or expose Apple response contents', async () => {
  const calls = [];
  const api = appleClient(config, async (...args) => { calls.push(args); return { ok: false, status: 403,
    json: () => { throw new Error('PRIVATE RESPONSE'); } }; });
  await assert.rejects(api('/v1/certificates', 'POST', {}), /HTTP 403/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://api.appstoreconnect.apple.com/v1/certificates');
  assert.equal(calls[0][1].redirect, 'error');
  await assert.rejects(api('/v1/certificates/id', 'DELETE'), /Unsupported/);
  assert.equal(calls.length, 1);
});

async function exercise({ existing = true, failProfile = false } = {}) {
  const requests = [], checkpoints = [], writes = {};
  const receipt = {};
  const bundle = { id: 'bundle-id', attributes: { identifier: config.bundle } };
  const files = { receipt, csr: 'fake-csr', write: (name, bytes) => { writes[name] = bytes; } };
  const api = async (path, method = 'GET', data) => {
    requests.push({ path, method, data });
    if (method === 'GET') return { data: existing ? [bundle] : [] };
    if (path === '/v1/bundleIds') return { data: bundle };
    if (path === '/v1/certificates') {
      assert.equal(checkpoints.at(-1).bundleId, bundle.id);
      return { data: { id: 'cert-id', attributes: { certificateContent: Buffer.from('cert').toString('base64') } } };
    }
    if (path === '/v1/profiles') {
      assert.equal(checkpoints.at(-1).certificateId, 'cert-id');
      assert.equal(writes['certificate.cer'].toString(), 'cert');
      if (failProfile) throw new Error('profile creation failed');
      return { data: { id: 'profile-id', attributes: { profileContent: Buffer.from('profile').toString('base64') } } };
    }
    throw new Error('unexpected request');
  };
  const promise = provision(config, api, files, () => checkpoints.push({ ...receipt }));
  if (failProfile) await assert.rejects(promise, /profile creation failed/);
  else await promise;
  return { requests, checkpoints, writes, receipt };
}

test('reuses bundle and creates one certificate/profile with correct relationships', async () => {
  const { requests, receipt, writes } = await exercise();
  assert.deepEqual(requests.map(row => row.method), ['GET', 'POST', 'POST']);
  assert.equal(requests[1].data.attributes.certificateType, 'DISTRIBUTION');
  assert.equal(requests[2].data.attributes.profileType, 'IOS_APP_STORE');
  assert.deepEqual(requests[2].data.relationships, {
    bundleId: { data: { type: 'bundleIds', id: 'bundle-id' } },
    certificates: { data: [{ type: 'certificates', id: 'cert-id' }] },
  });
  assert.equal(receipt.profileId, 'profile-id');
  assert.equal(writes['app.mobileprovision'].toString(), 'profile');
});

test('registers missing bundle before making signing assets', async () => {
  const { requests } = await exercise({ existing: false });
  assert.equal(requests[1].path, '/v1/bundleIds');
  assert.equal(requests[1].data.attributes.identifier, config.bundle);
});

test('partial failure retains certificate receipt without duplicate creation', async () => {
  const { requests, checkpoints, receipt } = await exercise({ failProfile: true });
  assert.equal(receipt.certificateId, 'cert-id');
  assert.equal(receipt.profileId, undefined);
  assert.equal(checkpoints.at(-1).certificateId, 'cert-id');
  assert.equal(requests.filter(row => row.path === '/v1/certificates').length, 1);
});
