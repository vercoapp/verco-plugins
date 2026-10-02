/**
 * The library scan: a sweep over `media.list()` in pages, then removal of results left by earlier
 * runs. Progress and totals live in one KV record, and every tick advances them with a single
 * compare-and-set, so pages processed twice (by a retried or concurrent tick) are stored twice but
 * counted once.
 *
 * Every `ctx` call in a sandboxed plugin (storage, KV, settings, media, cron, log) is a call to the
 * host's bridge, and Cloudflare counts each one toward the sandbox's subrequest limit, 10 per
 * invocation by default. Each entry point therefore counts its calls; the Node runner and the test
 * hosts do not enforce the limit, so tests check the counts instead.
 */
import type { PluginContext } from 'emdash/plugin';

import type { ProcessorErrorCode, ProcessSkipReason } from './processor/contract.ts';
import type { PresetName } from './processor/presets.ts';
import {
  scanItem,
  summarizeScan,
  type EstimateBasis,
  type FindingCode,
  type ImageFormat,
  type ScanMediaItem,
  type ScanOptions,
  type ScanResult,
  type SkipReason,
} from './scanner.ts';

export const SCAN_STATE_KEY = 'state:scan';
/** Recurring task that advances an active scan; cancelled once the scan completes. */
export const SCAN_TASK = 'scan-step';
export const SCAN_TASK_SCHEDULE = '* * * * *';
/** `media.list()` and `storage.query()` both return at most 100 items. */
export const PAGE_SIZE = 100;
/** Bridge calls one plugin invocation may make: EmDash's default sandbox subrequest limit. */
export const BRIDGE_CALL_LIMIT = 10;
/** Calls `advanceScan` may make inside the cron hook, which keeps one to cancel the task. */
export const TICK_CALL_BUDGET = BRIDGE_CALL_LIMIT - 1;
/**
 * Sweep pages per tick. More would fit the call budget, but the host writes each stored result as
 * its own database statement, so a tick writes at most 300.
 */
export const SWEEP_PAGES_PER_TICK = 3;

export type ScanPhase = 'sweep' | 'cleanup' | 'complete';

/** Why an image was not assessed: from its metadata (estimates) or from its decoded bytes (measured). */
export type ResultSkipReason = SkipReason | ProcessSkipReason;

/**
 * A measured run's settings. The native edition records them when it starts a scan it can measure;
 * a run without them estimates from metadata.
 */
export interface MeasureSpec {
  preset: PresetName;
  removeGps: boolean;
  /** `capabilities().processor` and `.version` of the processor the run started with. */
  processor: string;
  processorVersion: string;
}

/** An item a measured run will try again in a later tick, after a retryable processor error. */
export interface PendingRetry {
  id: string;
  /** Attempts made so far. */
  attempts: number;
}

export interface RunTotals {
  /** Results recorded: assessed, skipped or failed. */
  scanned: number;
  flagged: number;
  ok: number;
  skipped: Partial<Record<ResultSkipReason, number>>;
  /** Savings of flagged results estimated from metadata. */
  estimatedSavingsBytes: number;
  /** Flagged results with only advisory findings, so no saving is included for them. */
  unestimated: number;
  /** Results whose output size was measured by encoding (flagged or ok). Absent in older runs. */
  measured?: number;
  /** Savings of flagged results measured by encoding. Absent in older runs. */
  measuredSavingsBytes?: number;
  /** Items whose processing failed. Absent in older runs. */
  failed?: number;
}

export interface ScanRun {
  /** ISO timestamp of the start; results from earlier runs sort before it. */
  runId: string;
  phase: ScanPhase;
  options: ScanOptions;
  /** `media.list()` cursor for the next sweep page, `null` for the first. */
  cursor: string | null;
  startedAt: string;
  /** Time of the last write to this record: progress, an upload, or completion. */
  updatedAt: string;
  finishedAt: string | null;
  totals: RunTotals;
  /** Set when the run measures by encoding; `null` or absent when it estimates from metadata. */
  measure?: MeasureSpec | null;
  /** Measured runs only: items of the page at `cursor` already handled. */
  offset?: number;
  /** Measured runs only: the last item handled in that page, to resume after it. */
  lastId?: string | null;
  /** Measured runs only: items to try again. The run does not clean up until this is empty. */
  retries?: PendingRetry[];
}

/** What a measured result records about the encode. The output bytes themselves are discarded. */
export interface MeasuredOutput {
  inputBytes: number;
  outputBytes: number;
  preset: PresetName;
  removeGps: boolean;
  processor: string;
  processorVersion: string;
}

/**
 * One stored result per media item, keyed by media ID. Both editions write and read the same records,
 * so `basis` says how each one was decided. Records written before `basis` existed are estimates.
 */
export interface StoredResult {
  runId: string;
  filename: string;
  mimeType: string;
  size: number | null;
  width: number | null;
  height: number | null;
  status: ScanResult['status'] | 'failed';
  reason: ResultSkipReason | null;
  format: ImageFormat | null;
  findings: FindingCode[];
  /**
   * The saving in bytes, zero when there is none, so flagged results can be ordered by it. An estimate
   * or a measurement according to `basis`; the name predates measured results and is indexed.
   */
  estimateBytes: number;
  estimateBasis: EstimateBasis | null;
  scannedAt: string;
  /** `measured` when the bytes were decoded and encoded; absent in records from older versions. */
  basis?: ResultBasis;
  /** Measured results that were encoded: sizes, preset and processor. */
  measured?: MeasuredOutput | null;
  /** Failed results: the processor's error code (or `read-failed`) and the attempts made. */
  failure?: { code: ProcessorErrorCode | 'read-failed' | 'internal'; attempts: number } | null;
  /** Native edition: set when this plugin optimized the image after the scan, cleared on restore. */
  optimized?: OptimizedMarker | null;
}

/** What an apply recorded on the image's scan result: the saving made, and with which settings. */
export interface OptimizedMarker {
  inputBytes: number;
  outputBytes: number;
  preset: PresetName;
  removeGps: boolean;
  processor: string;
  processorVersion: string;
  at: string;
}

export type ResultBasis = 'measured' | 'estimated';

export function resultBasis(result: Pick<StoredResult, 'basis'>): ResultBasis {
  return result.basis ?? 'estimated';
}

export interface ScanDeps {
  kv: PluginContext['kv'];
  media: Pick<NonNullable<PluginContext['media']>, 'list' | 'get'>;
  results: PluginContext['storage'][string];
  log: PluginContext['log'];
  now: () => Date;
}

export type MediaItem = Awaited<ReturnType<ScanDeps['media']['list']>>['items'][number];

export function emptySummary(): RunTotals {
  return { ...summarizeScan([]), measured: 0, measuredSavingsBytes: 0, failed: 0 };
}

/** Adds totals; fields missing from runs stored by older versions count as zero. */
export function addSummaries(a: RunTotals, b: RunTotals): RunTotals {
  const skipped = { ...a.skipped };
  for (const [reason, count] of Object.entries(b.skipped) as [ResultSkipReason, number][]) {
    skipped[reason] = (skipped[reason] ?? 0) + count;
  }
  return {
    scanned: a.scanned + b.scanned,
    flagged: a.flagged + b.flagged,
    ok: a.ok + b.ok,
    skipped,
    estimatedSavingsBytes: a.estimatedSavingsBytes + b.estimatedSavingsBytes,
    unestimated: a.unestimated + b.unestimated,
    measured: (a.measured ?? 0) + (b.measured ?? 0),
    measuredSavingsBytes: (a.measuredSavingsBytes ?? 0) + (b.measuredSavingsBytes ?? 0),
    failed: (a.failed ?? 0) + (b.failed ?? 0),
  };
}

/** `a` minus `b`, field by field. */
export function subtractSummaries(a: RunTotals, b: RunTotals): RunTotals {
  const negated: RunTotals = {
    scanned: -b.scanned,
    flagged: -b.flagged,
    ok: -b.ok,
    skipped: Object.fromEntries(Object.entries(b.skipped).map(([reason, count]) => [reason, -(count ?? 0)])),
    estimatedSavingsBytes: -b.estimatedSavingsBytes,
    unestimated: -b.unestimated,
    measured: -(b.measured ?? 0),
    measuredSavingsBytes: -(b.measuredSavingsBytes ?? 0),
    failed: -(b.failed ?? 0),
  };
  return addSummaries(a, negated);
}

/** Totals for stored results, estimated and measured savings kept apart. */
export function summarizeStored(results: Iterable<StoredResult>): RunTotals {
  const totals = emptySummary();
  for (const result of results) {
    totals.scanned += 1;
    const measured = resultBasis(result) === 'measured';
    if (result.status === 'skipped') {
      if (result.reason) totals.skipped[result.reason] = (totals.skipped[result.reason] ?? 0) + 1;
    } else if (result.status === 'failed') {
      totals.failed! += 1;
    } else {
      if (measured) totals.measured! += 1;
      if (result.status === 'ok') {
        totals.ok += 1;
      } else {
        totals.flagged += 1;
        if (measured) totals.measuredSavingsBytes! += result.estimateBytes;
        else if (result.estimateBasis !== null) totals.estimatedSavingsBytes += result.estimateBytes;
        else totals.unestimated += 1;
      }
    }
  }
  return totals;
}

export function toScanInput(item: MediaItem): ScanMediaItem {
  return { id: item.id, mimeType: item.mimeType, size: item.size, width: item.width, height: item.height };
}

export function toStored(result: ScanResult, item: MediaItem, runId: string, scannedAt: string): StoredResult {
  return {
    runId,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.size ?? null,
    width: item.width ?? null,
    height: item.height ?? null,
    status: result.status,
    reason: result.status === 'skipped' ? result.reason : null,
    format: result.status === 'skipped' ? null : result.format,
    findings: result.status === 'flagged' ? result.findings : [],
    estimateBytes: result.status === 'flagged' ? (result.estimate?.bytes ?? 0) : 0,
    estimateBasis: result.status === 'flagged' ? (result.estimate?.basis ?? null) : null,
    scannedAt,
    basis: 'estimated',
  };
}

export async function readScan(deps: Pick<ScanDeps, 'kv'>): Promise<ScanRun | null> {
  return deps.kv.get<ScanRun>(SCAN_STATE_KEY);
}

/**
 * Starts a scan unless one is active. Returns the active or new run and whether this call started it.
 */
export async function startScan(
  deps: ScanDeps,
  options: ScanOptions,
  measure: MeasureSpec | null = null,
): Promise<{ started: boolean; run: ScanRun }> {
  const current = await deps.kv.getVersioned<ScanRun>(SCAN_STATE_KEY);
  if (current && current.value.phase !== 'complete') return { started: false, run: current.value };

  const startedAt = deps.now().toISOString();
  const run: ScanRun = {
    runId: startedAt,
    phase: 'sweep',
    options,
    cursor: null,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    totals: emptySummary(),
    ...(measure ? { measure, offset: 0, retries: [] } : {}),
  };
  const written = await deps.kv.compareAndSet(SCAN_STATE_KEY, current?.revision ?? null, run);
  if (!written.applied) {
    // Another request started a scan first.
    return { started: false, run: (await readScan(deps)) ?? run };
  }
  return { started: true, run };
}

export interface AdvanceLimits {
  /** Bridge calls this call may make, including reading and writing the state. */
  calls: number;
  sweepPages: number;
}

/**
 * Advances the active scan within `limits`: sweep pages first, their results written together, then
 * cleanup with whatever calls remain, then one compare-and-set. Returns the state after the tick, or
 * the state as read when another invocation moved it first, or `null` when no scan exists.
 */
export async function advanceScan(deps: ScanDeps, limits: Partial<AdvanceLimits> = {}): Promise<ScanRun | null> {
  const { calls = TICK_CALL_BUDGET, sweepPages = SWEEP_PAGES_PER_TICK } = limits;
  let used = 1;
  const state = await deps.kv.getVersioned<ScanRun>(SCAN_STATE_KEY);
  if (!state || state.value.phase === 'complete') return state?.value ?? null;

  let run = state.value;
  const scannedAt = deps.now().toISOString();
  const pending: Array<{ id: string; data: StoredResult }> = [];

  // A sweep page costs one list call; keep room for the shared putMany and the final write.
  for (let page = 0; run.phase === 'sweep' && page < sweepPages && used + 3 <= calls; page += 1) {
    const listed = await deps.media.list({
      limit: PAGE_SIZE,
      mimeType: 'image/',
      ...(run.cursor ? { cursor: run.cursor } : {}),
    });
    used += 1;
    // A measured run that this edition continues by estimating may have handled part of the page.
    const stored = listed.items.slice(run.offset ?? 0).map((item) => ({
      id: item.id,
      data: toStored(scanItem(toScanInput(item), run.options), item, run.runId, scannedAt),
    }));
    pending.push(...stored);
    const done = !listed.hasMore || !listed.cursor;
    run = {
      ...run,
      totals: addSummaries(run.totals, summarizeStored(stored.map(({ data }) => data))),
      cursor: done ? null : listed.cursor!,
      phase: done ? 'cleanup' : 'sweep',
      ...(run.offset ? { offset: 0 } : {}),
    };
  }
  // Written before cleanup, which removes every result older than this run.
  if (pending.length > 0) {
    await deps.results.putMany(pending);
    used += 1;
  }

  // Items a measured run meant to retry are not retried by estimating; they drop out of this run.
  if (run.phase === 'cleanup' && run.retries?.length) run = { ...run, retries: [] };

  // A cleanup page costs a query and, when it finds results from earlier runs, a delete.
  while (run.phase === 'cleanup' && used + 3 <= calls) {
    const step = await cleanupPage(deps, run);
    used += step.calls;
    run = step.run;
  }

  if (run === state.value) return run;
  const next = { ...run, updatedAt: deps.now().toISOString() };
  const written = await deps.kv.compareAndSet(SCAN_STATE_KEY, state.revision, next);
  return written.applied ? next : state.value;
}

/**
 * Removes one page of results left by earlier runs, and completes the run when none remain. One or two
 * bridge calls: the query, and a delete when it finds any.
 */
export async function cleanupPage(
  deps: Pick<ScanDeps, 'results' | 'now'>,
  run: ScanRun,
): Promise<{ run: ScanRun; calls: number }> {
  const stale = await deps.results.query({ where: { runId: { lt: run.runId } }, limit: PAGE_SIZE });
  let calls = 1;
  if (stale.items.length > 0) {
    await deps.results.deleteMany(stale.items.map(({ id }) => id));
    calls += 1;
  }
  return {
    run: stale.hasMore ? run : { ...run, phase: 'complete', finishedAt: deps.now().toISOString() },
    calls,
  };
}

/** Two attempts keep the upload hook within the call limit: see `recordUpload`. */
const UPLOAD_TOTALS_ATTEMPTS = 2;

/**
 * Scans one newly uploaded item. A sweep lists newest first from the moment it starts, so it never
 * reaches uploads made after that; this hook covers them and adds them to the run's totals.
 *
 * An upload that lands while a run is being created can be counted by both the hook and the sweep;
 * the window is the time between reading the state and writing the result.
 *
 * Bridge calls: one `media.get`, three per attempt, and one log line when both attempts conflict, so
 * at most 8 besides the caller's.
 */
export async function recordUpload(deps: ScanDeps, mediaId: string, defaults: ScanOptions): Promise<void> {
  const item = await deps.media.get(mediaId);
  if (!item || !item.mimeType.toLowerCase().startsWith('image/')) return;

  for (let attempt = 0; attempt < UPLOAD_TOTALS_ATTEMPTS; attempt += 1) {
    const state = await deps.kv.getVersioned<ScanRun>(SCAN_STATE_KEY);
    const run = state?.value;
    const scanned = scanItem(toScanInput(item), run?.options ?? defaults);
    const result = toStored(scanned, item, run?.runId ?? '', deps.now().toISOString());
    await deps.results.put(item.id, result);
    // Without a run there are no totals yet; the first sweep will count this item.
    if (!state || !run) return;

    const totals = addSummaries(run.totals, summarizeStored([result]));
    const written = await deps.kv.compareAndSet(SCAN_STATE_KEY, state.revision, {
      ...run,
      totals,
      updatedAt: deps.now().toISOString(),
    });
    if (written.applied) return;
  }
  deps.log.warn('Scan totals not updated for an upload after repeated conflicts', { mediaId });
}

/** Attempts for each conditional write of `replaceResult`. */
const REPLACE_RESULT_ATTEMPTS = 3;

/**
 * Rewrites the stored result of one media item, if there is one, with conditional writes, and moves
 * the scan's totals by the difference when the result counts toward them (it belongs to the scan
 * in the state record). Never creates a result. Returns whether the result was rewritten.
 */
export async function replaceResult(
  deps: Pick<ScanDeps, 'kv' | 'results' | 'now'>,
  mediaId: string,
  update: (old: StoredResult) => StoredResult,
): Promise<boolean> {
  for (let attempt = 0; attempt < REPLACE_RESULT_ATTEMPTS; attempt += 1) {
    const row = await deps.results.getVersioned(mediaId);
    if (!row) return false;
    const old = row.value as StoredResult;
    const next = update(old);
    if (next === old) return false;
    const written = await deps.results.compareAndSet(mediaId, row.revision, next);
    if (!written.applied) continue;
    for (let retry = 0; retry < REPLACE_RESULT_ATTEMPTS; retry += 1) {
      const state = await deps.kv.getVersioned<ScanRun>(SCAN_STATE_KEY);
      if (!state || state.value.runId !== old.runId) break;
      const totals = addSummaries(subtractSummaries(state.value.totals, summarizeStored([old])), summarizeStored([next]));
      const moved = await deps.kv.compareAndSet(SCAN_STATE_KEY, state.revision, {
        ...state.value,
        totals,
        updatedAt: deps.now().toISOString(),
      });
      if (moved.applied) break;
    }
    return true;
  }
  return false;
}
