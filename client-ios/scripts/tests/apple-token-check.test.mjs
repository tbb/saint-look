import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { options, tokenFor, request, diagnose } from '../apple-token-check.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keyId = 'ABCDEFGHIJ', issuer = '12345678-abcd-1234-abcd-1234567890ab';

test('both JWT modes verify with ES256 and carry the correct identity claims', () => {
  for (const mode of ['team', 'individual']) {
    const signed = tokenFor(privateKey, keyId, mode, issuer, 1000);
    const [header, payload, signature] = signed.token.split('.');
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.exp - claims.iat, 300);
    assert.equal(claims.aud, 'appstoreconnect-v1');
    assert.equal(claims.iss, mode === 'team' ? issuer : undefined);
    assert.equal(claims.sub, mode === 'individual' ? 'user' : undefined);
  }
});

test('curl uses stdin for bearer; rejects redirects and suppresses private response details', () => {
  const token = 'PRIVATE_BEARER_TOKEN';
  const result = request(token, (command, args, config) => {
    assert.equal(command, 'curl');
    assert.equal(args[0], '-q');
    assert.ok(!args.join(' ').includes(token));
    assert.ok(!args.includes('--location'));
    assert.ok(config.input.includes(token));
    return { status: 0, stdout: 'HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 401\r\nDate: Sun, 01 Nov 2026 00:00:00 GMT\r\n\r\n'
      + JSON.stringify({ errors: [{ code: 'NOT_AUTHORIZED', detail: token + ' private account name' }] })
      + '\n__ASC_STATUS__:401\n' };
  });
  assert.equal(result.httpStatus, 401);
  assert.deepEqual(result.errorCodes, ['NOT_AUTHORIZED']);
  assert.equal(result.serverTimeUTC, '2026-11-01T00:00:00.000Z');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes('private account'));
  assert.equal(request(token, () => ({ status: 60, stderr: token })).outcome, 'transport_error');
  assert.equal(request(token, () => ({ status: 0,
    stdout: 'HTTP/2 200\r\n\r\n<html>Proxy login</html>\n__ASC_STATUS__:200\n' })).outcome, 'not_accepted');
});

test('invalid Team issuer is never sent; Individual has no issuer and reports no secret', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apple-token-check-test-'));
  const key = join(directory, `AuthKey_${keyId}.p8`);
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(key, pem, { mode: 0o600 });
  let calls = 0;
  try {
    const config = options(['--key', key, '--key-id', keyId, '--issuer-id', '3JFB6R47R3', '--team-id', '3JFB6R47R3']);
    const report = diagnose(config, (_command, _args, requestConfig) => {
      calls++;
      const bearer = /Bearer ([^"]+)/.exec(requestConfig.input)[1];
      const payload = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url'));
      assert.equal(payload.sub, 'user');
      assert.ok(!Object.hasOwn(payload, 'iss'));
      return { status: 0, stdout: 'HTTP/2 200\r\n\r\n{"data":[{"name":"PRIVATE_APP"}]}\n__ASC_STATUS__:200\n' };
    });
    assert.equal(calls, 1);
    assert.equal(report.attempts[0].outcome, 'not_sent');
    assert.equal(report.attempts[1].httpStatus, 200);
    assert.ok(report.keyFileNameMatchesKeyId);
    assert.ok(!JSON.stringify(report).includes('PRIVATE_APP'));
    assert.ok(!JSON.stringify(report).includes(pem));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual curl roundtrip against a local fixture parses headers and status', async () => {
  // Only this test substitutes loopback HTTP; the shipped CLI has no endpoint override.
  const server = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(req.headers.authorization === 'Bearer local-fixture' ? 200 : 401, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({data: [{name: 'PRIVATE_APP_NAME'}]}));
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const [ready] = await once(server.stdout, 'data');
    const port = Number(ready.toString().trim());
    assert.ok(port > 0);
    const result = request('local-fixture', (command, args, config) => spawnSync(command,
      args.map(arg => arg === '=https' ? '=http' : arg.startsWith('https://api.appstoreconnect.apple.com/')
        ? `http://127.0.0.1:${port}/v1/apps?limit=1` : arg), config));
    assert.equal(result.httpStatus, 200);
    assert.equal(result.outcome, 'accepted');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_APP_NAME'));
  } finally { server.kill(); await once(server, 'exit'); }
});

test('standalone CLI writes a shareable failure report and never overwrites input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apple-token-cli-test-'));
  const key = join(directory, `AuthKey_${keyId}.p8`), output = join(directory, 'report.json');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(key, pem, { mode: 0o600 });
  writeFileSync(join(directory, 'curl'), `#!/usr/bin/env node
    let input = ''; process.stdin.on('data', data => input += data);
    process.stdin.on('end', () => {
      if (!input.includes('Authorization: Bearer ')) process.exit(2);
      console.log('HTTP/2 401\\r\\n\\r\\n{"errors":[{"code":"NOT_AUTHORIZED","detail":"PRIVATE_DETAIL"}]}\\n__ASC_STATUS__:401');
    });
  `, { mode: 0o700 });
  const script = fileURLToPath(new URL('../apple-token-check.mjs', import.meta.url));
  const args = [script, '--key', key, '--key-id', keyId, '--out', output];
  const env = { ...process.env, PATH: directory + ':' + process.env.PATH };
  try {
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(output));
    assert.equal(report.attempts[1].httpStatus, 401);
    assert.ok(!readFileSync(output, 'utf8').includes('PRIVATE_DETAIL'));
    assert.ok(!result.stdout.includes(pem));
    assert.equal(readFileSync(key, 'utf8'), pem);
    assert.equal(spawnSync(process.execPath, [...args.slice(0, -1), key], { env }).status, 2);
    assert.equal(readFileSync(key, 'utf8'), pem);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
