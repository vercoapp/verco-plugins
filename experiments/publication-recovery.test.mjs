import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { digest } from './helpers/fenced-media-fixture.mjs';
import { CrashSignal, JournaledMediaFixture } from './helpers/journaled-media-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runRoot = join(root, '.qualification-runs');
await mkdir(runRoot, { recursive: true });
const pixels = (color, size = 16) => sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
const originalBytes = await pixels('#e02020');
const optimizedBytes = await pixels('#2060e0');
const editorBytes = await pixels('#20e040');

async function setup(t) {
  const directory = await mkdtemp(join(runRoot, 'recovery-'));
  const instances = [];
  const open = (initialize = false) => {
    const instance = new JournaledMediaFixture(directory, initialize);
    instances.push(instance);
    return instance;
  };
  t.after(async () => {
    for (const instance of instances) try { instance.close(); } catch { /* already closed by a simulated death */ }
    await rm(directory, { recursive: true, force: true });
  });
  const first = open(true);
  const original = await first.stage(originalBytes);
  first.seed('image', original);
  return { directory, first, open, source: first.snapshot('image') };
}

/** Everything a reader or recovery tool relies on: complete revisions and intact retained objects. */
async function assertComplete(fixture, id = 'image') {
  const read = await fixture.read(id);
  assert.ok(read, 'media must be readable');
  assert.equal(digest(read.bytes), read.digest);
  assert.equal(read.bytes.length, read.size);
  const metadata = await sharp(read.bytes).metadata();
  assert.equal(metadata.width, read.width);
  assert.equal(metadata.height, read.height);
  for (const row of fixture.db.prepare('SELECT object_key, digest FROM revisions').all()) {
    assert.equal(digest(await readFile(join(fixture.directory, row.object_key))), row.digest, `${row.object_key} is intact`);
  }
  for (const row of fixture.db.prepare('SELECT object_key, digest FROM originals').all()) {
    assert.equal(digest(await readFile(join(fixture.directory, row.object_key))), row.digest, `${row.object_key} is intact`);
  }
  return read;
}

const files = async (directory, name) => (await readdir(join(directory, name)).catch(() => [])).sort();
const input = (source, extra = {}) => ({ operationId: 'op-1', mediaId: 'image', expectedRevision: source.revision, bytes: optimizedBytes, ...extra });

async function die(fixture, point, operation) {
  fixture.crashAt = point;
  await assert.rejects(fixture.execute(operation), (error) => error instanceof CrashSignal && error.point === point);
  fixture.close(); // the process is gone; an open transaction is discarded by SQLite
}

const CRASH_POINTS = [
  ['before-intent', 'old'],
  ['after-intent', 'old'],
  ['candidate-write-partial', 'old'],
  ['candidate-object-written', 'old'],
  ['after-candidate-staged', 'old'],
  ['original-write-partial', 'old'],
  ['original-object-written', 'old'],
  ['after-original-retained', 'old'],
  ['in-publication-transaction', 'old'],
  ['after-publication', 'new'],
];

for (const [point, outcome] of CRASH_POINTS) {
  test(`a crash at ${point} leaves a complete ${outcome} revision; reconciliation then a new operation succeeds`, async (t) => {
    const { directory, first, open, source } = await setup(t);
    await die(first, point, input(source));
    const restarted = open();
    const before = await assertComplete(restarted);
    assert.equal(before.revision === source.revision, outcome === 'old');
    assert.equal(digest(before.bytes), digest(outcome === 'old' ? originalBytes : optimizedBytes));

    await restarted.reconcile();
    assert.deepEqual((await files(directory, 'objects')).filter((name) => name.endsWith('.tmp')), []);
    assert.deepEqual((await files(directory, 'originals')).filter((name) => name.endsWith('.tmp')), []);
    const afterReconcile = await assertComplete(restarted);
    assert.equal(afterReconcile.revision, before.revision);

    if (outcome === 'old') {
      const receipt = await restarted.execute(input(source, { operationId: 'op-2' }));
      assert.equal(receipt.status, 'published');
      assert.equal(digest((await assertComplete(restarted)).bytes), digest(optimizedBytes));
    } else {
      assert.equal((await restarted.execute(input(source))).status, 'published');
    }
    assert.deepEqual(restarted.backupTotals(), { count: 1, bytes: originalBytes.length });
    assert.deepEqual(await files(directory, 'originals'), [`${digest(originalBytes)}.png`]);
  });

  test(`a crash at ${point} is resumed by the same operation ID exactly once`, async (t) => {
    const { directory, first, open, source } = await setup(t);
    await die(first, point, input(source));
    const restarted = open();
    await assertComplete(restarted);
    const receipt = await restarted.execute(input(source));
    assert.equal(receipt.status, 'published');
    const published = await assertComplete(restarted);
    assert.equal(published.revision, receipt.newRevision);
    assert.equal(digest(published.bytes), digest(optimizedBytes));
    assert.equal(receipt.originalDigest, digest(originalBytes));

    const revisionCount = restarted.db.prepare('SELECT COUNT(*) AS n FROM revisions').get().n;
    assert.deepEqual(await restarted.execute(input(source)), receipt); // lost response: same durable receipt
    assert.equal(restarted.db.prepare('SELECT COUNT(*) AS n FROM revisions').get().n, revisionCount);
    assert.equal((await assertComplete(restarted)).revision, receipt.newRevision);
    assert.deepEqual(restarted.backupTotals(), { count: 1, bytes: originalBytes.length });
    // A resumed operation may leave the dead process's temporary file; reconciliation removes it.
    assert.deepEqual((await files(directory, 'originals')).filter((name) => !name.endsWith('.tmp')), [`${digest(originalBytes)}.png`]);
    await restarted.reconcile();
    assert.deepEqual(await files(directory, 'originals'), [`${digest(originalBytes)}.png`]);
    assert.deepEqual((await files(directory, 'objects')).filter((name) => name.endsWith('.tmp')), []);
    assert.equal((await assertComplete(restarted)).revision, receipt.newRevision);
  });
}

test('reconciliation rejects open operations durably and a retry of the same ID returns that outcome', async (t) => {
  const { first, open, source } = await setup(t);
  await die(first, 'after-original-retained', input(source));
  const restarted = open();
  assert.deepEqual((await restarted.reconcile()).interrupted, ['op-1']);
  assert.equal(restarted.operationState('image', 'op-1'), 'aborted');
  const receipt = await restarted.execute(input(source));
  assert.deepEqual([receipt.status, receipt.code], ['rejected', 'INTERRUPTED']);
  assert.equal((await assertComplete(restarted)).revision, source.revision);
});

test('reconciliation removes only unreferenced and temporary objects, never an active or retained revision', async (t) => {
  const { directory, first, open, source } = await setup(t);
  const receipt = await first.execute(input(source));
  assert.equal(receipt.status, 'published');
  const orphan = await pixels('#808080');
  await writeFile(join(directory, 'objects', `${digest(orphan)}.png`), orphan);
  await writeFile(join(directory, 'objects', `${digest(orphan)}.png.stale.tmp`), orphan.subarray(0, 10));
  await writeFile(join(directory, 'originals', 'stray.png'), orphan);
  const objectsBefore = await files(directory, 'objects');
  const restarted = open();
  assert.deepEqual((await restarted.reconcile({ graceMs: 60_000 })).removed, [], 'recent files stay inside the grace window');
  const { removed } = await restarted.reconcile();
  assert.deepEqual(removed.sort(), [`objects/${digest(orphan)}.png`, `objects/${digest(orphan)}.png.stale.tmp`, 'originals/stray.png'].sort());
  assert.deepEqual(await files(directory, 'objects'), objectsBefore.filter((name) => !name.startsWith(digest(orphan))));
  assert.equal((await assertComplete(restarted)).revision, receipt.newRevision);
});

for (const failure of ['io', 'corrupt']) {
  test(`a ${failure} failure while retaining the original publishes nothing and keeps the source active`, async (t) => {
    const { directory, first, source } = await setup(t);
    first.failRetention = failure;
    const receipt = await first.execute(input(source));
    assert.deepEqual([receipt.status, receipt.code], ['rejected', 'BACKUP_FAILED']);
    const read = await assertComplete(first);
    assert.equal(read.revision, source.revision);
    assert.deepEqual(first.backupTotals(), { count: 0, bytes: 0 });
    assert.deepEqual(await files(directory, 'originals'), [], 'no corrupt or partial object carries a final name');
    first.failRetention = null;
    assert.equal((await first.execute(input(source))).code, 'BACKUP_FAILED', 'the rejection is durable for this operation ID');
    assert.equal((await first.execute(input(source, { operationId: 'op-2' }))).status, 'published');
    assert.equal(first.backupTotals().count, 1);
  });
}

test('invalid candidates are rejected before any object or backup is written', async (t) => {
  const { directory, first, source } = await setup(t);
  const objectsBefore = await files(directory, 'objects');
  const cases = {
    CORRUPT: Buffer.from(optimizedBytes.subarray(0, optimizedBytes.length - 20)),
    DIMENSIONS_CHANGED: await pixels('#2060e0', 32),
    WRONG_FORMAT: await sharp({ create: { width: 16, height: 16, channels: 3, background: '#2060e0' } }).jpeg().toBuffer(),
  };
  let n = 0;
  for (const [code, bytes] of Object.entries(cases)) {
    const receipt = await first.execute(input(source, { operationId: `bad-${n++}`, bytes }));
    assert.ok(receipt.code === code || (code === 'CORRUPT' && receipt.code === 'UNDECODABLE'), `${code} got ${receipt.code}`);
    assert.equal(receipt.status, 'rejected');
  }
  assert.deepEqual(await files(directory, 'objects'), objectsBefore);
  assert.equal(first.backupTotals().count, 0);
  assert.equal((await assertComplete(first)).revision, source.revision);
});

test('reusing an operation ID with different input is rejected, including after deletion', async (t) => {
  const { first, source } = await setup(t);
  const receipt = await first.execute(input(source));
  assert.equal(receipt.status, 'published');
  const conflicting = input(source, { bytes: editorBytes });
  assert.equal((await first.execute(conflicting)).code, 'CONFLICTING_OPERATION');
  assert.equal(first.delete('image', receipt.newRevision).success, true);
  assert.equal((await first.execute(conflicting)).code, 'CONFLICTING_OPERATION');
  assert.deepEqual(await first.execute(input(source)), receipt, 'identical retry after deletion still returns the receipt');
  assert.equal(await first.read('image'), null, 'a retry never resurrects the image');
});

test('an editor publishing between retention and commit wins; the stale operation is rejected and the backup is not duplicated', async (t) => {
  const { first, open, source } = await setup(t);
  const editor = open();
  first.hooks['after-original-retained'] = async () => {
    const candidate = await editor.stage(editorBytes);
    assert.equal(editor.publish('image', source.revision, candidate).success, true);
  };
  const receipt = await first.execute(input(source));
  assert.deepEqual([receipt.status, receipt.code], ['rejected', 'CONFLICT']);
  const read = await assertComplete(first);
  assert.equal(digest(read.bytes), digest(editorBytes));
  assert.equal(first.operationState('image', 'op-1'), 'rejected');
  assert.equal(first.backupTotals().count, 1, 'the retained original stays; nothing was published from it');
});

test('deletion between retention and commit rejects the operation, and neither retry nor reconciliation resurrects the image', async (t) => {
  const { first, open, source } = await setup(t);
  const editor = open();
  first.hooks['after-original-retained'] = async () => { assert.equal(editor.delete('image', source.revision).success, true); };
  const receipt = await first.execute(input(source));
  assert.deepEqual([receipt.status, receipt.code], ['rejected', 'CONFLICT']);
  first.hooks = {};
  assert.deepEqual(await first.execute(input(source)), receipt);
  assert.equal((await first.execute(input(source, { operationId: 'op-2' }))).code, 'CONFLICT');
  first.close();
  const restarted = open();
  await restarted.reconcile();
  assert.equal(await restarted.read('image'), null);
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS n FROM media').get().n, 1);
  assert.equal(digest(await readFile(join(restarted.directory, restarted.db.prepare('SELECT object_key FROM revisions WHERE id = ?').get(source.revision).object_key))), digest(originalBytes));
});

test('a reader holding a pre-publication snapshot still reads one complete revision after publication', async (t) => {
  const { first, open, source } = await setup(t);
  const reader = open();
  const snapshot = reader.snapshot('image');
  const receipt = await first.execute(input(source));
  const oldBytes = await readFile(join(reader.directory, snapshot.objectKey));
  assert.equal(digest(oldBytes), snapshot.digest);
  assert.equal(oldBytes.length, snapshot.size);
  const fresh = await reader.read('image');
  assert.equal(fresh.revision, receipt.newRevision);
  assert.equal(digest(fresh.bytes), fresh.digest);
});

test('restore returns exact original bytes with a new revision and keeps current editorial metadata', async (t) => {
  const { first, source } = await setup(t);
  const receipt = await first.execute(input(source));
  first.db.prepare("UPDATE media SET caption = 'Edited caption', focal_x = 0.4 WHERE id = 'image'").run();
  const restored = await first.restore({ operationId: 'restore-1', mediaId: 'image', expectedRevision: receipt.newRevision, originalDigest: receipt.originalDigest });
  assert.equal(restored.status, 'published');
  const read = await assertComplete(first);
  assert.equal(digest(read.bytes), digest(originalBytes));
  assert.notEqual(read.revision, source.revision);
  assert.equal(read.caption, 'Edited caption');
  assert.equal(read.focalX, 0.4);
  assert.deepEqual(first.backupTotals(), { count: 1, bytes: originalBytes.length });
});

test('restore after a manual edit reports conflict without overwriting the edit', async (t) => {
  const { first, open, source } = await setup(t);
  const receipt = await first.execute(input(source));
  const editor = open();
  const candidate = await editor.stage(editorBytes);
  assert.equal(editor.publish('image', receipt.newRevision, candidate).success, true);
  const restored = await first.restore({ operationId: 'restore-1', mediaId: 'image', expectedRevision: receipt.newRevision, originalDigest: receipt.originalDigest });
  assert.deepEqual([restored.status, restored.code], ['rejected', 'CONFLICT']);
  assert.equal(digest((await assertComplete(first)).bytes), digest(editorBytes));
});

for (const point of ['after-intent', 'candidate-object-written', 'in-publication-transaction', 'after-publication']) {
  test(`a restore interrupted at ${point} recovers to a complete revision and can be repeated`, async (t) => {
    const { first, open, source } = await setup(t);
    const receipt = await first.execute(input(source));
    const restore = { operationId: 'restore-1', mediaId: 'image', expectedRevision: receipt.newRevision, originalDigest: receipt.originalDigest };
    first.crashAt = point;
    await assert.rejects(first.restore(restore), CrashSignal);
    first.close();
    const restarted = open();
    const before = await assertComplete(restarted);
    assert.equal(digest(before.bytes), digest(point === 'after-publication' ? originalBytes : optimizedBytes));
    await restarted.reconcile();
    const again = point === 'after-publication'
      ? await restarted.restore(restore)
      : await restarted.restore({ ...restore, operationId: 'restore-2' });
    assert.equal(again.status, 'published');
    assert.equal(digest((await assertComplete(restarted)).bytes), digest(originalBytes));
    assert.deepEqual(restarted.backupTotals(), { count: 1, bytes: originalBytes.length });
  });
}

test('retained originals and receipts are readable by a fresh process with no plugin state', async (t) => {
  const { first, open, source } = await setup(t);
  const receipt = await first.execute(input(source));
  first.close();
  const recovery = open();
  const original = recovery.db.prepare('SELECT * FROM originals WHERE digest = ?').get(receipt.originalDigest);
  assert.equal(digest(await readFile(join(recovery.directory, original.object_key))), digest(originalBytes));
  const restored = await recovery.restore({ operationId: 'recover-1', mediaId: 'image', expectedRevision: receipt.newRevision, originalDigest: receipt.originalDigest });
  assert.equal(restored.status, 'published');
  assert.equal(digest((await assertComplete(recovery)).bytes), digest(originalBytes));
});
