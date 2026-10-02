/**
 * The native edition registered in a real EmDash runtime: the patched pilot checkout
 * (`.upstream/emdash-pilot`, or `EMDASH_PILOT_DIR`), SQLite, local storage and `safeMedia`
 * configured. `EMDASH_PILOT_CORE` is empty when the checkout is absent; see `vitest.config.ts`.
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { expect } from 'vitest';

import { createNativePlugin } from '../../src/native.ts';
import { createLocalProcessor } from '../../src/processor/local.ts';
import { createStaging } from '../../src/staging.ts';

export const core = process.env.EMDASH_PILOT_CORE ?? '';
export const LOCAL_PROFILE = { runtime: 'node', database: 'sqlite', storage: 'local', locks: 'in-process' };

/** Imports a module of the pilot checkout, or a package it depends on. */
async function pilot<T>(path: string): Promise<T> {
  return import(/* @vite-ignore */ path.startsWith('src/') ? join(core, path) : createRequire(join(core, 'package.json')).resolve(path));
}

export interface Runtime {
  stopCron(): Promise<void>;
  handlePluginApiRoute(...args: unknown[]): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  storage: { download(key: string): Promise<{ body: ReadableStream }> } | null;
  db: unknown;
  hooks: { invokeCronHook(pluginId: string, event: { name: string; scheduledAt: string }): Promise<{ success: boolean; error?: unknown }> };
}

export interface MediaRepository {
  create(input: unknown): Promise<{ id: string }>;
  update(id: string, input: unknown): Promise<unknown>;
  findById(id: string): Promise<Record<string, unknown> | null>;
}

/**
 * Starts a runtime over the site directory `root` with the plugin allowed on `qualifiedProfiles`.
 * The runtime caches its database per process, so every runtime of one test file shares the site.
 */
export async function startPilot(root: string, qualifiedProfiles: Array<Record<string, string>>) {
  await mkdir(join(root, 'uploads'), { recursive: true });
  const { EmDashRuntime } = await pilot<{ EmDashRuntime: { create(deps: unknown): Promise<Runtime> } }>('src/emdash-runtime.ts');
  const { LocalStorage } = await pilot<{ LocalStorage: new (options: unknown) => { upload(input: unknown): Promise<unknown> } }>('src/storage/local.ts');
  const { MediaRepository } = await pilot<{ MediaRepository: new (db: unknown) => MediaRepository }>('src/database/repositories/media.ts');
  const { NodeSqliteCompatDatabase } = await pilot<{ NodeSqliteCompatDatabase: new (path: string) => unknown }>('src/db/node-sqlite-compat.ts');
  const { SqliteDialect } = await pilot<{ SqliteDialect: new (options: unknown) => unknown }>('kysely');
  const { OptionsRepository } = await pilot<{ OptionsRepository: new (db: unknown) => { set(name: string, value: unknown): Promise<void> } }>('src/database/repositories/options.ts');

  const processor = createLocalProcessor();
  const storage = new LocalStorage({ directory: join(root, 'uploads'), baseUrl: '/media' });
  const plugin = createNativePlugin({
    processor: () => processor,
    qualifiedProfiles,
    staging: () => createStaging({ directory: join(root, 'staging') }),
  });
  const runtime = await EmDashRuntime.create({
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
  const media = new MediaRepository(runtime.db);

  return {
    runtime,
    media,
    /** Uploads a JPEG and records it as a ready media item with editorial fields. */
    async addImage(key: string, bytes: Uint8Array, width: number, height: number) {
      await storage.upload({ key, body: bytes, contentType: 'image/jpeg' });
      const { id } = await media.create({
        filename: key.toLowerCase(),
        mimeType: 'image/jpeg',
        size: bytes.byteLength,
        width,
        height,
        storageKey: key,
        alt: 'A gradient',
        caption: 'Generated for the test',
        status: 'ready',
      });
      await media.update(id, { focalX: 0.25, focalY: 0.75 });
      return id;
    },
    setSetting: (name: string, value: unknown) => new OptionsRepository(runtime.db).set(`plugin:image-optimizer:settings:${name}`, value),
    async route<T>(name: string, input: unknown): Promise<T> {
      const result = await runtime.handlePluginApiRoute(
        'image-optimizer',
        'POST',
        `/${name}`,
        new Request(`http://test.local/_emdash/api/plugins/image-optimizer/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
      expect(result.success, JSON.stringify(result.error)).toBe(true);
      return result.data as T;
    },
    /** Runs the plugin's scheduled task once, through the runtime's cron dispatch. */
    async cron(name: string) {
      const result = await runtime.hooks.invokeCronHook('image-optimizer', { name, scheduledAt: new Date().toISOString() });
      expect(result.success, String(result.error)).toBe(true);
    },
    async served(key: string): Promise<Uint8Array> {
      const { body } = await runtime.storage!.download(key);
      return new Uint8Array(await new Response(body).arrayBuffer());
    },
  };
}

export type Pilot = Awaited<ReturnType<typeof startPilot>>;
