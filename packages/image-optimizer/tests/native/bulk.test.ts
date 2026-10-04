/**
 * Bulk runs, their controls, upload automation and storage accounting in the native edition, over
 * the fake plugin context and the fake `ctx.media.safe`, with the real local processor (cached by
 * input, so identical images are encoded once).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateBlockResponse } from '@emdash-cms/blocks/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppliedRecord, BulkView } from '../../src/admin.ts';
import {
  AUTOMATION_RUN_ID,
  BULK_STATE_KEY,
  BULK_TASK,
  LEASE_MS,
  MAX_ITEM_ATTEMPTS,
  RETRY_MAX_MS,
  type StartOutcome,
} from '../../src/bulk.ts';
import { SCAN_STATE_KEY, type ScanRun, type StoredResult } from '../../src/job.ts';
import { MEASURED_TICK_WALL_MS } from '../../src/measure.ts';
import { APPLIED_PREFIX, parseOperationId, storageAccounting } from '../../src/mutations.ts';
import { createPlugin, CRON_HOOK_TIMEOUT_MS } from '../../src/native.ts';
import { ImageProcessorError, type ImageProcessor } from '../../src/processor/contract.ts';
import { createLocalProcessor } from '../../src/processor/local.ts';
import { bulkSite, cachedProcessor, gate, START, type BulkSite, type SiteImage } from './bulk-site.ts';
import { sha256 } from './fake-safe-media.ts';
import { photo } from './fixtures.ts';

const local = createLocalProcessor();
const shared = cachedProcessor(local);
/** Distinct heavy JPEGs (different widths), each worth optimizing. */
const heavies = await Promise.all(
  Array.from({ length: 6 }, (_, index) => photo(3, 320 + index * 8, 240).jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer()),
);
const light = await photo().jpeg({ quality: 50 }).toBuffer();
const editorImage = await photo(3).flop().jpeg({ quality: 97 }).toBuffer();

const heavy = (id: string, index = 0): SiteImage => ({
  id,
  bytes: heavies[index % heavies.length]!,
  width: 320 + (index % heavies.length) * 8,
  height: 240,
});

let stagingRoot: string;
beforeEach(async () => {
  stagingRoot = await mkdtemp(join(tmpdir(), 'image-optimizer-bulk-test-'));
});
afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true });
});

function site(images: SiteImage[], options: Partial<Parameters<typeof bulkSite>[0]> = {}): BulkSite {
  return bulkSite({ images, stagingDirectory: join(stagingRoot, 'staging'), processor: shared, ...options });
}

const start = (s: BulkSite, input: unknown = {}) => s.route('bulk-start', input) as Promise<StartOutcome>;
const replaces = (s: BulkSite) => s.safe.publications.filter(({ kind }) => kind === 'replace');
const statesOf = (s: BulkSite, runId: string) =>
  Object.fromEntries(s.items(runId).map((item) => [item.mediaId, item.state]));

/** A processor whose `process` waits for `hold` once, for the image `id`. */
function holding(base: ImageProcessor, s: () => BulkSite, id: string, hold: Promise<void>, entered: () => void): ImageProcessor {
  let held = false;
  return {
    capabilities: () => base.capabilities(),
    async process(request) {
      const active = s().media(id);
      if (!held && active && Buffer.from(request.bytes).equals(Buffer.from(active.bytes!))) {
        held = true;
        entered();
        await hold;
      }
      return base.process(request);
    },
  };
}

describe('runs', () => {
  it('applies every measured result in bounded ticks, then completes and frees the task', async () => {
    const s = site([heavy('a', 0), heavy('b', 1), heavy('c', 2), { id: 'l', bytes: light, width: 320, height: 240 }], {
      limits: { items: 2 },
    });
    s.seedMeasured(['a', 'b', 'c', 'l']);
    const started = await start(s);
    expect(started).toMatchObject({ ok: true, run: { kind: 'apply', status: 'running' } });
    if (!started.ok) return;
    expect(s.host.tasks.has(BULK_TASK)).toBe(true);

    await s.tick();
    // Prepared, then two images: the tick's bound.
    expect(s.items(started.run.runId).filter(({ state }) => state !== 'queued')).toHaveLength(2);
    const ticks = await s.drain();
    expect(ticks).toBeLessThanOrEqual(3);
    expect(statesOf(s, started.run.runId)).toEqual({ a: 'optimized', b: 'optimized', c: 'optimized', l: 'skipped' });
    expect(s.item(started.run.runId, 'l')).toMatchObject({ code: 'below-threshold' });
    expect(s.run(started.run.runId)).toMatchObject({ status: 'complete', prepared: true, enqueued: 4 });
    expect(await s.host.ctx.kv.get(BULK_STATE_KEY)).toBeNull();
    expect(s.host.tasks.has(BULK_TASK)).toBe(false);
    expect(replaces(s)).toHaveLength(3);
    expect(await s.staging.list()).toEqual([]);
  });

  it('applies a selection only, and refuses an invalid one', async () => {
    const s = site([heavy('a', 0), heavy('b', 1), heavy('c', 2)]);
    s.seedMeasured(['a', 'b', 'c']);
    expect(await start(s, { mediaIds: [] })).toMatchObject({ ok: false, error: 'INVALID_SELECTION' });
    expect(await start(s, { mediaIds: ['a', 7] })).toMatchObject({ ok: false, error: 'INVALID_SELECTION' });
    const started = await start(s, { mediaIds: ['b', 'c', 'c'] });
    if (!started.ok) throw new Error(started.message);
    await s.drain();
    expect(statesOf(s, started.run.runId)).toEqual({ b: 'optimized', c: 'optimized' });
    expect(Buffer.from(s.media('a')!.bytes!)).toEqual(heavies[0]);
  });

  it('runs one at a time, and never beside a scan', async () => {
    const s = site([heavy('a'), heavy('b', 1)]);
    s.seedMeasured(['a', 'b']);
    const first = await start(s);
    expect(first.ok).toBe(true);
    expect(await start(s)).toMatchObject({ ok: false, error: 'RUN_ACTIVE' });

    // A scan does not start while the run is active.
    const page = await s.admin({ type: 'block_action', action_id: 'start_scan' });
    expect(page.toast).toMatchObject({ type: 'info', message: expect.stringMatching(/optimization run is active/) });
    expect(s.host.state()).toBeUndefined();
    await s.drain();

    // A run does not start while a scan runs.
    await s.admin({ type: 'block_action', action_id: 'start_scan' });
    expect(s.host.state()?.phase).not.toBe('complete');
    expect(await start(s, { mediaIds: ['a'] })).toMatchObject({ ok: false, error: 'SCAN_RUNNING' });
  });

  it('starts one run when two requests race', async () => {
    const s = site([heavy('a'), heavy('b', 1)]);
    s.seedMeasured(['a', 'b']);
    const outcomes = await Promise.all([start(s, { mediaIds: ['a'] }), start(s, { mediaIds: ['b'] })]);
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.find(({ ok }) => !ok)).toMatchObject({ error: 'RUN_ACTIVE' });
  });

  it('waits while a scan that raced it runs, without touching an image', async () => {
    const s = site([heavy('a')]);
    s.seedMeasured(['a']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    s.host.seedState({ ...(s.host.state() ?? ({} as ScanRun)), runId: 'x', phase: 'sweep', measure: null } as ScanRun);
    await s.tick();
    await s.tick();
    expect(s.items(started.run.runId).every(({ state }) => state === 'queued')).toBe(true);
    expect(s.run(started.run.runId)).toMatchObject({ prepared: false });
    expect(s.safe.calls.replace).toBe(0);
  });

  it('does nothing on a host whose profile is not qualified', async () => {
    const s = site([heavy('a')], { qualifiedProfiles: [] });
    s.seedMeasured(['a']);
    expect(await start(s)).toMatchObject({ ok: false, error: 'UNAVAILABLE' });
    expect(await start(s, { kind: 'restore' })).toMatchObject({ ok: false, error: 'UNAVAILABLE' });
    expect(s.host.tasks.has(BULK_TASK)).toBe(false);
    expect(s.safe.calls.replace).toBe(0);
  });

  it('records deletions, editor changes and failures per item', async () => {
    let s: BulkSite;
    const failing: ImageProcessor = {
      capabilities: () => shared.capabilities(),
      async process(request) {
        if (Buffer.from(request.bytes).equals(heavies[2]!)) throw new ImageProcessorError('encode-failed', 'boom');
        if (Buffer.from(request.bytes).equals(heavies[1]!)) s.safe.editorReplace('edited', Uint8Array.from(editorImage));
        return shared.process(request);
      },
    };
    s = site([heavy('ok', 0), heavy('edited', 1), heavy('broken', 2), heavy('gone', 3)], { processor: failing });
    s.seedMeasured(['ok', 'edited', 'broken', 'gone']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    await s.tick(); // prepares and processes all four
    s.safe.remove('gone');
    await s.drain();
    const items = Object.fromEntries(s.items(started.run.runId).map((item) => [item.mediaId, item]));
    expect(items.ok).toMatchObject({ state: 'optimized' });
    expect(items.edited).toMatchObject({ state: 'conflict' });
    expect(items.broken).toMatchObject({ state: 'failed', code: 'encode-failed' });
    expect(Buffer.from(s.media('edited')!.bytes!)).toEqual(editorImage);
  });
});

describe('deletion during a run', () => {
  it('skips an image deleted before its turn', async () => {
    const s = site([heavy('a'), heavy('gone', 1)], { limits: { items: 1 } });
    s.seedMeasured(['a', 'gone']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    await s.tick();
    s.safe.remove('gone');
    await s.drain();
    expect(s.item(started.run.runId, 'gone')).toMatchObject({ state: 'skipped', code: 'deleted' });
    expect(replaces(s)).toHaveLength(1);
  });
});

describe('leases', () => {
  it('lets two overlapping workers commit each image once', async () => {
    const s = site(Array.from({ length: 12 }, (_, index) => heavy(`m${index}`, index)), { limits: { items: 4 } });
    s.seedMeasured(s.library.map(({ id }) => id));
    // Count the conditional writes to items that lost a race.
    const items = s.host.ctx.storage.items!;
    const compareAndSet = items.compareAndSet.bind(items);
    let lost = 0;
    items.compareAndSet = async (...args) => {
      const written = await compareAndSet(...args);
      if (!written.applied && args[1] !== null) lost += 1;
      return written;
    };
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    for (let round = 0; round < 5; round += 1) await Promise.all([s.tick(), s.tick(), s.tick()]);
    await s.drain();
    expect(lost).toBeGreaterThan(0);
    expect(Object.values(statesOf(s, started.run.runId))).toEqual(Array(12).fill('optimized'));
    const operations = replaces(s).map(({ mediaId }) => mediaId);
    expect(new Set(operations).size).toBe(operations.length);
    expect(operations).toHaveLength(12);
  });

  /** A processor that counts the images it starts and holds them until `release`. */
  function counting(release: Promise<void>) {
    let started = 0;
    const processor: ImageProcessor = {
      capabilities: () => shared.capabilities(),
      async process(request) {
        started += 1;
        await release;
        return shared.process(request);
      },
    };
    return { processor, started: () => started };
  }

  it('claims an item for one worker only when two read it at the same moment', async () => {
    const release = gate();
    const counter = counting(release.promise);
    const s = site([heavy('a'), heavy('b', 1)], { processor: counter.processor, limits: { items: 1 } });
    s.seedMeasured(['a', 'b']);
    const started = await start(s, { mediaIds: ['a'] });
    if (!started.ok) throw new Error(started.message);
    // Both workers read the queued item before either writes its claim: the first two reads of it
    // answer together.
    const items = s.host.ctx.storage.items!;
    const getVersioned = items.getVersioned.bind(items);
    const both = gate();
    let reads = 0;
    items.getVersioned = async (id) => {
      const found = await getVersioned(id);
      if (id.endsWith(':a') && reads < 2) {
        reads += 1;
        if (reads === 2) both.open();
        await both.promise;
      }
      return found;
    };
    const ticks = Promise.all([s.tick(), s.tick()]);
    await expect.poll(() => counter.started()).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release.open();
    await ticks;
    expect(counter.started()).toBe(1);
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'optimized', attempts: 1 });
  });

  it('does not take over an item another worker claimed after this one listed it', async () => {
    const release = gate();
    const counter = counting(release.promise);
    const s = site([heavy('a')], { processor: counter.processor });
    s.seedMeasured(['a']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    const first = s.tick(); // the processor holds the first worker's claim
    await expect.poll(() => counter.started()).toBe(1);
    // The second worker's list of queued items is stale: it still names the claimed item.
    const items = s.host.ctx.storage.items!;
    const query = items.query.bind(items);
    const stale = [{ id: `${started.run.runId}:a`, data: s.item(started.run.runId, 'a') }];
    items.query = async (options) =>
      (options?.where as { state?: unknown } | undefined)?.state === 'queued' ? { items: stale, hasMore: false } : query(options);
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'processing' });
    await Promise.race([s.tick(), new Promise((resolve) => setTimeout(resolve, 200))]);
    items.query = query;
    expect(counter.started()).toBe(1);
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'processing', attempts: 1 });
    release.open();
    await first;
    await s.drain();
    expect(replaces(s)).toHaveLength(1);
  });

  it('only the current holder commits after a lease expired while its worker was still processing', async () => {
    const hold = gate();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let s: BulkSite;
    s = site([heavy('slow', 0)], { processor: holding(shared, () => s, 'slow', hold.promise, () => entered()) });
    s.seedMeasured(['slow']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);

    const stale = s.tick(); // claims, then hangs in the processor
    await inside;
    expect(s.item(started.run.runId, 'slow')).toMatchObject({ state: 'processing', attempts: 1 });
    // While the lease is live, another worker leaves the item alone.
    s.advance(LEASE_MS - 1000);
    await s.tick();
    expect(s.item(started.run.runId, 'slow')).toMatchObject({ state: 'processing', attempts: 1 });
    s.advance(1001);
    await s.tick(); // takes the item over and commits it
    expect(s.item(started.run.runId, 'slow')).toMatchObject({ state: 'optimized', attempts: 2 });

    hold.open();
    await stale; // the first worker finishes processing, cannot advance the item, and does not commit
    expect(replaces(s)).toHaveLength(1);
    expect(s.safe.calls.replace).toBe(1);
    expect(s.item(started.run.runId, 'slow')).toMatchObject({ state: 'optimized', attempts: 2 });
  });

  it('resolves an item whose worker stopped after the host published, from the host record', async () => {
    const s = site([heavy('a', 0), heavy('b', 1)], { limits: { items: 1 } });
    s.seedMeasured(['a', 'b']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    // The worker stops right after the host published: its tick never returns.
    s.safe.onPublished(() => new Promise<void>(() => {}));
    void s.tick();
    await expect.poll(() => s.item(started.run.runId, 'a')?.state).toBe('committing');
    await expect.poll(() => replaces(s).length).toBe(1);
    s.safe.onPublished(undefined);

    s.restart();
    s.advance(LEASE_MS + 1);
    await s.drain();
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'optimized', replayed: true });
    expect(s.item(started.run.runId, 'b')).toMatchObject({ state: 'optimized' });
    expect(replaces(s).map(({ mediaId }) => mediaId).sort()).toEqual(['a', 'b']);
  });

  it('records an image as optimized when its worker stopped after recording the receipt but before the item', async () => {
    const s = site([heavy('a')]);
    s.seedMeasured(['a']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    // The process stops as the worker writes the item's outcome.
    const items = s.host.ctx.storage.items!;
    const compareAndSet = items.compareAndSet.bind(items);
    items.compareAndSet = async (id, expected, data) => {
      if ((data as { state?: string }).state === 'optimized') {
        items.compareAndSet = compareAndSet;
        throw new Error('Simulated stop');
      }
      return compareAndSet(id, expected, data);
    };
    await expect(s.tick()).rejects.toThrow('Simulated stop');
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'committing' });
    expect(await s.host.ctx.kv.get(`${APPLIED_PREFIX}a`)).toMatchObject({ state: 'optimized' });

    s.restart();
    s.advance(LEASE_MS + 1);
    await s.drain();
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'optimized', replayed: true, attempts: 2 });
    expect(replaces(s)).toHaveLength(1);
  });

  it('records a restore whose worker stopped before recording it', async () => {
    const s = site([heavy('a')]);
    s.seedMeasured(['a']);
    await start(s);
    await s.drain();
    const restore = await start(s, { kind: 'restore' });
    if (!restore.ok) throw new Error(restore.message);
    // The process stops right after the host restored, before the plugin's record changed.
    const kv = s.host.ctx.kv;
    const set = kv.set.bind(kv);
    kv.set = async (key, value) => {
      if (key === `${APPLIED_PREFIX}a` && (value as AppliedRecord).state === 'restored') {
        kv.set = set;
        throw new Error('Simulated stop');
      }
      return set(key, value);
    };
    await s.tick();
    expect(sha256(s.media('a')!.bytes!)).toBe(sha256(heavies[0]!));
    expect(await kv.get(`${APPLIED_PREFIX}a`)).toMatchObject({ state: 'optimized' });

    await s.drain();
    expect(s.item(restore.run.runId, 'a')).toMatchObject({ state: 'restored', replayed: true });
    expect(await kv.get(`${APPLIED_PREFIX}a`)).toMatchObject({ state: 'restored' });
    expect(s.safe.publications.filter(({ kind }) => kind === 'restore')).toHaveLength(1);
  });

  it('retries a lost response and resumes the same operation', async () => {
    const s = site([heavy('a')]);
    s.seedMeasured(['a']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    s.safe.failNext('unreachable-after-publish');
    await s.tick();
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'retry_wait', code: 'uncertain' });
    s.advance(RETRY_MAX_MS);
    await s.drain();
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'optimized', replayed: true });
    expect(replaces(s)).toHaveLength(1);
  });

  it('gives up on an item after repeated failures', async () => {
    const busy: ImageProcessor = {
      capabilities: () => shared.capabilities(),
      async process() {
        throw new ImageProcessorError('busy', 'busy');
      },
    };
    const s = site([heavy('a')], { processor: busy });
    s.seedMeasured(['a']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    for (let attempt = 0; attempt < MAX_ITEM_ATTEMPTS + 1; attempt += 1) {
      await s.tick();
      s.advance(RETRY_MAX_MS);
    }
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'failed', attempts: MAX_ITEM_ATTEMPTS });
    expect(s.run(started.run.runId)).toMatchObject({ status: 'complete' });
  });
});

describe('controls', () => {
  it('pause stops new work, an image already committing finishes, and resume continues', async () => {
    const s = site([heavy('a', 0), heavy('b', 1), heavy('c', 2)], { limits: { items: 1 } });
    s.seedMeasured(['a', 'b', 'c']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    // Pause while the host is publishing the first image.
    s.safe.onPublished(async () => {
      expect(await s.route('bulk-pause')).toMatchObject({ ok: true, run: { status: 'paused' } });
    });
    await s.tick();
    s.safe.onPublished(undefined);
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'optimized' });
    await s.tick();
    await s.tick();
    expect(statesOf(s, started.run.runId)).toEqual({ a: 'optimized', b: 'queued', c: 'queued' });
    expect(s.host.tasks.has(BULK_TASK)).toBe(true);
    expect(await s.route('bulk-pause')).toMatchObject({ ok: false, error: 'NOT_ALLOWED' });

    expect(await s.route('bulk-resume')).toMatchObject({ ok: true, run: { status: 'running' } });
    await s.drain();
    expect(statesOf(s, started.run.runId)).toEqual({ a: 'optimized', b: 'optimized', c: 'optimized' });
  });

  it('keeps output processed while pausing ready to commit, and submits it on resume', async () => {
    let s: BulkSite;
    const pausing: ImageProcessor = {
      capabilities: () => shared.capabilities(),
      async process(request) {
        await s.route('bulk-pause');
        return shared.process(request);
      },
    };
    s = site([heavy('a')], { processor: pausing });
    s.seedMeasured(['a']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    await s.tick();
    const item = s.item(started.run.runId, 'a')!;
    expect(item).toMatchObject({ state: 'ready_to_commit', leaseOwner: null });
    expect(await s.staging.list()).toEqual([item.operationId]);
    expect(s.safe.calls.replace).toBe(0);

    await s.route('bulk-resume');
    await s.drain();
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'optimized', operationId: item.operationId });
    expect(replaces(s)).toEqual([{ mediaId: 'a', operationId: item.operationId, kind: 'replace' }]);
  });

  it('cancel skips what was not submitted and keeps what was optimized', async () => {
    const s = site([heavy('a', 0), heavy('b', 1), heavy('c', 2)], { limits: { items: 1 } });
    s.seedMeasured(['a', 'b', 'c']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    await s.tick();
    expect(await s.route('bulk-cancel')).toMatchObject({ ok: true, run: { status: 'cancelling' } });
    await s.drain();
    expect(statesOf(s, started.run.runId)).toEqual({ a: 'optimized', b: 'skipped', c: 'skipped' });
    expect(s.item(started.run.runId, 'b')).toMatchObject({ code: 'cancelled' });
    expect(s.run(started.run.runId)).toMatchObject({ status: 'cancelled' });
    expect(await s.host.ctx.kv.get(BULK_STATE_KEY)).toBeNull();
    expect(replaces(s)).toHaveLength(1);
  });

  it('retries the failed items of the last run', async () => {
    let fail = true;
    const flaky: ImageProcessor = {
      capabilities: () => shared.capabilities(),
      async process(request) {
        if (fail) throw new ImageProcessorError('encode-failed', 'boom');
        return shared.process(request);
      },
    };
    const s = site([heavy('a')], { processor: flaky });
    s.seedMeasured(['a']);
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    await s.drain();
    expect(s.run(started.run.runId)).toMatchObject({ status: 'complete' });
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'failed' });

    fail = false;
    expect(await s.route('bulk-retry')).toMatchObject({ ok: true, changed: 1, run: { status: 'running' } });
    await s.drain();
    expect(s.item(started.run.runId, 'a')).toMatchObject({ state: 'optimized' });
    expect(s.run(started.run.runId)).toMatchObject({ status: 'complete' });
  });

  it('never makes the original active when a re-optimization run is paused before submitting', async () => {
    let pause = false;
    let s: BulkSite;
    const pausing: ImageProcessor = {
      capabilities: () => shared.capabilities(),
      async process(request) {
        if (pause) await s.route('bulk-pause');
        return shared.process(request);
      },
    };
    s = site([heavy('a')], { processor: pausing });
    s.seedMeasured(['a']);
    const first = await start(s);
    if (!first.ok) throw new Error(first.message);
    await s.drain();
    const optimized = sha256(s.media('a')!.bytes!);
    expect(s.safe.history('a')).toEqual([sha256(heavies[0]!), optimized]);

    s.host.settings.set('preset', 'high-fidelity');
    pause = true;
    const again = await start(s, { mediaIds: ['a'] });
    if (!again.ok) throw new Error(again.message);
    await s.tick();
    pause = false;
    const item = s.item(again.run.runId, 'a')!;
    // Paused with the output staged: the optimized image is still active, the original never was.
    expect(s.safe.history('a')).toEqual([sha256(heavies[0]!), optimized]);
    expect(item).toMatchObject({ state: 'ready_to_commit', leaseOwner: null });
    expect(parseOperationId(item.operationId!)).toMatchObject({ kind: 'reopt', originalSha256: sha256(heavies[0]!) });
    expect(s.safe.calls.restore).toBe(0);
    expect(await s.staging.list()).toEqual([item.operationId]);

    await s.route('bulk-resume');
    await s.drain();
    expect(s.item(again.run.runId, 'a')).toMatchObject({ state: 'optimized', operationId: item.operationId });
    const reoptimized = sha256(s.media('a')!.bytes!);
    expect(s.safe.history('a')).toEqual([sha256(heavies[0]!), optimized, reoptimized]);
    expect(s.safe.reads).toHaveLength(1);
    expect(s.safe.calls.restore).toBe(0);
  });

  it('retries a re-optimization whose original the host could not read just now, and records refusals per item', async () => {
    const s = site([heavy('a', 0), heavy('b', 1)]);
    s.seedMeasured(['a', 'b']);
    const first = await start(s);
    if (!first.ok) throw new Error(first.message);
    await s.drain();
    s.host.settings.set('preset', 'high-fidelity');
    s.safe.loseOriginal(sha256(heavies[1]!));
    s.safe.refuseReads('ORIGINAL_UNREADABLE');
    const again = await start(s, { mediaIds: ['a', 'b'] });
    if (!again.ok) throw new Error(again.message);
    await s.drain();
    const items = Object.fromEntries(s.items(again.run.runId).map((item) => [item.mediaId, item]));
    expect(items.a).toMatchObject({ state: 'optimized', attempts: 2 });
    expect(items.b).toMatchObject({ state: 'failed', code: 'original-missing' });
    expect(s.safe.calls.restore).toBe(0);
  });

  it('restores a selection with an outcome per image: restored, missing original, conflict', async () => {
    const s = site([heavy('a', 0), heavy('b', 1), heavy('c', 2), heavy('d', 3)]);
    s.seedMeasured(['a', 'b', 'c', 'd']);
    const applied = await start(s);
    if (!applied.ok) throw new Error(applied.message);
    await s.drain();
    s.safe.damageOriginal(sha256(heavies[1]!));
    s.safe.editorReplace('c', Uint8Array.from(editorImage));

    const restore = await start(s, { kind: 'restore', mediaIds: ['a', 'b', 'c'] });
    if (!restore.ok) throw new Error(restore.message);
    await s.drain();
    const items = Object.fromEntries(s.items(restore.run.runId).map((item) => [item.mediaId, item]));
    expect(items.a).toMatchObject({ state: 'restored' });
    expect(items.b).toMatchObject({ state: 'failed', code: 'missing-original' });
    expect(items.c).toMatchObject({ state: 'conflict', code: 'nothing-to-restore' });
    expect(sha256(s.media('a')!.bytes!)).toBe(sha256(heavies[0]!));
    expect(Buffer.from(s.media('c')!.bytes!)).toEqual(editorImage);
    // Not selected: still optimized.
    expect(sha256(s.media('d')!.bytes!)).not.toBe(sha256(heavies[3]!));
  });

  it('restores everything this plugin optimized', async () => {
    const s = site([heavy('a', 0), heavy('b', 1)]);
    s.seedMeasured(['a', 'b']);
    await start(s);
    await s.drain();
    const restore = await start(s, { kind: 'restore' });
    if (!restore.ok) throw new Error(restore.message);
    await s.drain();
    expect(statesOf(s, restore.run.runId)).toEqual({ a: 'restored', b: 'restored' });
  });
});

describe('restarts', () => {
  it('continues a run from stored state after the plugin restarts, without duplicate mutation', async () => {
    const s = site(Array.from({ length: 6 }, (_, index) => heavy(`m${index}`, index)), { limits: { items: 2 } });
    s.seedMeasured(s.library.map(({ id }) => id));
    const started = await start(s);
    if (!started.ok) throw new Error(started.message);
    await s.tick();
    s.restart();
    await s.tick();
    s.restart();
    await s.drain();
    expect(Object.values(statesOf(s, started.run.runId))).toEqual(Array(6).fill('optimized'));
    expect(replaces(s)).toHaveLength(6);
  });
});

describe('upload automation', () => {
  const upload = (s: BulkSite, id: string) =>
    (s.plugin.hooks['media:afterUpload'] as { handler: (...args: unknown[]) => Promise<void> }).handler(
      { media: { ...s.media(id)!, url: '', createdAt: s.media(id)!.createdAt } },
      s.host.ctx,
    );

  it('is off by default: an upload is estimated, not queued', async () => {
    const s = site([heavy('new')]);
    await upload(s, 'new');
    expect(s.items()).toEqual([]);
    expect(s.host.tasks.has(BULK_TASK)).toBe(false);
  });

  it('queues nothing where the host does not allow changes, even when switched on', async () => {
    const s = site([{ ...heavy('new'), createdAt: new Date(START).toISOString() }], { qualifiedProfiles: [] });
    s.host.settings.set('autoOptimize', true);
    await upload(s, 'new');
    expect(s.items()).toEqual([]);
    expect(s.host.tasks.has(BULK_TASK)).toBe(false);
    s.host.tasks.set(BULK_TASK, { schedule: '* * * * *' });
    await s.tick();
    expect(s.items()).toEqual([]);
    expect(s.host.tasks.has(BULK_TASK)).toBe(false);
  });

  it('queues an upload without processing it, then optimizes it in the background', async () => {
    let processed = 0;
    const counting: ImageProcessor = {
      capabilities: () => shared.capabilities(),
      async process(request) {
        processed += 1;
        return shared.process(request);
      },
    };
    const s = site([{ ...heavy('new'), createdAt: new Date(START).toISOString() }], { processor: counting });
    s.host.settings.set('autoOptimize', true);
    await upload(s, 'new');
    expect(processed).toBe(0);
    expect(s.item(AUTOMATION_RUN_ID, 'new')).toMatchObject({ state: 'queued' });
    expect(s.host.tasks.has(BULK_TASK)).toBe(true);
    await s.tick();
    expect(s.item(AUTOMATION_RUN_ID, 'new')).toMatchObject({ state: 'optimized' });
    // Uploading the same item again does not queue it twice, nor queue it again.
    await upload(s, 'new');
    expect(s.items(AUTOMATION_RUN_ID)).toHaveLength(1);
    expect(s.item(AUTOMATION_RUN_ID, 'new')).toMatchObject({ state: 'optimized' });
  });

  it('lets the upload succeed when queueing fails, and when the encoder fails later', async () => {
    const broken: ImageProcessor = {
      capabilities: () => shared.capabilities(),
      async process() {
        throw new ImageProcessorError('encode-failed', 'boom');
      },
    };
    const s = site([{ ...heavy('new'), createdAt: new Date(START).toISOString() }], { processor: broken });
    s.host.settings.set('autoOptimize', true);
    const items = s.host.ctx.storage.items!;
    const compareAndSet = items.compareAndSet;
    items.compareAndSet = async () => {
      throw new Error('storage down');
    };
    await expect(upload(s, 'new')).resolves.toBeUndefined();
    expect(s.host.logs.some(({ message }) => /reconciliation pass will find it/.test(message))).toBe(true);
    items.compareAndSet = compareAndSet;

    // The reconciliation pass finds the upload the hook missed; the encoder then fails on it.
    await s.tick();
    await s.tick();
    expect(s.item(AUTOMATION_RUN_ID, 'new')).toMatchObject({ state: 'failed', code: 'encode-failed' });
    expect(Buffer.from(s.media('new')!.bytes!)).toEqual(heavies[0]);
  });

  it('reconciles uploads the hook missed once, and not images older than the switch', async () => {
    const s = site([
      { ...heavy('missed-2', 1), createdAt: new Date(START + 2000).toISOString() },
      { ...heavy('missed-1', 2), createdAt: new Date(START + 1000).toISOString() },
      { ...heavy('older', 3), createdAt: new Date(START - 1000).toISOString() },
    ]);
    s.host.settings.set('autoOptimize', true);
    s.host.settings.set('minSavingsKB', 1000); // nothing is applied: only queueing is under test
    await s.tick(); // switches automation on at START and runs the first pass
    expect(s.items(AUTOMATION_RUN_ID).map(({ mediaId }) => mediaId).sort()).toEqual(['missed-1', 'missed-2']);
    expect(await s.route('bulk-reconcile')).toEqual({ queued: 0 });
    expect(s.items(AUTOMATION_RUN_ID)).toHaveLength(2);
  });

  it('switching automation off forgets it; the task stops when nothing is left', async () => {
    const s = site([{ ...heavy('new'), createdAt: new Date(START).toISOString() }]);
    s.host.settings.set('autoOptimize', true);
    await s.tick();
    expect(s.host.tasks.size).toBeGreaterThanOrEqual(0);
    s.host.settings.set('autoOptimize', false);
    s.host.tasks.set(BULK_TASK, { schedule: '* * * * *' });
    await s.tick();
    expect(await s.host.ctx.kv.get('state:automation')).toBeNull();
    expect(s.host.tasks.has(BULK_TASK)).toBe(false);
  });
});

describe('accounting', () => {
  it('reports gross reduction, retained originals and a net storage increase separately', async () => {
    const s = site([heavy('a', 0), heavy('b', 1), heavy('c', 2)]);
    s.seedMeasured(['a', 'b', 'c']);
    await start(s);
    await s.drain();
    const records = (await s.host.ctx.kv.list(APPLIED_PREFIX)).map(({ value }) => value as AppliedRecord);
    const outputs = ['a', 'b', 'c'].map((id) => s.media(id)!.bytes!.byteLength);
    const inputs = [0, 1, 2].map((index) => heavies[index]!.byteLength);
    const accounting = storageAccounting(records);
    expect(accounting).toEqual({
      optimized: 3,
      grossReductionBytes: inputs.reduce((a, b) => a + b) - outputs.reduce((a, b) => a + b),
      retainedOriginalBytes: inputs.reduce((a, b) => a + b),
      // Every original is kept: the site stores the optimized files on top of them.
      netStorageChangeBytes: outputs.reduce((a, b) => a + b),
    });
    expect(accounting.netStorageChangeBytes).toBeGreaterThan(0);

    // A restore keeps the optimized file as well: the reduction goes, the retained bytes grow.
    const restore = await start(s, { kind: 'restore', mediaIds: ['a'] });
    expect(restore.ok).toBe(true);
    await s.drain();
    const after = storageAccounting((await s.host.ctx.kv.list(APPLIED_PREFIX)).map(({ value }) => value as AppliedRecord));
    expect(after.optimized).toBe(2);
    expect(after.retainedOriginalBytes).toBe(accounting.retainedOriginalBytes + outputs[0]!);
    expect(after.netStorageChangeBytes).toBe(accounting.netStorageChangeBytes + inputs[0]!);

    const page = await s.admin({ type: 'page_load', page: '/report' });
    expect(validateBlockResponse(page, { pluginPagePaths: ['/report'] }).errors).toEqual([]);
    const text = JSON.stringify(page.blocks);
    expect(text).toMatch(/Source reduction \(gross\)/);
    expect(text).toMatch(/"label":"Net storage change","value":"\+/);
    expect(text).toMatch(/More storage than before/);
    // The gross reduction is never labelled a saving.
    const labels = page.blocks
      .filter((block) => block.block_id === 'storage' || block.block_id === 'net-storage')
      .flatMap((block) => (block.items as Array<{ label: string }>).map(({ label }) => label));
    expect(labels).toEqual(['Source reduction (gross)', 'Originals retained', 'Net storage change']);
    expect(text).toMatch(/It is not a storage saving/);
  });

  it('refreshes the scan result and its totals after apply and restore', async () => {
    const s = site([heavy('a', 0), heavy('b', 1)]);
    await s.scan();
    const before = s.host.state()!;
    expect(before.totals.flagged).toBe(2);
    const saving = s.host.results.get('a')!.estimateBytes;

    const applied = await s.apply('a');
    expect(applied.outcome).toBe('optimized');
    expect(s.host.results.get('a')).toMatchObject({ status: 'ok', estimateBytes: 0, optimized: { inputBytes: heavies[0]!.byteLength } });
    let totals = (await s.host.ctx.kv.get<ScanRun>(SCAN_STATE_KEY))!.totals;
    expect(totals).toMatchObject({ flagged: 1, ok: before.totals.ok + 1, measuredSavingsBytes: before.totals.measuredSavingsBytes! - saving });

    expect(await s.route('restore', { mediaId: 'a' })).toMatchObject({ outcome: 'restored' });
    const restored = s.host.results.get('a') as StoredResult;
    expect(restored).toMatchObject({ status: 'flagged', optimized: null, basis: 'measured', size: heavies[0]!.byteLength });
    totals = (await s.host.ctx.kv.get<ScanRun>(SCAN_STATE_KEY))!.totals;
    expect(totals.flagged).toBe(2);
    expect(totals.ok).toBe(before.totals.ok);
  });
});

describe('report', () => {
  const REPORT = { type: 'page_load', page: '/report' };
  const actions = (page: { blocks: unknown[] }) => JSON.stringify(page.blocks).match(/"action_id":"bulk_[a-z_]+"/g) ?? [];

  it('offers no bulk controls when the host does not allow changes', async () => {
    const s = site([heavy('a')], { qualifiedProfiles: [] });
    await s.scan();
    const page = await s.admin(REPORT);
    expect(actions(page)).toEqual([]);
    expect(JSON.stringify(page.blocks)).not.toMatch(/Bulk optimization|Upload automation/);
  });

  it('starts, pauses, resumes and shows a run from the report', async () => {
    const s = site([heavy('a', 0), heavy('b', 1)], { limits: { items: 1 } });
    await s.scan();
    let page = await s.admin(REPORT);
    expect(validateBlockResponse(page, { pluginPagePaths: ['/report'] }).errors).toEqual([]);
    expect(actions(page)).toEqual(expect.arrayContaining(['"action_id":"bulk_apply_all"', '"action_id":"bulk_apply_page"']));

    page = await s.admin({ type: 'block_action', action_id: 'bulk_apply_all' });
    expect(page.toast).toMatchObject({ type: 'success' });
    expect(JSON.stringify(page.blocks)).toMatch(/Optimization run in progress/);
    expect(actions(page)).toEqual(expect.arrayContaining(['"action_id":"bulk_pause"', '"action_id":"bulk_cancel"']));

    await s.tick();
    page = await s.admin({ type: 'block_action', action_id: 'bulk_pause' });
    expect(JSON.stringify(page.blocks)).toMatch(/Optimization run paused/);
    expect(actions(page)).toContain('"action_id":"bulk_resume"');
    page = await s.admin({ type: 'block_action', action_id: 'bulk_resume' });
    await s.drain();
    page = await s.admin(REPORT);
    expect(validateBlockResponse(page, { pluginPagePaths: ['/report'] }).errors).toEqual([]);
    expect(JSON.stringify(page.blocks)).toMatch(/Last optimization run finished .*: 2 optimized/);
    const view = (await s.route('bulk-status')) as BulkView;
    expect(view.run).toMatchObject({ status: 'complete', counts: { optimized: 2 } });
  });

  it('optimizes the listed page as a selection', async () => {
    const s = site([heavy('a', 0), heavy('b', 1)]);
    await s.scan();
    const page = await s.admin({ type: 'block_action', action_id: 'bulk_apply_page', value: { mediaIds: ['b'] } });
    expect(page.toast).toMatchObject({ type: 'success' });
    await s.drain();
    expect(s.items().map(({ mediaId, state }) => [mediaId, state])).toEqual([['b', 'optimized']]);
  });
});

describe('scheduled task', () => {
  it('gives a tick time for its wall-time bound plus one image at the processor limit', () => {
    const cron = createPlugin().hooks.cron as { timeout?: number };
    expect(cron.timeout).toBe(CRON_HOOK_TIMEOUT_MS);
    expect(CRON_HOOK_TIMEOUT_MS).toBeGreaterThanOrEqual(MEASURED_TICK_WALL_MS + local.capabilities().limits.wallTimeMs);
  });
});

describe('item records', () => {
  it('hold no image bytes', async () => {
    const s = site([heavy('a')]);
    s.seedMeasured(['a']);
    await start(s);
    await s.drain();
    const stored = JSON.stringify([...s.host.collections.values()].map((collection) => [...collection.values()]));
    expect(stored.length).toBeLessThan(heavies[0]!.byteLength / 4);
    expect((await s.host.ctx.kv.get<AppliedRecord>(`${APPLIED_PREFIX}a`))?.retained).toEqual({
      [sha256(heavies[0]!)]: heavies[0]!.byteLength,
    });
  });
});

