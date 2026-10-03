// The uploads-directory scan against a small database and directory: a clean state after a
// replacement and a restore, and each problem planted on its own.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { scanPublicStorage } from './public-storage.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const ORIGINAL_A = 'original bytes of a';
const OPTIMIZED_A = 'optimized bytes of a';
const ORIGINAL_B = 'original bytes of b';
const OPTIMIZED_B = 'optimized bytes of b';
const UNTOUCHED_C = 'uploaded bytes of c';

/**
 * Three media items as host patch 0010 leaves them: `a` optimized, `b` optimized and restored (its
 * original is active again, and its optimized file is retained too), `c` never replaced.
 */
function fixture({ cleanupColumn = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'public-storage-'));
  const uploads = join(root, 'uploads');
  const databasePath = join(root, 'site.db');
  const put = (key, text) => {
    mkdirSync(dirname(join(uploads, key)), { recursive: true });
    writeFileSync(join(uploads, key), text);
  };
  put('a.jpg', OPTIMIZED_A);
  put(`media-revisions/${sha(OPTIMIZED_A)}.jpg`, OPTIMIZED_A);
  put('b.jpg', ORIGINAL_B);
  put(`media-revisions/${sha(ORIGINAL_B)}.jpg`, ORIGINAL_B);
  put('c.jpg', UNTOUCHED_C);

  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE media (id TEXT PRIMARY KEY, storage_key TEXT, revision_id TEXT);
    CREATE TABLE _emdash_media_revisions (id TEXT PRIMARY KEY, media_id TEXT, object_key TEXT, sha256 TEXT);
    CREATE TABLE _emdash_media_originals (sha256 TEXT PRIMARY KEY, storage_key TEXT);
    CREATE TABLE _emdash_media_operations (operation_id TEXT, media_id TEXT, kind TEXT, state TEXT${cleanupColumn ? ', public_cleaned_at TEXT' : ''});
  `);
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  run('INSERT INTO media VALUES (?, ?, ?)', 'a', 'a.jpg', 'a2');
  run('INSERT INTO media VALUES (?, ?, ?)', 'b', 'b.jpg', 'b3');
  run('INSERT INTO media VALUES (?, ?, ?)', 'c', 'c.jpg', null);
  run('INSERT INTO _emdash_media_revisions VALUES (?, ?, ?, ?)', 'a1', 'a', 'a.jpg', sha(ORIGINAL_A));
  run('INSERT INTO _emdash_media_revisions VALUES (?, ?, ?, ?)', 'a2', 'a', `media-revisions/${sha(OPTIMIZED_A)}.jpg`, sha(OPTIMIZED_A));
  run('INSERT INTO _emdash_media_revisions VALUES (?, ?, ?, ?)', 'b1', 'b', 'b.jpg', sha(ORIGINAL_B));
  run('INSERT INTO _emdash_media_revisions VALUES (?, ?, ?, ?)', 'b2', 'b', `media-revisions/${sha(OPTIMIZED_B)}.jpg`, sha(OPTIMIZED_B));
  run('INSERT INTO _emdash_media_revisions VALUES (?, ?, ?, ?)', 'b3', 'b', `media-revisions/${sha(ORIGINAL_B)}.jpg`, sha(ORIGINAL_B));
  for (const text of [ORIGINAL_A, ORIGINAL_B, OPTIMIZED_B]) run('INSERT INTO _emdash_media_originals VALUES (?, ?)', sha(text), `originals/${sha(text)}`);
  const operation = (id, mediaId, kind, state, cleaned) =>
    cleanupColumn
      ? run('INSERT INTO _emdash_media_operations VALUES (?, ?, ?, ?, ?)', id, mediaId, kind, state, cleaned)
      : run('INSERT INTO _emdash_media_operations VALUES (?, ?, ?, ?)', id, mediaId, kind, state);
  operation('op-a', 'a', 'replace', 'published', '2026-01-01T00:00:00.000Z');
  operation('op-b1', 'b', 'replace', 'published', '2026-01-01T00:00:00.000Z');
  operation('op-b2', 'b', 'restore', 'published', '2026-01-01T00:00:00.000Z');
  operation('op-c', 'c', 'replace', 'aborted', null);
  db.close();
  return { root, uploads, databasePath, put, scan: (options = {}) => scanPublicStorage({ databasePath, uploadsDirectory: uploads, ...options }), sql: (text, ...values) => {
    const again = new DatabaseSync(databasePath);
    again.prepare(text).run(...values);
    again.close();
  } };
}

function withFixture(run, options) {
  const site = fixture(options);
  try {
    return run(site);
  } finally {
    rmSync(site.root, { recursive: true, force: true });
  }
}

test('a directory in line with its publications has no problem', () => {
  withFixture((site) => {
    const scan = site.scan();
    assert.deepEqual(scan.problems, []);
    assert.equal(scan.digests.size, 5);
    assert.equal(scan.managed.length, 2);
    assert.equal(scan.revisionObjects, 2);
    assert.equal(scan.pendingCleanups, 0);
    // The original of `b` is retained and active; only the two others must never be served.
    assert.deepEqual([...scan.retainedNotActive].toSorted(), [sha(ORIGINAL_A), sha(OPTIMIZED_B)].toSorted());
  });
});

test('an original left at its stable key is found, twice over', () => {
  withFixture((site) => {
    site.put('a.jpg', ORIGINAL_A);
    assert.deepEqual(site.scan().problems, [`a.jpg does not hold the active revision of a`, `a.jpg holds retained original ${sha(ORIGINAL_A)}`]);
  });
});

test('a retained original under any other name is found', () => {
  withFixture((site) => {
    site.put('backup/copy-of-a.jpg', ORIGINAL_A);
    site.put('c-old.jpg', OPTIMIZED_B);
    assert.deepEqual(site.scan().problems, [`backup/copy-of-a.jpg holds retained original ${sha(ORIGINAL_A)}`, `c-old.jpg holds retained original ${sha(OPTIMIZED_B)}`]);
  });
});

test('a superseded revision object is found, as an extra object and as a retained original', () => {
  withFixture((site) => {
    const key = `media-revisions/${sha(OPTIMIZED_B)}.jpg`;
    site.put(key, OPTIMIZED_B);
    assert.deepEqual(site.scan().problems, [`${key} holds retained original ${sha(OPTIMIZED_B)}`, `${key} is a revision object that is no media item's active revision`]);
  });
});

test('an extra revision object that is nobody\'s original is found', () => {
  withFixture((site) => {
    site.put('media-revisions/stray.jpg', 'a candidate nobody published');
    assert.deepEqual(site.scan().problems, [`media-revisions/stray.jpg is a revision object that is no media item's active revision`]);
  });
});

test('a temporary file of a stable-key rewrite is found', () => {
  withFixture((site) => {
    site.put('media-revisions/stable-0123.tmp', OPTIMIZED_A);
    assert.deepEqual(site.scan().problems, ['media-revisions/stable-0123.tmp is a temporary file of an interrupted stable-key rewrite']);
  });
});

test('a missing or wrong active revision object is found', () => {
  withFixture((site) => {
    rmSync(join(site.uploads, `media-revisions/${sha(OPTIMIZED_A)}.jpg`));
    assert.deepEqual(site.scan().problems, [`media-revisions/${sha(OPTIMIZED_A)}.jpg does not hold the active revision of a`]);
  });
});

test('a missing stable key is found', () => {
  withFixture((site) => {
    rmSync(join(site.uploads, 'a.jpg'));
    assert.deepEqual(site.scan().problems, ['a.jpg does not hold the active revision of a']);
  });
});

test('a published operation without a recorded cleanup is found; an aborted one is not', () => {
  withFixture((site) => {
    site.sql("UPDATE _emdash_media_operations SET public_cleaned_at = NULL WHERE operation_id = 'op-b2'");
    const scan = site.scan();
    assert.equal(scan.pendingCleanups, 1);
    assert.deepEqual(scan.problems, ['operation op-b2 on b is published but its public cleanup is not recorded']);
  });
});

test('the last revision of deleted media is allowed only when named and never retained', () => {
  withFixture((site) => {
    // `a` deleted while optimized: its stable key is gone, its revision object stays.
    site.sql("DELETE FROM media WHERE id = 'a'");
    rmSync(join(site.uploads, 'a.jpg'));
    const key = `media-revisions/${sha(OPTIMIZED_A)}.jpg`;
    assert.deepEqual(site.scan().problems, [`${key} is a revision object that is no media item's active revision`]);
    const allowed = site.scan({ leftoverDigests: new Set([sha(OPTIMIZED_A)]) });
    assert.deepEqual(allowed.problems, []);
    assert.equal(allowed.leftovers, 1);

    // `b` deleted while restored: its revision object holds a retained original and must go.
    site.sql("DELETE FROM media WHERE id = 'b'");
    rmSync(join(site.uploads, 'b.jpg'));
    const original = `media-revisions/${sha(ORIGINAL_B)}.jpg`;
    assert.deepEqual(site.scan({ leftoverDigests: new Set([sha(OPTIMIZED_A), sha(ORIGINAL_B)]) }).problems, [
      `${original} holds retained original ${sha(ORIGINAL_B)}`,
      `${original} is a revision object that is no media item's active revision`,
    ]);
  });
});

test('a host that does not record public cleanups is refused, not passed', () => {
  withFixture((site) => {
    assert.throws(() => site.scan(), /predates host patch 0010/);
  }, { cleanupColumn: false });
});
