// Upload only the already-verified, isolated git archive. Never log CLI error bodies.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
try {
  const env = process.env;
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  for (const name of ['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID']) {
    if (!uuid.test(env[name] || '')) throw new Error(`Configure ${name} as an explicit ID.`);
  }
  if (!env.RAILWAY_TOKEN) throw new Error('Configure the project environment Railway token.');
  if (!process.argv[2]) throw new Error('Provide the verified release directory.');
  const release = resolve(process.argv[2]);
  const revision = readFileSync(join(release, 'backend/REVISION'), 'utf8').trim();
  if (!/^[a-f0-9]{40}$/.test(revision) || !lstatSync(join(release, 'railway.json')).isFile()) throw new Error('Verified release is incomplete.');
  let result;
  try {
    result = JSON.parse(execFileSync('railway', ['up', release, '--path-as-root', '--no-gitignore',
      '--project', env.RAILWAY_PROJECT_ID, '--environment', env.RAILWAY_ENVIRONMENT_ID,
      '--service', env.RAILWAY_SERVICE_ID, '--detach', '--json', '--message', revision,
    ], { encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { throw new Error('Railway upload did not return a deployment ID. Check Railway before attempting another upload.'); }
  if (!uuid.test(result.deploymentId || '')) throw new Error('Railway returned an invalid deployment ID.');
  console.log(JSON.stringify({ revision, deploymentId: result.deploymentId }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Deployment upload failed.');
  process.exitCode = 1;
}
