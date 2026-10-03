// What the site's uploads directory holds, read from the disk and the database the way a file
// server mounted on the directory would see it, and what must not be there once the host has
// brought public storage in line with its publications (host patch 0010): a retained original that
// is not an active revision, a stable key that lags behind its active revision, a superseded or
// stray revision object, a temporary file of an interrupted rewrite, a cleanup still owed.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Where the host keeps revision objects, under the uploads directory. */
export const REVISIONS_PREFIX = 'media-revisions/';

function walk(directory, prefix = '') {
  const keys = [];
  let entries;
  try {
    entries = readdirSync(join(directory, prefix), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return keys;
    throw error;
  }
  for (const entry of entries) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) keys.push(...walk(directory, key));
    else keys.push(key);
  }
  return keys;
}

/**
 * Scans every file of the uploads directory against the database, read-only.
 *
 * `leftoverDigests` are the digests of the last active revisions of media the caller deleted: the
 * host leaves such an object in place when it was never retained as an original.
 *
 * Returns the files with their digests, the managed media (those with a revision object of their
 * own), the published operations whose public cleanup is not recorded, and the problems.
 * Throws when the host's database has no record of public cleanups at all: an older host.
 */
export function scanPublicStorage({ databasePath, uploadsDirectory, leftoverDigests = new Set() }) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let retained;
  let media;
  let pending;
  try {
    const columns = db.prepare('PRAGMA table_info(_emdash_media_operations)').all().map((column) => column.name);
    if (!columns.includes('public_cleaned_at')) {
      throw new Error('This host does not record public storage cleanups: it predates host patch 0010 (public active revision), which these checks require');
    }
    retained = new Set(db.prepare('SELECT sha256 FROM _emdash_media_originals').all().map((row) => row.sha256));
    media = db
      .prepare('SELECT m.id, m.storage_key, r.object_key, r.sha256 FROM media m LEFT JOIN _emdash_media_revisions r ON r.id = m.revision_id ORDER BY m.id')
      .all();
    pending = db
      .prepare("SELECT operation_id, media_id, kind FROM _emdash_media_operations WHERE state = 'published' AND public_cleaned_at IS NULL ORDER BY operation_id")
      .all();
  } finally {
    db.close();
  }

  // Per key, the digests it may hold; `null` allows any: the item's bytes live only at that key.
  const allowed = new Map();
  const allow = (key, sha256) => allowed.set(key, (allowed.get(key) ?? new Set()).add(sha256));
  const managed = [];
  for (const item of media) {
    const inPlace = item.object_key === null || item.object_key === item.storage_key;
    allow(item.storage_key, inPlace ? null : item.sha256);
    if (!inPlace) {
      allow(item.object_key, item.sha256);
      managed.push(item);
    }
  }
  const activeObjects = new Map(managed.map((item) => [item.object_key, item.sha256]));
  const active = new Set(managed.map((item) => item.sha256));

  const problems = [];
  const digests = new Map();
  let leftovers = 0;
  for (const key of walk(uploadsDirectory)) {
    const digest = createHash('sha256').update(readFileSync(join(uploadsDirectory, key))).digest('hex');
    digests.set(key, digest);
    const may = allowed.get(key);
    if (retained.has(digest) && !may?.has(null) && !may?.has(digest)) problems.push(`${key} holds retained original ${digest}`);
    if (!key.startsWith(REVISIONS_PREFIX)) continue;
    const name = key.slice(REVISIONS_PREFIX.length);
    if (/^stable-.*\.tmp$/.test(name)) problems.push(`${key} is a temporary file of an interrupted stable-key rewrite`);
    else if (activeObjects.has(key)) continue;
    else if (leftoverDigests.has(digest) && !retained.has(digest)) leftovers += 1;
    else problems.push(`${key} is a revision object that is no media item's active revision`);
  }
  for (const item of managed) {
    if (digests.get(item.object_key) !== item.sha256) problems.push(`${item.object_key} does not hold the active revision of ${item.id}`);
    // A stable key shared by several media rows is left as it is by the host.
    if (media.filter((other) => other.storage_key === item.storage_key).length > 1) continue;
    if (digests.get(item.storage_key) !== item.sha256) problems.push(`${item.storage_key} does not hold the active revision of ${item.id}`);
  }
  for (const operation of pending) problems.push(`operation ${operation.operation_id} on ${operation.media_id} is published but its public cleanup is not recorded`);

  return {
    digests,
    media,
    managed,
    retained,
    /** Retained originals that no media item has as its active revision: never to be served. */
    retainedNotActive: new Set([...retained].filter((digest) => !active.has(digest))),
    pendingCleanups: pending.length,
    leftovers,
    revisionObjects: [...digests.keys()].filter((key) => key.startsWith(REVISIONS_PREFIX)).length,
    problems: problems.toSorted(),
  };
}
