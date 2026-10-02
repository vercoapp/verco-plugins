/**
 * The native edition: the report of the registry edition, registered in `plugins: []` and run in the
 * site process, plus a measured scan and a sample when Sharp is installed. It shares the plugin ID,
 * storage, settings and routes with the sandboxed edition (`plugin.ts`), so a site can switch between
 * them and keep its results. Register one of the two, never both. Shared behaviour lives in
 * `handlers.ts` and the measured scan in `measure.ts`; this file is the declarations, the processor
 * and the wrappers from native handlers (one context) to the shared functions.
 */
import { createRequire } from 'node:module';

import { definePlugin } from 'emdash';
import type { PluginDescriptor } from 'emdash';

import { handleAdmin, handleCron, handleScanStart, handleScanStatus, handleUpload } from './handlers.ts';
import { createNativeScan, type NativeScanOptions } from './measure.ts';
import { createLocalProcessor, type ImageProcessor } from './processor/index.ts';

export const PLUGIN_ID = 'image-optimizer';
/** Kept equal to the version in `package.json`; a test checks it. */
export const PLUGIN_VERSION = '0.1.0';
/** The npm package name, which EmDash imports `createPlugin` from. */
const ENTRYPOINT = 'image-optimizer';

/** Registers the native edition: `plugins: [imageOptimizerPlugin()]` in the options of `emdash()`. */
export function imageOptimizerPlugin(): PluginDescriptor {
  return { id: PLUGIN_ID, version: PLUGIN_VERSION, format: 'native', entrypoint: ENTRYPOINT };
}

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

/**
 * The plugin with a given processor. `createPlugin` uses the local Sharp processor; tests pass their
 * own, with a clock and tick limits.
 */
export function createNativePlugin(options: NativeScanOptions) {
  const native = createNativeScan(options);
  return definePlugin({
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    // `media:bytes:read` lets the measured scan and the sample read image bytes. It is native-only:
    // the sandboxed manifest keeps `media:read` alone. Neither edition can write media.
    capabilities: ['media:read', 'media:bytes:read'],
    allowedHosts: [],
    storage: {
      // One scan result per media item, keyed by media ID.
      results: { indexes: ['runId', 'status', ['status', 'estimateBytes']] },
    },
    hooks: {
      cron: async (event, ctx) => handleCron(event, ctx, native),
      'media:afterUpload': {
        // A failed scan must not fail the upload.
        errorPolicy: 'continue',
        handler: handleUpload,
      },
    },
    routes: {
      // The route context is a plugin context with the request's input merged in.
      admin: { handler: async (ctx) => handleAdmin(ctx, ctx, native) },
      'scan-start': { methods: ['POST'], handler: async (ctx) => handleScanStart(ctx, native) },
      'scan-status': { methods: ['GET'], handler: async (ctx) => handleScanStatus(ctx) },
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
      },
    },
  });
}

/** Called by EmDash when it starts. The shared declarations match `emdash-plugin.jsonc`; a test checks it. */
export function createPlugin() {
  return createNativePlugin({ processor: defaultProcessor() });
}

export default createPlugin;
