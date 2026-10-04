/**
 * Apply, restore and re-optimization in the native edition, through its routes and its report, over
 * the fake plugin context with a fake `ctx.media.safe` that follows the patched host's semantics, and
 * the real local processor on generated images.
 */
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateBlockResponse } from '@emdash-cms/blocks/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActionOutcome, AppliedRecord } from '../../src/admin.ts';
import {
  APPLIED_PREFIX,
  MIN_APPLY_SAVING_BYTES,
  parseOperationId,
  policyKey,
  reoptimizeOperationId,
  replaceOperationId,
  restoreOperationId,
  storageAccounting,
  type Policy,
} from '../../src/mutations.ts';
import { createNativePlugin, createPlugin } from '../../src/native.ts';
import type { ImageProcessor, ProcessRequest } from '../../src/processor/contract.ts';
import { createLocalProcessor } from '../../src/processor/local.ts';
import type { SafeMediaAccess } from '../../src/safe-media.ts';
import { createStaging, type Staging } from '../../src/staging.ts';
import { fakeHost } from '../fake-host.ts';
import { fakeSafeMedia, LOCAL_PROFILE, sha256, type EditorialMedia, type FakeSafeMedia } from './fake-safe-media.ts';
import { photo } from './fixtures.ts';

const processor = createLocalProcessor();
const heavy = await photo().jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer();
const light = await photo().jpeg({ quality: 50 }).toBuffer();
const editorImage = await photo(3).flop().jpeg({ quality: 97 }).toBuffer();

function editorial(id: string, bytes: Uint8Array): EditorialMedia {
  return {
    id,
    filename: `${id}.jpg`,
    mimeType: 'image/jpeg',
    size: bytes.byteLength,
    width: 320,
    height: 240,
    bytes: Uint8Array.from(bytes),
    url: `/_emdash/api/media/file/${id}.jpg`,
    alt: `Alt text of ${id}`,
    caption: `Caption of ${id}`,
    focalX: 0.25,
    focalY: 0.75,
  };
}

/** Everything but the bytes and their size: what a replacement must keep. */
function editorialFields(media: EditorialMedia) {
  const { bytes: _bytes, size: _size, ...kept } = media;
  return structuredClone(kept);
}

type Handler = (...args: unknown[]) => Promise<unknown>;
type Page = { blocks: Array<Record<string, unknown> & { type: string }> };

let stagingRoot: string;
beforeEach(async () => {
  stagingRoot = await mkdtemp(join(tmpdir(), 'image-optimizer-staging-test-'));
});
afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true });
});

interface SetupOptions {
  /** `null`: the host offers no safe-media access. */
  safe?: { profile?: Record<string, string>; protocol?: number; readOriginal?: boolean } | null;
  /** Defaults to the profile the fake host reports. */
  qualifiedProfiles?: Array<Record<string, string>>;
  processor?: ImageProcessor;
  staging?: Staging;
}

function setup(options: SetupOptions = {}) {
  const library = [editorial('heavy', heavy), editorial('light', light)];
  const host = fakeHost(library, { readBytes: true });
  host.settings.set('minSavingsKB', 1);
  host.settings.set('minSavingsPercent', 5);
  const safe = options.safe === null ? null : fakeSafeMedia(library, options.safe ?? {});
  if (safe) (host.ctx.media as unknown as { safe: unknown }).safe = safe.access();
  const staging = options.staging ?? createStaging({ directory: join(stagingRoot, 'staging') });
  const inputs: Uint8Array[] = [];
  const base = options.processor ?? processor;
  const recording: ImageProcessor = {
    capabilities: () => base.capabilities(),
    async process(request: ProcessRequest) {
      inputs.push(Uint8Array.from(request.bytes));
      return base.process(request);
    },
  };
  const plugin = createNativePlugin({
    processor: () => recording,
    qualifiedProfiles: options.qualifiedProfiles ?? [safe?.support.profile ?? LOCAL_PROFILE],
    staging: () => staging,
  });
  const handler = (entry: unknown) =>
    (typeof entry === 'function' ? entry : (entry as { handler: Handler }).handler) as Handler;
  const route = (name: string, input?: unknown) =>
    handler(plugin.routes[name])({ ...host.ctx, input, request: new Request('https://site.test/', { method: 'POST' }) });
  return {
    host,
    library,
    safe: safe as FakeSafeMedia,
    staging,
    plugin,
    inputs,
    media: (id: string) => library.find((item) => item.id === id) as EditorialMedia,
    apply: (mediaId: string) => route('apply', { mediaId }) as Promise<ActionOutcome>,
    restore: (mediaId: string) => route('restore', { mediaId }) as Promise<ActionOutcome>,
    admin: (input: unknown) => route('admin', input) as Promise<Page>,
    record: (mediaId: string) => host.ctx.kv.get<AppliedRecord>(`${APPLIED_PREFIX}${mediaId}`),
  };
}

const policyFor = (preset: string): Policy => ({
  processor: 'local-sharp',
  processorVersion: processor.capabilities().version,
  preset,
  removeGps: false,
});

describe('gating', () => {
  it('stays read-only on a host without safe-media access', async () => {
    const site = setup({ safe: null });
    const before = Buffer.from(site.media('heavy').bytes!);
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'unavailable', reason: 'missing-host-operation' });
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'unavailable', reason: 'missing-host-operation' });
    expect(Buffer.from(site.media('heavy').bytes!)).toEqual(before);
    expect(site.inputs).toHaveLength(0);
  });

  it('stays read-only with an empty allowlist, which qualifies no profile', async () => {
    const site = setup({ qualifiedProfiles: [] });
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
    expect(site.safe.calls.replace + site.safe.calls.restore).toBe(0);
    expect(site.inputs).toHaveLength(0);
  });

  /** `createPlugin()` as a site registers it, with only a staging directory and, in one test, an allowlist. */
  const shipped = (site: ReturnType<typeof setup>, name: 'apply' | 'restore', qualifiedProfiles?: Array<Record<string, string>>) => {
    const plugin = createPlugin({ stagingDirectory: join(stagingRoot, 'default'), ...(qualifiedProfiles ? { qualifiedProfiles } : {}) });
    return (plugin.routes[name] as { handler: Handler }).handler({ ...site.host.ctx, input: { mediaId: 'heavy' } }) as Promise<ActionOutcome>;
  };

  it('by default, createPlugin() without options applies and restores on the qualified profile', async () => {
    const site = setup();
    expect(site.safe.support.profile).toEqual({ runtime: 'node', database: 'sqlite', storage: 'local', locks: 'in-process' });
    const original = Buffer.from(site.media('heavy').bytes!);
    expect(await shipped(site, 'apply')).toMatchObject({ outcome: 'optimized' });
    expect(site.safe.calls.replace).toBe(1);
    expect(Buffer.from(site.media('heavy').bytes!)).not.toEqual(original);
    expect(await shipped(site, 'restore')).toMatchObject({ outcome: 'restored' });
    expect(Buffer.from(site.media('heavy').bytes!)).toEqual(original);
  });

  it('by default, stays read-only on every other profile: a different, missing or extra field', async () => {
    for (const [profile, named] of [
      [{ ...LOCAL_PROFILE, storage: 's3' }, /storage s3/],
      [{ ...LOCAL_PROFILE, database: 'd1' }, /database d1/],
      [{ ...LOCAL_PROFILE, locks: 'distributed' }, /locks distributed/],
      [{ runtime: 'node', database: 'sqlite', storage: 'local' }, /storage local/],
      [{ ...LOCAL_PROFILE, replicas: 'many' }, /replicas many/],
    ] as Array<[Record<string, string>, RegExp]>) {
      const site = setup({ safe: { profile } });
      const before = Buffer.from(site.media('heavy').bytes!);
      const outcome = await shipped(site, 'apply');
      expect(outcome).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
      expect(outcome.outcome === 'unavailable' && outcome.message).toMatch(named);
      expect(await shipped(site, 'restore')).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
      expect(site.safe.calls.replace + site.safe.calls.restore).toBe(0);
      expect(Buffer.from(site.media('heavy').bytes!)).toEqual(before);
    }
  });

  it('an empty allowlist passed to createPlugin() keeps the qualified profile read-only', async () => {
    const site = setup();
    expect(await shipped(site, 'apply', [])).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
    expect(site.safe.calls.replace).toBe(0);
  });

  it('refuses a host whose profile is not exactly an allowed one, naming the profile', async () => {
    const site = setup({ safe: { profile: { ...LOCAL_PROFILE, storage: 's3' } }, qualifiedProfiles: [LOCAL_PROFILE] });
    const outcome = await site.apply('heavy');
    expect(outcome).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
    expect(outcome.outcome === 'unavailable' && outcome.message).toMatch(/storage s3/);
    expect(site.safe.calls.replace).toBe(0);
  });

  it('refuses an unknown protocol version', async () => {
    const site = setup({ safe: { protocol: 2 } });
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'unavailable', reason: 'unknown-protocol' });
  });

  it('cannot declare the safe-media capability on published EmDash, which rejects it', () => {
    expect(createPlugin().capabilities).not.toContain('media:bytes:replace');
  });
});

describe('fenced apply', () => {
  it('replaces the image in place with a smaller output and keeps ID, address and editorial fields', async () => {
    const site = setup();
    const before = editorialFields(site.media('heavy'));
    const sourceRevisionId = site.safe.activeRevisionId('heavy')!;

    const outcome = await site.apply('heavy');

    expect(outcome).toMatchObject({ outcome: 'optimized', replayed: false, inputBytes: heavy.byteLength });
    if (outcome.outcome !== 'optimized') return;
    const after = site.media('heavy');
    expect(editorialFields(after)).toEqual(before);
    expect(after.bytes!.byteLength).toBe(outcome.outputBytes);
    expect(heavy.byteLength - outcome.outputBytes).toBeGreaterThanOrEqual(MIN_APPLY_SAVING_BYTES);
    // The operation ID is derived from the media ID, source revision, policy and processor version.
    const operationId = replaceOperationId({ mediaId: 'heavy', sourceRevisionId, policy: policyFor('balanced') });
    expect(site.safe.publications).toEqual([{ mediaId: 'heavy', operationId, kind: 'replace' }]);
    expect(await site.record('heavy')).toMatchObject({
      state: 'optimized',
      operationId,
      sourceRevisionId,
      originalSha256: sha256(heavy),
      preset: 'balanced',
    });
    expect(await site.staging.list()).toEqual([]);
  });

  it('submits nothing when the saving misses a threshold, with the measured numbers', async () => {
    const site = setup();
    const outcome = await site.apply('light');
    expect(outcome).toMatchObject({ outcome: 'skipped', reason: 'below-threshold', inputBytes: light.byteLength });
    expect(site.safe.calls.replace).toBe(0);
    expect(Buffer.from(site.media('light').bytes!)).toEqual(light);
    expect(await site.staging.list()).toEqual([]);
  });

  it('applies the settings when they are stricter than the floor, and never goes below 10 KiB and 5%', async () => {
    const strict = setup();
    strict.host.settings.set('minSavingsPercent', 95);
    expect(await strict.apply('heavy')).toMatchObject({ outcome: 'skipped', reason: 'below-threshold' });

    // A tiny image saves a high percentage but fewer than 10 KiB: the floor refuses it even with
    // thresholds of zero in the settings.
    const tiny = await photo(3, 64, 48).jpeg({ quality: 100 }).toBuffer();
    const loose = setup();
    loose.host.settings.set('minSavingsKB', 0);
    loose.host.settings.set('minSavingsPercent', 0);
    Object.assign(loose.media('light'), { bytes: Uint8Array.from(tiny), size: tiny.byteLength, width: 64, height: 48 });
    expect(await loose.apply('light')).toMatchObject({ outcome: 'skipped', reason: 'below-threshold' });
    expect(loose.safe.calls.replace).toBe(0);
  });

  it('does nothing for an image it already optimized with the same settings', async () => {
    const site = setup();
    await site.apply('heavy');
    const inputs = site.inputs.length;
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'skipped', reason: 'already-optimized' });
    expect(site.inputs).toHaveLength(inputs);
    expect(site.safe.publications).toHaveLength(1);
  });

  it('answers a lost response from the host record, without publishing twice', async () => {
    const site = setup();
    site.safe.failNext('after-publish');
    const outcome = await site.apply('heavy');
    expect(outcome).toMatchObject({ outcome: 'optimized', replayed: true });
    expect(site.safe.publications).toHaveLength(1);
    expect(await site.staging.list()).toEqual([]);
  });

  it('replays the receipt when an apply whose outcome was unknown is retried', async () => {
    const site = setup();
    site.safe.failNext('unreachable-after-publish');
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'uncertain' });
    expect(await site.staging.list()).toHaveLength(1);
    const inputs = site.inputs.length;

    expect(await site.apply('heavy')).toMatchObject({ outcome: 'optimized', replayed: true });
    expect(site.inputs).toHaveLength(inputs);
    expect(site.safe.publications).toHaveLength(1);
    expect(await site.staging.list()).toEqual([]);
  });

  it('leaves the editor’s newer image active when it changes during processing', async () => {
    let site: ReturnType<typeof setup>;
    const editing: ImageProcessor = {
      capabilities: () => processor.capabilities(),
      async process(request) {
        site.safe.editorReplace('heavy', Uint8Array.from(editorImage));
        return processor.process(request);
      },
    };
    site = setup({ processor: editing });
    const outcome = await site.apply('heavy');
    expect(outcome).toMatchObject({ outcome: 'conflict' });
    expect(Buffer.from(site.media('heavy').bytes!)).toEqual(editorImage);
    expect(site.safe.publications).toEqual([]);
    expect(site.safe.originals.size).toBe(0);
    expect(await site.staging.list()).toEqual([]);
  });

  it('refuses bytes that do not match the revision it read', async () => {
    const site = setup();
    await site.apply('heavy');
    await site.restore('heavy');
    // The active revision now has a known digest; bytes read afterwards must match it.
    const read = site.host.ctx.media!.readBytes!.bind(site.host.ctx.media);
    (site.host.ctx.media as { readBytes: unknown }).readBytes = async (id: string, options?: { maxBytes?: number }) => {
      const result = await read(id, options);
      return { ...result, bytes: Uint8Array.from(editorImage) };
    };
    site.host.settings.set('preset', 'high-fidelity');
    const inputs = site.inputs.length;
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'conflict' });
    expect(site.inputs).toHaveLength(inputs);
  });

  it('reports the host refusing an output whose dimensions changed, and changes nothing', async () => {
    const resizing: ImageProcessor = {
      capabilities: () => processor.capabilities(),
      async process(request) {
        const result = await processor.process(request);
        if (result.status !== 'processed') return result;
        const sharp = (await import('sharp')).default;
        return { ...result, output: await sharp(result.output).resize(160, 120).jpeg({ quality: 60 }).toBuffer() };
      },
    };
    const site = setup({ processor: resizing });
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'failed', code: 'DIMENSIONS_CHANGED' });
    expect(Buffer.from(site.media('heavy').bytes!)).toEqual(heavy);
    expect(await site.staging.list()).toEqual([]);
  });
});

describe('staging', () => {
  /** A processor whose output differs on every call, as an encoder is allowed to. */
  function drifting(): ImageProcessor {
    let calls = 0;
    return {
      capabilities: () => processor.capabilities(),
      async process(request) {
        const result = await processor.process(request);
        if (result.status !== 'processed') return result;
        calls += 1;
        // Bytes after the JPEG end marker: a different file that decodes to the same image.
        return { ...result, output: Buffer.concat([result.output, Buffer.alloc(calls)]) };
      },
    };
  }

  it('resumes an operation the host recorded before the process stopped, with the same staged bytes', async () => {
    const site = setup({ processor: drifting() });
    site.safe.failNext('after-intent');
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'uncertain' });
    const [staged] = await site.staging.list();
    expect(staged).toBeDefined();
    const inputs = site.inputs.length;

    const outcome = await site.apply('heavy');
    expect(outcome).toMatchObject({ outcome: 'optimized', replayed: false });
    // Not processed again: the staged output was submitted under the same operation ID.
    expect(site.inputs).toHaveLength(inputs);
    expect(site.safe.publications).toEqual([{ mediaId: 'heavy', operationId: staged, kind: 'replace' }]);
    expect(await site.staging.list()).toEqual([]);
  });

  it('moves to the next operation ID after the host ended the interrupted one', async () => {
    const site = setup();
    site.safe.failNext('after-intent');
    await site.apply('heavy');
    const [first] = await site.staging.list();
    site.safe.reconcile();

    expect(await site.apply('heavy')).toMatchObject({ outcome: 'optimized' });
    expect(site.safe.publications).toEqual([{ mediaId: 'heavy', operationId: `${first}.2`, kind: 'replace' }]);
    expect(await site.staging.list()).toEqual([]);
  });

  it('removes the staged output after a rejection', async () => {
    let site: ReturnType<typeof setup>;
    site = setup({
      processor: {
        capabilities: () => processor.capabilities(),
        async process(request) {
          site.safe.editorReplace('heavy', Uint8Array.from(editorImage));
          return processor.process(request);
        },
      },
    });
    await site.apply('heavy');
    expect(await site.staging.list()).toEqual([]);
    expect(await readdir(site.staging.directory)).toEqual([]);
  });

  it('sweeps entries left by a crash once they are stale, and keeps fresh ones', async () => {
    const staging = createStaging({ directory: join(stagingRoot, 'sweep'), maxAgeMs: 60_000 });
    await staging.put('imgopt.replace.stale', new Uint8Array([1, 2, 3]));
    await staging.put('imgopt.replace.fresh', new Uint8Array([4, 5, 6]));
    const old = new Date(Date.now() - 120_000);
    const [stale] = (await readdir(staging.directory)).filter((name) => name.startsWith('imgopt.replace.stale.'));
    await utimes(join(staging.directory, stale!), old, old);
    expect(await staging.sweep()).toBe(1);
    expect(await staging.list()).toEqual(['imgopt.replace.fresh']);
  });

  it('never returns a staged entry that no longer matches its digest', async () => {
    const staging = createStaging({ directory: join(stagingRoot, 'damaged') });
    const { sha256: digest } = await staging.put('imgopt.replace.x', new Uint8Array([1, 2, 3]));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(staging.directory, `imgopt.replace.x.${digest}.out`), new Uint8Array([9]));
    expect(await staging.get('imgopt.replace.x')).toBeNull();
    expect(await staging.list()).toEqual([]);
  });

  it('keeps the staging directory private to the site user', async () => {
    const staging = createStaging({ directory: join(stagingRoot, 'private') });
    await staging.put('imgopt.replace.y', new Uint8Array([1]));
    const { stat } = await import('node:fs/promises');
    expect((await stat(staging.directory)).mode & 0o077).toBe(0);
  });
});

describe('restore', () => {
  it('puts the original back byte for byte and keeps ID, address and editorial fields', async () => {
    const site = setup();
    const before = editorialFields(site.media('heavy'));
    const applied = await site.apply('heavy');
    if (applied.outcome !== 'optimized') throw new Error(applied.outcome);

    const outcome = await site.restore('heavy');
    expect(outcome).toMatchObject({ outcome: 'restored', replayed: false, sha256: sha256(heavy), bytes: heavy.byteLength });
    expect(sha256(site.media('heavy').bytes!)).toBe(sha256(heavy));
    expect(editorialFields(site.media('heavy'))).toEqual(before);
    expect(site.safe.publications.map(({ kind, operationId }) => [kind, operationId])).toEqual([
      ['replace', expect.any(String)],
      [
        'restore',
        restoreOperationId({ mediaId: 'heavy', expectedRevisionId: applied.revisionId, originalSha256: sha256(heavy) }),
      ],
    ]);
    expect(await site.record('heavy')).toMatchObject({ state: 'restored' });
    // Restored: nothing more to restore.
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'nothing-to-restore' });
  });

  it('answers a lost restore response from the host record', async () => {
    const site = setup();
    await site.apply('heavy');
    site.safe.failNext('after-publish');
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'restored', replayed: true });
    expect(site.safe.publications.filter(({ kind }) => kind === 'restore')).toHaveLength(1);
  });

  it('does not overwrite an image an editor changed after the optimization', async () => {
    const site = setup();
    await site.apply('heavy');
    site.safe.editorReplace('heavy', Uint8Array.from(editorImage));
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'nothing-to-restore' });
    expect(Buffer.from(site.media('heavy').bytes!)).toEqual(editorImage);
    expect(site.safe.calls.restore).toBe(0);
    expect(await site.record('heavy')).toMatchObject({ state: 'superseded' });
  });

  it('does not restore another caller’s replacement', async () => {
    const site = setup();
    const other = site.safe.access('plugin:another');
    const revision = (await other.revision('heavy'))!;
    const replaced = await other.replace({
      mediaId: 'heavy',
      operationId: replaceOperationId({ mediaId: 'heavy', sourceRevisionId: revision.revisionId, policy: policyFor('balanced') }),
      expectedRevisionId: revision.revisionId,
      bytes: light.length ? Uint8Array.from(await photo().jpeg({ quality: 70 }).toBuffer()) : new Uint8Array(),
    });
    expect(replaced.ok).toBe(true);
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'nothing-to-restore' });
    expect(site.safe.calls.restore).toBe(0);
  });

  it('does not report a restore whose receipt names other bytes than the original', async () => {
    const site = setup();
    await site.apply('heavy');
    const safe = (site.host.ctx.media as unknown as { safe: SafeMediaAccess }).safe;
    const restore = safe.restore.bind(safe);
    safe.restore = async (request) => {
      const result = await restore(request);
      return result.ok ? { ...result, receipt: { ...result.receipt, candidateSha256: 'f'.repeat(64) } } : result;
    };
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'failed', code: 'UNEXPECTED_RECEIPT' });
    expect(await site.record('heavy')).toMatchObject({ state: 'optimized' });
  });

  it('reports a missing original and changes nothing', async () => {
    const site = setup();
    await site.apply('heavy');
    const optimized = Buffer.from(site.media('heavy').bytes!);
    site.safe.damageOriginal(sha256(heavy));
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'no-original' });
    expect(Buffer.from(site.media('heavy').bytes!)).toEqual(optimized);
  });
});

describe('re-optimization from the retained original', () => {
  /** Optimizes `heavy` under the default preset, then switches the preset. */
  async function optimizedThenChanged(options: SetupOptions = {}) {
    const site = setup(options);
    const first = await site.apply('heavy');
    if (first.outcome !== 'optimized') throw new Error(first.outcome);
    const optimized = sha256(site.media('heavy').bytes!);
    const record = (await site.record('heavy'))!;
    site.host.settings.set('preset', 'high-fidelity');
    return { site, optimized, record };
  }

  /** Nothing changed since the first optimization: the optimized image is active, nothing was read or published. */
  async function unchanged(site: ReturnType<typeof setup>, optimized: string, record: AppliedRecord) {
    expect(site.safe.history('heavy')).toEqual([sha256(heavy), optimized]);
    expect(site.safe.publications).toHaveLength(1);
    expect(site.safe.calls.restore).toBe(0);
    // Only the first optimization's input was processed: never the optimized bytes.
    expect(site.inputs.map(sha256)).toEqual([sha256(heavy)]);
    expect(await site.record('heavy')).toEqual(record);
    expect(await site.staging.list()).toEqual([]);
  }

  it('processes the original privately and replaces the optimized image; the original never becomes active', async () => {
    const { site, optimized } = await optimizedThenChanged();

    const outcome = await site.apply('heavy');

    expect(outcome).toMatchObject({ outcome: 'optimized', reoptimized: true, replayed: false, inputBytes: heavy.byteLength });
    const reoptimized = sha256(site.media('heavy').bytes!);
    // Optimized, then re-optimized: no revision with the original's bytes in between.
    expect(site.safe.history('heavy')).toEqual([sha256(heavy), optimized, reoptimized]);
    expect(reoptimized).not.toBe(optimized);
    expect(site.safe.publications.map(({ kind }) => kind)).toEqual(['replace', 'replace']);
    expect(site.safe.calls.restore).toBe(0);
    expect(site.inputs.map(sha256)).toEqual([sha256(heavy), sha256(heavy)]);
    // The read asked for the original by digest, within the processor's and the host's limits.
    expect(site.safe.reads).toEqual([{ mediaId: 'heavy', sha256: sha256(heavy), maxBytes: 16 * 1024 * 1024 }]);

    const record = await site.record('heavy');
    expect(record).toMatchObject({ state: 'optimized', preset: 'high-fidelity', originalSha256: sha256(heavy), inputBytes: heavy.byteLength });
    expect(parseOperationId(record!.operationId)).toEqual({
      kind: 'reopt',
      key: policyKey(policyFor('high-fidelity')),
      originalSha256: sha256(heavy),
    });
    // Fenced on the optimized revision that was active.
    expect(record!.sourceRevisionId).toBe(site.safe.operations.get(`heavy\u0000${record!.operationId}`)!.expectedRevisionId);

    // The original is still the one restore puts back.
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'restored', sha256: sha256(heavy) });
    expect(sha256(site.media('heavy').bytes!)).toBe(sha256(heavy));
  });

  it('keeps starting from the same original over repeated changes, and counts each retained file once', async () => {
    const { site, optimized } = await optimizedThenChanged();
    await site.apply('heavy');
    const fidelity = sha256(site.media('heavy').bytes!);
    const fidelityBytes = site.media('heavy').bytes!.byteLength;
    site.host.settings.set('preset', 'balanced');
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'optimized', reoptimized: true, inputBytes: heavy.byteLength });
    // Deterministic: the same original under the same policy gives the same file again.
    expect(sha256(site.media('heavy').bytes!)).toBe(optimized);
    const balancedBytes = site.media('heavy').bytes!.byteLength;
    site.host.settings.set('preset', 'high-fidelity');
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'optimized', reoptimized: true });

    expect(site.safe.history('heavy')).toEqual([sha256(heavy), optimized, fidelity, optimized, fidelity]);
    expect(site.inputs.map(sha256)).toEqual(Array(4).fill(sha256(heavy)));
    expect(site.safe.calls.restore).toBe(0);

    // The host retains the original, the balanced file and the high-fidelity file, each once,
    // although the balanced file was replaced twice.
    const record = (await site.record('heavy'))!;
    expect(record.retained).toEqual({ [sha256(heavy)]: heavy.byteLength, [optimized]: balancedBytes, [fidelity]: fidelityBytes });
    const accounting = storageAccounting([record]);
    expect(accounting).toEqual({
      optimized: 1,
      grossReductionBytes: heavy.byteLength - fidelityBytes,
      retainedOriginalBytes: heavy.byteLength + balancedBytes + fidelityBytes,
      netStorageChangeBytes: balancedBytes + 2 * fidelityBytes,
    });
    const page = JSON.stringify((await site.admin({ type: 'page_load', page: '/report' })).blocks);
    expect(page).toMatch(/"label":"Originals retained"/);

    expect(await site.restore('heavy')).toMatchObject({ outcome: 'restored', sha256: sha256(heavy) });
    expect(sha256(site.media('heavy').bytes!)).toBe(sha256(heavy));
  });

  it('leaves the optimized image active and records nothing when the new settings do not save enough', async () => {
    const { site, optimized, record } = await optimizedThenChanged();
    site.host.settings.set('minSavingsPercent', 95);

    expect(await site.apply('heavy')).toMatchObject({
      outcome: 'skipped',
      reason: 'below-threshold',
      reoptimized: true,
      inputBytes: heavy.byteLength,
      message: expect.stringMatching(/optimized image stays active/),
    });
    expect(site.safe.history('heavy')).toEqual([sha256(heavy), optimized]);
    expect(site.safe.publications).toHaveLength(1);
    expect(site.safe.calls.restore).toBe(0);
    expect(await site.record('heavy')).toEqual(record);
    expect(await site.staging.list()).toEqual([]);
  });

  it('does not re-optimize on a host without the private read, and changes nothing', async () => {
    const { site, optimized, record } = await optimizedThenChanged({ safe: { readOriginal: false } });

    expect(await site.apply('heavy')).toMatchObject({ outcome: 'skipped', reason: 'reoptimize-unsupported', reoptimized: true });
    await unchanged(site, optimized, record);
    expect(site.safe.calls.readOriginal).toBe(0);
    // Restore still works there.
    expect(await site.restore('heavy')).toMatchObject({ outcome: 'restored', sha256: sha256(heavy) });
  });

  const refusals: Array<[string, Record<string, unknown>]> = [
    ['NO_ORIGINAL', { outcome: 'failed', code: 'original-not-retained' }],
    ['ORIGINAL_MISSING', { outcome: 'failed', code: 'original-missing' }],
    ['ORIGINAL_CORRUPT', { outcome: 'failed', code: 'original-corrupt' }],
    ['TOO_LARGE', { outcome: 'skipped', reason: 'original-too-large' }],
    ['MEDIA_UNAVAILABLE', { outcome: 'failed', code: 'not-found' }],
    ['INVALID_REQUEST', { outcome: 'failed', code: 'invalid-request' }],
    ['ORIGINAL_UNREADABLE', { outcome: 'failed', code: 'original-unreadable', retryable: true }],
  ];

  it.each(refusals)('reports the host refusing the read with %s, and changes nothing', async (code, expected) => {
    const { site, optimized, record } = await optimizedThenChanged();
    site.safe.refuseReads(code);
    const outcome = await site.apply('heavy');
    expect(outcome).toMatchObject({ ...expected, reoptimized: true });
    if (code !== 'ORIGINAL_UNREADABLE') expect((outcome as { retryable?: boolean }).retryable ?? false).toBe(false);
    await unchanged(site, optimized, record);
  });

  it('reports what the host finds: a lost file, a damaged file, an original over the limit', async () => {
    const cases: Array<[(site: ReturnType<typeof setup>) => void, Record<string, unknown>]> = [
      [(site) => site.safe.loseOriginal(sha256(heavy)), { outcome: 'failed', code: 'original-missing' }],
      [(site) => site.safe.damageOriginal(sha256(heavy)), { outcome: 'failed', code: 'original-corrupt' }],
      [(site) => (site.safe.support.limits.maxBytes = heavy.byteLength - 1), { outcome: 'skipped', reason: 'original-too-large' }],
    ];
    for (const [fault, expected] of cases) {
      const { site, optimized, record } = await optimizedThenChanged();
      fault(site);
      expect(await site.apply('heavy')).toMatchObject({ ...expected, reoptimized: true });
      expect(site.safe.calls.readOriginal).toBe(1);
      await unchanged(site, optimized, record);
    }
  });

  it('does not process its own output again when the host no longer lists the original', async () => {
    const { site, optimized, record } = await optimizedThenChanged();
    site.safe.pruneOriginal(sha256(heavy));
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'failed', code: 'original-not-retained', reoptimized: true });
    expect(site.safe.calls.readOriginal).toBe(0);
    await unchanged(site, optimized, record);
    // Under the settings it was optimized with, it is simply already optimized.
    site.host.settings.set('preset', 'balanced');
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'skipped', reason: 'already-optimized' });
    await unchanged(site, optimized, record);
  });

  it('reports a pruned original after a re-optimization, from the host read', async () => {
    const { site } = await optimizedThenChanged();
    await site.apply('heavy');
    const reoptimized = sha256(site.media('heavy').bytes!);
    const record = (await site.record('heavy'))!;
    site.safe.pruneOriginal(sha256(heavy));
    site.host.settings.set('preset', 'balanced');
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'failed', code: 'original-not-retained', reoptimized: true });
    expect(site.safe.calls.readOriginal).toBe(2);
    expect(site.safe.history('heavy').at(-1)).toBe(reoptimized);
    expect(site.inputs).toHaveLength(2);
    expect(site.safe.publications).toHaveLength(2);
    expect(await site.record('heavy')).toEqual(record);
  });

  it('retries a read the host could not do just now', async () => {
    const { site, optimized } = await optimizedThenChanged();
    site.safe.refuseReads('ORIGINAL_UNREADABLE');
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'failed', code: 'original-unreadable', retryable: true });
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'optimized', reoptimized: true });
    expect(site.safe.history('heavy')).toHaveLength(3);
    expect(site.safe.history('heavy').slice(0, 2)).toEqual([sha256(heavy), optimized]);
  });

  it('never processes bytes the host returns that are not the original', async () => {
    const tampering: Array<(result: { bytes: Uint8Array; size: number; sha256: string; mediaId: string }) => object> = [
      // Other bytes under the original's digest: of another size, and of the same size.
      (result) => ({ ...result, bytes: Uint8Array.from(light), size: light.byteLength }),
      (result) => ({ ...result, bytes: result.bytes.map((byte, index) => (index === 1000 ? byte ^ 1 : byte)) }),
      // The right bytes, but the answer names another original or item.
      (result) => ({ ...result, sha256: sha256(light) }),
      (result) => ({ ...result, mediaId: 'light' }),
      // A size that does not match the bytes.
      (result) => ({ ...result, size: result.size - 1 }),
    ];
    for (const tamper of tampering) {
      const { site, optimized, record } = await optimizedThenChanged();
      site.safe.tamperNextRead((result) => tamper(result) as typeof result);
      expect(await site.apply('heavy')).toMatchObject({ outcome: 'failed', code: 'original-mismatch', reoptimized: true });
      await unchanged(site, optimized, record);
    }
  });

  it('never processes an original over the limit it asked for, or of another size than the host lists', async () => {
    const overLimit = await optimizedThenChanged();
    const safe = (overLimit.site.host.ctx.media as unknown as { safe: Required<SafeMediaAccess> }).safe;
    const read = safe.readOriginal.bind(safe);
    // A host that ignores the limit.
    safe.readOriginal = (mediaId, digest) => read(mediaId, digest);
    overLimit.site.safe.support.limits.maxBytes = heavy.byteLength - 1;
    expect(await overLimit.site.apply('heavy')).toMatchObject({ outcome: 'failed', code: 'original-mismatch' });
    await unchanged(overLimit.site, overLimit.optimized, overLimit.record);

    const resized = await optimizedThenChanged();
    const access = (resized.site.host.ctx.media as unknown as { safe: SafeMediaAccess }).safe;
    const list = access.listRestorableOriginals.bind(access);
    access.listRestorableOriginals = async (mediaId) =>
      (await list(mediaId)).map((entry) => (entry.sha256 === sha256(heavy) ? { ...entry, size: entry.size + 1 } : entry));
    expect(await resized.site.apply('heavy')).toMatchObject({ outcome: 'failed', code: 'original-mismatch' });
    await unchanged(resized.site, resized.optimized, resized.record);
  });

  it('answers a lost response to a re-optimization from the host record, without publishing twice', async () => {
    const { site } = await optimizedThenChanged();
    site.safe.failNext('after-publish');
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'optimized', reoptimized: true, replayed: true, inputBytes: heavy.byteLength });
    expect(site.safe.publications).toHaveLength(2);
    expect(await site.record('heavy')).toMatchObject({ preset: 'high-fidelity', originalSha256: sha256(heavy) });
    expect(await site.staging.list()).toEqual([]);
  });

  it('completes a re-optimization whose outcome was unknown from the host receipt, without reading or processing again', async () => {
    const { site, optimized } = await optimizedThenChanged();
    const optimizedBytes = site.media('heavy').bytes!.byteLength;
    site.safe.failNext('unreachable-after-publish');
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'uncertain', reoptimized: true });
    const reoptimized = sha256(site.media('heavy').bytes!);
    expect(site.safe.history('heavy')).toEqual([sha256(heavy), optimized, reoptimized]);

    // The record still names the first optimization; the host's receipt completes it.
    const outcome = await site.apply('heavy');
    expect(outcome).toMatchObject({ outcome: 'optimized', reoptimized: true, replayed: true, inputBytes: heavy.byteLength });
    expect(site.safe.reads).toHaveLength(1);
    expect(site.inputs).toHaveLength(2);
    expect(site.safe.publications).toHaveLength(2);
    expect(site.safe.history('heavy')).toEqual([sha256(heavy), optimized, reoptimized]);
    const record = await site.record('heavy');
    expect(record).toMatchObject({ state: 'optimized', preset: 'high-fidelity', originalSha256: sha256(heavy), inputBytes: heavy.byteLength });
    expect(record!.retained).toEqual({ [sha256(heavy)]: heavy.byteLength, [optimized]: optimizedBytes });
    expect(await site.apply('heavy')).toMatchObject({ outcome: 'skipped', reason: 'already-optimized' });
  });
});

describe('operation IDs', () => {
  it('are deterministic and change with each part of the identity', () => {
    const identity = { mediaId: 'm1', sourceRevisionId: 'r1', policy: policyFor('balanced') };
    const id = replaceOperationId(identity);
    expect(replaceOperationId({ ...identity })).toBe(id);
    expect(id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    const variants = [
      { ...identity, mediaId: 'm2' },
      { ...identity, sourceRevisionId: 'r2' },
      { ...identity, policy: policyFor('high-fidelity') },
      { ...identity, policy: { ...policyFor('balanced'), removeGps: true } },
      { ...identity, policy: { ...policyFor('balanced'), processorVersion: 'other' } },
    ];
    for (const variant of variants) expect(replaceOperationId(variant)).not.toBe(id);
    expect(replaceOperationId(identity, 2)).toBe(`${id}.2`);
    expect(restoreOperationId({ mediaId: 'm1', expectedRevisionId: 'r1', originalSha256: 'a'.repeat(64) })).toMatch(
      /^imgopt\.restore\./,
    );
  });

  it('tell a re-optimization from a first optimization, deterministically, within the host limit', () => {
    const original = 'a'.repeat(64);
    const identity = { mediaId: 'm1', sourceRevisionId: 'r1', originalSha256: original, policy: policyFor('balanced') };
    const id = reoptimizeOperationId(identity);
    expect(reoptimizeOperationId({ ...identity })).toBe(id);
    expect(id).not.toBe(replaceOperationId(identity));
    expect(parseOperationId(id)).toEqual({ kind: 'reopt', key: policyKey(identity.policy), originalSha256: original });
    expect(parseOperationId(replaceOperationId(identity))).toEqual({ kind: 'replace', key: policyKey(identity.policy) });
    for (const attempt of [1, 2, 3]) {
      const attemptId = reoptimizeOperationId(identity, attempt);
      expect(attemptId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
      expect(parseOperationId(attemptId)).toMatchObject({ kind: 'reopt', originalSha256: original });
    }
    const variants = [
      { ...identity, mediaId: 'm2' },
      { ...identity, sourceRevisionId: 'r2' },
      { ...identity, originalSha256: 'b'.repeat(64) },
      { ...identity, policy: policyFor('high-fidelity') },
      { ...identity, policy: { ...policyFor('balanced'), processorVersion: 'other' } },
    ];
    for (const variant of variants) expect(reoptimizeOperationId(variant)).not.toBe(id);
    expect(parseOperationId(`${id.slice(0, -1)}g`)).toBeNull();
  });
});

describe('report', () => {
  const REPORT = { type: 'page_load', page: '/report' };
  const elements = (page: Page) =>
    JSON.stringify(page.blocks).match(/"action_id":"(apply_image|restore_image)"/g) ?? [];

  async function scanned(site: ReturnType<typeof setup>) {
    await site.admin({ type: 'block_action', action_id: 'start_scan' });
    const cron = site.plugin.hooks.cron as unknown as { handler: Handler };
    for (let tick = 0; tick < 5; tick += 1) await cron.handler({ name: 'scan-step', scheduledAt: '' }, site.host.ctx);
  }

  it('states the read-only reason and offers no apply or restore when the host does not allow them', async () => {
    const site = setup({ qualifiedProfiles: [] });
    await scanned(site);
    const page = await site.admin(REPORT);
    expect(validateBlockResponse(page, { pluginPagePaths: ['/report'] }).errors).toEqual([]);
    expect(elements(page)).toEqual([]);
    expect(JSON.stringify(page)).toMatch(/Read-only: apply and restore are not available\. This host profile \(runtime node/);
  });

  it('offers apply per result, applies from the report, then offers restore and restores', async () => {
    const site = setup();
    await scanned(site);
    const page = await site.admin(REPORT);
    expect(validateBlockResponse(page, { pluginPagePaths: ['/report'] }).errors).toEqual([]);
    expect(elements(page)).toContain('"action_id":"apply_image"');

    const applied = await site.admin({ type: 'block_action', action_id: 'apply_image', value: { mediaId: 'heavy' } });
    expect(validateBlockResponse(applied, { pluginPagePaths: ['/report'] }).errors).toEqual([]);
    expect(JSON.stringify(applied.blocks[1])).toMatch(/heavy\.jpg: optimized/);
    expect(JSON.stringify(applied)).toMatch(/Optimized by this plugin \(1\)/);
    expect(elements(applied)).toContain('"action_id":"restore_image"');

    const restored = await site.admin({ type: 'block_action', action_id: 'restore_image', value: { mediaId: 'heavy' } });
    expect(validateBlockResponse(restored, { pluginPagePaths: ['/report'] }).errors).toEqual([]);
    expect(JSON.stringify(restored.blocks[1])).toMatch(/heavy\.jpg: restored/);
    expect(sha256(site.media('heavy').bytes!)).toBe(sha256(heavy));
  });

  it('shows a conflict without changing the newer image', async () => {
    let site: ReturnType<typeof setup>;
    site = setup({
      processor: {
        capabilities: () => processor.capabilities(),
        async process(request) {
          site.safe.editorReplace('heavy', Uint8Array.from(editorImage));
          return processor.process(request);
        },
      },
    });
    const page = await site.admin({ type: 'block_action', action_id: 'apply_image', value: { mediaId: 'heavy' } });
    expect(JSON.stringify(page.blocks[1])).toMatch(/heavy\.jpg: not changed: it changed meanwhile/);
    expect(Buffer.from(site.media('heavy').bytes!)).toEqual(editorImage);
  });
});
