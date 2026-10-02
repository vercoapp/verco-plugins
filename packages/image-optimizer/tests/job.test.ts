import { describe, expect, it } from 'vitest';

import {
  addSummaries,
  advanceScan,
  emptySummary,
  readScan,
  recordUpload,
  SCAN_STATE_KEY,
  startScan,
  type ScanDeps,
  type ScanRun,
  type StoredResult,
} from '../src/job.ts';
import { DEFAULT_SCAN_OPTIONS } from '../src/scanner.ts';

interface FakeMedia {
  id: string;
  filename: string;
  mimeType: string;
  size: number | null;
  width?: number | null;
  height?: number | null;
}

/** In-memory stand-ins with the host's semantics: revisioned KV, newest-first keyset listing, range queries. */
function fakeHost(library: FakeMedia[]) {
  const kv = new Map<string, { value: unknown; revision: number }>();
  const results = new Map<string, StoredResult>();
  const listCalls: Array<string | undefined> = [];
  let revisions = 0;
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  let beforeList: (() => Promise<void>) | undefined;
  let beforeCas: (() => Promise<void>) | undefined;

  const deps: ScanDeps = {
    kv: {
      async get<T>(key: string) {
        return (kv.get(key)?.value as T | undefined) ?? null;
      },
      async getVersioned<T>(key: string) {
        const entry = kv.get(key);
        return entry ? { value: structuredClone(entry.value) as T, revision: String(entry.revision) } : null;
      },
      async compareAndSet(key: string, expected: string | null, value: unknown) {
        const hook = beforeCas;
        beforeCas = undefined;
        await hook?.();
        const entry = kv.get(key);
        if ((entry ? String(entry.revision) : null) !== expected) return { applied: false } as const;
        revisions += 1;
        kv.set(key, { value: structuredClone(value), revision: revisions });
        return { applied: true, revision: String(revisions) } as const;
      },
    } as unknown as ScanDeps['kv'],
    media: {
      async list(options) {
        listCalls.push(options?.cursor);
        const hook = beforeList;
        beforeList = undefined;
        await hook?.();
        const prefix = options?.mimeType ?? '';
        const matching = library.filter((item) => item.mimeType.startsWith(prefix));
        // Keyset cursor, like the host: the next page starts after the last listed item, so items
        // added at the front (newer uploads) are never reached.
        const start = options?.cursor ? matching.findIndex((item) => item.id === options.cursor) + 1 : 0;
        const limit = options?.limit ?? 50;
        const items = matching.slice(start, start + limit);
        const hasMore = start + limit < matching.length;
        return {
          items: items.map((item) => ({ ...item, url: '', createdAt: '' })),
          hasMore,
          ...(hasMore ? { cursor: items.at(-1)!.id } : {}),
        };
      },
      async get(id) {
        const item = library.find((candidate) => candidate.id === id);
        return item ? { ...item, url: '', createdAt: '' } : null;
      },
    },
    results: {
      async put(id: string, data: StoredResult) {
        results.set(id, structuredClone(data));
      },
      async putMany(items: Array<{ id: string; data: StoredResult }>) {
        for (const { id, data } of items) results.set(id, structuredClone(data));
      },
      async query(options: { where: { runId: { lt: string } }; limit: number }) {
        const matching = [...results].filter(([, data]) => data.runId < options.where.runId.lt);
        return {
          items: matching.slice(0, options.limit).map(([id, data]) => ({ id, data })),
          hasMore: matching.length > options.limit,
        };
      },
      async deleteMany(ids: string[]) {
        for (const id of ids) results.delete(id);
        return ids.length;
      },
    } as unknown as ScanDeps['results'],
    log: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ScanDeps['log'],
    now: () => new Date((clock += 1000)),
  };

  return {
    deps,
    results,
    listCalls,
    state: () => kv.get(SCAN_STATE_KEY)?.value as ScanRun | undefined,
    onNextList(hook: () => Promise<void>) {
      beforeList = hook;
    },
    onNextCompareAndSet(hook: () => Promise<void>) {
      beforeCas = hook;
    },
  };
}

function jpegs(count: number, overrides: Partial<FakeMedia> = {}): FakeMedia[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${String(index).padStart(4, '0')}`,
    filename: `photo-${index}.jpg`,
    mimeType: 'image/jpeg',
    size: 600_000,
    width: 1200,
    height: 800,
    ...overrides,
  }));
}

describe('sweep', () => {
  it('pages through the library, then completes with totals for every image', async () => {
    const library = [...jpegs(250), { id: 'doc', filename: 'a.pdf', mimeType: 'application/pdf', size: 10 }];
    const host = fakeHost(library);
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);

    // One page per call: three sweep pages, then the cleanup page that completes the run.
    for (const phase of ['sweep', 'sweep', 'cleanup', 'complete']) {
      expect((await advanceScan(host.deps, 1))?.phase).toBe(phase);
    }
    expect(host.listCalls).toEqual([undefined, 'm0099', 'm0199']);

    const run = host.state()!;
    expect(run.totals.scanned).toBe(250);
    expect(run.totals.flagged).toBe(250);
    expect(run.totals.estimatedSavingsBytes).toBe(250 * 369_600);
    expect(run.finishedAt).not.toBeNull();
    expect(run.updatedAt > run.startedAt).toBe(true);
    expect(run.updatedAt >= run.finishedAt!).toBe(true);
    expect(host.results.size).toBe(250);
    expect(host.results.get('m0000')).toMatchObject({
      runId: run.runId,
      status: 'flagged',
      findings: ['heavy-encoding'],
      estimateBytes: 369_600,
      estimateBasis: 'resize-and-reencode',
    });
    expect(await advanceScan(host.deps)).toEqual(run);
  });

  it('counts a page once when a concurrent invocation advanced the scan first', async () => {
    const host = fakeHost(jpegs(150));
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);

    // While this invocation lists its first page, another one takes the same page and commits.
    host.onNextList(async () => {
      await advanceScan(host.deps, 1);
    });
    const afterConflict = await advanceScan(host.deps, 5);
    expect(afterConflict?.totals.scanned).toBe(100);
    expect(afterConflict?.cursor).toBe('m0099');

    await advanceScan(host.deps, 5);
    expect(host.state()).toMatchObject({ phase: 'complete', totals: { scanned: 150, flagged: 150 } });
  });

  it('removes results from earlier runs and keeps the current ones', async () => {
    const host = fakeHost(jpegs(3));
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);
    await advanceScan(host.deps);
    const first = host.state()!;
    host.results.set('deleted-media', { ...host.results.get('m0000')!, runId: first.runId });

    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);
    await advanceScan(host.deps);
    const second = host.state()!;

    expect(second.runId > first.runId).toBe(true);
    expect([...host.results.keys()].sort()).toEqual(['m0000', 'm0001', 'm0002']);
    expect([...host.results.values()].every((result) => result.runId === second.runId)).toBe(true);
  });

  it('completes an empty library', async () => {
    const host = fakeHost([]);
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);
    expect(await advanceScan(host.deps)).toMatchObject({ phase: 'complete', totals: emptySummary() });
  });
});

describe('starting', () => {
  it('does not restart an active scan, and starts afresh after completion', async () => {
    const host = fakeHost(jpegs(150));
    const first = await startScan(host.deps, DEFAULT_SCAN_OPTIONS);
    expect(first.started).toBe(true);
    await advanceScan(host.deps, 1);

    const again = await startScan(host.deps, { ...DEFAULT_SCAN_OPTIONS, maxDimension: 100 });
    expect(again).toMatchObject({ started: false, run: { runId: first.run.runId, cursor: 'm0099' } });

    await advanceScan(host.deps);
    const next = await startScan(host.deps, { ...DEFAULT_SCAN_OPTIONS, maxDimension: 100 });
    expect(next.started).toBe(true);
    expect(next.run).toMatchObject({ phase: 'sweep', cursor: null, totals: emptySummary() });
    expect(next.run.options.maxDimension).toBe(100);
  });

  it('lets only one of two simultaneous starts create the run', async () => {
    const host = fakeHost(jpegs(1));
    const [a, b] = await Promise.all([
      startScan(host.deps, DEFAULT_SCAN_OPTIONS),
      startScan(host.deps, DEFAULT_SCAN_OPTIONS),
    ]);
    expect([a.started, b.started].sort()).toEqual([false, true]);
    expect(a.run.runId).toBe(b.run.runId);
  });
});

describe('uploads', () => {
  it('stores a result without totals before any scan has run', async () => {
    const host = fakeHost(jpegs(1));
    await recordUpload(host.deps, 'm0000', DEFAULT_SCAN_OPTIONS);
    expect(host.results.get('m0000')).toMatchObject({ runId: '', status: 'flagged' });
    expect(await readScan(host.deps)).toBeNull();
  });

  it("adds an upload to the run's totals with the run's options", async () => {
    const library: FakeMedia[] = [];
    const host = fakeHost(library);
    await startScan(host.deps, { ...DEFAULT_SCAN_OPTIONS, maxDimension: 4000 });
    await advanceScan(host.deps);
    library.push(...jpegs(1, { size: 2_400_000, width: 4000, height: 3000 }));

    await recordUpload(host.deps, 'm0000', DEFAULT_SCAN_OPTIONS);
    // With the run's maxDimension of 4000 this light JPEG needs no resize, so it is fine.
    expect(host.results.get('m0000')).toMatchObject({ runId: host.state()!.runId, status: 'ok' });
    expect(host.state()!.totals).toEqual(addSummaries(emptySummary(), { ...emptySummary(), scanned: 1, ok: 1 }));
  });

  it('retries the totals when the sweep moves the state at the same time', async () => {
    const library = jpegs(150);
    const host = fakeHost(library);
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);
    await advanceScan(host.deps, 1);
    library.unshift({ id: 'new', filename: 'new.jpg', mimeType: 'image/jpeg', size: 600_000, width: 1200, height: 800 });

    // The upload's first write conflicts with the next sweep page.
    host.onNextCompareAndSet(async () => {
      await advanceScan(host.deps, 1);
    });
    await recordUpload(host.deps, 'new', DEFAULT_SCAN_OPTIONS);

    const before = host.state()!.updatedAt;
    expect(host.state()).toMatchObject({ phase: 'cleanup', totals: { scanned: 151, flagged: 151 } });
    await recordUpload(host.deps, 'new', DEFAULT_SCAN_OPTIONS);
    expect(host.state()!.updatedAt > before).toBe(true);
  });

  it('ignores missing media and non-images', async () => {
    const host = fakeHost([{ id: 'doc', filename: 'a.pdf', mimeType: 'application/pdf', size: 10 }]);
    await recordUpload(host.deps, 'doc', DEFAULT_SCAN_OPTIONS);
    await recordUpload(host.deps, 'missing', DEFAULT_SCAN_OPTIONS);
    expect(host.results.size).toBe(0);
  });
});
