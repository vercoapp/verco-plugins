/**
 * The native edition: the report of the registry edition, registered in `plugins: []` and run in the
 * site process, plus a measured scan and a sample when Sharp is installed, and apply and restore of
 * single images (`mutations.ts`) and in bulk runs (`bulk.ts`) where the host allows them. It shares the
 * plugin ID, the results storage, settings and routes with the sandboxed edition (`plugin.ts`), so a
 * site can switch between them and keep its results; the apply, restore and bulk routes, the bulk
 * storage collections and three settings are its own. Register one of the two, never both. Shared
 * behaviour lives in `handlers.ts` and the measured scan in `measure.ts`; this file is the
 * declarations, the processor and the wrappers from native handlers (one context) to the shared
 * functions.
 */
import { createRequire } from 'node:module';

import { definePlugin } from 'emdash';
import type { PluginDescriptor } from 'emdash';

import {
  AUTOMATION_SETTING,
  BULK_STORAGE,
  BULK_TASK,
  createBulk,
  type RunKind,
  type Selection,
} from './bulk.ts';
import { handleAdmin, handleCron, handleScanStart, handleScanStatus, handleUpload, type NativeScan } from './handlers.ts';
import { createNativeScan, MEASURED_TICK_WALL_MS, type NativeScanOptions } from './measure.ts';
import { createNativeMutations, type NativeMutationOptions } from './mutations.ts';
import { createLocalProcessor, DEFAULT_PROCESSOR_LIMITS, type ImageProcessor } from './processor/index.ts';
import { SAFE_MEDIA_CAPABILITY } from './safe-media.ts';
import { createStaging } from './staging.ts';

export const PLUGIN_ID = 'image-optimizer';
/** Kept equal to the version in `package.json`; a test checks it. */
export const PLUGIN_VERSION = '0.1.0';
/** The npm package name, which EmDash imports `createPlugin` from. */
const ENTRYPOINT = 'image-optimizer';

/** A host profile as safe-media discovery reports it: runtime, database, storage and locks. */
export type HostProfile = Readonly<Record<string, string>>;

/** Site options of the native edition, passed by EmDash to `createPlugin()`. */
export interface ImageOptimizerOptions {
  /**
   * Host profiles on which to allow apply and restore. **Unsupported**: no profile has passed
   * qualification, so the plugin allows none by default and stays read-only. Listing a profile here
   * enables apply and restore on a host that reports exactly that profile, at the operator's risk.
   */
  qualifiedProfiles?: HostProfile[];
  /** Directory for output waiting for the host commit. Defaults to one under the system temporary directory. */
  stagingDirectory?: string;
}

/** Registers the native edition: `plugins: [imageOptimizerPlugin()]` in the options of `emdash()`. */
export function imageOptimizerPlugin(options: ImageOptimizerOptions = {}): PluginDescriptor<ImageOptimizerOptions> {
  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    format: 'native',
    entrypoint: ENTRYPOINT,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

/**
 * How long EmDash waits for the scheduled task: a tick's wall-time bound (20 s), plus one image that
 * started just before it, up to the processor's wall-time kill (60 s), plus the host commit.
 */
export const CRON_HOOK_TIMEOUT_MS = MEASURED_TICK_WALL_MS + DEFAULT_PROCESSOR_LIMITS.wallTimeMs + 30_000;

/** Sharp is an optional peer dependency: without it the native edition estimates, like the sandboxed one. */
function sharpInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('sharp');
    return true;
  } catch {
    return false;
  }
}

/** One local processor per plugin instance, created when first needed, so its worker limits are shared. */
function defaultProcessor(): () => ImageProcessor | null {
  let processor: ImageProcessor | null | undefined;
  return () => (processor ??= sharpInstalled() ? createLocalProcessor() : null);
}

type Definition = Parameters<typeof definePlugin>[0];

/**
 * `definePlugin()` with the safe-media capability added, on an EmDash that knows it (the patched
 * host). Published EmDash rejects an unknown capability, so there the plugin is defined without it
 * and has no safe-media access: it stays read-only.
 */
function defineWithSafeMedia<T extends Definition>(definition: T) {
  const capabilities = [...(definition.capabilities ?? []), SAFE_MEDIA_CAPABILITY] as unknown as T['capabilities'];
  try {
    return definePlugin({ ...definition, capabilities });
  } catch (error) {
    if (error instanceof Error && error.message.includes(`"${SAFE_MEDIA_CAPABILITY}"`)) return definePlugin(definition);
    throw error;
  }
}

/**
 * Route input of `bulk-start`: `{ kind: 'apply' | 'restore', mediaIds?: string[] }`. Without media IDs
 * an apply run takes every measured result and a restore run every image this plugin optimized.
 */
function bulkRequestOf(input: unknown): { kind: RunKind; selection: Selection } {
  const record = typeof input === 'object' && input !== null ? (input as { kind?: unknown; mediaIds?: unknown }) : {};
  const kind: RunKind = record.kind === 'restore' ? 'restore' : 'apply';
  if (record.mediaIds === undefined) return { kind, selection: { mode: kind === 'apply' ? 'eligible' : 'optimized' } };
  const mediaIds = Array.isArray(record.mediaIds) ? record.mediaIds : [];
  // Anything but strings makes the selection invalid, which `start` refuses.
  return { kind, selection: { mode: 'selected', mediaIds: mediaIds.map((id) => (typeof id === 'string' ? id : '')) } };
}

/** Route input naming one media item. */
function mediaIdOf(input: unknown): string {
  const value = typeof input === 'object' && input !== null ? (input as { mediaId?: unknown }).mediaId : undefined;
  return typeof value === 'string' ? value : '';
}

async function settingsOf(ctx: { settings: { list(): Promise<Array<{ key: string; value: unknown }>> } }) {
  return new Map((await ctx.settings.list()).map(({ key, value }) => [key, value]));
}

/**
 * The plugin with a given processor. `createPlugin` uses the local Sharp processor; tests pass their
 * own, with a clock, tick limits, a staging area and a qualified-profile allowlist.
 */
export function createNativePlugin(options: NativeScanOptions & Partial<Omit<NativeMutationOptions, 'processor'>>) {
  const mutations = createNativeMutations({ ...options, processor: options.processor });
  const bulk = createBulk({
    mutations,
    ...(options.now ? { now: options.now } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const native: NativeScan = { ...createNativeScan(options), mutations, bulk };
  return defineWithSafeMedia({
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    // `media:bytes:read` lets the measured scan and the sample read image bytes. It is native-only:
    // the sandboxed manifest keeps `media:read` alone. `media:bytes:replace` (added above when the
    // host knows it) grants the fenced safe-media access, which apply and restore use only when the
    // host's profile is on the qualified list. The sandboxed edition cannot write media.
    capabilities: ['media:read', 'media:bytes:read'],
    allowedHosts: [],
    storage: {
      // One scan result per media item, keyed by media ID.
      results: { indexes: ['runId', 'status', ['status', 'estimateBytes']] },
      // Native-only: bulk runs and their items (`bulk.ts`).
      runs: { indexes: [...BULK_STORAGE.runs.indexes] },
      items: { indexes: BULK_STORAGE.items.indexes.map((index) => (typeof index === 'string' ? index : [...index])) },
    },
    hooks: {
      cron: {
        // EmDash stops waiting for a hook after 5 s by default; a measured or bulk tick starts no
        // new image after 20 s, and one image may take up to the processor's 60 s wall time.
        timeout: CRON_HOOK_TIMEOUT_MS,
        handler: async (event, ctx) => {
          if (event.name !== BULK_TASK) return handleCron(event, ctx, native);
          const report = await bulk.tick(ctx);
          if (!report.active) await ctx.cron?.cancel(BULK_TASK);
        },
      },
      'media:afterUpload': {
        // Neither the estimate nor queueing for optimization may fail the upload.
        errorPolicy: 'continue',
        handler: async (event, ctx) => {
          try {
            await handleUpload(event, ctx);
          } finally {
            // Only queues the upload, when automation is on; never processes it here, never throws.
            await bulk.onUpload(event, ctx);
          }
        },
      },
    },
    routes: {
      // The route context is a plugin context with the request's input merged in.
      admin: { handler: async (ctx) => handleAdmin(ctx, ctx, native) },
      'scan-start': { methods: ['POST'], handler: async (ctx) => handleScanStart(ctx, native) },
      'scan-status': { methods: ['GET'], handler: async (ctx) => handleScanStatus(ctx) },
      // Native-only. Each answers `unavailable`, changing nothing, unless the host allows it.
      apply: {
        methods: ['POST'],
        permission: 'plugins:manage',
        handler: async (ctx) => mutations.apply(ctx, await settingsOf(ctx), mediaIdOf(ctx.input)),
      },
      restore: {
        methods: ['POST'],
        permission: 'plugins:manage',
        handler: async (ctx) => mutations.restore(ctx, mediaIdOf(ctx.input)),
      },
      // Native-only bulk runs. Starting one answers an error, changing nothing, unless the host
      // allows the run's kind of change.
      'bulk-start': {
        methods: ['POST'],
        permission: 'plugins:manage',
        handler: async (ctx) => {
          const { kind, selection } = bulkRequestOf(ctx.input);
          return bulk.start(ctx, kind, selection);
        },
      },
      'bulk-pause': { methods: ['POST'], permission: 'plugins:manage', handler: async (ctx) => bulk.control(ctx, 'pause') },
      'bulk-resume': { methods: ['POST'], permission: 'plugins:manage', handler: async (ctx) => bulk.control(ctx, 'resume') },
      'bulk-cancel': { methods: ['POST'], permission: 'plugins:manage', handler: async (ctx) => bulk.control(ctx, 'cancel') },
      'bulk-retry': { methods: ['POST'], permission: 'plugins:manage', handler: async (ctx) => bulk.retryFailed(ctx) },
      'bulk-reconcile': {
        methods: ['POST'],
        permission: 'plugins:manage',
        handler: async (ctx) => ({ queued: await bulk.reconcile(ctx) }),
      },
      'bulk-status': {
        methods: ['POST'],
        permission: 'plugins:manage',
        handler: async (ctx) => bulk.view(ctx, await settingsOf(ctx)),
      },
    },
    admin: {
      pages: [{ path: '/report', label: 'Image report', icon: 'image' }],
      widgets: [{ id: 'savings', title: 'Image savings', size: 'third' }],
      settingsSchema: {
        maxDimension: {
          type: 'number',
          label: 'Largest useful edge (px)',
          description: 'Images wider or taller than this are reported as larger than the site needs.',
          default: 2560,
          min: 1,
        },
        minSavingsKB: { type: 'number', label: 'Smallest saving to report (KB)', default: 50, min: 0 },
        minSavingsPercent: {
          type: 'number',
          label: 'Smallest saving to report (% of the file)',
          default: 20,
          min: 0,
          max: 100,
        },
        // Native-only: the settings of the measured scan and the sample.
        preset: {
          type: 'select',
          label: 'Encoding preset',
          description:
            'How the measured scan and the sample re-encode images. Balanced: JPEG and WebP at quality 80. High fidelity: quality 90 without chroma subsampling. PNG and lossless WebP stay lossless under both.',
          options: [
            { value: 'balanced', label: 'Balanced' },
            { value: 'high-fidelity', label: 'High fidelity' },
          ],
          default: 'balanced',
        },
        removeGps: {
          type: 'boolean',
          label: 'Remove GPS position',
          description: 'Measure as if the GPS position were removed from image metadata. Other metadata is always kept.',
          default: false,
        },
        [AUTOMATION_SETTING]: {
          type: 'boolean',
          label: 'Optimize new uploads',
          description:
            'Queue each new upload for optimization in the background, with the settings above. Uploads never wait for it and never fail because of it. Only takes effect where the host allows changing media.',
          default: false,
        },
      },
    },
  });
}

/**
 * Called by EmDash when it starts, with the descriptor's options. The shared declarations match
 * `emdash-plugin.jsonc`; a test checks it.
 */
export function createPlugin(options: ImageOptimizerOptions = {}) {
  const directory = options.stagingDirectory;
  return createNativePlugin({
    processor: defaultProcessor(),
    ...(options.qualifiedProfiles ? { qualifiedProfiles: options.qualifiedProfiles } : {}),
    staging: () => createStaging(directory ? { directory } : {}),
  });
}

export default createPlugin;
