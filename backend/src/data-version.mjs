import { readFileSync } from 'node:fs';

export const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url), 'utf8'));

export function initializeDataVersion(database) {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  // v4 enforces encoder-ready publication. Older code cannot enforce this
  // receipt, so rolling back code after publication is deliberately rejected.
  // The additive schema is initialized idempotently by the corresponding modules.
  if ([1, 2, 3].includes(version) && release.dataVersion === 4) {
    database.exec('PRAGMA user_version=4');
    return;
  }
  if (version !== 0 && (version < release.minDataVersion || version > release.maxDataVersion)) {
    throw new Error('Unsupported data version; code rollback cannot restore this database.');
  }
  if (version === 0) database.exec(`PRAGMA user_version=${release.dataVersion}`);
}
