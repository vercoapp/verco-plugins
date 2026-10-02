/**
 * The native edition: the same read-only report as the registry edition, registered in `plugins: []`
 * and run in the site process. It shares the plugin ID, storage, settings and routes with the
 * sandboxed edition (`plugin.ts`), so a site can switch between them and keep its results. Register
 * one of the two, never both. Behaviour lives in `handlers.ts`; this file is only the declarations
 * and the wrappers from native handlers (one context) to the shared functions.
 */
import { definePlugin } from 'emdash';
import type { PluginDescriptor } from 'emdash';

import { handleAdmin, handleCron, handleScanStart, handleScanStatus, handleUpload } from './handlers.ts';

export const PLUGIN_ID = 'image-optimizer';
/** Kept equal to the version in `package.json`; a test checks it. */
export const PLUGIN_VERSION = '0.1.0';
/** The npm package name, which EmDash imports `createPlugin` from. */
const ENTRYPOINT = 'image-optimizer';

/** Registers the native edition: `plugins: [imageOptimizerPlugin()]` in the options of `emdash()`. */
export function imageOptimizerPlugin(): PluginDescriptor {
  return { id: PLUGIN_ID, version: PLUGIN_VERSION, format: 'native', entrypoint: ENTRYPOINT };
}

/** Called by EmDash when it starts. The declarations match `emdash-plugin.jsonc`; a test checks it. */
export function createPlugin() {
  return definePlugin({
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    capabilities: ['media:read'],
    allowedHosts: [],
    storage: {
      // One scan result per media item, keyed by media ID.
      results: { indexes: ['runId', 'status', ['status', 'estimateBytes']] },
    },
    hooks: {
      cron: handleCron,
      'media:afterUpload': {
        // A failed scan must not fail the upload.
        errorPolicy: 'continue',
        handler: handleUpload,
      },
    },
    routes: {
      // The route context is a plugin context with the request's input merged in.
      admin: { handler: async (ctx) => handleAdmin(ctx, ctx) },
      'scan-start': { methods: ['POST'], handler: async (ctx) => handleScanStart(ctx) },
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
      },
    },
  });
}

export default createPlugin;
