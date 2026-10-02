import type { PluginContext, SandboxedPlugin } from 'emdash/plugin';

import {
  advanceScan,
  readScan,
  recordUpload,
  SCAN_TASK,
  SCAN_TASK_SCHEDULE,
  startScan,
  type ScanDeps,
} from './job.ts';
import { resolveScanOptions, type ScanOptions } from './scanner.ts';

const OPTION_KEYS = ['maxDimension', 'minSavingsBytes', 'minSavingsRatio'] as const;

function deps(ctx: PluginContext): ScanDeps {
  const media = ctx.media;
  if (!media) throw new Error('media:read is not available to this plugin');
  const results = ctx.storage.results;
  if (!results) throw new Error('The results storage collection is not declared');
  return { kv: ctx.kv, media, results, log: ctx.log, now: () => new Date() };
}

/** Reads scan options from plugin settings; unset settings take the defaults. */
async function readOptions(ctx: PluginContext): Promise<ScanOptions> {
  const options: Partial<Record<(typeof OPTION_KEYS)[number], number>> = {};
  for (const key of OPTION_KEYS) {
    const value = await ctx.settings.get(key);
    if (value !== null && value !== undefined) options[key] = value as number;
  }
  return resolveScanOptions(options);
}

const plugin: SandboxedPlugin = {
  hooks: {
    cron: async (event, ctx) => {
      if (event.name !== SCAN_TASK) return;
      const run = await advanceScan(deps(ctx));
      if (!run || run.phase === 'complete') await ctx.cron?.cancel(SCAN_TASK);
    },
    'media:afterUpload': {
      // A failed scan must not fail the upload.
      errorPolicy: 'continue',
      handler: async (event, ctx) => {
        await recordUpload(deps(ctx), event.media.id, await readOptions(ctx));
      },
    },
  },
  routes: {
    'scan-start': {
      methods: ['POST'],
      handler: async (_routeCtx, ctx) => {
        let options: ScanOptions;
        try {
          options = await readOptions(ctx);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          return { ok: false, error: 'INVALID_SETTINGS', message: error.message };
        }
        if (!ctx.cron) return { ok: false, error: 'CRON_UNAVAILABLE' };

        const { started } = await startScan(deps(ctx), options);
        await ctx.cron.schedule(SCAN_TASK, { schedule: SCAN_TASK_SCHEDULE });
        // Take the first pages now so a small library finishes without waiting for the task.
        const run = await advanceScan(deps(ctx));
        if (run?.phase === 'complete') await ctx.cron.cancel(SCAN_TASK);
        return { ok: true, started, run };
      },
    },
    'scan-status': {
      methods: ['GET'],
      handler: async (_routeCtx, ctx) => ({ ok: true, run: await readScan(ctx) }),
    },
  },
};

export default plugin;
