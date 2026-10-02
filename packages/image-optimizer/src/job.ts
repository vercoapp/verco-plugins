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

import {
  scanItem,
  summarizeScan,
  type EstimateBasis,
  type FindingCode,
  type ImageFormat,
  type ScanMediaItem,
  type ScanOptions,
  type ScanResult,
  type ScanSummary,
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
  totals: ScanSummary;
}

/** One stored result per media item, keyed by media ID. */
export interface StoredResult {
  runId: string;
  filename: string;
  mimeType: string;
  size: number | null;
  width: number | null;
  height: number | null;
  status: ScanResult['status'];
  reason: SkipReason | null;
  format: ImageFormat | null;
  findings: FindingCode[];
  /** Zero when there is no estimate, so flagged results can be ordered by it. */
  estimateBytes: number;
  estimateBasis: EstimateBasis | null;
  scannedAt: string;
}

export interface ScanDeps {
  kv: PluginContext['kv'];
  media: Pick<NonNullable<PluginContext['media']>, 'list' | 'get'>;
  results: PluginContext['storage'][string];
  log: PluginContext['log'];
  now: () => Date;
}

type MediaItem = Awaited<ReturnType<ScanDeps['media']['list']>>['items'][number];

export function emptySummary(): ScanSummary {
  return summarizeScan([]);
}

export function addSummaries(a: ScanSummary, b: ScanSummary): ScanSummary {
  const skipped = { ...a.skipped };
  for (const [reason, count] of Object.entries(b.skipped) as [SkipReason, number][]) skipped[reason] += count;
  return {
    scanned: a.scanned + b.scanned,
    flagged: a.flagged + b.flagged,
    ok: a.ok + b.ok,
    skipped,
    estimatedSavingsBytes: a.estimatedSavingsBytes + b.estimatedSavingsBytes,
    unestimated: a.unestimated + b.unestimated,
  };
}

function toScanInput(item: MediaItem): ScanMediaItem {
  return { id: item.id, mimeType: item.mimeType, size: item.size, width: item.width, height: item.height };
}

function toStored(result: ScanResult, item: MediaItem, runId: string, scannedAt: string): StoredResult {
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
    const pairs = listed.items.map((item) => ({ item, result: scanItem(toScanInput(item), run.options) }));
    for (const { item, result } of pairs) {
      pending.push({ id: item.id, data: toStored(result, item, run.runId, scannedAt) });
    }
    const done = !listed.hasMore || !listed.cursor;
    run = {
      ...run,
      totals: addSummaries(run.totals, summarizeScan(pairs.map(({ result }) => result))),
      cursor: done ? null : listed.cursor!,
      phase: done ? 'cleanup' : 'sweep',
    };
  }
  // Written before cleanup, which removes every result older than this run.
  if (pending.length > 0) {
    await deps.results.putMany(pending);
    used += 1;
  }

  // A cleanup page costs a query and, when it finds results from earlier runs, a delete.
  while (run.phase === 'cleanup' && used + 3 <= calls) {
    const stale = await deps.results.query({ where: { runId: { lt: run.runId } }, limit: PAGE_SIZE });
    used += 1;
    if (stale.items.length > 0) {
      await deps.results.deleteMany(stale.items.map(({ id }) => id));
      used += 1;
    }
    if (!stale.hasMore) run = { ...run, phase: 'complete', finishedAt: deps.now().toISOString() };
  }

  if (run === state.value) return run;
  const next = { ...run, updatedAt: deps.now().toISOString() };
  const written = await deps.kv.compareAndSet(SCAN_STATE_KEY, state.revision, next);
  return written.applied ? next : state.value;
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
    const result = scanItem(toScanInput(item), run?.options ?? defaults);
    await deps.results.put(item.id, toStored(result, item, run?.runId ?? '', deps.now().toISOString()));
    // Without a run there are no totals yet; the first sweep will count this item.
    if (!state || !run) return;

    const totals = addSummaries(run.totals, summarizeScan([result]));
    const written = await deps.kv.compareAndSet(SCAN_STATE_KEY, state.revision, {
      ...run,
      totals,
      updatedAt: deps.now().toISOString(),
    });
    if (written.applied) return;
  }
  deps.log.warn('Scan totals not updated for an upload after repeated conflicts', { mediaId });
}
