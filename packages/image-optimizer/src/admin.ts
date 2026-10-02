/**
 * Block Kit for the report page and the dashboard widget. Rendering is pure: the caller loads the
 * scan state and a page of results, and these functions turn them into blocks.
 */
import type { Block, BlockResponse, StatItem } from '@emdash-cms/blocks/server';

import { resultBasis, type ResultSkipReason, type ScanRun, type StoredResult } from './job.ts';
import type { EncoderInfo, ProcessorFormat } from './processor/contract.ts';
import type { PresetName, PresetOptions } from './processor/presets.ts';
import type { FindingCode } from './scanner.ts';

export const REPORT_PAGE = '/report';
export const SAVINGS_WIDGET = 'savings';
export const RESULTS_PER_PAGE = 50;

export const ACTION_START = 'start_scan';
export const ACTION_REFRESH = 'refresh';
export const ACTION_RESULTS_PAGE = 'results_page';
/** Declared because tables require one; the skipped list shows a single page. */
export const ACTION_SKIPPED_PAGE = 'skipped_page';
export const ACTION_FAILED_PAGE = 'failed_page';
/** Declared because tables require one; the optimized list shows a single page. */
export const ACTION_OPTIMIZED_PAGE = 'optimized_page';
/** Native edition: process one image with the current settings and show the numbers. */
export const ACTION_SAMPLE = 'sample_image';
/** Native edition, on a host that allows it: replace one image with its optimized output. */
export const ACTION_APPLY = 'apply_image';
/** Native edition, on a host that allows it: put back the original of one optimized image. */
export const ACTION_RESTORE = 'restore_image';
export const SKIPPED_SHOWN = 50;
/** Native edition: bulk run controls share this prefix. */
export const ACTION_BULK = 'bulk_';
export const ACTION_BULK_APPLY_ALL = 'bulk_apply_all';
export const ACTION_BULK_APPLY_PAGE = 'bulk_apply_page';
export const ACTION_BULK_RESTORE_ALL = 'bulk_restore_all';
export const ACTION_BULK_PAUSE = 'bulk_pause';
export const ACTION_BULK_RESUME = 'bulk_resume';
export const ACTION_BULK_CANCEL = 'bulk_cancel';
export const ACTION_BULK_RETRY = 'bulk_retry';
export const ACTION_BULK_RECONCILE = 'bulk_reconcile';
/** Declared because tables require one; the list shows a single page. */
export const ACTION_BULK_ATTENTION_PAGE = 'bulk_attention_page';

export type AdminRequest =
  | { kind: 'page'; page: string }
  | {
      kind: 'action';
      actionId: string;
      page: string | null;
      cursor: string | null;
      mediaId: string | null;
      /** Bulk actions on a selection: the media IDs, as strings only. */
      mediaIds: string[] | null;
    };

/** Narrows the host's interaction payload; anything unrecognized is `null`. */
export function parseAdminRequest(input: unknown): AdminRequest | null {
  if (typeof input !== 'object' || input === null) return null;
  const interaction = input as Record<string, unknown>;
  if (interaction.type === 'page_load' && typeof interaction.page === 'string') {
    return { kind: 'page', page: interaction.page };
  }
  if (interaction.type === 'block_action' && typeof interaction.action_id === 'string') {
    const value = interaction.value;
    const field = (name: string) => {
      const found = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined;
      return typeof found === 'string' ? found : null;
    };
    const ids = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).mediaIds : undefined;
    return {
      kind: 'action',
      actionId: interaction.action_id,
      page: typeof interaction.page === 'string' ? interaction.page : null,
      cursor: field('cursor'),
      mediaId: field('mediaId'),
      mediaIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : null,
    };
  }
  return null;
}

export interface ResultsPage {
  items: Array<{ id: string; data: StoredResult }>;
  cursor: string | null;
}

/** One image as the sample measured it. */
export interface SampleImage {
  bytes: number;
  width: number;
  height: number;
  format: ProcessorFormat;
}

/** The outcome of processing one image for the sample. Nothing of it is stored. */
export type SampleView = { mediaId: string; filename: string | null; preset: PresetName; removeGps: boolean } & (
  | { outcome: 'processed'; before: SampleImage; after: SampleImage; encoder: EncoderInfo; elapsedMs: number }
  | { outcome: 'skipped'; reason: ResultSkipReason }
  | { outcome: 'failed'; message: string }
);

/** What the native edition adds to the report when it can measure. */
export interface NativeReportView {
  preset: PresetName;
  removeGps: boolean;
  /** The Sharp options the preset uses, by input type. */
  options: PresetOptions;
  processorVersion: string;
  /** Set when the settings cannot be used; the values above are then the defaults. */
  invalidSettings?: string;
  sample?: SampleView;
}

/** What the native edition recorded about an image it optimized. The host holds the original. */
export interface AppliedRecord {
  mediaId: string;
  filename: string;
  /** `superseded`: the image was changed by someone else after the optimization. */
  state: 'optimized' | 'restored' | 'superseded';
  operationId: string;
  sourceRevisionId: string;
  /** The revision the last operation published. */
  revisionId: string;
  /** SHA-256 of the original the host retained. */
  originalSha256: string | null;
  inputBytes: number;
  outputBytes: number;
  preset: string;
  removeGps: boolean;
  policyKey: string;
  appliedAt: string;
  restoredAt?: string;
  /**
   * Files the host retains because of this plugin's operations on the image, by SHA-256: the
   * original an apply replaced, and the optimized file a restore or re-optimization replaced. Absent
   * in older records.
   */
  retained?: Record<string, number>;
}

/** The storage effect of this plugin's changes. Gross reduction is not a storage saving. */
export interface StorageAccounting {
  /** Images optimized by this plugin now. */
  optimized: number;
  /** How much smaller the active files of those images are than the files they replaced. */
  grossReductionBytes: number;
  /** Files the host keeps because of this plugin's operations, so they can be restored. */
  retainedOriginalBytes: number;
  /** Retained bytes minus the gross reduction: positive is more storage used than before. */
  netStorageChangeBytes: number;
}

/** Bulk item states, as `bulk.ts` defines them. */
export type BulkItemState =
  | 'queued'
  | 'processing'
  | 'ready_to_commit'
  | 'committing'
  | 'retry_wait'
  | 'optimized'
  | 'restored'
  | 'skipped'
  | 'conflict'
  | 'failed';
export type BulkCounts = Record<BulkItemState, number>;

export interface BulkItemView {
  mediaId: string;
  filename: string;
  state: BulkItemState;
  code: string | null;
  message: string | null;
}

/** The active or most recent bulk run, and upload automation. */
export interface BulkView {
  run: {
    runId: string;
    kind: 'apply' | 'restore';
    status: 'running' | 'paused' | 'cancelling' | 'complete' | 'cancelled';
    prepared: boolean;
    createdAt: string;
    finishedAt: string | null;
    counts: BulkCounts;
    /** Gross: what this run's optimized files shrank by. */
    grossReductionBytes: number;
    /** Failed and conflicting items, first ones. */
    attention: BulkItemView[];
  } | null;
  automation: { enabled: boolean; counts: BulkCounts | null };
  scanRunning: boolean;
}

/** Whether apply and restore are allowed on this host, and why not. */
export interface MutationsView {
  apply: boolean;
  restore: boolean;
  reason: string;
  message: string;
  /** Images this plugin optimized and has not restored, newest first. */
  optimized: AppliedRecord[];
  /** Over every image this plugin changed. */
  accounting: StorageAccounting;
}

type ActionBase = {
  action: 'apply' | 'restore';
  mediaId: string;
  filename: string | null;
  /**
   * Apply only: the image was already optimized under other settings, so the retained original was
   * read privately and processed instead of the active bytes. The original is never made active.
   */
  reoptimized?: boolean;
};

/** The outcome of one apply or restore. */
export type ActionOutcome = ActionBase &
  (
    | { outcome: 'optimized'; replayed: boolean; inputBytes: number; outputBytes: number; revisionId: string }
    | { outcome: 'restored'; replayed: boolean; sha256: string; bytes: number; revisionId: string }
    | { outcome: 'unavailable'; reason: string; message: string }
    | { outcome: 'skipped'; reason: string; message: string; inputBytes?: number; outputBytes?: number }
    | { outcome: 'conflict' | 'nothing-to-restore' | 'uncertain' | 'deferred'; message: string }
    | { outcome: 'no-original'; message: string; retryable?: boolean }
    | { outcome: 'failed'; code: string; message: string; retryable?: boolean }
  );

export interface ReportView {
  run: ScanRun | null;
  results: ResultsPage;
  /** The first page of skipped images and how many are stored in total. */
  skipped: { items: ResultsPage['items']; total: number };
  /** The first page of images whose processing failed, and whether there are more. */
  failed?: { items: ResultsPage['items']; more: boolean };
  /** Whether `results` continues from an earlier page. */
  continued: boolean;
  locale: string;
  /** Native edition only, and only when it can measure. */
  native?: NativeReportView | null;
  /** Native edition only: apply and restore, allowed or not. */
  mutations?: MutationsView;
  /** Native edition only: the outcome of the apply or restore just requested. */
  action?: ActionOutcome;
  /** Native edition only, when the host allows apply or restore: bulk runs and automation. */
  bulk?: BulkView;
}

const SKIP_LABELS: Record<ResultSkipReason, string> = {
  'not-an-image': 'not an image',
  'unsupported-format': 'unsupported format',
  'missing-size': 'missing size',
  'missing-dimensions': 'missing dimensions',
  'invalid-metadata': 'invalid metadata',
  malformed: 'malformed',
  animated: 'animated',
  'over-byte-limit': 'too large to read',
  'over-pixel-limit': 'too many pixels',
  'unhandled-colour-profile': 'colour profile',
  'unhandled-bit-depth': 'bit depth',
  'unhandled-metadata': 'metadata',
};

const SKIP_EXPLANATIONS: Record<ResultSkipReason, string> = {
  'not-an-image': 'Not an image.',
  'unsupported-format': 'The scan has no estimate for this format (for example GIF, SVG or HEIC).',
  'missing-size': 'The media library has no file size for it.',
  'missing-dimensions': 'The media library has no width or height for it.',
  'invalid-metadata': 'Its recorded size or dimensions are not valid numbers.',
  malformed: 'Its bytes do not decode as the image they claim to be.',
  animated: 'It is animated; re-encoding would keep only the first frame.',
  'over-byte-limit': 'The file is larger than the processor or the host lets the plugin read.',
  'over-pixel-limit': 'It has more pixels than the processor accepts.',
  'unhandled-colour-profile': 'Its colour space or profile cannot be kept exactly (for example CMYK).',
  'unhandled-bit-depth': 'It has more than 8 bits per sample, which re-encoding would reduce.',
  'unhandled-metadata': 'It has metadata the GPS removal setting cannot be applied to.',
};

const FAILURE_EXPLANATIONS: Record<string, string> = {
  busy: 'The processor stayed busy.',
  timeout: 'Processing took longer than the time limit.',
  crashed: 'The processor stopped without a result.',
  aborted: 'Processing was interrupted.',
  unavailable: 'The processor could not start.',
  'encode-failed': 'The encoder failed on it.',
  'invalid-output': 'The output failed the processor’s checks, so it was discarded.',
  'metadata-policy-failed': 'GPS removal could not be verified on the output.',
  'read-failed': 'Its bytes could not be read.',
  internal: 'The processor failed unexpectedly.',
};

const PRESET_DESCRIPTIONS: Record<PresetName, string> = {
  balanced: 'JPEG and WebP re-encoded lossily at quality 80; PNG and lossless WebP recompressed losslessly',
  'high-fidelity':
    'JPEG and WebP re-encoded lossily at quality 90 without chroma subsampling; PNG and lossless WebP recompressed losslessly',
};

/**
 * The host attests the admin locale, but `Intl` throws on a tag it cannot use, which would break the
 * whole page; fall back to English instead.
 */
export function resolveLocale(locale: string | undefined): string {
  try {
    return locale && Intl.NumberFormat.supportedLocalesOf(locale).length > 0 ? locale : 'en';
  } catch {
    return 'en';
  }
}

export function formatBytes(bytes: number, locale: string): string {
  const units = [
    ['gigabyte', 1e9],
    ['megabyte', 1e6],
    ['kilobyte', 1e3],
  ] as const;
  for (const [unit, size] of units) {
    if (bytes >= size) {
      return new Intl.NumberFormat(locale, { style: 'unit', unit, maximumFractionDigits: 1 }).format(bytes / size);
    }
  }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte' }).format(bytes);
}

function formatCount(count: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(count);
}

function formatTime(iso: string, locale: string): string {
  const formatted = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(iso));
  return `${formatted} UTC`;
}

function findingLabel(code: FindingCode, run: ScanRun | null): string {
  switch (code) {
    case 'oversized-dimensions':
      return run ? `Larger than ${run.options.maxDimension} px` : 'Oversized';
    case 'heavy-encoding':
      return 'Heavy encoding';
    case 'possible-photo-as-png':
      return 'PNG may be a photo';
    case 'uncompressed-format':
      return 'Uncompressed format';
  }
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** `labelled`: the run measures or the page has measured results, so each cell says which it is. */
function savingCell(result: StoredResult, locale: string, labelled: boolean): string {
  if (resultBasis(result) === 'measured') {
    const inputBytes = result.measured?.inputBytes ?? result.size ?? 0;
    return `${formatBytes(result.estimateBytes, locale)} measured (${percent(result.estimateBytes, inputBytes)}%)`;
  }
  if (result.estimateBasis === null) return 'Not estimated';
  const saving = formatBytes(result.estimateBytes, locale);
  const text = result.estimateBasis === 'resize' ? `${saving} (resize only)` : saving;
  return labelled ? `${text}, estimated` : text;
}

function whyCell(result: StoredResult, run: ScanRun | null): string {
  if (resultBasis(result) === 'measured' && result.measured) {
    return `Smaller re-encoded with the ${result.measured.preset} preset`;
  }
  return result.findings.map((code) => findingLabel(code, run)).join(', ');
}

/** Whether savings on this page need a measured or estimated label. */
function labelSavings(view: ReportView): boolean {
  return Boolean(view.run?.measure) || view.results.items.some(({ data }) => resultBasis(data) === 'measured');
}

/**
 * Two blocks of two cards rather than one of four: on a phone the host shows about two cards per
 * row, and a fourth card was cut off. The saving comes first because it is what the page is for.
 */
function savingStat(run: ScanRun, locale: string): StatItem {
  const { totals } = run;
  const measured = totals.measuredSavingsBytes ?? 0;
  if (run.measure) {
    return {
      label: 'Measured saving',
      value: formatBytes(measured, locale),
      description:
        totals.estimatedSavingsBytes > 0
          ? `Plus ${formatBytes(totals.estimatedSavingsBytes, locale)} estimated for images not measured`
          : `Re-encoded with the ${run.measure.preset} preset`,
    };
  }
  return {
    label: 'Estimated saving',
    value: formatBytes(totals.estimatedSavingsBytes, locale),
    description: measured > 0 ? `From metadata, plus ${formatBytes(measured, locale)} measured` : 'From metadata only',
  };
}

function summaryStats(run: ScanRun, locale: string): [StatItem[], StatItem[]] {
  const { totals } = run;
  const failed = totals.failed ?? 0;
  const skipped = Object.values(totals.skipped).reduce((sum, count) => sum + (count ?? 0), 0);
  const reasons = (Object.entries(totals.skipped) as [ResultSkipReason, number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${formatCount(count, locale)} ${SKIP_LABELS[reason]}`);
  if (failed > 0) reasons.push(`${formatCount(failed, locale)} failed`);
  return [
    [
      savingStat(run, locale),
      {
        label: 'Could be smaller',
        value: formatCount(totals.flagged, locale),
        ...(totals.unestimated > 0
          ? { description: `${formatCount(totals.unestimated, locale)} without a saving estimate` }
          : {}),
      },
    ],
    [
      { label: 'Images scanned', value: formatCount(totals.scanned, locale) },
      {
        label: failed > 0 ? 'Skipped or failed' : 'Skipped',
        value: formatCount(skipped + failed, locale),
        ...(reasons.length > 0 ? { description: reasons.join(', ') } : {}),
      },
    ],
  ];
}

function sampleButton(mediaId: string, label = 'Sample') {
  return { type: 'button' as const, action_id: ACTION_SAMPLE, label, value: { mediaId } };
}

function applyButton(mediaId: string, filename: string) {
  return {
    type: 'button' as const,
    action_id: ACTION_APPLY,
    label: 'Apply',
    value: { mediaId },
    confirm: {
      title: `Optimize ${filename}?`,
      text: 'The image is re-encoded with the current settings and its file is replaced in place, only if the saving reaches the thresholds and the image has not changed meanwhile. The host keeps the original, and Restore puts it back byte for byte. ID, address, alt text, caption and focal point stay as they are.',
      confirm: 'Apply',
      deny: 'Cancel',
    },
  };
}

function restoreButton(mediaId: string, filename: string) {
  return {
    type: 'button' as const,
    action_id: ACTION_RESTORE,
    label: 'Restore',
    value: { mediaId },
    confirm: {
      title: `Restore the original of ${filename}?`,
      text: 'The original the host kept is put back byte for byte, unless the image was changed since it was optimized.',
      confirm: 'Restore',
      deny: 'Cancel',
      style: 'danger' as const,
    },
  };
}

/** Restore for an image this plugin optimized, Apply for the others. */
function changeButton(mutations: MutationsView, mediaId: string, filename: string) {
  const optimized = mutations.optimized.some((entry) => entry.mediaId === mediaId);
  return optimized && mutations.restore ? restoreButton(mediaId, filename) : applyButton(mediaId, filename);
}

function resultsTable(view: ReportView): Block {
  const { run, results, locale } = view;
  const labelled = labelSavings(view);
  return {
    type: 'table',
    block_id: 'results',
    // The saving and the reason come right after the file: on a phone the table scrolls sideways
    // and only the first columns are in view.
    columns: [
      { key: 'file', label: 'File' },
      { key: 'saving', label: labelled ? 'Saving' : 'Estimated saving' },
      { key: 'findings', label: 'Why' },
      { key: 'size', label: 'Size' },
      { key: 'dimensions', label: 'Dimensions' },
      { key: 'format', label: 'Format', format: 'badge' },
      ...(view.native ? [{ key: 'sample', label: 'Sample', format: 'element' as const }] : []),
      ...(view.mutations?.apply ? [{ key: 'change', label: 'Optimize', format: 'element' as const }] : []),
    ],
    rows: results.items.map(({ id, data }) => ({
      file: data.filename,
      format: data.format?.toUpperCase() ?? '',
      dimensions: data.width && data.height ? `${data.width} × ${data.height}` : '',
      size: data.size === null ? '' : formatBytes(data.size, locale),
      saving: savingCell(data, locale, labelled),
      findings: whyCell(data, run),
      ...(view.native ? { sample: sampleButton(id) } : {}),
      ...(view.mutations?.apply ? { change: changeButton(view.mutations, id, data.filename) } : {}),
    })),
    page_action_id: ACTION_RESULTS_PAGE,
    empty_text: run ? 'No images need attention.' : 'Run a scan to see results.',
    ...(results.cursor ? { next_cursor: results.cursor } : {}),
  };
}

function skippedSection(view: ReportView): Block {
  const { skipped, locale } = view;
  const shown = skipped.items.length;
  return {
    type: 'accordion',
    label: `Skipped images (${formatCount(skipped.total, locale)})`,
    default_open: false,
    blocks: [
      {
        type: 'context',
        text:
          shown < skipped.total
            ? `These images were not assessed. Showing ${formatCount(shown, locale)} of ${formatCount(skipped.total, locale)}.`
            : 'These images were not assessed.',
      },
      {
        type: 'table',
        block_id: 'skipped',
        columns: [
          { key: 'file', label: 'File' },
          { key: 'type', label: 'Type', format: 'code' },
          { key: 'reason', label: 'Why it was skipped' },
        ],
        rows: skipped.items.map(({ data }) => ({
          file: data.filename,
          type: data.mimeType,
          reason: data.reason ? SKIP_EXPLANATIONS[data.reason] : '',
        })),
        page_action_id: ACTION_SKIPPED_PAGE,
      },
    ],
  };
}

function failedSection(failed: NonNullable<ReportView['failed']>): Block {
  return {
    type: 'accordion',
    label: 'Images that could not be processed',
    default_open: false,
    blocks: [
      {
        type: 'context',
        text: failed.more
          ? `These images were not assessed; the next scan tries them again. Showing the first ${failed.items.length}.`
          : 'These images were not assessed; the next scan tries them again.',
      },
      {
        type: 'table',
        block_id: 'failed',
        columns: [
          { key: 'file', label: 'File' },
          { key: 'reason', label: 'What happened' },
          { key: 'attempts', label: 'Attempts', format: 'number' },
        ],
        rows: failed.items.map(({ data }) => ({
          file: data.filename,
          reason: data.failure ? (FAILURE_EXPLANATIONS[data.failure.code] ?? data.failure.code) : '',
          attempts: data.failure?.attempts ?? 0,
        })),
        page_action_id: ACTION_FAILED_PAGE,
      },
    ],
  };
}

function describeImage(image: SampleImage, locale: string): string {
  return `${formatBytes(image.bytes, locale)}, ${image.width} × ${image.height} ${image.format.toUpperCase()}`;
}

/** The sample's numbers. Images are not shown: see the context line. */
function sampleBlocks(sample: SampleView, locale: string): Block[] {
  const name = sample.filename ?? 'The image';
  const unchanged = 'The media library is unchanged.';
  if (sample.outcome === 'failed') {
    return [
      { type: 'banner', variant: 'error', title: `Sample of ${name} failed`, description: `${sample.message} ${unchanged}` },
    ];
  }
  if (sample.outcome === 'skipped') {
    return [
      { type: 'banner', title: `Sample of ${name}: skipped`, description: `${SKIP_EXPLANATIONS[sample.reason]} ${unchanged}` },
    ];
  }
  const saving = sample.before.bytes - sample.after.bytes;
  return [
    { type: 'section', text: `Sample: ${name}, re-encoded with the ${sample.preset} preset.` },
    {
      type: 'fields',
      block_id: 'sample',
      fields: [
        { label: 'Before', value: describeImage(sample.before, locale) },
        { label: 'After', value: describeImage(sample.after, locale) },
        {
          label: saving >= 0 ? 'Saving' : 'Larger by',
          value: `${formatBytes(Math.abs(saving), locale)} (${percent(Math.abs(saving), sample.before.bytes)}%)`,
        },
        { label: 'GPS position', value: sample.removeGps ? 'Removed' : 'Kept' },
        { label: 'Time', value: `${formatCount(sample.elapsedMs, locale)} ms` },
        { label: 'Encoder', value: `Sharp ${sample.encoder.sharp}, libvips ${sample.encoder.vips}` },
      ],
    },
    { type: 'code', language: 'jsonc', code: JSON.stringify(sample.encoder.options, null, 2) },
    {
      type: 'context',
      text: `The output was measured in memory and discarded. ${unchanged} Only numbers are shown: Block Kit shows images by URL, and the processed image is never stored, so it has none.`,
    },
  ];
}

function nativeSettingsBlocks(native: NativeReportView): Block[] {
  const intro = native.invalidSettings
    ? `The settings cannot be used (${native.invalidSettings}); showing the defaults. `
    : '';
  return [
    {
      type: 'section',
      text: `${intro}Scans measure savings by re-encoding each image locally with the ${native.preset} preset: ${PRESET_DESCRIPTIONS[native.preset]}. GPS position is ${native.removeGps ? 'removed' : 'kept'}; other metadata is kept.`,
    },
    {
      type: 'accordion',
      label: `Encoder options for ${native.preset}`,
      default_open: false,
      blocks: [
        { type: 'code', language: 'jsonc', code: JSON.stringify(native.options, null, 2) },
        { type: 'context', text: `Sharp output options by input type. Processor ${native.processorVersion}.` },
      ],
    },
  ];
}

function contextText(run: ScanRun, locale: string): string {
  const when = run.finishedAt
    ? `Last scan finished ${formatTime(run.finishedAt, locale)}.`
    : `Scan started ${formatTime(run.startedAt, locale)}.`;
  if (!run.measure) {
    return `${when} Savings are estimates from file type, size and dimensions; the images themselves are not read. Nothing is changed.`;
  }
  const { preset, removeGps } = run.measure;
  const parts = [
    when,
    `Savings are measured: each image was re-encoded locally with the ${preset} preset (GPS ${removeGps ? 'removed' : 'kept'}) and the output discarded. Nothing is changed.`,
  ];
  if (run.totals.estimatedSavingsBytes > 0 || run.totals.unestimated > 0) {
    parts.push('Images uploaded since the scan started are estimated from metadata until the next scan.');
  }
  return parts.join(' ');
}

function savingText(before: number, after: number, locale: string): string {
  const saving = before - after;
  return `${formatBytes(before, locale)} to ${formatBytes(after, locale)}, ${formatBytes(saving, locale)} (${percent(saving, before)}%) smaller`;
}

const ACTION_TITLES: Record<ActionOutcome['outcome'], string> = {
  optimized: 'optimized',
  restored: 'restored',
  unavailable: 'not changed: apply and restore are not available',
  skipped: 'not changed',
  conflict: 'not changed: it changed meanwhile',
  'nothing-to-restore': 'nothing to restore',
  uncertain: 'outcome not confirmed',
  deferred: 'not changed: held back',
  'no-original': 'no original to restore',
  failed: 'not changed',
};

/** The outcome of an apply or restore just requested. */
function actionBlocks(action: ActionOutcome, locale: string): Block[] {
  const name = action.filename ?? 'The image';
  const title = `${name}: ${ACTION_TITLES[action.outcome]}`;
  const reoptimized = action.reoptimized ? ' The new settings started from the retained original, which was read privately and never made active.' : '';
  switch (action.outcome) {
    case 'optimized':
      return [
        {
          type: 'banner',
          title,
          description: `${savingText(action.inputBytes, action.outputBytes, locale)}. The host keeps the original; Restore puts it back byte for byte.${reoptimized}${action.replayed ? ' The host had already made this change, so it returned its earlier receipt and changed nothing again.' : ''}`,
        },
      ];
    case 'restored':
      return [
        {
          type: 'banner',
          title,
          description: `The original is active again, byte for byte: ${formatBytes(action.bytes, locale)}, SHA-256 ${action.sha256.slice(0, 16)}….${action.replayed ? ' The host had already restored it and returned its earlier receipt.' : ''}`,
        },
      ];
    case 'skipped': {
      const numbers =
        action.inputBytes !== undefined && action.outputBytes !== undefined
          ? ` Measured: ${formatBytes(action.inputBytes, locale)} to ${formatBytes(action.outputBytes, locale)}.`
          : '';
      return [{ type: 'banner', title, description: `${action.message}${numbers}` }];
    }
    case 'conflict':
    case 'uncertain':
    case 'deferred':
    case 'unavailable':
    case 'nothing-to-restore':
    case 'no-original':
      return [{ type: 'banner', variant: 'alert', title, description: action.message }];
    case 'failed':
      return [{ type: 'banner', variant: 'error', title, description: `${action.message} (${action.code})` }];
  }
}

function signedBytes(bytes: number, locale: string): string {
  if (bytes === 0) return formatBytes(0, locale);
  return `${bytes > 0 ? '+' : '−'}${formatBytes(Math.abs(bytes), locale)}`;
}

/**
 * The storage effect, three numbers kept apart: the gross reduction of the active files, the
 * originals the host retains, and the net change. The gross reduction is never called a saving of
 * storage: while originals are retained, optimizing uses more storage, not less.
 */
export function accountingBlocks(accounting: StorageAccounting, locale: string): Block[] {
  const net = accounting.netStorageChangeBytes;
  return [
    {
      type: 'stats',
      block_id: 'storage',
      items: [
        {
          label: 'Source reduction (gross)',
          value: formatBytes(accounting.grossReductionBytes, locale),
          description: `How much smaller the ${formatCount(accounting.optimized, locale)} optimized files are`,
        },
        {
          label: 'Originals retained',
          value: formatBytes(accounting.retainedOriginalBytes, locale),
          description: 'Kept by the host so they can be restored',
        },
      ],
    },
    {
      type: 'stats',
      block_id: 'net-storage',
      items: [
        {
          label: 'Net storage change',
          value: signedBytes(net, locale),
          description:
            net > 0 ? 'More storage than before: the retained originals outweigh the reduction' : 'Less storage than before',
          trend: net > 0 ? 'up' : net < 0 ? 'down' : 'neutral',
        },
      ],
    },
    {
      type: 'context',
      text: 'The source reduction makes pages lighter to deliver. It is not a storage saving: the host keeps every original this plugin replaced, and every optimized file a restore or re-optimization replaced, until they are pruned.',
    },
  ];
}

const BULK_STATE_LABELS: Record<BulkItemState, string> = {
  queued: 'waiting',
  processing: 'processing',
  ready_to_commit: 'ready to submit',
  committing: 'submitting',
  retry_wait: 'waiting to retry',
  optimized: 'optimized',
  restored: 'restored',
  skipped: 'skipped',
  conflict: 'conflicts',
  failed: 'failed',
};

/** "12 optimized, 3 skipped, 1 failed", leaving out states with none. */
function countsText(counts: BulkCounts, locale: string): string {
  const parts = (Object.entries(counts) as Array<[BulkItemState, number]>)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${formatCount(count, locale)} ${BULK_STATE_LABELS[state]}`);
  return parts.length > 0 ? parts.join(', ') : 'no images';
}

const BULK_ITEM_EXPLANATIONS: Record<string, string> = {
  conflict: 'The image changed while the run worked on it; the newer image was left as it is.',
  'nothing-to-restore': 'The active image is no longer this plugin’s optimization, so it was left as it is.',
  'missing-original': 'The host has no intact original for it, so nothing was restored.',
  'attempts-exhausted': 'Gave up after repeated attempts.',
};

function cancelButton() {
  return {
    type: 'button' as const,
    action_id: ACTION_BULK_CANCEL,
    label: 'Cancel run',
    style: 'danger' as const,
    confirm: {
      title: 'Cancel the run?',
      text: 'Images not yet submitted are skipped. Images already optimized stay optimized; restore them separately if needed.',
      confirm: 'Cancel run',
      deny: 'Keep running',
      style: 'danger' as const,
    },
  };
}

/** Controls for starting runs, shown when no run is active. */
function startButtons(view: ReportView, bulk: BulkView, mutations: MutationsView, locale: string) {
  const elements: Extract<Block, { type: 'actions' }>['elements'] = [];
  if (bulk.scanRunning) return elements;
  if (mutations.apply) {
    elements.push({
      type: 'button' as const,
      action_id: ACTION_BULK_APPLY_ALL,
      label: 'Optimize all measured images',
      style: 'primary' as const,
      confirm: {
        title: 'Optimize every image the scan measured as worth it?',
        text: 'Each image is re-encoded with the current settings and replaced in place, in the background, only when the saving still reaches the thresholds and the image has not changed meanwhile. The host keeps every original, so storage use grows; Restore puts originals back.',
        confirm: 'Start',
        deny: 'Cancel',
      },
    });
    const pageIds = view.results.items
      .filter(({ data }) => resultBasis(data) === 'measured' && !data.optimized)
      .map(({ id }) => id);
    if (pageIds.length > 0) {
      elements.push({
        type: 'button' as const,
        action_id: ACTION_BULK_APPLY_PAGE,
        label: `Optimize the ${formatCount(pageIds.length, locale)} listed`,
        value: { mediaIds: pageIds },
      });
    }
  }
  if (mutations.restore && mutations.accounting.optimized > 0) {
    elements.push({
      type: 'button' as const,
      action_id: ACTION_BULK_RESTORE_ALL,
      label: 'Restore all originals',
      style: 'danger' as const,
      confirm: {
        title: 'Restore the original of every image this plugin optimized?',
        text: 'Each original is put back byte for byte, unless the image was changed since it was optimized.',
        confirm: 'Restore all',
        deny: 'Cancel',
        style: 'danger' as const,
      },
    });
  }
  const failed = bulk.run?.counts.failed ?? 0;
  if (failed > 0) {
    elements.push({ type: 'button' as const, action_id: ACTION_BULK_RETRY, label: `Retry ${formatCount(failed, locale)} failed` });
  }
  return elements;
}

/** Bulk runs: the active or last run with its controls, and upload automation. */
function bulkBlocks(view: ReportView, bulk: BulkView, mutations: MutationsView, locale: string): Block[] {
  const blocks: Block[] = [{ type: 'divider' }, { type: 'section', text: 'Bulk optimization' }];
  const run = bulk.run;
  if (run && (run.status === 'running' || run.status === 'paused' || run.status === 'cancelling')) {
    const total = Object.values(run.counts).reduce((sum, count) => sum + count, 0);
    const what = run.kind === 'apply' ? 'Optimization run' : 'Restore run';
    const status = run.status === 'cancelling' ? 'being cancelled' : run.status === 'paused' ? 'paused' : 'in progress';
    blocks.push({
      type: 'banner',
      title: `${what} ${status}`,
      description: `${run.prepared ? `${formatCount(total, locale)} images: ${countsText(run.counts, locale)}.` : 'Selecting images.'} It continues in the background, one image at a time, about once a minute; refresh to see progress. An image already being submitted finishes even when the run is paused or cancelled.`,
    });
    blocks.push({
      type: 'actions',
      elements: [
        ...(run.status === 'running' ? [{ type: 'button' as const, action_id: ACTION_BULK_PAUSE, label: 'Pause' }] : []),
        ...(run.status === 'paused'
          ? [{ type: 'button' as const, action_id: ACTION_BULK_RESUME, label: 'Resume', style: 'primary' as const }]
          : []),
        ...(run.status !== 'cancelling' ? [cancelButton()] : []),
        { type: 'button', action_id: ACTION_REFRESH, label: 'Refresh' },
      ],
    });
  } else {
    if (run) {
      const ended = formatTime(run.finishedAt ?? run.createdAt, locale);
      const reduction =
        run.kind === 'apply'
          ? ` Its files are ${formatBytes(run.grossReductionBytes, locale)} smaller in all (gross, not a storage saving).`
          : '';
      blocks.push({
        type: 'context',
        text: `Last ${run.kind === 'apply' ? 'optimization' : 'restore'} run ${run.status === 'cancelled' ? 'cancelled' : 'finished'} ${ended}: ${countsText(run.counts, locale)}.${reduction}`,
      });
    }
    if (bulk.scanRunning) blocks.push({ type: 'context', text: 'Runs start once the scan has finished.' });
    const elements = startButtons(view, bulk, mutations, locale);
    if (elements.length > 0) blocks.push({ type: 'actions', elements });
  }

  if (run && run.attention.length > 0) {
    blocks.push({
      type: 'table',
      block_id: 'bulk-attention',
      columns: [
        { key: 'file', label: 'File' },
        { key: 'outcome', label: 'Outcome', format: 'badge' },
        { key: 'why', label: 'Why' },
      ],
      rows: run.attention.map((item) => ({
        file: item.filename,
        outcome: BULK_STATE_LABELS[item.state],
        why: (item.code ? BULK_ITEM_EXPLANATIONS[item.code] : undefined) ?? item.message ?? '',
      })),
      page_action_id: ACTION_BULK_ATTENTION_PAGE,
    });
  }

  if (bulk.automation.enabled) {
    const queue = bulk.automation.counts ? countsText(bulk.automation.counts, locale) : 'empty';
    blocks.push({
      type: 'context',
      text: `Upload automation is on: new uploads are queued and optimized in the background, never during the upload. Queue: ${queue}.`,
    });
    blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: ACTION_BULK_RECONCILE, label: 'Find missed uploads' }] });
  } else {
    blocks.push({
      type: 'context',
      text: 'Upload automation is off. Switch on “Optimize new uploads” in the settings to queue new uploads automatically.',
    });
  }
  return blocks;
}

/** Whether apply and restore are allowed, why not, and the images this plugin optimized. */
function mutationBlocks(mutations: MutationsView, locale: string): Block[] {
  const blocks: Block[] = [];
  if (!mutations.apply && !mutations.restore) {
    blocks.push({
      type: 'context',
      text: `Read-only: apply and restore are not available. ${mutations.message} Nothing is changed by this plugin.`,
    });
  } else {
    blocks.push({
      type: 'context',
      text: `${mutations.apply ? 'Apply replaces one image in place with its optimized output, only when the saving reaches both thresholds (and never less than 10 KiB and 5%) and the image has not changed since it was read.' : 'Applying is not available.'} The host keeps every original, and Restore puts it back byte for byte. ${mutations.message}`,
    });
  }
  if (mutations.accounting.retainedOriginalBytes > 0 || mutations.accounting.optimized > 0) {
    blocks.push(...accountingBlocks(mutations.accounting, locale));
  }
  if (mutations.optimized.length === 0) return blocks;
  blocks.push({
    type: 'accordion',
    label: `Optimized by this plugin (${formatCount(mutations.optimized.length, locale)})`,
    default_open: false,
    blocks: [
      {
        type: 'table',
        block_id: 'optimized',
        columns: [
          { key: 'file', label: 'File' },
          { key: 'saving', label: 'Saving' },
          { key: 'preset', label: 'Preset', format: 'badge' },
          ...(mutations.restore ? [{ key: 'restore', label: 'Original', format: 'element' as const }] : []),
        ],
        rows: mutations.optimized.map((entry) => ({
          file: entry.filename,
          saving: savingText(entry.inputBytes, entry.outputBytes, locale),
          preset: entry.preset,
          ...(mutations.restore ? { restore: restoreButton(entry.mediaId, entry.filename) } : {}),
        })),
        page_action_id: ACTION_OPTIMIZED_PAGE,
      },
    ],
  });
  return blocks;
}

export function reportPage(view: ReportView, toast?: BlockResponse['toast']): BlockResponse {
  const { run, locale } = view;
  const blocks: Block[] = [{ type: 'header', text: 'Image report' }];
  if (view.action) blocks.push(...actionBlocks(view.action, locale));
  if (view.native?.sample) blocks.push(...sampleBlocks(view.native.sample, locale));

  if (!run) {
    blocks.push({
      type: 'empty',
      title: 'No scan yet',
      description: view.native
        ? 'A scan checks every image in the media library for ones that could be smaller. It re-encodes each image locally to measure the saving, discards the output, and never changes media.'
        : 'A scan checks every image in the media library for ones that could be smaller. It reads only type, size and dimensions, and never changes media.',
      actions: [{ type: 'button', action_id: ACTION_START, label: 'Start scan', style: 'primary' }],
    });
    if (view.native) blocks.push(...nativeSettingsBlocks(view.native));
    if (view.mutations) blocks.push(...mutationBlocks(view.mutations, locale));
    if (view.mutations && view.bulk) blocks.push(...bulkBlocks(view, view.bulk, view.mutations, locale));
    return { blocks, ...(toast ? { toast } : {}) };
  }

  const running = run.phase !== 'complete';
  if (running) {
    blocks.push({
      type: 'banner',
      title: 'Scan in progress',
      description: `${formatCount(run.totals.scanned, locale)} images scanned so far. Last confirmed update ${formatTime(run.updatedAt, locale)}. The scan continues in the background about once a minute; refresh to see new progress. Results from the previous scan stay listed until it finishes.`,
    });
  }

  const [outcome, coverage] = summaryStats(run, locale);
  blocks.push({ type: 'stats', block_id: 'outcome', items: outcome });
  blocks.push({ type: 'stats', block_id: 'coverage', items: coverage });
  blocks.push({ type: 'context', text: contextText(run, locale) });
  const top = view.continued ? undefined : view.results.items[0];
  blocks.push({
    type: 'actions',
    elements: [
      ...(running ? [] : [{ type: 'button' as const, action_id: ACTION_START, label: 'Scan again', style: 'primary' as const }]),
      { type: 'button', action_id: ACTION_REFRESH, label: 'Refresh' },
      ...(view.native && top ? [sampleButton(top.id, 'Sample top result')] : []),
      // A link styled as a button: it navigates without a round trip through the plugin.
      { type: 'link', label: 'Settings', target: { kind: 'plugin-settings' }, appearance: 'secondary' },
    ],
  });
  if (view.native) blocks.push(...nativeSettingsBlocks(view.native));
  if (view.mutations) blocks.push(...mutationBlocks(view.mutations, locale));
  if (view.mutations && view.bulk) blocks.push(...bulkBlocks(view, view.bulk, view.mutations, locale));

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: view.continued
      ? 'Images that could be smaller, continued.'
      : `Images that could be smaller, largest ${labelSavings(view) ? '' : 'estimated '}saving first.`,
    ...(view.continued
      ? { accessory: { type: 'button' as const, action_id: ACTION_REFRESH, label: 'Back to top' } }
      : {}),
  });
  blocks.push(resultsTable(view));
  if (view.skipped.total > 0) blocks.push(skippedSection(view));
  if (view.failed && view.failed.items.length > 0) blocks.push(failedSection(view.failed));

  return { blocks, ...(toast ? { toast } : {}) };
}

export function savingsWidget(run: ScanRun | null, locale: string): BlockResponse {
  const report = { type: 'link' as const, label: 'Open report', target: { kind: 'plugin-page' as const, path: REPORT_PAGE } };
  if (!run) {
    return {
      blocks: [
        { type: 'context', text: 'No scan yet.' },
        { type: 'actions', elements: [report] },
      ],
    };
  }
  return {
    blocks: [
      {
        type: 'stats',
        items: [
          run.measure
            ? { label: 'Measured saving', value: formatBytes(run.totals.measuredSavingsBytes ?? 0, locale) }
            : { label: 'Estimated saving', value: formatBytes(run.totals.estimatedSavingsBytes, locale) },
          { label: 'Images to review', value: formatCount(run.totals.flagged, locale) },
        ],
      },
      ...(run.phase === 'complete' ? [] : [{ type: 'context' as const, text: 'Scan in progress.' }]),
      { type: 'actions', elements: [report] },
    ],
  };
}
