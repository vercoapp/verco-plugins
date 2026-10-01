import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import sharp from 'sharp';
import { createEditorRuntime, digest, FencedMediaFixture } from './helpers/fenced-media-fixture.mjs';
import { loadPinnedMediaRoutes } from './helpers/pinned-media-routes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runRoot = join(root, '.qualification-runs');
await mkdir(runRoot, { recursive: true });
const compiled = await mkdtemp(join(runRoot, 'writer-handlers-'));
after(() => rm(compiled, { recursive: true, force: true }));
const routes = await loadPinnedMediaRoutes(compiled);
const pixels = async (color) => sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer();
const originalBytes = await pixels('#e02020');
const editorBytes = await pixels('#20e040');
const optimizedBytes = await pixels('#2060e0');

async function fixture(t) {
  const directory = await mkdtemp(join(runRoot, 'writer-db-'));
  const editor = new FencedMediaFixture(directory, true);
  const optimizer = new FencedMediaFixture(directory);
  t.after(async () => {
    optimizer.close(); editor.close();
    await rm(directory, { recursive: true, force: true });
  });
  const original = await editor.stage(originalBytes);
  editor.seed('image', original);
  return { editor, optimizer, original, directory };
}

function context(runtime, bytes = editorBytes, user = { id: 'author', role: 30 }) {
  const data = new FormData();
  data.set('file', new File([bytes], 'replacement.png', { type: 'image/png' }));
  data.set('width', '16'); data.set('height', '16');
  return {
    params: { id: 'image' },
    request: new Request('http://fixture/_emdash/api/media/image/replace', { method: 'PUT', body: data, headers: { 'X-EmDash-Request': '1' } }),
    locals: { emdash: runtime, user },
  };
}

function pauseAfterRead(t) {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  return {
    reached: reached.promise, release: release.resolve,
    hook: async (snapshot) => { reached.resolve(snapshot); await release.promise; },
  };
}

test('pinned editor replace wins over stale optimization and preserves a later caption/focal edit', async (t) => {
  const { editor, optimizer } = await fixture(t);
  const stale = optimizer.snapshot('image');
  const optimized = await optimizer.stage(optimizedBytes);
  const response = await routes.replace(context(createEditorRuntime(editor)));
  assert.equal(response.status, 200);
  editor.db.prepare("UPDATE media SET alt = 'New alt', caption = 'New caption', focal_x = 0.6 WHERE id = 'image'").run();
  assert.equal(optimizer.publish('image', stale.revision, optimized).error.code, 'CONFLICT');
  const current = await editor.read('image');
  assert.equal(current.digest, digest(editorBytes));
  assert.equal(digest(current.bytes), digest(editorBytes));
  assert.equal(current.alt, 'New alt'); assert.equal(current.caption, 'New caption'); assert.equal(current.focalX, 0.6);
  assert.equal(current.storageKey, stale.storageKey);
});

test('pinned editor replace reports conflict when optimization publishes after the editor source read', { timeout: 5000 }, async (t) => {
  const { editor, optimizer } = await fixture(t);
  const gate = pauseAfterRead(t);
  const responsePromise = routes.replace(context(createEditorRuntime(editor, gate.hook)));
  const source = await gate.reached;
  const optimized = await optimizer.stage(optimizedBytes);
  assert.equal(optimizer.publish('image', source.revision, optimized).success, true);
  gate.release();
  assert.equal((await responsePromise).status, 409);
  assert.equal(digest((await editor.read('image')).bytes), digest(optimizedBytes));
});

test('pinned editor deletion fences stale optimization and restore and retains reader objects', async (t) => {
  const { editor, optimizer, original } = await fixture(t);
  const stale = optimizer.snapshot('image');
  const inFlightRead = optimizer.read('image');
  const candidate = await optimizer.stage(optimizedBytes);
  const response = await routes.remove(context(createEditorRuntime(editor)));
  assert.equal(response.status, 200);
  assert.equal(optimizer.publish('image', stale.revision, candidate).error.code, 'CONFLICT');
  assert.equal(optimizer.publish('image', stale.revision, original).error.code, 'CONFLICT');
  assert.equal(await optimizer.read('image'), null);
  assert.equal(digest((await inFlightRead).bytes), digest(originalBytes));
});

test('pinned editor deletion conflicts if another writer publishes after its source read', { timeout: 5000 }, async (t) => {
  const { editor, optimizer } = await fixture(t);
  const gate = pauseAfterRead(t);
  const deleting = routes.remove(context(createEditorRuntime(editor, gate.hook)));
  const source = await gate.reached;
  const candidate = await optimizer.stage(optimizedBytes);
  assert.equal(optimizer.publish('image', source.revision, candidate).success, true);
  gate.release();
  assert.equal((await deleting).status, 409);
  assert.equal(digest((await editor.read('image')).bytes), digest(optimizedBytes));
});

test('pinned editor replacement cannot resurrect a deletion during its source read', { timeout: 5000 }, async (t) => {
  const { editor, optimizer } = await fixture(t);
  const gate = pauseAfterRead(t);
  const replacing = routes.replace(context(createEditorRuntime(editor, gate.hook)));
  const source = await gate.reached;
  assert.equal(optimizer.delete('image', source.revision).success, true);
  gate.release();
  assert.equal((await replacing).status, 409);
  assert.equal(await editor.read('image'), null);
});

test('restore creates a new source revision even when it returns to identical original bytes', async (t) => {
  const { editor, optimizer } = await fixture(t);
  const first = optimizer.snapshot('image');
  const candidate = await optimizer.stage(optimizedBytes);
  assert.equal(optimizer.publish('image', first.revision, candidate).success, true);
  editor.db.prepare("UPDATE media SET caption = 'Latest caption', focal_y = 0.3 WHERE id = 'image'").run();
  const restore = await optimizer.stage(originalBytes);
  const oldRevision = { id: first.revision };
  assert.equal(optimizer.publish('image', candidate.id, oldRevision).error.code, 'CONFLICT');
  assert.equal(optimizer.publish('image', candidate.id, restore).success, true);
  const restored = await editor.read('image');
  assert.equal(restored.digest, first.digest);
  assert.notEqual(restored.revision, first.revision);
  assert.equal(restored.caption, 'Latest caption'); assert.equal(restored.focalY, 0.3);
  assert.equal(optimizer.publish('image', first.revision, candidate).error.code, 'CONFLICT');
});

test('unparticipating SQL writers cannot change byte pointers or hard-delete managed media', async (t) => {
  const { editor, optimizer, directory } = await fixture(t);
  const initial = editor.snapshot('image');
  assert.throws(() => optimizer.db.prepare("UPDATE media SET revision = revision WHERE id = 'image'").run(), /revision writer/);
  assert.throws(() => optimizer.db.prepare("DELETE FROM media WHERE id = 'image'").run(), /revision writer/);
  assert.throws(() => optimizer.db.prepare("UPDATE media SET id = 'another-image' WHERE id = 'image'").run(), /revision writer/);
  assert.throws(() => optimizer.db.prepare("INSERT OR REPLACE INTO media SELECT * FROM media WHERE id = 'image'").run(), /identity cannot be reused/);
  assert.throws(() => optimizer.db.prepare("UPDATE revisions SET size = 0 WHERE id = ?").run(initial.revision), /immutable/);
  const legacy = new DatabaseSync(join(directory, 'media.sqlite'));
  try {
    assert.throws(() => legacy.prepare("DELETE FROM media WHERE id = 'image'").run(), /verco_writer_authorized/);
  } finally { legacy.close(); }
  assert.equal(editor.snapshot('image').revision, initial.revision);
});

test('pinned route permission and ownership checks reject callers before staging bytes', async (t) => {
  const { editor } = await fixture(t);
  const originalCount = editor.db.prepare('SELECT COUNT(*) AS count FROM revisions').get().count;
  for (const [user, expected] of [[null, 401], [{ id: 'author', role: 10 }, 403], [{ id: 'someone-else', role: 30 }, 403]]) {
    assert.equal((await routes.replace(context(createEditorRuntime(editor), editorBytes, user))).status, expected);
    assert.equal((await routes.remove(context(createEditorRuntime(editor), editorBytes, user))).status, expected);
  }
  assert.equal(editor.db.prepare('SELECT COUNT(*) AS count FROM revisions').get().count, originalCount);
});

test('concurrent editor requests keep their own snapshots and cannot overwrite a winner', { timeout: 5000 }, async (t) => {
  const { editor, optimizer } = await fixture(t);
  const gate = pauseAfterRead(t);
  const staleEditor = routes.replace(context(createEditorRuntime(editor, gate.hook), editorBytes));
  await gate.reached;
  assert.equal((await routes.replace(context(createEditorRuntime(optimizer), optimizedBytes))).status, 200);
  gate.release();
  assert.equal((await staleEditor).status, 409);
  const current = await editor.read('image');
  assert.equal(current.size, optimizedBytes.length);
  assert.equal(current.contentHash, `sha1:${createHash('sha1').update(optimizedBytes).digest('hex')}`);
  assert.equal(digest(current.bytes), digest(optimizedBytes));
});

test('a rejected staged revision does not leave the writer transaction or SQL guard open', async (t) => {
  const { editor, optimizer } = await fixture(t);
  const source = editor.snapshot('image');
  assert.throws(() => optimizer.publish('image', source.revision, { id: 'missing-staged-revision' }), /FOREIGN KEY/);
  assert.equal(optimizer.db.isTransaction, false);
  assert.throws(() => optimizer.db.prepare("DELETE FROM media WHERE id = 'image'").run(), /revision writer/);
  assert.equal(editor.snapshot('image').revision, source.revision);
  const valid = await optimizer.stage(optimizedBytes);
  assert.equal(optimizer.publish('image', source.revision, valid).success, true);
});
