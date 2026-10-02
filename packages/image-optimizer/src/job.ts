/**
 * The library scan: a sweep over `media.list()` in pages, then removal of results left by earlier
 * runs. Progress and totals live in one KV record, and every page advances them with a single
 * compare-and-set, so a page processed twice (by a retried or concurrent tick) is stored twice but
 * counted once.
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
/** Pages per invocation, kept well inside the default 5-second hook timeout. */
export const PAGES_PER_TICK = 5;

export type ScanPhase = 'sweep' | 'cleanup' | 'complete';

export interface ScanRun {
  /** ISO timestamp of the start; results from earlier runs sort before it. */
  runId: string;
  phase: ScanPhase;
  options: ScanOptions;
  /** `media.list()` cursor for the next sweep page, `null` for the first. */
  cursor: string | null;
  startedAt: string;
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

/**
 * Advances the active scan by at most `maxPages` pages. Stops early when another invocation moved
 * the state first. Returns the state after the last step, or `null` when no scan exists.
 */
export async function advanceScan(deps: ScanDeps, maxPages = PAGES_PER_TICK): Promise<ScanRun | null> {
  let state = await deps.kv.getVersioned<ScanRun>(SCAN_STATE_KEY);
  for (let page = 0; page < maxPages && state && state.value.phase !== 'complete'; page += 1) {
    const run = state.value;
    const next = run.phase === 'sweep' ? await sweepPage(deps, run) : await cleanupPage(deps, run);
    const written = await deps.kv.compareAndSet(SCAN_STATE_KEY, state.revision, next);
    if (!written.applied) return readScan(deps);
    state = { value: next, revision: written.revision };
  }
  return state?.value ?? null;
}

async function sweepPage(deps: ScanDeps, run: ScanRun): Promise<ScanRun> {
  const page = await deps.media.list({
    limit: PAGE_SIZE,
    mimeType: 'image/',
    ...(run.cursor ? { cursor: run.cursor } : {}),
  });
  const scannedAt = deps.now().toISOString();
  const pairs = page.items.map((item) => ({ item, result: scanItem(toScanInput(item), run.options) }));
  if (pairs.length > 0) {
    await deps.results.putMany(
      pairs.map(({ item, result }) => ({ id: item.id, data: toStored(result, item, run.runId, scannedAt) })),
    );
  }
  const totals = addSummaries(run.totals, summarizeScan(pairs.map(({ result }) => result)));
  const done = !page.hasMore || !page.cursor;
  return { ...run, totals, cursor: done ? null : page.cursor!, phase: done ? 'cleanup' : 'sweep' };
}

/** Deletes one page of results older than this run: media deleted since they were scanned. */
async function cleanupPage(deps: ScanDeps, run: ScanRun): Promise<ScanRun> {
  const stale = await deps.results.query({ where: { runId: { lt: run.runId } }, limit: PAGE_SIZE });
  if (stale.items.length > 0) await deps.results.deleteMany(stale.items.map(({ id }) => id));
  if (stale.hasMore) return run;
  return { ...run, phase: 'complete', finishedAt: deps.now().toISOString() };
}

const UPLOAD_TOTALS_ATTEMPTS = 3;

/**
 * Scans one newly uploaded item. A sweep lists newest first from the moment it starts, so it never
 * reaches uploads made after that; this hook covers them and adds them to the run's totals.
 *
 * An upload that lands while a run is being created can be counted by both the hook and the sweep;
 * the window is the time between reading the state and writing the result.
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
    const written = await deps.kv.compareAndSet(SCAN_STATE_KEY, state.revision, { ...run, totals });
    if (written.applied) return;
  }
  deps.log.warn('Scan totals not updated for an upload after repeated conflicts', { mediaId });
}
