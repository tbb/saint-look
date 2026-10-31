// One-time signing setup on a hosted runner. No Apple password or local Mac.
import { createPrivateKey, sign, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function signingConfiguration(env) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main'
      || env.IOS_TESTFLIGHT_ENABLED !== 'true' || env.GITHUB_RUN_ATTEMPT !== '1') {
    throw new Error('Signing setup requires an enabled first-attempt manual main run');
  }
  if (env.IOS_DISTRIBUTION_P12_BASE64 || env.IOS_APP_STORE_PROFILE_BASE64) {
    throw new Error('Signing assets already configured; setup will not replace or revoke them');
  }
  const config = { keyId: env.ASC_KEY_ID, issuer: env.ASC_ISSUER_ID, privateKey: env.ASC_PRIVATE_KEY,
    bundle: env.IOS_TESTFLIGHT_BUNDLE_ID || 'com.saintlook.dev', recipient: env.IOS_IPA_AGE_RECIPIENT };
  if (!/^[A-Z0-9]{10}$/.test(config.keyId || '') || !/^[a-fA-F0-9-]{36}$/.test(config.issuer || '')
      || !/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+){2,}$/.test(config.bundle) || config.bundle.length > 200
      || !/^age1[0-9a-z]{58}$/.test(config.recipient || '')) throw new Error('Missing or invalid Apple signing configuration');
  const key = createPrivateKey(config.privateKey || '');
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('App Store Connect requires an ES256 private key');
  }
  return config;
}

export function appleToken(config, now = Math.floor(Date.now() / 1000)) {
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encoded({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })}.${encoded({
    iss: config.issuer, iat: now, exp: now + 300, aud: 'appstoreconnect-v1',
  })}`;
  return `${body}.${sign('sha256', Buffer.from(body), { key: config.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

export function appleClient(config, fetchImpl = fetch) {
  return async (path, method = 'GET', data) => {
    if (!path.startsWith('/v1/') || !['GET', 'POST'].includes(method)) throw new Error('Unsupported signing request');
    const response = await fetchImpl('https://api.appstoreconnect.apple.com' + path, {
      method, headers: { Authorization: `Bearer ${appleToken(config)}`, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify({ data }) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Apple signing request failed (HTTP ${response.status}); inspect the account before another setup run`);
    return response.json();
  };
}

function binary(content) {
  if (typeof content !== 'string' || content.length > 2 * 1024 * 1024
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Error('Invalid Apple signing asset');
  return Buffer.from(content, 'base64');
}

export async function provision(config, api, files, checkpoint) {
  const found = await api('/v1/bundleIds?filter[identifier]=' + encodeURIComponent(config.bundle));
  const matching = found.data?.filter(row => row.attributes?.identifier === config.bundle) || [];
  if (matching.length > 1) throw new Error('Ambiguous bundle identifier');
  let bundle = matching[0];
  if (!bundle) bundle = (await api('/v1/bundleIds', 'POST', { type: 'bundleIds',
    attributes: { identifier: config.bundle, name: 'Saint Look', platform: 'IOS' } })).data;
  if (!bundle?.id || bundle.attributes?.identifier !== config.bundle) throw new Error('Apple bundle response mismatch');
  files.receipt.bundleId = bundle.id;
  checkpoint();
  const certificate = (await api('/v1/certificates', 'POST', { type: 'certificates',
    attributes: { certificateType: 'DISTRIBUTION', csrContent: files.csr } })).data;
  if (!certificate?.id) throw new Error('Apple certificate receipt missing');
  // Persist the private key before the request and the receipt immediately after.
  // A failed/uncertain POST is never retried automatically or followed by revocation.
  files.receipt.certificateId = certificate.id;
  checkpoint();
  files.write('certificate.cer', binary(certificate.attributes?.certificateContent));
  checkpoint();
  const profile = (await api('/v1/profiles', 'POST', { type: 'profiles',
    attributes: { name: `Saint Look TestFlight ${config.bundle}`, profileType: 'IOS_APP_STORE' },
    relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } },
      certificates: { data: [{ type: 'certificates', id: certificate.id }] } } })).data;
  if (!profile?.id) throw new Error('Apple profile receipt missing');
  files.receipt.profileId = profile.id;
  checkpoint();
  files.write('app.mobileprovision', binary(profile.attributes?.profileContent));
  checkpoint();
}

async function main() {
  process.umask(0o077);
  const config = signingConfiguration(process.env);
  const output = process.argv[2];
  if (!output || !output.endsWith('.tar.age')) throw new Error('Choose an encrypted signing asset output');
  const destination = resolve(output);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'saint-look-signing-'));
  const assets = join(work, 'assets');
  mkdirSync(assets, { mode: 0o700 });
  const receipt = { bundleIdentifier: config.bundle, state: 'private-key-created' };
  const command = (name, args) => execFileSync(name, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  const checkpoint = () => {
    writeFileSync(join(assets, 'receipt.json'), JSON.stringify(receipt, null, 2));
    command('tar', ['-czf', join(work, 'assets.tar'), '-C', assets, '.']);
    command('age', ['--encrypt', '--recipient', config.recipient, '--output', join(work, 'assets.age'), join(work, 'assets.tar')]);
    renameSync(join(work, 'assets.age'), destination);
    rmSync(join(work, 'assets.tar'));
  };
  try {
    command('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(assets, 'private-key.pem'),
      '-out', join(assets, 'request.csr'), '-subj', '/CN=Saint Look TestFlight']);
    checkpoint();
    await provision(config, appleClient(config), { receipt, csr: readFileSync(join(assets, 'request.csr'), 'utf8'),
      write: (name, bytes) => writeFileSync(join(assets, name), bytes, { mode: 0o600 }) }, checkpoint);
    const passwordPath = join(assets, 'p12-password.txt');
    writeFileSync(passwordPath, randomBytes(32).toString('base64url'), { mode: 0o600 });
    command('openssl', ['x509', '-inform', 'DER', '-in', join(assets, 'certificate.cer'), '-out', join(assets, 'certificate.pem')]);
    command('openssl', ['pkcs12', '-export', '-inkey', join(assets, 'private-key.pem'), '-in', join(assets, 'certificate.pem'),
      '-out', join(assets, 'distribution.p12'), '-passout', `file:${passwordPath}`]);
    receipt.state = 'ready-for-github-secrets';
    checkpoint();
    console.log(JSON.stringify(receipt));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Signing setup did not finish. Inspect the encrypted recovery artifact and Apple account before another run; no private output was published.');
    process.exitCode = 1;
  });
}
