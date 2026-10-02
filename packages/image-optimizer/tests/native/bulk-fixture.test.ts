/**
 * A mixed 1,000-image bulk run on the fake host, with overlapping workers, plugin restarts, workers
 * that stop mid-commit or hang while processing until their lease expires, lost host responses,
 * editors replacing images during the run, and deletions. Every image's final state is checked, and
 * the host's publications show that no image was replaced twice.
 *
 * The images are small and few distinct ones are encoded (the processor is cached by input digest);
 * reading, staging, the fenced commit and the host's checks run for every image.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import type { AppliedRecord } from '../../src/admin.ts';
import { BULK_TASK, LEASE_MS, OPEN_STATES, type BulkItem, type StartOutcome } from '../../src/bulk.ts';
import { APPLIED_PREFIX, storageAccounting } from '../../src/mutations.ts';
import { ImageProcessorError, type ImageProcessor } from '../../src/processor/contract.ts';
import { bulkSite, cachedProcessor, gate, type BulkSite, type SiteImage } from './bulk-site.ts';
import { photo } from './fixtures.ts';

const VARIANTS = 9;
const variants = await Promise.all(
  Array.from({ length: VARIANTS }, (_, index) => photo(3, 320 + index * 8, 240).jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer()),
);
const light = await photo().jpeg({ quality: 50 }).toBuffer();
const editorImage = await photo(3).flop().jpeg({ quality: 97 }).toBuffer();
/** The processor fails on this one, without retry. */
const BROKEN = variants[VARIANTS - 1]!;

type Kind = 'normal' | 'light' | 'broken' | 'edited' | 'deleted';
const COUNTS: Record<Kind, number> = { normal: 760, light: 100, broken: 50, edited: 50, deleted: 40 };

/** Kinds spread through the run's order; deletions come last, so they are not reached before they happen. */
function plan(): Array<{ id: string; kind: Kind }> {
  const spread: Kind[] = [];
  const left = { ...COUNTS, deleted: 0 };
  for (let index = 0; spread.length < 1000 - COUNTS.deleted; index += 1) {
    const kind: Kind = index % 20 === 3 && left.light ? 'light' : index % 20 === 7 && left.broken ? 'broken' : index % 20 === 11 && left.edited ? 'edited' : 'normal';
    if (kind !== 'normal') left[kind] -= 1;
    else if (!left.normal) continue;
    else left.normal -= 1;
    spread.push(kind);
  }
  for (let index = 0; index < COUNTS.deleted; index += 1) spread.push('deleted');
  return spread.map((kind, index) => ({ id: `m${String(index).padStart(4, '0')}`, kind }));
}

let stagingRoot: string;
beforeAll(async () => {
  stagingRoot = await mkdtemp(join(tmpdir(), 'image-optimizer-fixture-'));
});
afterAll(async () => {
  await rm(stagingRoot, { recursive: true, force: true });
});

it('runs a mixed 1,000-image batch to a known outcome for every image, with no duplicate mutation', async () => {
  const began = performance.now();
  const items = plan();
  const kindOf = new Map(items.map(({ id, kind }) => [id, kind]));
  const images: SiteImage[] = items.map(({ id, kind }, index) => {
    if (kind === 'light') return { id, bytes: light, width: 320, height: 240 };
    const variant = kind === 'broken' ? VARIANTS - 1 : index % (VARIANTS - 1);
    return { id, bytes: variants[variant]!, width: 320 + variant * 8, height: 240 };
  });

  const cached = cachedProcessor();
  /** Workers that hang while processing until released, as a stalled process does. */
  let hangProcessing = 0;
  const stalled: Array<{ open: () => void }> = [];
  let entered = 0;
  const processor: ImageProcessor = {
    capabilities: () => cached.capabilities(),
    async process(request) {
      if (Buffer.from(request.bytes).equals(BROKEN)) throw new ImageProcessorError('encode-failed', 'Simulated encoder failure');
      if (hangProcessing > 0) {
        hangProcessing -= 1;
        const hold = gate();
        stalled.push(hold);
        entered += 1;
        await hold.promise;
      }
      return cached.process(request);
    },
  };

  const s: BulkSite = bulkSite({ images, stagingDirectory: join(stagingRoot, 'staging'), processor, limits: { items: 60 } });
  s.seedMeasured(items.map(({ id }) => id));

  // Editors replace these images right after the run read them, before it commits.
  const read = s.host.ctx.media!.readBytes!.bind(s.host.ctx.media);
  const edited = new Set<string>();
  (s.host.ctx.media as { readBytes: unknown }).readBytes = async (id: string, options?: { maxBytes?: number }) => {
    const result = await read(id, options);
    if (kindOf.get(id) === 'edited' && !edited.has(id)) {
      edited.add(id);
      s.safe.editorReplace(id, Uint8Array.from(editorImage));
    }
    return result;
  };

  /** Workers that stop for good right after the host published: their tick never returns. */
  let stopAfterPublish = 0;
  let stoppedAfterPublish = 0;
  s.safe.onPublished(async () => {
    if (stopAfterPublish > 0) {
      stopAfterPublish -= 1;
      stoppedAfterPublish += 1;
      await new Promise<void>(() => {});
    }
  });

  const started = (await s.route('bulk-start', {})) as StartOutcome;
  if (!started.ok) throw new Error(started.message);
  const { runId } = started.run;

  const pending: Array<Promise<unknown>> = [];
  const round = async (workers: number) => {
    await Promise.all(Array.from({ length: workers }, () => s.tick()));
    s.advance(60_000);
  };

  // Round 1: one worker prepares the run and starts.
  await round(1);
  expect(s.run(runId)).toMatchObject({ prepared: true, enqueued: 1000 });

  // A worker stops right after the host published, and the process restarts.
  stopAfterPublish = 1;
  pending.push(s.tick());
  await expect.poll(() => stoppedAfterPublish).toBe(1);
  s.restart();

  // A worker hangs while processing, past its lease.
  hangProcessing = 1;
  pending.push(s.tick());
  await expect.poll(() => entered).toBe(1);

  // Lost responses: one answered from the host's record at once, one only on a later attempt.
  s.safe.failNext('after-publish', 'unreachable-after-publish');

  // Deletions while the run is under way.
  for (const { id, kind } of items) if (kind === 'deleted') s.safe.remove(id);

  // Overlapping workers, with restarts between rounds.
  for (let index = 0; index < 4; index += 1) {
    await round(3);
    if (index % 2 === 1) s.restart();
  }

  // Leases of the stopped and the hung worker expire; others take their items over.
  s.advance(LEASE_MS);
  for (let index = 0; index < 30 && s.host.tasks.has(BULK_TASK); index += 1) await round(2);

  // The hung worker wakes up: it can no longer advance its item and must not commit.
  const publishedBefore = s.safe.publications.length;
  for (const hold of stalled) hold.open();
  await Promise.race([Promise.allSettled(pending.slice(1)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  expect(s.safe.publications.length).toBe(publishedBefore);

  // --- Every image's final state ---
  const finals = new Map(s.items(runId).map((item) => [item.mediaId, item] as const));
  expect(finals.size).toBe(1000);
  const open = [...finals.values()].filter((item) => OPEN_STATES.includes(item.state));
  expect(open).toEqual([]);
  const expected: Record<Kind, Partial<BulkItem>> = {
    normal: { state: 'optimized' },
    light: { state: 'skipped', code: 'below-threshold' },
    broken: { state: 'failed', code: 'encode-failed' },
    edited: { state: 'conflict' },
    deleted: { state: 'skipped', code: 'deleted' },
  };
  for (const { id, kind } of items) expect(finals.get(id), `${id} (${kind})`).toMatchObject(expected[kind]);
  expect(s.run(runId)).toMatchObject({ status: 'complete' });
  expect(s.host.tasks.has(BULK_TASK)).toBe(false);

  // --- No duplicate mutation ---
  const replaced = s.safe.publications.filter(({ kind }) => kind === 'replace').map(({ mediaId }) => mediaId);
  expect(new Set(replaced).size).toBe(replaced.length);
  expect(replaced.sort()).toEqual(items.filter(({ kind }) => kind === 'normal').map(({ id }) => id).sort());
  for (const { id, kind } of items) {
    if (kind === 'edited') expect(Buffer.from(s.media(id)!.bytes!).equals(editorImage), id).toBe(true);
  }
  // Recovered from the host's records: the worker that stopped after publishing, and the lost responses.
  const replayed = [...finals.values()].filter((item) => item.replayed);
  expect(replayed.length).toBeGreaterThanOrEqual(2);
  // Taken over after a lease expired.
  expect([...finals.values()].filter((item) => item.attempts > 1).length).toBeGreaterThanOrEqual(2);

  // Records and accounting agree with the host.
  const records = (await s.host.ctx.kv.list(APPLIED_PREFIX)).map(({ value }) => value as AppliedRecord);
  expect(records.filter(({ state }) => state === 'optimized')).toHaveLength(COUNTS.normal);
  const accounting = storageAccounting(records);
  expect(accounting.optimized).toBe(COUNTS.normal);
  // The host stores originals by digest, so the few distinct originals of this fixture count once.
  const distinct = variants.slice(0, VARIANTS - 1).reduce((sum, bytes) => sum + bytes.byteLength, 0);
  expect(accounting.retainedOriginalBytes).toBe(distinct);
  expect(accounting.netStorageChangeBytes).toBe(distinct - accounting.grossReductionBytes);
  expect(await s.staging.list()).toEqual([]);

  const seconds = (performance.now() - began) / 1000;
  console.info(
    `1,000-image batch: ${replaced.length} replaced, ${replayed.length} replayed, ${cached.encodes()} encodes, ${seconds.toFixed(1)} s`,
  );
}, 120_000);
