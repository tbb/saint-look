// The CLI boundary accepts a checked main commit and writes a clean upload tree.
import { execFileSync } from 'node:child_process';
import { mkdirSync, lstatSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function apiOrigin() {
  const configured = process.env.SAINT_LOOK_DEPLOY_TEST_API;
  if (!configured) return 'https://api.github.com';
  const url = new URL(configured);
  if (process.env.NODE_ENV !== 'test' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid test API configuration.');
  return url.origin;
}
async function github(path) {
  const response = await fetch(apiOrigin() + path, { headers: {
    Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('GitHub verification request failed.');
  return response.json();
}
try {
  const [sha, destination] = process.argv.slice(2);
  if (!destination) throw new Error('Provide a new release directory.');
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Select a full lowercase commit SHA.');
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Run the deployment workflow from main.');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !process.env.GH_TOKEN) throw new Error('GitHub verification configuration is incomplete.');
  if (git('rev-parse', '--verify', `${sha}^{commit}`) !== sha) throw new Error('Selected commit is unavailable.');
  try { git('merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'); }
  catch { throw new Error('Selected commit is not part of main.'); }
  const result = await github(`/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&status=success&per_page=100`);
  const run = result.workflow_runs?.find(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push'
    && run.path === '.github/workflows/ci.yml' && run.status === 'completed' && run.conclusion === 'success'
    && run.head_repository?.full_name === repository && Number.isSafeInteger(run.id));
  if (!run) throw new Error('No successful main CI for the selected commit.');
  const checked = await github(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  for (const name of ['changes', 'backend', 'ios', 'container', 'deploy-policy']) {
    const matches = checked.jobs?.filter(job => job.name === name) || [];
    if (!matches.length || matches.some(job => job.status !== 'completed' || job.conclusion !== 'success')) {
      throw new Error(`Required CI job did not pass: ${name}.`);
    }
  }
  const profile = process.env.SAINT_LOOK_DEPLOYMENT_PROFILE || 'controlled-http';
  if (!['controlled-http', 'live'].includes(profile)) throw new Error('Unsupported deployment profile.');
  let manifest;
  try { manifest = JSON.parse(git('show', `${sha}:backend/release.json`)); }
  catch { throw new Error('Selected commit has no supported release manifest.'); }
  if (manifest.format !== 1 || manifest.profile !== 'controlled-http' || ![1, 2, 3, 4].includes(manifest.dataVersion)
    || manifest.minDataVersion !== manifest.dataVersion || manifest.maxDataVersion !== manifest.dataVersion
    || (manifest.dataVersion === 4 && manifest.modelRuntime !== 'outfit-transformer-labse-v1')) {
    throw new Error('Selected release is not supported by this deployment workflow.');
  }
  if (profile === 'live' && !manifest.profiles?.includes('live')) throw new Error('Selected release does not support the selected profile.');
  if (profile === 'live' && manifest.providerConfig !== 'photoroom-jev-1.14.0-taxonomy-1') {
    throw new Error('Selected release has an incompatible provider configuration.');
  }
  if (manifest.dataVersion >= 4) {
    for (const name of ['ios-outfits', 'ios-visual-iphone-light', 'ios-visual-iphone-dark', 'ios-visual-iphone-max-text', 'ios-visual-ipad-light']) {
      const matches = checked.jobs?.filter(job => job.name === name) || [];
      if (!matches.length || matches.some(job => job.status !== 'completed' || job.conclusion !== 'success')) {
        throw new Error(`Required CI job did not pass: ${name}.`);
      }
    }
  }
  if (process.env.SAINT_LOOK_MODEL_PROFILE && process.env.SAINT_LOOK_MODEL_PROFILE !== 'disabled') {
    if (profile !== 'live' || process.env.SAINT_LOOK_MODEL_PROFILE !== manifest.modelRuntime) throw new Error('Selected release has an incompatible model runtime.');
    const images = await github(`/repos/${repository}/actions/workflows/model-image.yml/runs?head_sha=${sha}&branch=main&status=success&per_page=100`);
    const imageRun = images.workflow_runs?.find(value => value.head_sha === sha && value.head_branch === 'main'
      && value.event === 'push' && value.path === '.github/workflows/model-image.yml' && value.status === 'completed'
      && value.conclusion === 'success' && value.head_repository?.full_name === repository && Number.isSafeInteger(value.id));
    if (!imageRun) throw new Error('No successful real checkpoint image check for the selected main commit.');
    const imageJobs = await github(`/repos/${repository}/actions/runs/${imageRun.id}/jobs?filter=latest&per_page=100`);
    const matches = imageJobs.jobs?.filter(job => job.name === 'checkpoint-image') || [];
    if (!matches.length || matches.some(job => job.status !== 'completed' || job.conclusion !== 'success')) {
      throw new Error('Required real checkpoint image job did not pass.');
    }
  }
  try { git('show', `${sha}:fly.toml`); }
  catch { throw new Error('Selected release has no Fly deployment configuration.'); }
  if (git('ls-tree', '-r', sha).split('\n').some(entry => entry.startsWith('120000 '))) throw new Error('Release symlinks are not supported.');
  const output = resolve(destination);
  mkdirSync(output, { mode: 0o700 });
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', sha], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('tar', ['-x', '-C', output], { input: archive, stdio: ['pipe', 'ignore', 'pipe'] });
    if (!lstatSync(join(output, 'backend')).isDirectory()) throw new Error('Invalid backend release directory.');
    writeFileSync(join(output, 'backend/REVISION'), sha + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify({ revision: sha, ciRunId: run.id, profile, dataVersion: manifest.dataVersion }));
} catch (error) {
  console.error(error instanceof Error && !error.message.includes('Command failed') ? error.message : 'Release verification failed.');
  process.exitCode = 1;
}
