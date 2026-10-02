import type { BlockResponse } from '@emdash-cms/blocks/server';
import type { PluginContext, SandboxedPlugin } from 'emdash/plugin';

import {
  ACTION_RESULTS_PAGE,
  ACTION_START,
  parseAdminRequest,
  reportPage,
  resolveLocale,
  RESULTS_PER_PAGE,
  SAVINGS_WIDGET,
  savingsWidget,
  SKIPPED_SHOWN,
  type ReportView,
} from './admin.ts';
import {
  advanceScan,
  readScan,
  recordUpload,
  SCAN_TASK,
  SCAN_TASK_SCHEDULE,
  startScan,
  type ScanDeps,
  type ScanRun,
  type StoredResult,
} from './job.ts';
import { resolveScanOptions, type ScanOptions } from './scanner.ts';

function deps(ctx: PluginContext): ScanDeps {
  const media = ctx.media;
  if (!media) throw new Error('media:read is not available to this plugin');
  return { kv: ctx.kv, media, results: results(ctx), log: ctx.log, now: () => new Date() };
}

function results(ctx: PluginContext): ScanDeps['results'] {
  const collection = ctx.storage.results;
  if (!collection) throw new Error('The results storage collection is not declared');
  return collection;
}

/**
 * Reads scan options from plugin settings, which use kilobytes and percent; unset settings take the
 * defaults. Throws `RangeError` for values the scan cannot use.
 */
async function readOptions(ctx: PluginContext): Promise<ScanOptions> {
  const [maxDimension, minSavingsKB, minSavingsPercent] = await Promise.all(
    ['maxDimension', 'minSavingsKB', 'minSavingsPercent'].map((key) => ctx.settings.get(key)),
  );
  const options: Partial<ScanOptions> = {};
  if (maxDimension !== null && maxDimension !== undefined) options.maxDimension = maxDimension as number;
  if (minSavingsKB !== null && minSavingsKB !== undefined) options.minSavingsBytes = (minSavingsKB as number) * 1000;
  if (minSavingsPercent !== null && minSavingsPercent !== undefined) {
    options.minSavingsRatio = (minSavingsPercent as number) / 100;
  }
  return resolveScanOptions(options);
}

type BeginOutcome =
  | { ok: true; started: boolean; run: ScanRun | null }
  | { ok: false; error: 'INVALID_SETTINGS' | 'CRON_UNAVAILABLE'; message?: string };

/** Starts a scan, or reports the one already running, and takes its first pages. */
async function beginScan(ctx: PluginContext): Promise<BeginOutcome> {
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
}

function beginToast(outcome: BeginOutcome): NonNullable<BlockResponse['toast']> {
  if (!outcome.ok) {
    return outcome.error === 'INVALID_SETTINGS'
      ? { type: 'error', message: `The scan did not start. Check the plugin settings: ${outcome.message}.` }
      : { type: 'error', message: 'The scan did not start: this site cannot run scheduled tasks.' };
  }
  if (!outcome.started) return { type: 'info', message: 'A scan is already running.' };
  return outcome.run?.phase === 'complete'
    ? { type: 'success', message: 'Scan finished.' }
    : { type: 'success', message: 'Scan started. It continues in the background.' };
}

async function loadReport(ctx: PluginContext, cursor: string | null, locale: string): Promise<ReportView> {
  const collection = results(ctx);
  const flagged = (next: string | null) =>
    collection.query({
      where: { status: 'flagged' },
      orderBy: { estimateBytes: 'desc' },
      limit: RESULTS_PER_PAGE,
      ...(next ? { cursor: next } : {}),
    });

  let page;
  let continued = cursor !== null;
  try {
    page = await flagged(cursor);
  } catch (error) {
    if (cursor === null) throw error;
    // A cursor from an earlier page can stop being valid; start again from the top.
    page = await flagged(null);
    continued = false;
  }
  const [skipped, skippedTotal, run] = await Promise.all([
    collection.query({ where: { status: 'skipped' }, limit: SKIPPED_SHOWN }),
    collection.count({ status: 'skipped' }),
    readScan(ctx),
  ]);

  const asResults = (items: Array<{ id: string; data: unknown }>) =>
    items.map(({ id, data }) => ({ id, data: data as StoredResult }));
  return {
    run,
    results: { items: asResults(page.items), cursor: page.hasMore && page.cursor ? page.cursor : null },
    skipped: { items: asResults(skipped.items), total: skippedTotal },
    continued,
    locale,
  };
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
    admin: {
      handler: async (routeCtx, ctx) => {
        const request = parseAdminRequest(routeCtx.input);
        const locale = resolveLocale(routeCtx.ui?.locale);
        if (request?.kind === 'page' && request.page === `widget:${SAVINGS_WIDGET}`) {
          return savingsWidget(await readScan(ctx), locale);
        }
        if (request?.kind === 'action' && request.actionId === ACTION_START) {
          const toast = beginToast(await beginScan(ctx));
          return reportPage(await loadReport(ctx, null, locale), toast);
        }
        const cursor = request?.kind === 'action' && request.actionId === ACTION_RESULTS_PAGE ? request.cursor : null;
        return reportPage(await loadReport(ctx, cursor, locale));
      },
    },
    'scan-start': {
      methods: ['POST'],
      handler: async (_routeCtx, ctx) => beginScan(ctx),
    },
    'scan-status': {
      methods: ['GET'],
      handler: async (_routeCtx, ctx) => ({ ok: true, run: await readScan(ctx) }),
    },
  },
};

export default plugin;
