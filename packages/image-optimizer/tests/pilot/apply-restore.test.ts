/**
 * End to end on the patched host: the native edition registered in a real EmDash runtime (the pilot
 * checkout at `.upstream/emdash-pilot`, SQLite, local storage, `safeMedia` configured), applying and
 * restoring through its routes. Skipped when the pilot checkout is absent; see `vitest.config.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ActionOutcome } from '../../src/admin.ts';
import { createNativePlugin } from '../../src/native.ts';
import { createLocalProcessor } from '../../src/processor/local.ts';
import { createStaging } from '../../src/staging.ts';
import { photo } from '../native/fixtures.ts';

const core = process.env.EMDASH_PILOT_CORE ?? '';
const LOCAL_PROFILE = { runtime: 'node', database: 'sqlite', storage: 'local', locks: 'in-process' };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Imports a module of the pilot checkout, or a package it depends on. */
async function pilot<T>(path: string): Promise<T> {
  return import(/* @vite-ignore */ path.startsWith('src/') ? join(core, path) : createRequire(join(core, 'package.json')).resolve(path));
}

describe.skipIf(!core)('the native edition on the patched host', () => {
  let root: string;
  let runtime: { stopCron(): Promise<void>; handlePluginApiRoute(...args: unknown[]): Promise<{ success: boolean; data?: unknown; error?: unknown }>; storage: { download(key: string): Promise<{ body: ReadableStream }> } | null; db: unknown } | undefined;
  const processor = createLocalProcessor();

  // The runtime caches its database per process, so the tests share one site directory.
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'image-optimizer-pilot-'));
    await mkdir(join(root, 'uploads'), { recursive: true });
  });

  afterEach(async () => {
    await runtime?.stopCron();
    runtime = undefined;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function start(qualifiedProfiles: Array<Record<string, string>>, key: string) {
    const { EmDashRuntime } = await pilot<{ EmDashRuntime: { create(deps: unknown): Promise<NonNullable<typeof runtime>> } }>('src/emdash-runtime.ts');
    const { LocalStorage } = await pilot<{ LocalStorage: new (options: unknown) => { upload(input: unknown): Promise<unknown> } }>('src/storage/local.ts');
    const { MediaRepository } = await pilot<{ MediaRepository: new (db: unknown) => { create(input: unknown): Promise<{ id: string }>; update(id: string, input: unknown): Promise<unknown>; findById(id: string): Promise<Record<string, unknown> | null> } }>('src/database/repositories/media.ts');
    const { NodeSqliteCompatDatabase } = await pilot<{ NodeSqliteCompatDatabase: new (path: string) => unknown }>('src/db/node-sqlite-compat.ts');
    const { SqliteDialect } = await pilot<{ SqliteDialect: new (options: unknown) => unknown }>('kysely');

    const storage = new LocalStorage({ directory: join(root, 'uploads'), baseUrl: '/media' });
    const plugin = createNativePlugin({
      processor: () => processor,
      qualifiedProfiles,
      staging: () => createStaging({ directory: join(root, 'staging') }),
    });
    runtime = await EmDashRuntime.create({
      config: {
        database: { entrypoint: 'emdash/db/sqlite', config: {}, type: 'sqlite' },
        storage: { entrypoint: 'emdash/storage/local', config: { directory: join(root, 'uploads') } },
        safeMedia: { privateDirectory: join(root, 'private') },
      },
      plugins: [plugin],
      createDialect: () => new SqliteDialect({ database: new NodeSqliteCompatDatabase(join(root, 'site.db')) }),
      createStorage: () => storage,
      sandboxEnabled: false,
      sandboxedPluginEntries: [],
      createSandboxRunner: null,
    });

    // Large enough to pass the default thresholds (50 KB and 20%).
    const original = await photo(3, 640, 480).jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer();
    await storage.upload({ key, body: original, contentType: 'image/jpeg' });
    const media = new MediaRepository(runtime.db);
    const { id } = await media.create({
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: original.byteLength,
      width: 640,
      height: 480,
      storageKey: key,
      alt: 'A gradient',
      caption: 'Generated for the test',
      status: 'ready',
    });
    await media.update(id, { focalX: 0.25, focalY: 0.75 });
    const { OptionsRepository } = await pilot<{ OptionsRepository: new (db: unknown) => { set(name: string, value: unknown): Promise<void> } }>('src/database/repositories/options.ts');
    const setSetting = (name: string, value: unknown) =>
      new OptionsRepository(runtime!.db).set(`plugin:image-optimizer:settings:${name}`, value);
    return { id, original, media, setSetting };
  }

  async function route(name: string, mediaId: string): Promise<ActionOutcome> {
    const result = await runtime!.handlePluginApiRoute(
      'image-optimizer',
      'POST',
      `/${name}`,
      new Request(`http://test.local/_emdash/api/plugins/image-optimizer/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaId }),
      }),
    );
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    return result.data as ActionOutcome;
  }

  async function served(key: string): Promise<Uint8Array> {
    const { body } = await runtime!.storage!.download(key);
    return new Uint8Array(await new Response(body).arrayBuffer());
  }

  /** What a replacement must keep: identity, address and editorial fields. */
  const kept = (row: Record<string, unknown> | null) => ({
    id: row?.id,
    filename: row?.filename,
    storageKey: row?.storageKey,
    alt: row?.alt,
    caption: row?.caption,
    focalX: row?.focalX,
    focalY: row?.focalY,
    width: row?.width,
    height: row?.height,
    mimeType: row?.mimeType,
  });

  it('stays read-only with the shipped allowlist', async () => {
    const { id, original } = await start([], '01HZPILOTREADONLY.jpg');
    expect(await route('apply', id)).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
    expect(await route('restore', id)).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
    expect(sha(await served('01HZPILOTREADONLY.jpg'))).toBe(sha(original));
  });

  it('applies in place, keeps the item, and restores the original byte for byte', async () => {
    const { id, original, media } = await start([LOCAL_PROFILE], '01HZPILOTOPT.jpg');
    const before = kept(await media.findById(id));
    expect(before).toMatchObject({ alt: 'A gradient', focalX: 0.25 });

    const applied = await route('apply', id);
    expect(applied).toMatchObject({ outcome: 'optimized', replayed: false, inputBytes: original.byteLength });
    if (applied.outcome !== 'optimized') return;
    const optimized = await served('01HZPILOTOPT.jpg');
    expect(optimized.byteLength).toBe(applied.outputBytes);
    expect(optimized.byteLength).toBeLessThan(original.byteLength);
    expect(kept(await media.findById(id))).toEqual(before);
    expect((await media.findById(id))?.size).toBe(applied.outputBytes);

    // Applying again with the same settings changes nothing.
    expect(await route('apply', id)).toMatchObject({ outcome: 'skipped', reason: 'already-optimized' });

    const restored = await route('restore', id);
    expect(restored).toMatchObject({ outcome: 'restored', sha256: sha(original) });
    expect(sha(await served('01HZPILOTOPT.jpg'))).toBe(sha(original));
    expect(kept(await media.findById(id))).toEqual(before);
  });

  it('re-optimizes from the retained original when the preset changes', async () => {
    const { id, original, media, setSetting } = await start([LOCAL_PROFILE], '01HZPILOTREOPT.jpg');
    const before = kept(await media.findById(id));
    const first = await route('apply', id);
    expect(first).toMatchObject({ outcome: 'optimized' });
    const balanced = sha(await served('01HZPILOTREOPT.jpg'));

    await setSetting('preset', 'high-fidelity');
    const again = await route('apply', id);
    // The input was the original's bytes, not the balanced output.
    expect(again).toMatchObject({ outcome: 'optimized', reoptimized: true, inputBytes: original.byteLength });
    const fidelity = sha(await served('01HZPILOTREOPT.jpg'));
    expect(fidelity).not.toBe(balanced);
    expect(fidelity).not.toBe(sha(original));
    expect(kept(await media.findById(id))).toEqual(before);

    expect(await route('restore', id)).toMatchObject({ outcome: 'restored', sha256: sha(original) });
    expect(sha(await served('01HZPILOTREOPT.jpg'))).toBe(sha(original));
  });
});
