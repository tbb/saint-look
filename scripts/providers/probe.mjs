// One-off account checks. Output only allowlisted public metadata; never raw provider bodies.
import { appendFileSync, writeFileSync } from 'node:fs';
const report = { time: new Date().toISOString(), checks: [] };
const count = value => Number.isFinite(value) && value >= 0 ? value : null;
async function check(name, url, headers, select) {
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const result = { name, status: response.status };
    if (response.ok) {
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 65536) throw new Error('oversized');
        chunks.push(chunk);
      }
      Object.assign(result, select(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    } else await response.body?.cancel();
    report.checks.push(result);
  } catch { report.checks.push({ name, error: 'request_or_response_failed_no_retry' }); }
}
for (const [name, variable] of [['photoroom_live_account', 'PHOTOROOM_API_KEY'], ['photoroom_sandbox_account', 'PHOTOROOM_SANDBOX_API_KEY']]) {
  if (!process.env[variable]) throw new Error('Required secret is missing');
  await check(name, 'https://image-api.photoroom.com/v2/account', { 'x-api-key': process.env[variable] }, data => ({
    plan: typeof data.plan === 'string' && /^[a-z_-]{1,24}$/.test(data.plan) ? data.plan : null,
    available: count(data.images?.available), subscription: count(data.images?.subscription),
  }));
}
if (!process.env.TYPESAFE_API_KEY) throw new Error('Required secret is missing');
await check('jev_models', 'https://api.typesafe.ai/v1/models', { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` }, data => ({
  models: Array.isArray(data.models) ? data.models.map(model => model.name).filter(name => typeof name === 'string' && /^jev-[a-z0-9.-]{1,40}$/.test(name)) : [],
}));
const output = JSON.stringify(report, null, 2);
console.log(output);
writeFileSync('provider-check.json', output + '\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Read-only provider account checks; no images or inference requests sent.\n\n```json\n' + output + '\n```\n');
if (report.checks.some(check => check.status !== 200)) process.exitCode = 1;
