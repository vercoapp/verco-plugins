/**
 * The plugin's behaviour, written once for both editions. Every function takes the plugin context, so
 * the sandboxed entry (`plugin.ts`, handlers of `(routeCtx, ctx)`) and the native entry (`native.ts`,
 * handlers of one context) are thin wrappers over these. Nothing here imports native-only code: the
 * native entry passes its additions (the measured scan and the sample) in as a `NativeScan`.
 */
import type { BlockResponse } from '@emdash-cms/blocks/server';
import type { CronEvent, MediaAfterUploadEvent, PluginContext, SandboxedRouteContext } from 'emdash/plugin';

import {
  ACTION_APPLY,
  ACTION_BULK,
  ACTION_RESTORE,
  ACTION_RESULTS_PAGE,
  ACTION_SAMPLE,
  ACTION_START,
  parseAdminRequest,
  reportPage,
  resolveLocale,
  RESULTS_PER_PAGE,
  SAVINGS_WIDGET,
  savingsWidget,
  SKIPPED_SHOWN,
  type ActionOutcome,
  type AppliedRecord,
  type BulkView,
  type MutationsView,
  type NativeReportView,
  type ReportView,
  type SampleView,
} from './admin.ts';
import {
  advanceScan,
  readScan,
  recordUpload,
  SCAN_TASK,
  SCAN_TASK_SCHEDULE,
  startScan,
  type MeasureSpec,
  type ScanDeps,
  type ScanRun,
  type StoredResult,
} from './job.ts';
import { resolveScanOptions, type ScanOptions } from './scanner.ts';

type Settings = ReadonlyMap<string, unknown>;

/**
 * What the native edition adds. Each method returns `null` (or `undefined` for `advance`) when the
 * context cannot measure, without byte access or without Sharp; the shared behaviour then applies.
 */
export interface NativeScan {
  /** The settings of a measured run. Throws `RangeError` for settings the processor cannot use. */
  measureSpec(ctx: PluginContext, deps: ScanDeps, settings: Settings): MeasureSpec | null;
  /** Advances a measured run, or returns `undefined` when this context cannot measure. */
  advance(ctx: PluginContext, deps: ScanDeps): Promise<ScanRun | null | undefined>;
  report(ctx: PluginContext, deps: ScanDeps, settings: Settings): NativeReportView | null;
  /** Throws `RangeError` for settings the processor cannot use. */
  sample(ctx: PluginContext, deps: ScanDeps, settings: Settings, mediaId: string): Promise<SampleView | null>;
  /** Apply and restore, which the host may or may not allow. */
  mutations?: NativeMutations;
  /** Bulk runs and upload automation, offered when the host allows apply or restore. */
  bulk?: NativeBulk;
}

/** Called by a bulk run inside an apply, after the output is staged and before it is submitted. */
export interface ApplyHooks {
  /** `false` holds the commit back; the apply then answers `deferred` and keeps the staged output. */
  beforeCommit?(operationId: string): Promise<boolean>;
}

/** What the shared handlers need of bulk runs: the report section, its actions, and the scan guard. */
export interface NativeBulk {
  view(ctx: PluginContext, settings: Settings): Promise<BulkView>;
  /** Runs a bulk action from the report and returns the toast to show. */
  act(ctx: PluginContext, action: string, mediaIds: string[] | null): Promise<NonNullable<BlockResponse['toast']>>;
  /** A message when a scan must not start now, or `null`. */
  busy(ctx: PluginContext): Promise<string | null>;
}

/**
 * Single-image apply and restore. Each method asks the host whether they are allowed and returns an
 * `unavailable` outcome, changing nothing, when they are not.
 */
export interface NativeMutations {
  view(ctx: PluginContext): Promise<MutationsView>;
  /** Whether the host allows apply and restore now, without the records `view` lists. */
  allowed(ctx: PluginContext): Promise<{ apply: boolean; restore: boolean; message: string }>;
  apply(ctx: PluginContext, settings: Settings, mediaId: string, hooks?: ApplyHooks): Promise<ActionOutcome>;
  restore(ctx: PluginContext, mediaId: string): Promise<ActionOutcome>;
  /** This plugin's records of the images it changed. */
  records(ctx: PluginContext): Promise<AppliedRecord[]>;
  /** Removes output staged for an operation that will not be submitted. */
  discard(operationId: string): Promise<void>;
}

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

/** All plugin settings. One bridge call. */
async function readSettings(ctx: PluginContext): Promise<Settings> {
  return new Map((await ctx.settings.list()).map(({ key, value }) => [key, value]));
}

/**
 * Scan options from plugin settings, which use kilobytes and percent; unset settings take the
 * defaults. Throws `RangeError` for values the scan cannot use.
 */
export function scanOptionsFrom(settings: Settings): ScanOptions {
  const [maxDimension, minSavingsKB, minSavingsPercent] = ['maxDimension', 'minSavingsKB', 'minSavingsPercent'].map(
    (key) => settings.get(key),
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
  | { ok: true; started: boolean; run: ScanRun }
  | { ok: false; error: 'INVALID_SETTINGS' | 'CRON_UNAVAILABLE' | 'BUSY'; message?: string };

/**
 * Starts a scan, or reports the one already running, and leaves the work to the scheduled task. The
 * native edition starts a measured scan when it can measure. Four bridge calls: settings, reading and
 * writing the state, and scheduling the task.
 */
async function beginScan(ctx: PluginContext, native?: NativeScan): Promise<BeginOutcome> {
  let options: ScanOptions;
  let measure: MeasureSpec | null = null;
  try {
    const settings = await readSettings(ctx);
    options = scanOptionsFrom(settings);
    if (native) measure = native.measureSpec(ctx, deps(ctx), settings);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { ok: false, error: 'INVALID_SETTINGS', message: error.message };
  }
  if (!ctx.cron) return { ok: false, error: 'CRON_UNAVAILABLE' };
  const busy = native?.bulk ? await native.bulk.busy(ctx) : null;
  if (busy) return { ok: false, error: 'BUSY', message: busy };

  const { started, run } = await startScan(deps(ctx), options, measure);
  await ctx.cron.schedule(SCAN_TASK, { schedule: SCAN_TASK_SCHEDULE });
  return { ok: true, started, run };
}

function beginToast(outcome: BeginOutcome): NonNullable<BlockResponse['toast']> {
  if (!outcome.ok) {
    if (outcome.error === 'BUSY') return { type: 'info', message: `The scan did not start. ${outcome.message}` };
    return outcome.error === 'INVALID_SETTINGS'
      ? { type: 'error', message: `The scan did not start. Check the plugin settings: ${outcome.message}.` }
      : { type: 'error', message: 'The scan did not start: this site cannot run scheduled tasks.' };
  }
  if (!outcome.started) return { type: 'info', message: 'A scan is already running.' };
  if (outcome.run.measure) {
    return {
      type: 'success',
      message:
        'Scan started. It re-encodes each image to measure the saving, which is much slower than estimating, and runs in the background.',
    };
  }
  return { type: 'success', message: 'Scan started. It runs in the background, about 300 images a minute.' };
}

/** Four bridge calls, or five when the caller does not already have the run. */
async function loadReport(
  ctx: PluginContext,
  cursor: string | null,
  locale: string,
  known?: ScanRun,
): Promise<ReportView> {
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
  const [skipped, skippedTotal, failed, run] = await Promise.all([
    collection.query({ where: { status: 'skipped' }, limit: SKIPPED_SHOWN }),
    collection.count({ status: 'skipped' }),
    collection.query({ where: { status: 'failed' }, limit: SKIPPED_SHOWN }),
    known ?? readScan(ctx),
  ]);

  const asResults = (items: Array<{ id: string; data: unknown }>) =>
    items.map(({ id, data }) => ({ id, data: data as StoredResult }));
  return {
    run,
    results: { items: asResults(page.items), cursor: page.hasMore && page.cursor ? page.cursor : null },
    skipped: { items: asResults(skipped.items), total: skippedTotal },
    failed: { items: asResults(failed.items), more: failed.hasMore },
    continued,
    locale,
  };
}

/**
 * The scheduled task. In the sandboxed edition, at most TICK_CALL_BUDGET bridge calls to advance, plus
 * one to cancel. The native edition advances a measured run by measuring when it can, and otherwise
 * continues it with estimates.
 */
export async function handleCron(event: CronEvent, ctx: PluginContext, native?: NativeScan): Promise<void> {
  if (event.name !== SCAN_TASK) return;
  const scan = deps(ctx);
  let run: ScanRun | null | undefined;
  if (native && (await readScan(scan))?.measure) run = await native.advance(ctx, scan);
  if (run === undefined) run = await advanceScan(scan);
  if (!run || run.phase === 'complete') await ctx.cron?.cancel(SCAN_TASK);
}

/**
 * Uploads are estimated from metadata in both editions: measuring an upload would hold the request
 * for an encode. A measured run's report labels them as estimates until the next scan.
 */
export async function handleUpload(event: MediaAfterUploadEvent, ctx: PluginContext): Promise<void> {
  await recordUpload(deps(ctx), event.media.id, scanOptionsFrom(await readSettings(ctx)));
}

/** The Block Kit route behind the report page and the dashboard widget. */
export async function handleAdmin(
  routeCtx: Pick<SandboxedRouteContext, 'input' | 'ui'>,
  ctx: PluginContext,
  native?: NativeScan,
) {
  const request = parseAdminRequest(routeCtx.input);
  const locale = resolveLocale(routeCtx.ui?.locale);
  if (request?.kind === 'page' && request.page === `widget:${SAVINGS_WIDGET}`) {
    return savingsWidget(await readScan(ctx), locale);
  }

  // The native additions need the settings; the sandboxed edition does not read them here.
  const settings = native ? await readSettings(ctx) : null;
  const withNative = async (
    view: ReportView,
    sample?: SampleView | null,
    action?: ActionOutcome,
  ): Promise<ReportView> => {
    if (!native || !settings) return view;
    const extras = native.report(ctx, deps(ctx), settings);
    const offered = native.mutations ? await native.mutations.view(ctx) : null;
    // On a host without safe-media access, an edition that cannot measure renders the registry
    // edition's page, as before; elsewhere the page says why apply and restore are unavailable.
    const mutations = offered && (extras || offered.reason !== 'missing-host-operation' || offered.optimized.length > 0) ? offered : null;
    const bulk = mutations && native.bulk && (mutations.apply || mutations.restore) ? await native.bulk.view(ctx, settings) : null;
    return {
      ...view,
      native: extras && sample ? { ...extras, sample } : extras,
      ...(mutations ? { mutations } : {}),
      ...(bulk ? { bulk } : {}),
      ...(action ? { action } : {}),
    };
  };

  if (native?.bulk && request?.kind === 'action' && request.actionId.startsWith(ACTION_BULK)) {
    const toast = await native.bulk.act(ctx, request.actionId, request.mediaIds);
    return reportPage(await withNative(await loadReport(ctx, null, locale)), toast);
  }

  const mutation = request?.kind === 'action' && request.mediaId ? request.mediaId : null;
  if (native?.mutations && settings && mutation && request?.kind === 'action') {
    if (request.actionId === ACTION_APPLY) {
      const action = await native.mutations.apply(ctx, settings, mutation);
      return reportPage(await withNative(await loadReport(ctx, null, locale), null, action));
    }
    if (request.actionId === ACTION_RESTORE) {
      const action = await native.mutations.restore(ctx, mutation);
      return reportPage(await withNative(await loadReport(ctx, null, locale), null, action));
    }
  }

  if (request?.kind === 'action' && request.actionId === ACTION_START) {
    const outcome = await beginScan(ctx, native);
    const view = await loadReport(ctx, null, locale, outcome.ok ? outcome.run : undefined);
    return reportPage(await withNative(view), beginToast(outcome));
  }
  if (native && settings && request?.kind === 'action' && request.actionId === ACTION_SAMPLE && request.mediaId) {
    let sample: SampleView | null;
    try {
      sample = await native.sample(ctx, deps(ctx), settings, request.mediaId);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const view = await withNative(await loadReport(ctx, null, locale));
      return reportPage(view, {
        type: 'error',
        message: `The sample did not run. Check the plugin settings: ${error.message}.`,
      });
    }
    return reportPage(await withNative(await loadReport(ctx, null, locale), sample));
  }
  const cursor = request?.kind === 'action' && request.actionId === ACTION_RESULTS_PAGE ? request.cursor : null;
  return reportPage(await withNative(await loadReport(ctx, cursor, locale)));
}

export async function handleScanStart(ctx: PluginContext, native?: NativeScan) {
  return beginScan(ctx, native);
}

export async function handleScanStatus(ctx: PluginContext) {
  return { ok: true, run: await readScan(ctx) };
}
