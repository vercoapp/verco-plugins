import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// This models publication predicates on real SQLite, not EmDash integration.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'verco-media-fence-'));
  const filename = join(directory, 'fixture.sqlite');
  const editor = new DatabaseSync(filename);
  const optimizer = new DatabaseSync(filename);
  t.after(() => {
    optimizer.close();
    editor.close();
    rmSync(directory, { recursive: true, force: true });
  });
  editor.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE media (
      id TEXT PRIMARY KEY, stable_key TEXT NOT NULL,
      revision TEXT NOT NULL, object_key TEXT NOT NULL,
      size INTEGER NOT NULL, alt TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO media VALUES ('image', 'image.jpg', 'source', 'objects/source.jpg', 100, 'Initial alt', 0);
  `);
  return { editor, optimizer };
}

function publish(db, expected, revision, size) {
  return db.prepare(`
    UPDATE media SET revision = ?, object_key = ?, size = ?
    WHERE id = 'image' AND revision = ? AND deleted = 0
  `).run(revision, `objects/${revision}.jpg`, size, expected).changes;
}

test('legacy stable-key predicate admits stale optimizer metadata after editor replacement', (t) => {
  const { editor, optimizer } = fixture(t);
  const source = optimizer.prepare('SELECT * FROM media').get();
  editor.prepare("UPDATE media SET size = 200 WHERE id = 'image'").run();
  const stale = optimizer.prepare(`
    UPDATE media SET size = 50 WHERE id = 'image' AND stable_key = ?
  `).run(source.stable_key);
  assert.equal(stale.changes, 1);
  assert.equal(editor.prepare('SELECT size FROM media').get().size, 50);
});

for (const winner of ['editor', 'optimizer', 'restore']) {
  for (const loser of ['editor', 'optimizer', 'restore'].filter((value) => value !== winner)) {
    test(`${winner} publication fences stale ${loser} on another connection`, (t) => {
      const { editor, optimizer } = fixture(t);
      const source = optimizer.prepare('SELECT revision FROM media').get().revision;
      assert.equal(publish(editor, source, winner, 80), 1);
      assert.equal(publish(optimizer, source, loser, 40), 0);
      const active = editor.prepare('SELECT * FROM media').get();
      assert.equal(active.revision, winner);
      assert.equal(active.object_key, `objects/${winner}.jpg`);
      assert.equal(active.size, 80);
    });
  }
}

for (const writer of ['optimizer', 'restore']) {
  test(`deletion fences stale ${writer} without recreating media`, (t) => {
    const { editor, optimizer } = fixture(t);
    const source = optimizer.prepare('SELECT revision FROM media').get().revision;
    assert.equal(editor.prepare(`
      UPDATE media SET revision = 'deleted', deleted = 1
      WHERE id = 'image' AND revision = ? AND deleted = 0
    `).run(source).changes, 1);
    assert.equal(publish(optimizer, source, writer, 40), 0);
    assert.equal(optimizer.prepare('SELECT * FROM media WHERE deleted = 0').get(), undefined);
    assert.equal(editor.prepare('SELECT revision FROM media').get().revision, 'deleted');
  });
}

test('publication preserves an editorial change made after the source read', (t) => {
  const { editor, optimizer } = fixture(t);
  const source = optimizer.prepare('SELECT revision FROM media').get().revision;
  editor.prepare("UPDATE media SET alt = 'Edited alt' WHERE id = 'image'").run();
  assert.equal(publish(optimizer, source, 'optimized', 50), 1);
  assert.equal(editor.prepare('SELECT alt FROM media').get().alt, 'Edited alt');
});
