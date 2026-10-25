// Upload a checked archive using trusted deployment configuration. Never log CLI diagnostics.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
try {
  const env = process.env;
  const app = env.FLY_APP_NAME;
  const profile = env.SAINT_LOOK_DEPLOYMENT_PROFILE || 'controlled-http';
  if (!['controlled-http', 'live'].includes(profile)) throw new Error('Unsupported deployment profile.');
  if (profile === 'live' && (env.AI_TRIAL_PREFLIGHT_VERIFIED !== 'true'
    || ![env.TYPESAFE_API_KEY, env.PHOTOROOM_API_KEY].every(key => /^[A-Za-z0-9_+/.=-]{8,1024}$/.test(key || '')))) {
    throw new Error('Live deployment requires verified account conditions and provider secrets.');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(app || '')) throw new Error('Configure an explicit Fly app name.');
  if (!env.FLY_API_TOKEN) throw new Error('Configure an app-scoped Fly deploy token.');
  if (!process.argv[2]) throw new Error('Provide the verified release directory.');
  const release = resolve(process.argv[2]);
  const revision = readFileSync(join(release, 'backend/REVISION'), 'utf8').trim();
  if (!/^[a-f0-9]{40}$/.test(revision) || !lstatSync(join(release, 'fly.toml')).isFile()) throw new Error('Verified Fly release is incomplete.');
  if (profile === 'live') {
    const manifest = JSON.parse(readFileSync(join(release, 'backend/release.json'), 'utf8'));
    if (!manifest.profiles?.includes('live')) throw new Error('Selected release does not support live.');
    if (manifest.providerConfig !== 'photoroom-jev-1.14.0-taxonomy-1') {
      throw new Error('Selected release has an incompatible provider configuration.');
    }
  }
  const cliEnvironment = { ...env, NO_COLOR: '1' };
  for (const name of Object.keys(cliEnvironment)) {
    if (name.startsWith('RAILWAY_') || name.startsWith('SAINT_LOOK_') || ['TYPESAFE_API_KEY', 'GEMINI_API_KEY', 'PHOTOROOM_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(name)) delete cliEnvironment[name];
  }
  function fly(args, timeout = 30000, input) {
    return execFileSync('flyctl', args, { env: cliEnvironment, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  }
  let volumes, machines, snapshots;
  try {
    volumes = JSON.parse(fly(['volumes', 'list', '--app', app, '--json']));
    machines = JSON.parse(fly(['machine', 'list', '--app', app, '--json'])) || [];
  } catch { throw new Error('Could not inspect the Fly app. No deployment was started.'); }
  if (!Array.isArray(volumes) || volumes.length !== 1) throw new Error('Prepare exactly one existing Fly volume before deployment.');
  const volume = volumes[0];
  if (volume.name !== 'saint_look_data' || volume.state !== 'created' || volume.region !== 'ams'
    || volume.size_gb !== 3 || volume.encrypted !== true || volume.auto_backup_enabled !== false
    || volume.host_dedication_id || volume.attached_alloc_id || !/^vol_[a-z0-9]+$/.test(volume.id || '')) {
    throw new Error('The Fly volume does not match the reviewed storage configuration.');
  }
  try { snapshots = JSON.parse(fly(['volumes', 'snapshots', 'list', volume.id, '--app', app, '--json'])) || []; }
  catch { throw new Error('Could not inspect volume snapshots. No deployment was started.'); }
  if (!Array.isArray(snapshots) || snapshots.length !== 0) throw new Error('Existing volume snapshots must be resolved before deployment.');
  if (!Array.isArray(machines) || machines.length > 1) throw new Error('The Fly app must have at most one Machine.');
  if (machines.length === 0) {
    if (volume.attached_machine_id) throw new Error('The volume is attached to an unexpected Machine.');
  } else {
    const machine = machines[0];
    const config = machine.config;
    if (machine.region !== 'ams' || !['started', 'stopped', 'suspended'].includes(machine.state)
      || volume.attached_machine_id !== machine.id || config?.guest?.cpu_kind !== 'shared'
      || config.guest.cpus !== 1 || config.guest.memory_mb !== 1024
      || config.metadata?.fly_process_group !== 'app' || config.mounts?.length !== 1
      || config.mounts[0].volume !== volume.id || config.mounts[0].path !== '/data') {
      throw new Error('The Fly Machine does not match the reviewed single-instance configuration.');
    }
  }
  // flyctl resolves the Dockerfile relative to --config, so keep trusted operational
  // config inside the clean archive: both Dockerfile and build context stay at the selected SHA.
  const deploymentConfig = join(release, 'fly.toml');
  copyFileSync(fileURLToPath(new URL('../../fly.toml', import.meta.url)), deploymentConfig);
  if (profile === 'live') {
    try {
      fly(['secrets', 'import', '--stage', '--app', app], 30000,
        `TYPESAFE_API_KEY=${env.TYPESAFE_API_KEY}\nPHOTOROOM_API_KEY=${env.PHOTOROOM_API_KEY}\n`);
    } catch { throw new Error('Could not stage provider secrets. No deployment was started.'); }
  }
  const deploymentId = randomUUID();
  try {
    fly(['deploy', release, '--app', app, '--config', deploymentConfig,
      '--local-only', '--ha=false', '--strategy', 'immediate', '--deploy-retries', '0',
      '--env', `SAINT_LOOK_DEPLOYMENT_ID=${deploymentId}`,
      '--env', `SAINT_LOOK_DEPLOYMENT_PROFILE=${profile}`,
      '--env', `SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED=${profile === 'live'}`, '--yes'], 600000);
  } catch { throw new Error('Fly deploy did not complete. Check Fly before attempting another deployment.'); }
  // This is our per-attempt marker, injected into the deployed process, not a Fly resource ID.
  console.log(JSON.stringify({ revision, deploymentId, profile }));
} catch (error) {
  console.error(error instanceof Error && !error.message.includes('Command failed') ? error.message : 'Deployment upload failed.');
  process.exitCode = 1;
}
