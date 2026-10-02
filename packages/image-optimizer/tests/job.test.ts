import { describe, expect, it } from 'vitest';

import {
  addSummaries,
  advanceScan,
  emptySummary,
  readScan,
  recordUpload,
    startScan,
} from '../src/job.ts';
import { DEFAULT_SCAN_OPTIONS } from '../src/scanner.ts';
import { fakeHost, jpegs, type FakeMedia } from './fake-host.ts';

describe('sweep', () => {
  it('pages through the library, then completes with totals for every image', async () => {
    const library = [...jpegs(250), { id: 'doc', filename: 'a.pdf', mimeType: 'application/pdf', size: 10 }];
    const host = fakeHost(library);
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);

    // One page per call. The third finishes the sweep, and the same tick's cleanup completes the run.
    for (const phase of ['sweep', 'sweep', 'complete']) {
      expect((await advanceScan(host.deps, { sweepPages: 1 }))?.phase).toBe(phase);
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
      await advanceScan(host.deps, { sweepPages: 1 });
    });
    const afterConflict = await advanceScan(host.deps);
    // The losing tick reports the state it read, which is not complete, so the task keeps running.
    expect(afterConflict).toMatchObject({ phase: 'sweep', totals: { scanned: 0 } });
    expect(host.state()).toMatchObject({ cursor: 'm0099', totals: { scanned: 100 } });

    await advanceScan(host.deps);
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
    await advanceScan(host.deps, { sweepPages: 1 });

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
    await advanceScan(host.deps, { sweepPages: 1 });
    library.unshift({ id: 'new', filename: 'new.jpg', mimeType: 'image/jpeg', size: 600_000, width: 1200, height: 800 });

    // The upload's first write conflicts with the next sweep page.
    host.onNextCompareAndSet(async () => {
      await advanceScan(host.deps, { sweepPages: 1 });
    });
    await recordUpload(host.deps, 'new', DEFAULT_SCAN_OPTIONS);

    const before = host.state()!.updatedAt;
    expect(host.state()).toMatchObject({ phase: 'complete', totals: { scanned: 151, flagged: 151 } });
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
