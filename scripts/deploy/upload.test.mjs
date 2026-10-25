import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const command = resolve('scripts/deploy/upload.mjs');
const app = 'saint-look-fixture';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'saint-look-upload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'release'); mkdirSync(release); mkdirSync(join(release, 'backend'));
  writeFileSync(join(release, 'backend/REVISION'), 'a'.repeat(40)); writeFileSync(join(release, 'fly.toml'), '# selected historical config must not drive deploy\n');
  const volume = { id: 'vol_fixture', name: 'saint_look_data', state: 'created', size_gb: 3, region: 'ams', encrypted: true, auto_backup_enabled: false, attached_machine_id: null };
  const machine = { id: 'machine_fixture', region: 'ams', state: 'started', config: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 }, mounts: [{ volume: volume.id, path: '/data' }], metadata: { fly_process_group: 'app' } } };
  const statePath = join(root, 'state.json');
  const state = { volumes: [volume], machines: [], snapshots: [] };
  const capture = join(root, 'capture.jsonl');
  writeFileSync(join(root, 'flyctl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE));
fs.appendFileSync(process.env.CAPTURE, JSON.stringify({ args, token: process.env.FLY_API_TOKEN, ownerTokenPresent: !!process.env.SAINT_LOOK_DEV_OWNER_TOKEN, railwayTokenPresent: !!process.env.RAILWAY_TOKEN }) + '\\n');
if (args[0] === 'deploy') {
  if (state.fail) { console.error(process.env.FLY_API_TOKEN); process.exit(1); }
  process.exit(0);
}
console.log(JSON.stringify(args[0] === 'machine' ? state.machines : args[1] === 'snapshots' ? state.snapshots : state.volumes));
`, { mode: 0o700 });
  const run = () => {
    writeFileSync(statePath, JSON.stringify(state));
    return spawnSync(process.execPath, [command, release], { encoding: 'utf8', env: { ...process.env,
      PATH: root + ':' + process.env.PATH, FIXTURE_STATE: statePath, CAPTURE: capture,
      FLY_API_TOKEN: 'fixture-scoped-token', FLY_APP_NAME: app,
      SAINT_LOOK_DEV_OWNER_TOKEN: 'unrelated-owner-secret', RAILWAY_TOKEN: 'unrelated-railway-token',
    } });
  };
  const calls = () => existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { release, state, volume, machine, calls, run };
}

test('a checked release deploys to its explicit app and existing volume with a fresh attempt marker', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const identity = JSON.parse(result.stdout);
  assert.equal(identity.revision, 'a'.repeat(40));
  assert.match(identity.deploymentId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  const calls = f.calls();
  assert.deepEqual(calls.slice(0, 3).map(call => call.args), [
    ['volumes', 'list', '--app', app, '--json'],
    ['machine', 'list', '--app', app, '--json'],
    ['volumes', 'snapshots', 'list', 'vol_fixture', '--app', app, '--json'],
  ]);
  const deploy = calls[3].args;
  assert.equal(deploy[0], 'deploy'); assert.equal(deploy[1], f.release);
  assert.equal(deploy[deploy.indexOf('--app') + 1], app);
  assert.equal(deploy[deploy.indexOf('--config') + 1], resolve('fly.toml'));
  assert.ok(deploy.includes('--local-only')); assert.ok(deploy.includes('--ha=false'));
  assert.equal(deploy[deploy.indexOf('--strategy') + 1], 'immediate');
  assert.equal(deploy[deploy.indexOf('--env') + 1], `SAINT_LOOK_DEPLOYMENT_ID=${identity.deploymentId}`);
  assert.ok(calls.every(call => call.token === 'fixture-scoped-token' && !call.ownerTokenPresent && !call.railwayTokenPresent));
  assert.doesNotMatch(result.stdout + result.stderr, /token|secret/);
});

test('deployment refuses missing, extra, unencrypted, snapshot-enabled or differently sized volumes', t => {
  const f = fixture(t);
  for (const volumes of [[], [f.volume, { ...f.volume, id: 'vol_extra' }],
    [{ ...f.volume, size_gb: 4 }], [{ ...f.volume, name: 'other_data' }],
    [{ ...f.volume, region: 'fra' }], [{ ...f.volume, encrypted: false }],
    [{ ...f.volume, auto_backup_enabled: true }]]) {
    f.state.volumes = volumes;
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.ok(f.calls().every(call => call.args[0] !== 'deploy'));
  }
});

test('existing machine must be the single reviewed instance attached to the original volume', t => {
  const f = fixture(t);
  f.volume.attached_machine_id = f.machine.id;
  for (const machines of [[f.machine, { ...f.machine, id: 'extra' }],
    [{ ...f.machine, region: 'fra' }], [{ ...f.machine, config: { ...f.machine.config, guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 1024 } } }],
    [{ ...f.machine, config: { ...f.machine.config, mounts: [{ volume: 'vol_other', path: '/data' }] } }]]) {
    f.state.machines = machines;
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.ok(f.calls().every(call => call.args[0] !== 'deploy'));
  }
  f.state.machines = [f.machine];
  assert.equal(f.run().status, 0);
});

test('retained disk snapshots block a deployment that claims no backups', t => {
  const f = fixture(t); f.state.snapshots = [{ id: 'vs_retained' }];
  assert.equal(f.run().status, 1);
  assert.ok(f.calls().every(call => call.args[0] !== 'deploy'));
});


test('ambiguous deployment errors hide CLI diagnostics and require inspection before retry', t => {
  const f = fixture(t); f.state.fail = true;
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Check Fly before attempting another deployment/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-scoped-token/);
  assert.equal(f.calls().filter(call => call.args[0] === 'deploy').length, 1);
});

test('deploying the same source again produces a different attempt marker', t => {
  const f = fixture(t);
  const first = f.run(), second = f.run();
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  assert.notEqual(JSON.parse(first.stdout).deploymentId, JSON.parse(second.stdout).deploymentId);
});
