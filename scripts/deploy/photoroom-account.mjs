import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { photoroomConfiguration } from '../../backend/src/photoroom-config.mjs';

class AccountError extends Error {}

export async function inspectPhotoroomAccount(env, fetchImpl = fetch) {
  const config = photoroomConfiguration(env);
  if (!config.configured || config.mode !== 'production') throw new AccountError('Production Photoroom configuration is incomplete.');
  const response = await fetchImpl('https://image-api.photoroom.com/v2/account', {
    method: 'GET', headers: { 'x-api-key': config.key }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AccountError(`Photoroom account check returned HTTP ${response.status}.`);
  }
  const value = await response.json();
  if (![value.images?.available, value.images?.subscription].every(n => Number.isFinite(n) && n >= 0)) {
    throw new AccountError('Photoroom account response did not contain valid credit counts.');
  }
  return { photoroomMode: 'production', accountVerified: true,
    plan: ['basic', 'plus', 'enterprise', 'trial', 'free'].includes(value.plan) ? value.plan : 'other',
    availableImages: value.images.available, subscriptionImages: value.images.subscription, imagesProcessed: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  inspectPhotoroomAccount(process.env).then(value => console.log(JSON.stringify(value))).catch(error => {
    console.error(error instanceof AccountError ? error.message : 'Photoroom account check failed; private output withheld.');
    process.exitCode = 1;
  });
}
