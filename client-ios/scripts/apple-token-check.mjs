#!/usr/bin/env node
// Standalone: Node.js 18+ and curl. No npm packages. Only GET /v1/apps?limit=1.
import { createPrivateKey, createPublicKey, createHash, sign, verify } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HELP = `Apple App Store Connect token check (Node.js 18+ and curl)

node apple-token-check.mjs --key ./AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX
node apple-token-check.mjs --key ./AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer-id UUID

Options:
  --key PATH        Private .p8 file; kept on this computer
  --key-id ID       Key ID from the same App Store Connect key (10 characters)
  --issuer-id UUID  Team-key Issuer ID (not the 10-character Developer Team ID)
  --team-id ID      Optional Developer Team ID; recorded, never used as iss
  --mode MODE       both (default), team, or individual
  --out PATH        Shareable JSON report; existing files are never overwritten

Default: test Team if a valid issuer is supplied, plus Individual without iss.
Each mode makes ONE read-only curl request. No retries, redirects or Apple writes.
No private key, bearer token, raw Apple response or app names enter the report.
Exit codes: 0 = at least one mode returned 200; 1 = none did; 2 = local error.
`;

export function options(args) {
  const result = { mode: 'both' };
  const allowed = new Set(['key', 'key-id', 'issuer-id', 'team-id', 'mode', 'out']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Unknown option or missing value. Run with --help.');
    }
    result[key] = args[i + 1];
  }
  if (!result.key || !/^[A-Z0-9]{10}$/.test(result['key-id'] || '')) {
    throw new Error('Provide --key and --key-id (10 uppercase letters/digits).');
  }
  if (!['both', 'team', 'individual'].includes(result.mode)) throw new Error('Invalid --mode.');
  if (result['team-id'] && !/^[A-Z0-9]{10}$/.test(result['team-id'])) throw new Error('Invalid --team-id.');
  return result;
}

export function tokenFor(key, keyId, mode, issuer, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { ...(mode === 'team' ? { iss: issuer } : { sub: 'user' }),
    iat: now, exp: now + 300, aud: 'appstoreconnect-v1' };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode(header)}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' });
  if (!verify('sha256', Buffer.from(body), { key: createPublicKey(key), dsaEncoding: 'ieee-p1363' }, signature)) {
    throw new Error('Local signature verification failed.');
  }
  return { header, payload, token: `${body}.${signature.toString('base64url')}` };
}

export function request(token, runner = spawnSync) {
  // -q MUST be first: ignore ~/.curlrc (including verbose/trace/redirect settings).
  // Authorization goes via stdin, not process arguments or a file. Do not echo stderr.
  const args = ['-q', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '10',
    '--max-time', '30', '--request', 'GET', '--include', '--config', '-',
    '--write-out', '\n__ASC_STATUS__:%{http_code}\n', 'https://api.appstoreconnect.apple.com/v1/apps?limit=1'];
  const result = runner('curl', args, { input: `header = "Authorization: Bearer ${token}"\n`,
    encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    return { outcome: 'transport_error', curlExitCode: result.status,
      hint: result.error?.code === 'ENOENT' ? 'Install curl and retry.'
        : 'Check network, proxy, TLS trust and system time; no automatic retry was made.' };
  }
  const match = /\n__ASC_STATUS__:(\d{3})\s*$/.exec(result.stdout);
  if (!match) return { outcome: 'invalid_curl_response' };
  const httpStatus = Number(match[1]);
  let body = result.stdout.slice(0, match.index), headers = '';
  // Handle proxy CONNECT headers and interim responses without exposing their text.
  while (/^HTTP\/\S+ \d{3}/.test(body)) {
    const separator = /\r?\n\r?\n/.exec(body);
    if (!separator) break;
    headers = body.slice(0, separator.index);
    body = body.slice(separator.index + separator[0].length);
  }
  const serverDate = Date.parse(/^date:\s*(.+)$/im.exec(headers)?.[1] || '');
  let errorCodes = [], responseHasAppList = false;
  try {
    const json = JSON.parse(body);
    responseHasAppList = Array.isArray(json.data);
    errorCodes = (Array.isArray(json.errors) ? json.errors : []).map(error => error?.code)
      .filter(code => typeof code === 'string' && /^[A-Z][A-Z0-9_.-]{0,99}$/.test(code)).slice(0, 5);
  } catch { /* HTTP result is still useful; never echo an unknown response. */ }
  const hints = {
    200: 'Authentication accepted for this read request; signing/upload permissions are not tested.',
    401: 'Authentication rejected. Check key type, matching Key ID/.p8, revocation, issuer (Team only), and clock.',
    403: 'Access forbidden; check API access and role permissions. This does not verify signing permissions.',
    429: 'Rate limited. Stop and retry later.',
  };
  return { httpStatus, outcome: httpStatus === 200 && responseHasAppList ? 'accepted' : 'not_accepted', errorCodes,
    ...(Number.isFinite(serverDate) ? { serverTimeUTC: new Date(serverDate).toISOString(),
      approximateClockSkewSeconds: Math.round((Date.now() - serverDate) / 1000) } : {}),
    hint: httpStatus === 200 && !responseHasAppList ? 'Unexpected response body; authentication is not confirmed.'
      : hints[httpStatus] || 'Unexpected HTTP status; no redirect or retry was attempted.' };
}

export function diagnose(config, runner = spawnSync) {
  let key;
  try {
    if (!statSync(config.key).isFile() || statSync(config.key).size > 65536) throw new Error();
    key = createPrivateKey(readFileSync(config.key));
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
  } catch { throw new Error('Cannot read an unencrypted P-256 private key from --key. Check the original .p8 file.'); }
  const fileKeyId = /^(?:AuthKey|ApiKey)_([A-Z0-9]{10})\.p8$/.exec(basename(config.key))?.[1];
  const report = { reportVersion: 1, checkedAtUTC: new Date().toISOString(), nodeVersion: process.version,
    keyId: config['key-id'], teamId: config['team-id'] || null,
    teamIdUsedForAuthentication: false, keyFileNameMatchesKeyId: fileKeyId ? fileKeyId === config['key-id'] : null,
    publicKeySHA256: createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex'),
    request: 'GET https://api.appstoreconnect.apple.com/v1/apps?limit=1', attempts: [],
    appleWriteRequests: 0, applicationSigningTested: false };
  for (const mode of config.mode === 'both' ? ['team', 'individual'] : [config.mode]) {
    if (mode === 'team' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(config['issuer-id'] || '')) {
      report.attempts.push({ mode, outcome: 'not_sent', reason: 'Team mode needs a real UUID Issuer ID; a Team ID is not an issuer.' });
      continue;
    }
    const signed = tokenFor(key, config['key-id'], mode, config['issuer-id']);
    const response = request(signed.token, runner);
    report.attempts.push({ mode, jwtHeader: signed.header, jwtPayload: signed.payload,
      localSignatureVerified: true, ...response });
    if (response.httpStatus === 429 || response.outcome === 'transport_error') break;
  }
  return report;
}

function main() {
  if (process.argv.includes('--help')) { console.log(HELP); return; }
  try {
    const config = options(process.argv.slice(2));
    const output = resolve(config.out || `apple-token-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    // Reserve the report before network activity; never overwrite a key or previous report.
    writeFileSync(output, '', { flag: 'wx', mode: 0o600 });
    let report;
    try { report = diagnose(config); }
    catch (error) { report = { localError: error.message, appleWriteRequests: 0 }; }
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    console.log(`Report: ${output}`);
    process.exitCode = report.localError ? 2 : report.attempts.some(attempt => attempt.outcome === 'accepted') ? 0 : 1;
  } catch {
    console.error('Invalid options or report cannot be created. Use --help; choose a new --out path. No secret details were printed.');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
