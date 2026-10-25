import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';

const command = resolve('scripts/deploy/prepare-release.mjs');
const jobs = ['changes', 'backend', 'ios', 'container', 'deploy-policy'];
async function fixture(t, checked = false, prepare = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'saint-look-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'test@example.invalid');
  await mkdir(join(directory, 'backend'));
  await writeFile(join(directory, 'fly.toml'), '# checked Fly release\n');
  await writeFile(join(directory, 'backend/release.json'), JSON.stringify({ format: 1, dataVersion: 1, minDataVersion: 1, maxDataVersion: 1, profile: 'controlled-http' }));
  await writeFile(join(directory, 'backend/source.txt'), 'checked source\n');
  await prepare(directory);
  git('add', '.'); git('commit', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const state = { checked, event: 'push', jobs: jobs.map(name => ({ name, status: 'completed', conclusion: 'success' })) };
  const api = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/ci.yml/runs')) {
      assert.equal(url.searchParams.get('head_sha'), sha);
      response.end(JSON.stringify({ workflow_runs: state.checked ? [{ id: 42, head_sha: sha, head_branch: 'main', event: state.event, path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', head_repository: { full_name: 'fixture/project' } }] : [] }));
    } else if (url.pathname.endsWith('/42/jobs')) response.end(JSON.stringify({ jobs: state.jobs }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.close(); api.closeAllConnections(); });
  const output = join(directory, 'release');
  async function run(selected = sha, overrides = {}) {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [command, selected, output], { cwd: directory, env: {
        ...process.env, NODE_ENV: 'test', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'fixture/project', GH_TOKEN: 'fixture-token',
        SAINT_LOOK_DEPLOY_TEST_API: `http://127.0.0.1:${api.address().port}`, ...overrides,
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  }
  return { directory, output, sha, git, state, run };
}

test('an unchecked main commit cannot produce a deployment archive', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No successful main CI/);
  await assert.rejects(access(f.output));
  assert.doesNotMatch(result.stderr, /fixture-token/);
});

test('a fully checked main commit produces exactly its source plus the baked revision', async t => {
  const f = await fixture(t, true);
  await writeFile(join(f.directory, 'backend/source.txt'), 'uncommitted change\n');
  await writeFile(join(f.directory, 'secret.env'), 'must not upload');
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(f.output, 'backend/source.txt'), 'utf8'), 'checked source\n');
  assert.equal(await readFile(join(f.output, 'backend/REVISION'), 'utf8'), f.sha + '\n');
  await assert.rejects(access(join(f.output, 'secret.env')));
  assert.deepEqual(JSON.parse(result.stdout), { revision: f.sha, ciRunId: 42, dataVersion: 1 });
});

for (const job of ['backend', 'ios', 'container', 'deploy-policy']) {
  test(`a skipped ${job} job cannot authorize deployment`, async t => {
    const f = await fixture(t, true);
    f.state.jobs.find(value => value.name === job).conclusion = 'skipped';
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Required CI job did not pass/);
    await assert.rejects(access(f.output));
  });
}

test('dispatch from another branch and abbreviated or injected refs are rejected before upload', async t => {
  const f = await fixture(t, true);
  for (const sha of ['main', f.sha.slice(0, 12), '--help', f.sha + ';echo unsafe']) {
    assert.match((await f.run(sha)).stderr, /full lowercase commit SHA/);
  }
  assert.match((await f.run(f.sha, { GITHUB_REF: 'refs/heads/unreviewed' })).stderr, /workflow from main/);
  await assert.rejects(access(f.output));
});

test('a commit outside main is rejected even when it exists locally', async t => {
  const f = await fixture(t, true);
  f.git('checkout', '-b', 'side');
  await writeFile(join(f.directory, 'side.txt'), 'side'); f.git('add', '.'); f.git('commit', '-m', 'side');
  const result = await f.run(f.git('rev-parse', 'HEAD'));
  assert.equal(result.code, 1); assert.match(result.stderr, /not part of main/);
  await assert.rejects(access(f.output));
});


test('manual CI cannot substitute for the complete main push checks', async t => {
  const f = await fixture(t, true); f.state.event = 'workflow_dispatch';
  const result = await f.run();
  assert.equal(result.code, 1); assert.match(result.stderr, /No successful main CI/);
  await assert.rejects(access(f.output));
});


test('a checked commit cannot smuggle files through a release symlink', async t => {
  const f = await fixture(t, true, directory => symlink('/tmp', join(directory, 'outside')));
  const result = await f.run();
  assert.equal(result.code, 1); assert.match(result.stderr, /symlinks are not supported/);
  await assert.rejects(access(f.output));
});

test('a checked historical release without the compatibility manifest cannot be rolled back', async t => {
  const f = await fixture(t, true, directory => rm(join(directory, 'backend/release.json')));
  const result = await f.run();
  assert.equal(result.code, 1); assert.match(result.stderr, /no supported release manifest/);
  await assert.rejects(access(f.output));
});


test('a checked Railway-only historical commit is not a Fly rollback target', async t => {
  const f = await fixture(t, true, directory => rm(join(directory, 'fly.toml')));
  const result = await f.run();
  assert.equal(result.code, 1); assert.match(result.stderr, /no Fly deployment configuration/);
  await assert.rejects(access(f.output));
});
