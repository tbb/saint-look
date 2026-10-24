import { readFileSync } from 'node:fs';

export function readRevision(required = false) {
  let revision;
  try { revision = readFileSync(new URL('../REVISION', import.meta.url), 'utf8').trim(); }
  catch (error) {
    if (error.code === 'ENOENT' && !required) return 'development';
    throw new Error('A baked release revision is required.');
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Invalid baked release revision.');
  return revision;
}
