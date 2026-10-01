import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const failure = (code) => ({ success: false, error: { code, message: 'The source revision changed or the media was deleted.' } });
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Disposable Node/SQLite protocol proof; no durable receipt or recovery implementation. */
export class FencedMediaFixture {
  #authorized = false;

  constructor(directory, initialize = false) {
    this.directory = directory;
    this.db = new DatabaseSync(join(directory, 'media.sqlite'));
    this.db.function('verco_writer_authorized', () => Number(this.#authorized));
    this.db.exec('PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;');
    if (initialize) this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE revisions (
        id TEXT PRIMARY KEY, object_key TEXT NOT NULL, digest TEXT NOT NULL,
        size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, content_hash TEXT NOT NULL
      );
      CREATE TABLE media (
        id TEXT PRIMARY KEY, storage_key TEXT UNIQUE NOT NULL,
        revision TEXT NOT NULL REFERENCES revisions(id), deleted INTEGER NOT NULL DEFAULT 0,
        alt TEXT NOT NULL, caption TEXT NOT NULL, focal_x REAL NOT NULL, focal_y REAL NOT NULL
      );
      CREATE TABLE published_revisions (id TEXT PRIMARY KEY REFERENCES revisions(id));
      CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions
      BEGIN SELECT RAISE(ABORT, 'Revision metadata is immutable'); END;
      CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions
      BEGIN SELECT RAISE(ABORT, 'Revision metadata is immutable'); END;
      CREATE TRIGGER media_no_legacy_reinsert BEFORE INSERT ON media
      WHEN EXISTS (SELECT 1 FROM media WHERE id = NEW.id OR storage_key = NEW.storage_key)
      BEGIN SELECT RAISE(ABORT, 'Managed media identity cannot be reused'); END;
      CREATE TRIGGER media_no_legacy_delete BEFORE DELETE ON media
      WHEN verco_writer_authorized() = 0
      BEGIN SELECT RAISE(ABORT, 'Managed media requires the revision writer'); END;
      CREATE TRIGGER media_no_legacy_bytes BEFORE UPDATE OF id, revision, deleted, storage_key ON media
      WHEN verco_writer_authorized() = 0
      BEGIN SELECT RAISE(ABORT, 'Managed media requires the revision writer'); END;
    `);
  }

  close() { this.db.close(); }

  async stage(bytes) {
    const output = Buffer.from(bytes);
    // The proof corpus is limited to small still PNGs; these are fixture limits.
    const image = sharp(output, { limitInputPixels: 256 });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) throw new Error('Fixture expects a still PNG.');
    await image.raw().toBuffer();
    const hash = digest(output);
    const objectKey = `objects/${hash}.png`;
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    try {
      await writeFile(join(this.directory, objectKey), output, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (digest(await readFile(join(this.directory, objectKey))) !== hash) throw new Error('Immutable object was corrupted.');
    }
    const revision = {
      id: randomUUID(), objectKey, digest: hash, size: output.length,
      width: metadata.width, height: metadata.height,
      contentHash: `sha1:${createHash('sha1').update(output).digest('hex')}`,
    };
    this.db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      revision.id, revision.objectKey, revision.digest, revision.size, revision.width, revision.height, revision.contentHash);
    return revision;
  }

  seed(id, revision) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO published_revisions VALUES (?)').run(revision.id);
      this.db.prepare('INSERT INTO media VALUES (?, ?, ?, 0, ?, ?, ?, ?)').run(
        id, `${id}.png`, revision.id, 'Original alt', 'Original caption', 0.25, 0.75);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  snapshot(id) {
    const row = this.db.prepare(`
      SELECT m.*, r.object_key, r.digest, r.size, r.width, r.height, r.content_hash
      FROM media m JOIN revisions r ON r.id = m.revision WHERE m.id = ? AND m.deleted = 0
    `).get(id);
    if (!row) return null;
    return {
      id: row.id, storageKey: row.storage_key, revision: row.revision,
      objectKey: row.object_key, digest: row.digest, size: row.size, width: row.width, height: row.height,
      contentHash: row.content_hash, mimeType: 'image/png', status: 'ready', authorId: 'author',
      alt: row.alt, caption: row.caption, focalX: row.focal_x, focalY: row.focal_y,
    };
  }

  publish(id, expected, candidate) {
    if (!expected) return failure('CONFLICT');
    this.#authorized = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = this.db.prepare(`
        UPDATE media SET revision = ? WHERE id = ? AND revision = ? AND deleted = 0
        AND NOT EXISTS (SELECT 1 FROM published_revisions WHERE id = ?)
      `).run(candidate.id, id, expected, candidate.id);
      if (result.changes !== 1) {
        this.db.exec('ROLLBACK');
        return failure('CONFLICT');
      }
      this.db.prepare('INSERT INTO published_revisions VALUES (?)').run(candidate.id);
      const item = this.snapshot(id);
      this.db.exec('COMMIT');
      return { success: true, data: { item } };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#authorized = false;
    }
  }

  delete(id, expected) {
    if (!expected) return failure('CONFLICT');
    this.#authorized = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const tombstone = randomUUID();
      // The active object remains retained; deletion never removes an in-flight reader's object.
      const source = this.snapshot(id);
      if (!source || source.revision !== expected) {
        this.db.exec('ROLLBACK');
        return failure('CONFLICT');
      }
      this.db.prepare('INSERT INTO revisions SELECT ?, object_key, digest, size, width, height, content_hash FROM revisions WHERE id = ?').run(tombstone, expected);
      this.db.prepare('INSERT INTO published_revisions VALUES (?)').run(tombstone);
      const result = this.db.prepare('UPDATE media SET revision = ?, deleted = 1 WHERE id = ? AND revision = ? AND deleted = 0').run(tombstone, id, expected);
      if (result.changes !== 1) throw new Error('Deletion fence failed.');
      this.db.exec('COMMIT');
      return { success: true, data: { deleted: true, storageDeleted: false } };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#authorized = false;
    }
  }

  async read(id) {
    const snapshot = this.snapshot(id);
    if (!snapshot) return null;
    return { ...snapshot, bytes: await readFile(join(this.directory, snapshot.objectKey)) };
  }
}

/** Each invocation owns its source snapshot and staged output; state never crosses requests. */
export function createEditorRuntime(writer, afterRead = async () => {}) {
  let source;
  let candidate;
  return {
    config: { maxUploadSize: 1024 * 1024 },
    storage: {
      async upload({ key, body }) {
        if (!source || key !== source.storageKey) throw new Error('No authorized source snapshot.');
        candidate = await writer.stage(body);
        return { key, size: candidate.size, url: `/_emdash/api/media/file/${key}` };
      },
    },
    async handleMediaGet(id) {
      source = writer.snapshot(id);
      if (!source) return failure('NOT_FOUND');
      await afterRead(source);
      return { success: true, data: { item: source } };
    },
    async handleMediaReplaceMetadata(id, key, input) {
      if (!source || id !== source.id || key !== source.storageKey || !candidate) return failure('CONFLICT');
      if (input.size !== candidate.size || input.width !== candidate.width || input.height !== candidate.height || input.contentHash !== candidate.contentHash) {
        return { success: false, error: { code: 'VALIDATION_ERROR', message: 'Output metadata does not match staged bytes.' } };
      }
      return writer.publish(id, source.revision, candidate);
    },
    async handleMediaDelete(id) {
      if (!source || id !== source.id) return failure('CONFLICT');
      return writer.delete(id, source.revision);
    },
  };
}
