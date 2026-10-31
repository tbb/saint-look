// Real OpenSSL 3 -> macOS Security compatibility, using a disposable self-signed
// identity. No Apple account, real certificate or signing secret is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportIdentity } from '../testflight-signing.mjs';

test('OpenSSL 3 identity imports into a temporary macOS keychain', { skip: process.platform !== 'darwin' }, () => {
  process.umask(0o077);
  const work = mkdtempSync(join(tmpdir(), 'saint-look-test-keychain-'));
  const keychain = join(work, 'test.keychain-db');
  const command = (name, args) => execFileSync(name, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  const openssl = join(command('brew', ['--prefix', 'openssl@3']).toString().trim(), 'bin/openssl');
  const useOpenSSL3 = (name, args) => command(name === 'openssl' ? openssl : name, args);
  try {
    assert.match(command(openssl, ['version']).toString(), /^OpenSSL 3\./);
    command(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=SaintLookDisposableTest', '-keyout', join(work, 'private-key.pem'),
      '-out', join(work, 'certificate.pem')]);
    const passwordPath = join(work, 'password.txt');
    writeFileSync(passwordPath, 'disposable-test-password');
    exportIdentity(useOpenSSL3, work, passwordPath);
    command('security', ['create-keychain', '-p', 'disposable-keychain', keychain]);
    command('security', ['unlock-keychain', '-p', 'disposable-keychain', keychain]);
    command('security', ['import', join(work, 'distribution.p12'), '-k', keychain,
      '-P', 'disposable-test-password', '-T', '/usr/bin/codesign']);
    assert.match(command('security', ['find-identity', keychain]).toString(), /SaintLookDisposableTest/);
  } finally {
    try { command('security', ['delete-keychain', keychain]); } catch { /* creation may have failed */ }
    rmSync(work, { recursive: true, force: true });
  }
});
