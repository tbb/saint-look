import { readFileSync } from 'node:fs';

export const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url), 'utf8'));

export function initializeDataVersion(database) {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  // Version zero is the existing unversioned catalog. This release introduces
  // the marker without changing its application schema. Never lower a marker.
  if (version !== 0 && (version < release.minDataVersion || version > release.maxDataVersion)) {
    throw new Error('Unsupported data version; code rollback cannot restore this database.');
  }
  if (version === 0) database.exec(`PRAGMA user_version=${release.dataVersion}`);
}
