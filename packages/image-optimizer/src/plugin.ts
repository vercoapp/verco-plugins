import type { SandboxedPlugin } from 'emdash/plugin';

import { handleAdmin, handleCron, handleScanStart, handleScanStatus, handleUpload } from './handlers.ts';

// The registry edition. Handlers take `(routeCtx, ctx)`; the native entry wraps the same functions.
const plugin: SandboxedPlugin = {
  hooks: {
    cron: handleCron,
    'media:afterUpload': {
      // A failed scan must not fail the upload.
      errorPolicy: 'continue',
      handler: handleUpload,
    },
  },
  routes: {
    admin: { handler: handleAdmin },
    'scan-start': { methods: ['POST'], handler: async (_routeCtx, ctx) => handleScanStart(ctx) },
    'scan-status': { methods: ['GET'], handler: async (_routeCtx, ctx) => handleScanStatus(ctx) },
  },
};

export default plugin;
