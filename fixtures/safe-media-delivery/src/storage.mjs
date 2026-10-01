import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { LocalStorage } from 'emdash-source/storage/local.ts';

/** Fixture resolver: publication is performed only by the qualification runner. */
export function createFixtureStorage({ expectedDigest } = {}) {
  const directory = process.env.VERCO_MEDIA_FIXTURE_DIR;
  if (!directory) throw new Error('VERCO_MEDIA_FIXTURE_DIR is required for the disposable fixture.');
  const objects = new LocalStorage({ directory: join(directory, 'active'), baseUrl: '/unserved-objects' });
  return {
    async download(key) {
      if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error('NOT_FOUND');
      const db = new DatabaseSync(join(directory, 'media.sqlite'), { readOnly: true });
      let revision;
      try {
        revision = db.prepare(`
          SELECT r.object_key, r.digest FROM media m JOIN revisions r ON r.id = m.active_revision
          WHERE m.stable_key = ? AND m.deleted = 0
        `).get(key);
      } finally {
        db.close();
      }
      if (!revision) throw new Error('NOT_FOUND');
      if (expectedDigest && expectedDigest !== revision.digest) throw new Error('NOT_FOUND');
      return objects.download(revision.object_key);
    },
  };
}

export function getFixtureBuildRevision(key) {
  const db = new DatabaseSync(join(process.env.VERCO_MEDIA_FIXTURE_DIR, 'media.sqlite'), { readOnly: true });
  try {
    const revision = db.prepare(`
      SELECT r.digest FROM media m JOIN revisions r ON r.id = m.active_revision
      WHERE m.stable_key = ? AND m.deleted = 0
    `).get(key);
    if (!revision) throw new Error('Build source is missing or deleted.');
    return revision.digest;
  } finally {
    db.close();
  }
}
