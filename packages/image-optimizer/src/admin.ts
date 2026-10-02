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
/** Native edition: process one image with the current settings and show the numbers. */
export const ACTION_SAMPLE = 'sample_image';
export const SKIPPED_SHOWN = 50;

export type AdminRequest =
  | { kind: 'page'; page: string }
  | { kind: 'action'; actionId: string; page: string | null; cursor: string | null; mediaId: string | null };

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
    return {
      kind: 'action',
      actionId: interaction.action_id,
      page: typeof interaction.page === 'string' ? interaction.page : null,
      cursor: field('cursor'),
      mediaId: field('mediaId'),
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
    ],
    rows: results.items.map(({ id, data }) => ({
      file: data.filename,
      format: data.format?.toUpperCase() ?? '',
      dimensions: data.width && data.height ? `${data.width} × ${data.height}` : '',
      size: data.size === null ? '' : formatBytes(data.size, locale),
      saving: savingCell(data, locale, labelled),
      findings: whyCell(data, run),
      ...(view.native ? { sample: sampleButton(id) } : {}),
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

export function reportPage(view: ReportView, toast?: BlockResponse['toast']): BlockResponse {
  const { run, locale } = view;
  const blocks: Block[] = [{ type: 'header', text: 'Image report' }];
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
