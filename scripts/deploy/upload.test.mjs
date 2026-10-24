import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const command = resolve('scripts/deploy/upload.mjs');
const id = '12345678-1234-1234-1234-123456789abc';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'saint-look-upload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'release'); mkdirSync(release); mkdirSync(join(release, 'backend'));
  writeFileSync(join(release, 'backend/REVISION'), 'a'.repeat(40)); writeFileSync(join(release, 'railway.json'), '{}');
  writeFileSync(join(root, 'railway'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), accountTokenPresent: !!process.env.RAILWAY_API_TOKEN }));
if (process.env.FAIL_UPLOAD) { console.error(process.env.RAILWAY_TOKEN); process.exit(1); }
console.log(JSON.stringify({ deploymentId: '${id}', logsUrl: 'https://railway.com/unused' }));
`, { mode: 0o700 });
  const capture = join(root, 'capture.json');
  const run = overrides => spawnSync(process.execPath, [command, release], { encoding: 'utf8', env: { ...process.env,
    PATH: root + ':' + process.env.PATH, CAPTURE: capture, RAILWAY_TOKEN: 'fixture-secret-project-token',
    RAILWAY_API_TOKEN: 'unrelated-account-token', RAILWAY_PROJECT_ID: id, RAILWAY_ENVIRONMENT_ID: id, RAILWAY_SERVICE_ID: id, ...overrides,
  } });
  return { release, capture, run };
}
test('upload targets existing IDs and sends only the environment project token', t => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(f.capture));
  assert.equal(observed.accountTokenPresent, false);
  assert.deepEqual(observed.args, ['up', f.release, '--path-as-root', '--no-gitignore', '--project', id,
    '--environment', id, '--service', id, '--detach', '--json', '--message', 'a'.repeat(40)]);
  assert.doesNotMatch(result.stdout + result.stderr, /token|logsUrl/);
});
test('ambiguous upload failure hides CLI diagnostic secrets and asks for status inspection', t => {
  const f = fixture(t); const result = f.run({ FAIL_UPLOAD: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Check Railway before attempting another upload/);
  assert.doesNotMatch(result.stderr + result.stdout, /fixture-secret-project-token/);
});
