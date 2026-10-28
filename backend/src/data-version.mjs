import { readFileSync } from 'node:fs';

export const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url), 'utf8'));

export function initializeDataVersion(database) {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  // v2 owns illustration artifacts as well as ingestion artifacts. v1 cannot
  // clean those on delete/expiry, so the marker intentionally prevents rollback.
  // The additive schema is initialized idempotently by the corresponding modules.
  if (version === 1 && release.dataVersion === 2) {
    database.exec('PRAGMA user_version=2');
    return;
  }
  if (version !== 0 && (version < release.minDataVersion || version > release.maxDataVersion)) {
    throw new Error('Unsupported data version; code rollback cannot restore this database.');
  }
  if (version === 0) database.exec(`PRAGMA user_version=${release.dataVersion}`);
}
