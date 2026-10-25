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
const secretInput = args[0] === 'secrets' ? fs.readFileSync(0, 'utf8') : undefined;
fs.appendFileSync(process.env.CAPTURE, JSON.stringify({ args, secretInput, token: process.env.FLY_API_TOKEN, ownerTokenPresent: !!process.env.SAINT_LOOK_DEV_OWNER_TOKEN, railwayTokenPresent: !!process.env.RAILWAY_TOKEN, providerKeyPresent: !!(process.env.TYPESAFE_API_KEY || process.env.PHOTOROOM_API_KEY || process.env.GEMINI_API_KEY), configText: args[0] === 'deploy' ? fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8') : undefined }) + '\\n');
if (args[0] === 'deploy') {
  if (state.fail) { console.error(process.env.FLY_API_TOKEN); process.exit(1); }
  process.exit(0);
}
console.log(JSON.stringify(args[0] === 'machine' ? state.machines : args[1] === 'snapshots' ? state.snapshots : state.volumes));
`, { mode: 0o700 });
  const run = (extra = {}) => {
    writeFileSync(statePath, JSON.stringify(state));
    return spawnSync(process.execPath, [command, release], { encoding: 'utf8', env: { ...process.env,
      PATH: root + ':' + process.env.PATH, FIXTURE_STATE: statePath, CAPTURE: capture,
      FLY_API_TOKEN: 'fixture-scoped-token', FLY_APP_NAME: app,
      SAINT_LOOK_DEV_OWNER_TOKEN: 'unrelated-owner-secret', RAILWAY_TOKEN: 'unrelated-railway-token', ...extra,
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
  assert.equal(deploy[deploy.indexOf('--config') + 1], join(f.release, 'fly.toml'));
  assert.equal(calls[3].configText, readFileSync(resolve('fly.toml'), 'utf8'));
  assert.doesNotMatch(calls[3].configText, /selected historical config/);
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


test('live upload stages provider secrets only on stdin and ordinary deploy explicitly resets controlled mode', t => {
  const f = fixture(t);
  writeFileSync(join(f.release, 'backend/release.json'), JSON.stringify({ profiles: ['controlled-http', 'live'], providerConfig: 'photoroom-jev-1.14.0-taxonomy-1' }));
  const result = f.run({ SAINT_LOOK_DEPLOYMENT_PROFILE: 'live', AI_TRIAL_PREFLIGHT_VERIFIED: 'true', TYPESAFE_API_KEY: 'typesafe-fixture-secret', PHOTOROOM_API_KEY: 'photoroom-fixture-secret' });
  assert.equal(result.status, 0, result.stderr);
  const secret = f.calls().find(call => call.args[0] === 'secrets');
  assert.ok(secret);
  assert.match(secret.secretInput, /TYPESAFE_API_KEY=typesafe-fixture-secret/);
  assert.match(secret.secretInput, /PHOTOROOM_API_KEY=photoroom-fixture-secret/);
  assert.ok(!JSON.stringify(secret.args).includes('fixture-secret'));
  assert.ok(f.calls().every(call => !call.providerKeyPresent));
  assert.ok(f.calls().find(call => call.args[0] === 'deploy').args.includes('SAINT_LOOK_DEPLOYMENT_PROFILE=live'));
  assert.equal(JSON.parse(result.stdout).profile, 'live');
  assert.equal(f.run().status, 0);
  const last = f.calls().filter(call => call.args[0] === 'deploy').at(-1);
  assert.ok(last.args.includes('SAINT_LOOK_DEPLOYMENT_PROFILE=controlled-http'));
  assert.ok(last.args.includes('SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED=false'));
});

test('live upload refuses absent account attestation or keys before invoking Fly', t => {
  const f = fixture(t);
  const r = f.run({ SAINT_LOOK_DEPLOYMENT_PROFILE: 'live' });
  assert.equal(r.status, 1);
  assert.equal(f.calls().length, 0);
});


test('live upload refuses the previous provider configuration before any Fly call', t => {
  const f = fixture(t);
  writeFileSync(join(f.release, 'backend/release.json'), JSON.stringify({ profiles: ['controlled-http', 'live'] }));
  const result = f.run({ SAINT_LOOK_DEPLOYMENT_PROFILE: 'live', AI_TRIAL_PREFLIGHT_VERIFIED: 'true', TYPESAFE_API_KEY: 'typesafe-fixture-secret', PHOTOROOM_API_KEY: 'photoroom-fixture-secret' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /provider configuration/);
  assert.equal(f.calls().length, 0);
});
