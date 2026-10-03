/**
 * The measured scan and the sample, for the native edition only: each image's bytes are read and
 * encoded by the local processor with the configured preset and metadata policy, the output size is
 * recorded and the output bytes are discarded. Nothing is written to media. The sandboxed entry must
 * not import this module; it reaches it only through the `NativeScan` the native entry passes to the
 * shared handlers.
 *
 * Results go to the same storage as the metadata estimates, marked `basis: 'measured'`, so either
 * edition can show them and label them as measured.
 */
import type { PluginContext } from 'emdash/plugin';

import type { NativeReportView, SampleView } from './admin.ts';
import type { NativeScan } from './handlers.ts';
import {
  addSummaries,
  cleanupPage,
  PAGE_SIZE,
  SCAN_STATE_KEY,
  summarizeStored,
  type MediaItem,
  type MeasureSpec,
  type PendingRetry,
  type ScanDeps,
  type ScanRun,
  type StoredResult,
} from './job.ts';
import {
  ImageProcessorError,
  type ImageProcessor,
  type ProcessedImage,
  type ProcessorErrorCode,
  type ProcessSkipReason,
} from './processor/contract.ts';
import { isPresetName, presetOptions, type PresetName } from './processor/presets.ts';
import { imageFormat, worthReporting, type ScanOptions } from './scanner.ts';

/*
 * Tick bounds. The scheduled task runs every minute, and in the native edition it runs in the site
 * process, where no sandbox call limit stops it; these bounds keep one tick from monopolizing it.
 *
 * - Images are processed one at a time, so a tick holds at most one of the processor's two workers
 *   and leaves the other for a sample, and the site keeps its other cores.
 * - A tick starts no new image after `MEASURED_TICK_WALL_MS` (15 s, a quarter of the cron interval).
 *   One image already started can run past it, up to the processor's own wall-time kill (40 s), so
 *   even a tick whose last image runs to that kill ends within 55 s, inside the one-minute interval,
 *   and the tick's own reads and writes after it take the rest. Normally the last image is fast: the
 *   slowest 24 MP encode measured was 12.3 s, so a tick that meets only such images ends within
 *   about 28 s.
 * - `MEASURED_ITEMS_PER_TICK` caps the images per tick when they are fast, so the bytes read and the
 *   storage written per tick stay small. Web-sized images (2-6 MP) took 0.1-1.5 s each to encode on
 *   the measured VPS, so 20 of them use 2-30 s: the wall-time bound, not the count, ends a tick of
 *   larger images. At this cap a 10,000-image library takes at least eight hours, against half an
 *   hour for the metadata estimate.
 *
 * The encode times are from `calibration/measure-processor.ts` on one VPS (4 vCPU AMD EPYC 9J45,
 * container capped at 2 CPUs and 3 GiB, Node 22.16); see `src/processor/limits.ts` for the figures.
 * Other hardware or a busy site can differ.
 */
export const MEASURED_ITEMS_PER_TICK = 20;
export const MEASURED_TICK_WALL_MS = 15_000;
/** Attempts per item for retryable processor errors (`busy`, `crashed`, `aborted`) before it is recorded as failed. */
export const MAX_ATTEMPTS = 3;
/** Items waiting for a retry, kept in the run record; beyond this, a retryable error is recorded as a failure. */
export const MAX_PENDING_RETRIES = PAGE_SIZE;
/** EmDash's largest `media.readBytes` (16 MiB): larger files cannot be read, so they are skipped unread. */
export const HOST_READ_LIMIT_BYTES = 16 * 1024 * 1024;
/** Cleanup pages per tick: each is one query and at most one delete of 100 results. */
const CLEANUP_PAGES_PER_TICK = 10;

const MEASURABLE_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface MeasureDeps extends ScanDeps {
  media: ScanDeps['media'] & { readBytes: NonNullable<NonNullable<PluginContext['media']>['readBytes']> };
  processor: ImageProcessor;
  /** Milliseconds from a monotonic clock, for the tick's wall-time bound. */
  clock: () => number;
}

export interface MeasureSettings {
  preset: PresetName;
  removeGps: boolean;
}

export interface MeasureLimits {
  items: number;
  wallTimeMs: number;
}

/** Reads the native-only settings. Throws `RangeError` for values the processor cannot use. */
export function readMeasureSettings(settings: ReadonlyMap<string, unknown>): MeasureSettings {
  const preset = settings.get('preset') ?? 'balanced';
  const removeGps = settings.get('removeGps') ?? false;
  if (!isPresetName(preset)) throw new RangeError('preset must be balanced or high-fidelity');
  if (typeof removeGps !== 'boolean') throw new RangeError('removeGps must be true or false');
  return { preset, removeGps };
}

type Attempt =
  | { kind: 'processed'; image: ProcessedImage; inputBytes: number }
  | { kind: 'skipped'; reason: ProcessSkipReason | 'not-an-image' }
  | { kind: 'error'; code: FailureCode; retryable: boolean; message: string };

/**
 * Reads one item's bytes and runs the processor on them. Images in formats the processor does not
 * handle, or larger than the host lets a plugin read, are skipped without reading. The output bytes
 * stay inside the returned `ProcessedImage`; callers keep only its measurements.
 */
async function attempt(
  deps: Pick<MeasureDeps, 'media' | 'processor'>,
  item: MediaItem,
  settings: { preset: PresetName; removeGps: boolean },
): Promise<Attempt> {
  const format = imageFormat(item.mimeType);
  if (format === undefined) return { kind: 'skipped', reason: 'not-an-image' };
  if (format === null || !MEASURABLE_FORMATS.has(format)) return { kind: 'skipped', reason: 'unsupported-format' };
  const limit = Math.min(HOST_READ_LIMIT_BYTES, deps.processor.capabilities().limits.maxInputBytes);
  if (typeof item.size === 'number' && item.size > limit) return { kind: 'skipped', reason: 'over-byte-limit' };

  let bytes: Uint8Array;
  try {
    bytes = (await deps.media.readBytes(item.id, { maxBytes: limit })).bytes;
  } catch (error) {
    // The host throws a RangeError when the file is larger than the limit asked for.
    if (error instanceof RangeError) return { kind: 'skipped', reason: 'over-byte-limit' };
    return { kind: 'error', code: 'read-failed', retryable: false, message: 'The image bytes could not be read' };
  }

  try {
    const result = await deps.processor.process({
      bytes,
      preset: settings.preset,
      metadata: { removeGps: settings.removeGps },
    });
    if (result.status === 'skipped') return { kind: 'skipped', reason: result.reason };
    return { kind: 'processed', image: result, inputBytes: bytes.byteLength };
  } catch (error) {
    if (error instanceof ImageProcessorError) {
      return { kind: 'error', code: error.code, retryable: error.retryable, message: error.message };
    }
    return { kind: 'error', code: 'internal', retryable: false, message: 'The processor failed unexpectedly' };
  }
}

function baseResult(item: MediaItem, runId: string, scannedAt: string): StoredResult {
  return {
    runId,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.size ?? null,
    width: item.width ?? null,
    height: item.height ?? null,
    status: 'ok',
    reason: null,
    format: null,
    findings: [],
    estimateBytes: 0,
    estimateBasis: null,
    scannedAt,
    basis: 'measured',
    measured: null,
    failure: null,
  };
}

/** A processed image as a stored result: flagged when the measured saving meets both thresholds. */
function processedResult(
  base: StoredResult,
  outcome: Extract<Attempt, { kind: 'processed' }>,
  options: ScanOptions,
  spec: MeasureSpec,
): StoredResult {
  const { image, inputBytes } = outcome;
  const outputBytes = image.output.byteLength;
  const saving = inputBytes - outputBytes;
  const flagged = worthReporting(saving, inputBytes, options);
  return {
    ...base,
    size: inputBytes,
    width: image.input.width,
    height: image.input.height,
    format: image.input.format,
    status: flagged ? 'flagged' : 'ok',
    estimateBytes: flagged ? saving : 0,
    measured: {
      inputBytes,
      outputBytes,
      preset: spec.preset,
      removeGps: spec.removeGps,
      processor: spec.processor,
      processorVersion: spec.processorVersion,
    },
  };
}

type FailureCode = ProcessorErrorCode | 'read-failed' | 'internal';

type ItemOutcome = { kind: 'result'; result: StoredResult } | { kind: 'retry'; code: FailureCode };

async function measureItem(
  deps: MeasureDeps,
  item: MediaItem,
  run: ScanRun & { measure: MeasureSpec },
  scannedAt: string,
  attempts: number,
): Promise<ItemOutcome> {
  const outcome = await attempt(deps, item, run.measure);
  const base = baseResult(item, run.runId, scannedAt);
  switch (outcome.kind) {
    case 'processed':
      return { kind: 'result', result: processedResult(base, outcome, run.options, run.measure) };
    case 'skipped':
      return { kind: 'result', result: { ...base, status: 'skipped', reason: outcome.reason } };
    case 'error':
      if (outcome.retryable && attempts < MAX_ATTEMPTS) return { kind: 'retry', code: outcome.code };
      return { kind: 'result', result: { ...base, status: 'failed', failure: { code: outcome.code, attempts } } };
  }
}

/**
 * Advances a measured run within `limits`: retries due from earlier ticks first, then the sweep from
 * where the last tick stopped inside its page, then cleanup once the sweep is done and nothing waits
 * for a retry. Results are written together, then the state with one compare-and-set, as in the
 * estimating `advanceScan`; a tick that loses the race returns the state as read.
 */
export async function advanceMeasuredScan(
  deps: MeasureDeps,
  limits: Partial<MeasureLimits> = {},
): Promise<ScanRun | null> {
  const { items = MEASURED_ITEMS_PER_TICK, wallTimeMs = MEASURED_TICK_WALL_MS } = limits;
  const state = await deps.kv.getVersioned<ScanRun>(SCAN_STATE_KEY);
  if (!state || state.value.phase === 'complete' || !state.value.measure) return state?.value ?? null;

  const started = deps.clock();
  const scannedAt = deps.now().toISOString();
  let run = state.value as ScanRun & { measure: MeasureSpec };
  let budget = items;
  // A busy processor will not free up within this tick; leave the rest for the next one.
  let saturated = false;
  // The first image always starts, so a slow host still makes progress at one image per tick.
  const canStart = () => budget > 0 && !saturated && (budget === items || deps.clock() - started < wallTimeMs);
  const pending: Array<{ id: string; data: StoredResult }> = [];
  const retries: PendingRetry[] = [];

  const handle = async (item: MediaItem, attemptsBefore: number) => {
    budget -= 1;
    const attempts = attemptsBefore + 1;
    const outcome = await measureItem(deps, item, run, scannedAt, attempts);
    if (outcome.kind === 'result') {
      pending.push({ id: item.id, data: outcome.result });
      return;
    }
    if (outcome.code === 'busy') saturated = true;
    if (retries.length < MAX_PENDING_RETRIES) {
      retries.push({ id: item.id, attempts });
      return;
    }
    const failed: StoredResult = {
      ...baseResult(item, run.runId, scannedAt),
      status: 'failed',
      failure: { code: outcome.code, attempts },
    };
    pending.push({ id: item.id, data: failed });
  };

  const due = run.retries ?? [];
  for (let index = 0; index < due.length; index += 1) {
    if (!canStart()) {
      retries.push(...due.slice(index));
      break;
    }
    const entry = due[index]!;
    const item = await deps.media.get(entry.id);
    // Deleted since: nothing to record, and cleanup removes its earlier result.
    if (item) await handle(item, entry.attempts);
  }

  while (run.phase === 'sweep' && canStart()) {
    const listed = await deps.media.list({
      limit: PAGE_SIZE,
      mimeType: 'image/',
      ...(run.cursor ? { cursor: run.cursor } : {}),
    });
    // Resume after the last item handled; its position moves if media earlier in the page was deleted.
    const last = run.lastId ? listed.items.findIndex(({ id }) => id === run.lastId) : -1;
    let index = last >= 0 ? last + 1 : (run.offset ?? 0);
    let lastId = run.lastId ?? null;
    while (index < listed.items.length && canStart()) {
      const item = listed.items[index]!;
      await handle(item, 0);
      lastId = item.id;
      index += 1;
    }
    if (index < listed.items.length) {
      run = { ...run, offset: index, lastId };
      break;
    }
    const done = !listed.hasMore || !listed.cursor;
    run = { ...run, cursor: done ? null : listed.cursor!, offset: 0, lastId: null, phase: done ? 'cleanup' : 'sweep' };
  }

  run = {
    ...run,
    retries,
    totals: addSummaries(run.totals, summarizeStored(pending.map(({ data }) => data))),
  };
  // Written before cleanup, which removes every result older than this run.
  if (pending.length > 0) await deps.results.putMany(pending);

  for (let page = 0; run.phase === 'cleanup' && retries.length === 0 && page < CLEANUP_PAGES_PER_TICK; page += 1) {
    run = (await cleanupPage(deps, run)).run as ScanRun & { measure: MeasureSpec };
  }

  const next = { ...run, updatedAt: deps.now().toISOString() };
  const written = await deps.kv.compareAndSet(SCAN_STATE_KEY, state.revision, next);
  return written.applied ? next : state.value;
}

/** Processes one image with the current settings for display, and keeps nothing. */
export async function sampleImage(
  deps: Pick<MeasureDeps, 'media' | 'processor'>,
  mediaId: string,
  settings: { preset: PresetName; removeGps: boolean },
): Promise<SampleView> {
  const item = await deps.media.get(mediaId);
  if (!item) return { outcome: 'failed', mediaId, filename: null, ...settings, message: 'The image no longer exists.' };
  const outcome = await attempt(deps, item, settings);
  const common = { mediaId, filename: item.filename, ...settings };
  switch (outcome.kind) {
    case 'processed': {
      const { image } = outcome;
      return {
        outcome: 'processed',
        ...common,
        before: {
          bytes: outcome.inputBytes,
          width: image.input.width,
          height: image.input.height,
          format: image.input.format,
        },
        after: {
          bytes: image.output.byteLength,
          width: image.result.width,
          height: image.result.height,
          format: image.result.format,
        },
        encoder: image.encoder,
        elapsedMs: image.elapsedMs,
      };
    }
    case 'skipped':
      return { outcome: 'skipped', ...common, reason: outcome.reason };
    case 'error':
      return {
        outcome: 'failed',
        ...common,
        message:
          outcome.code === 'busy' ? 'The image processor is busy. Try again in a minute.' : `${outcome.message}.`,
      };
  }
}

export interface NativeScanOptions {
  /** The processor, or `null` when Sharp is not installed; called when first needed. */
  processor: () => ImageProcessor | null;
  clock?: () => number;
  limits?: Partial<MeasureLimits>;
}

/**
 * The native edition's additions to the shared handlers. A context without byte access, or a site
 * without Sharp, gets none of them: scans estimate from metadata as in the sandboxed edition.
 */
export function createNativeScan(options: NativeScanOptions): NativeScan {
  const clock = options.clock ?? (() => performance.now());

  function measureDeps(ctx: PluginContext, deps: ScanDeps): MeasureDeps | null {
    const readBytes = ctx.media?.readBytes;
    if (!readBytes) return null;
    const processor = options.processor();
    if (!processor) return null;
    return { ...deps, media: { ...deps.media, readBytes: readBytes.bind(ctx.media) }, processor, clock };
  }

  return {
    measureSpec(ctx, deps, settings) {
      const measuring = measureDeps(ctx, deps);
      if (!measuring) return null;
      const { preset, removeGps } = readMeasureSettings(settings);
      const capabilities = measuring.processor.capabilities();
      return { preset, removeGps, processor: capabilities.processor, processorVersion: capabilities.version };
    },
    async advance(ctx, deps) {
      const measuring = measureDeps(ctx, deps);
      return measuring ? advanceMeasuredScan(measuring, options.limits) : undefined;
    },
    report(ctx, deps, settings): NativeReportView | null {
      const measuring = measureDeps(ctx, deps);
      if (!measuring) return null;
      const processorVersion = measuring.processor.capabilities().version;
      try {
        const current = readMeasureSettings(settings);
        return { ...current, options: presetOptions(current.preset), processorVersion };
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return {
          preset: 'balanced',
          removeGps: false,
          options: presetOptions('balanced'),
          processorVersion,
          invalidSettings: error.message,
        };
      }
    },
    async sample(ctx, deps, settings, mediaId) {
      const measuring = measureDeps(ctx, deps);
      if (!measuring) return null;
      return sampleImage(measuring, mediaId, readMeasureSettings(settings));
    },
  };
}
