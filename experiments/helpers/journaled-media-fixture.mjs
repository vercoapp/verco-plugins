import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DecodeRejection, PILOT_LIMITS, validateDecoded } from './decode-budget.mjs';
import { digest, FencedMediaFixture } from './fenced-media-fixture.mjs';

export class CrashSignal extends Error {
  constructor(point) {
    super(`Simulated process death at ${point}`);
    this.point = point;
  }
}

const OPEN_STATES = ['intent', 'candidate_staged', 'original_retained'];

/**
 * Write to a temporary name, flush, verify the bytes read back and only then rename into the
 * content-addressed name, so a partial or corrupt file never carries a final name. `tamper`
 * and `partial` inject storage faults; they exist only for failure-injection tests.
 */
async function durableWrite(directory, name, bytes, { tamper = (value) => value, partial } = {}) {
  await mkdir(directory, { recursive: true });
  const final = join(directory, name);
  const existing = await readFile(final).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (existing) {
    if (digest(existing) !== digest(bytes)) throw new Error('Immutable object was corrupted.');
    return false;
  }
  const temporary = `${final}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    if (partial) {
      await handle.writeFile(bytes.subarray(0, Math.floor(bytes.length / 2)));
      await handle.sync();
      partial();
    }
    await handle.writeFile(tamper(bytes));
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (digest(await readFile(temporary)) !== digest(bytes)) {
    await rm(temporary, { force: true });
    throw new Error('Written object failed verification.');
  }
  await rename(temporary, final);
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  return true;
}

/**
 * Disposable proof of the publication journal and reconciliation protocol on Node/SQLite and
 * a local filesystem. It is not an EmDash implementation. Crash points abandon the instance
 * exactly where a process could die; tests then reopen the same directory.
 */
export class JournaledMediaFixture extends FencedMediaFixture {
  crashAt = null;
  failRetention = null; // 'io' | 'corrupt'
  hooks = {}; // async interleaving points, keyed like crash points
  limits = PILOT_LIMITS;

  constructor(directory, initialize = false) {
    super(directory, initialize);
    this.db.exec('PRAGMA synchronous = FULL');
    if (initialize) this.db.exec(`
      CREATE TABLE originals (digest TEXT PRIMARY KEY, object_key TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE operations (
        media_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, expected_revision TEXT NOT NULL, candidate_digest TEXT NOT NULL,
        candidate_revision TEXT REFERENCES revisions(id), original_digest TEXT REFERENCES originals(digest), receipt TEXT,
        PRIMARY KEY (media_id, operation_id)
      );
      CREATE TRIGGER originals_no_update BEFORE UPDATE ON originals BEGIN SELECT RAISE(ABORT, 'Originals are immutable'); END;
      CREATE TRIGGER originals_no_delete BEFORE DELETE ON originals BEGIN SELECT RAISE(ABORT, 'Originals are retained'); END;
    `);
  }

  async #at(point) {
    this.#crash(point);
    await this.hooks[point]?.();
  }

  #crash(point) {
    if (this.crashAt === point) throw new CrashSignal(point);
  }

  #operation(mediaId, operationId) {
    return this.db.prepare('SELECT * FROM operations WHERE media_id = ? AND operation_id = ?').get(mediaId, operationId);
  }

  #revision(id) {
    return this.db.prepare('SELECT * FROM revisions WHERE id = ?').get(id);
  }

  #transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      // A dead process cannot roll back; SQLite discards the open transaction when the connection closes.
      if (!(error instanceof CrashSignal) && this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #finish(op, state, code) {
    const receipt = { status: state === 'published' ? 'published' : 'rejected', code, operationId: op.operation_id, expectedRevision: op.expected_revision };
    this.db.prepare(`UPDATE operations SET state = ?, receipt = ? WHERE media_id = ? AND operation_id = ? AND state IN ('intent', 'candidate_staged', 'original_retained')`)
      .run(state, JSON.stringify(receipt), op.media_id, op.operation_id);
    return receipt;
  }

  /** Replace through the journal. Repeating an identical operation ID returns its durable outcome. */
  async execute({ operationId, mediaId, kind = 'replace', expectedRevision, bytes }) {
    await this.#at('before-intent');
    const candidateDigest = digest(bytes);
    const fingerprint = digest(JSON.stringify([kind, mediaId, expectedRevision, candidateDigest]));
    let op = this.#operation(mediaId, operationId);
    if (op) {
      if (op.fingerprint !== fingerprint) return { status: 'rejected', code: 'CONFLICTING_OPERATION', operationId };
      if (!OPEN_STATES.includes(op.state)) return JSON.parse(op.receipt);
    } else {
      this.db.prepare(`INSERT INTO operations (media_id, operation_id, fingerprint, kind, state, expected_revision, candidate_digest) VALUES (?, ?, ?, ?, 'intent', ?, ?)`)
        .run(mediaId, operationId, fingerprint, kind, expectedRevision, candidateDigest);
      op = this.#operation(mediaId, operationId);
    }
    await this.#at('after-intent');
    return this.#advance(op, bytes);
  }

  async #advance(op, bytes) {
    if (op.state === 'intent') {
      const source = this.#revision(op.expected_revision);
      const current = this.snapshot(op.media_id);
      if (!source || !current || current.revision !== op.expected_revision) return this.#finish(op, 'rejected', 'CONFLICT');
      try {
        await validateDecoded(bytes, { format: source.object_key.split('.').pop(), width: source.width, height: source.height }, this.limits);
      } catch (error) {
        if (error instanceof DecodeRejection) return this.#finish(op, 'rejected', error.code);
        throw error;
      }
      const objectKey = `objects/${op.candidate_digest}.png`;
      await durableWrite(join(this.directory, 'objects'), `${op.candidate_digest}.png`, bytes, {
        partial: this.crashAt === 'candidate-write-partial' ? () => this.#crash('candidate-write-partial') : undefined,
      });
      await this.#at('candidate-object-written');
      const revision = { id: randomUUID(), width: source.width, height: source.height, size: bytes.length, contentHash: `sha1:${createHash('sha1').update(bytes).digest('hex')}` };
      this.#transaction(() => {
        this.db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(revision.id, objectKey, op.candidate_digest, revision.size, revision.width, revision.height, revision.contentHash);
        this.db.prepare(`UPDATE operations SET state = 'candidate_staged', candidate_revision = ? WHERE media_id = ? AND operation_id = ?`)
          .run(revision.id, op.media_id, op.operation_id);
      });
      op = this.#operation(op.media_id, op.operation_id);
    }
    await this.#at('after-candidate-staged');
    if (op.state === 'candidate_staged') {
      let retained = null;
      if (op.kind === 'replace') {
        try {
          retained = await this.#retainOriginal(op);
        } catch (error) {
          if (error instanceof CrashSignal) throw error;
          return this.#finish(op, 'rejected', 'BACKUP_FAILED');
        }
      }
      this.#transaction(() => {
        if (retained) this.db.prepare('INSERT OR IGNORE INTO originals VALUES (?, ?, ?)').run(retained.digest, retained.objectKey, retained.size);
        this.db.prepare(`UPDATE operations SET state = 'original_retained', original_digest = ? WHERE media_id = ? AND operation_id = ?`)
          .run(retained?.digest ?? null, op.media_id, op.operation_id);
      });
      op = this.#operation(op.media_id, op.operation_id);
    }
    await this.#at('after-original-retained');
    const receipt = this.#publish(op);
    await this.#at('after-publication');
    return receipt;
  }

  async #retainOriginal(op) {
    const source = this.#revision(op.expected_revision);
    const bytes = await readFile(join(this.directory, source.object_key));
    if (digest(bytes) !== source.digest) throw new Error('The source object does not match its revision.');
    if (this.failRetention === 'io') throw new Error('Simulated storage failure.');
    await durableWrite(join(this.directory, 'originals'), `${source.digest}.png`, bytes, {
      tamper: this.failRetention === 'corrupt' ? (value) => Buffer.concat([value.subarray(0, -1), Buffer.from([value.at(-1) ^ 1])]) : undefined,
      partial: this.crashAt === 'original-write-partial' ? () => this.#crash('original-write-partial') : undefined,
    });
    await this.#at('original-object-written');
    return { digest: source.digest, objectKey: `originals/${source.digest}.png`, size: bytes.length };
  }

  #publish(op) {
    return this.authorized(() => this.#transaction(() => {
      const result = this.db.prepare(`
        UPDATE media SET revision = ? WHERE id = ? AND revision = ? AND deleted = 0
        AND NOT EXISTS (SELECT 1 FROM published_revisions WHERE id = ?)
      `).run(op.candidate_revision, op.media_id, op.expected_revision, op.candidate_revision);
      if (result.changes !== 1) return null;
      this.db.prepare('INSERT INTO published_revisions VALUES (?)').run(op.candidate_revision);
      const receipt = {
        status: 'published', operationId: op.operation_id, kind: op.kind, expectedRevision: op.expected_revision,
        newRevision: op.candidate_revision, candidateDigest: op.candidate_digest, originalDigest: op.original_digest,
      };
      this.db.prepare(`UPDATE operations SET state = 'published', receipt = ? WHERE media_id = ? AND operation_id = ?`)
        .run(JSON.stringify(receipt), op.media_id, op.operation_id);
      this.#crash('in-publication-transaction'); // pointer, receipt and journal state commit together or not at all
      return receipt;
    }) ?? this.#finish(op, 'rejected', 'CONFLICT'));
  }

  /** Restore retained original bytes through the same journal, fence and publication step. */
  async restore({ operationId, mediaId, expectedRevision, originalDigest }) {
    const original = this.db.prepare('SELECT * FROM originals WHERE digest = ?').get(originalDigest);
    if (!original) return { status: 'rejected', code: 'NO_ORIGINAL', operationId };
    const bytes = await readFile(join(this.directory, original.object_key));
    if (digest(bytes) !== originalDigest) return { status: 'rejected', code: 'ORIGINAL_CORRUPT', operationId };
    return this.execute({ operationId, mediaId, kind: 'restore', expectedRevision, bytes });
  }

  /**
   * Startup reconciliation. Publication is a single database commit, so a crash leaves the previous
   * revision active or the new one fully published. Open operations are durably rejected as
   * interrupted and unreferenced or temporary files are removed. Assumes no other live writer
   * process; `graceMs` must exceed the longest write in production, where a lease is also needed.
   */
  async reconcile({ graceMs = 0 } = {}) {
    const interrupted = [];
    for (const op of this.db.prepare(`SELECT * FROM operations WHERE state IN ('intent', 'candidate_staged', 'original_retained')`).all()) {
      this.#finish(op, 'aborted', 'INTERRUPTED');
      interrupted.push(op.operation_id);
    }
    const referenced = {
      objects: new Set(this.db.prepare('SELECT object_key FROM revisions').all().map((row) => row.object_key)),
      originals: new Set(this.db.prepare('SELECT object_key FROM originals').all().map((row) => row.object_key)),
    };
    const removed = [];
    for (const directory of ['objects', 'originals']) {
      for (const name of await readdir(join(this.directory, directory)).catch(() => [])) {
        const key = `${directory}/${name}`;
        const unreferenced = name.endsWith('.tmp') || !referenced[directory].has(key);
        if (!unreferenced || Date.now() - (await stat(join(this.directory, key))).mtimeMs < graceMs) continue;
        await rm(join(this.directory, key), { force: true });
        removed.push(key);
      }
    }
    return { interrupted, removed };
  }

  backupTotals() {
    const row = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM originals').get();
    return { count: row.count, bytes: row.bytes };
  }

  operationState(mediaId, operationId) {
    return this.#operation(mediaId, operationId)?.state;
  }
}
