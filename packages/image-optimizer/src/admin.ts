/**
 * Block Kit for the report page and the dashboard widget. Rendering is pure: the caller loads the
 * scan state and a page of results, and these functions turn them into blocks.
 */
import type { Block, BlockResponse, StatItem } from '@emdash-cms/blocks/server';

import type { ScanRun, StoredResult } from './job.ts';
import type { FindingCode, SkipReason } from './scanner.ts';

export const REPORT_PAGE = '/report';
export const SAVINGS_WIDGET = 'savings';
export const RESULTS_PER_PAGE = 50;

export const ACTION_START = 'start_scan';
export const ACTION_REFRESH = 'refresh';
export const ACTION_RESULTS_PAGE = 'results_page';
/** Declared because tables require one; the skipped list shows a single page. */
export const ACTION_SKIPPED_PAGE = 'skipped_page';
export const SKIPPED_SHOWN = 50;

export type AdminRequest =
  | { kind: 'page'; page: string }
  | { kind: 'action'; actionId: string; page: string | null; cursor: string | null };

/** Narrows the host's interaction payload; anything unrecognized is `null`. */
export function parseAdminRequest(input: unknown): AdminRequest | null {
  if (typeof input !== 'object' || input === null) return null;
  const interaction = input as Record<string, unknown>;
  if (interaction.type === 'page_load' && typeof interaction.page === 'string') {
    return { kind: 'page', page: interaction.page };
  }
  if (interaction.type === 'block_action' && typeof interaction.action_id === 'string') {
    const value = interaction.value;
    const cursor =
      typeof value === 'object' && value !== null && typeof (value as { cursor?: unknown }).cursor === 'string'
        ? (value as { cursor: string }).cursor
        : null;
    return {
      kind: 'action',
      actionId: interaction.action_id,
      page: typeof interaction.page === 'string' ? interaction.page : null,
      cursor,
    };
  }
  return null;
}

export interface ResultsPage {
  items: Array<{ id: string; data: StoredResult }>;
  cursor: string | null;
}

export interface ReportView {
  run: ScanRun | null;
  results: ResultsPage;
  /** The first page of skipped images and how many are stored in total. */
  skipped: { items: ResultsPage['items']; total: number };
  /** Whether `results` continues from an earlier page. */
  continued: boolean;
  locale: string;
}

const SKIP_LABELS: Record<SkipReason, string> = {
  'not-an-image': 'not an image',
  'unsupported-format': 'unsupported format',
  'missing-size': 'missing size',
  'missing-dimensions': 'missing dimensions',
  'invalid-metadata': 'invalid metadata',
};

const SKIP_EXPLANATIONS: Record<SkipReason, string> = {
  'not-an-image': 'Not an image.',
  'unsupported-format': 'The scan has no estimate for this format (for example GIF, SVG or HEIC).',
  'missing-size': 'The media library has no file size for it.',
  'missing-dimensions': 'The media library has no width or height for it.',
  'invalid-metadata': 'Its recorded size or dimensions are not valid numbers.',
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

function savingCell(result: StoredResult, locale: string): string {
  if (result.estimateBasis === null) return 'Not estimated';
  const saving = formatBytes(result.estimateBytes, locale);
  return result.estimateBasis === 'resize' ? `${saving} (resize only)` : saving;
}

/**
 * Two blocks of two cards rather than one of four: on a phone the host shows about two cards per
 * row, and a fourth card was cut off. The saving comes first because it is what the page is for.
 */
function summaryStats(run: ScanRun, locale: string): [StatItem[], StatItem[]] {
  const { totals } = run;
  const skipped = Object.values(totals.skipped).reduce((sum, count) => sum + count, 0);
  const reasons = (Object.entries(totals.skipped) as [SkipReason, number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${formatCount(count, locale)} ${SKIP_LABELS[reason]}`);
  return [
    [
      {
        label: 'Estimated saving',
        value: formatBytes(totals.estimatedSavingsBytes, locale),
        description: 'From metadata only',
      },
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
        label: 'Skipped',
        value: formatCount(skipped, locale),
        ...(reasons.length > 0 ? { description: reasons.join(', ') } : {}),
      },
    ],
  ];
}

function resultsTable(view: ReportView): Block {
  const { run, results, locale } = view;
  return {
    type: 'table',
    block_id: 'results',
    // The saving and the reason come right after the file: on a phone the table scrolls sideways
    // and only the first columns are in view.
    columns: [
      { key: 'file', label: 'File' },
      { key: 'saving', label: 'Estimated saving' },
      { key: 'findings', label: 'Why' },
      { key: 'size', label: 'Size' },
      { key: 'dimensions', label: 'Dimensions' },
      { key: 'format', label: 'Format', format: 'badge' },
    ],
    rows: results.items.map(({ data }) => ({
      file: data.filename,
      format: data.format?.toUpperCase() ?? '',
      dimensions: data.width && data.height ? `${data.width} × ${data.height}` : '',
      size: data.size === null ? '' : formatBytes(data.size, locale),
      saving: savingCell(data, locale),
      findings: data.findings.map((code) => findingLabel(code, run)).join(', '),
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

export function reportPage(view: ReportView, toast?: BlockResponse['toast']): BlockResponse {
  const { run, locale } = view;
  const blocks: Block[] = [{ type: 'header', text: 'Image report' }];

  if (!run) {
    blocks.push({
      type: 'empty',
      title: 'No scan yet',
      description:
        'A scan checks every image in the media library for ones that could be smaller. It reads only type, size and dimensions, and never changes media.',
      actions: [{ type: 'button', action_id: ACTION_START, label: 'Start scan', style: 'primary' }],
    });
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
  blocks.push({
    type: 'context',
    text: [
      run.finishedAt ? `Last scan finished ${formatTime(run.finishedAt, locale)}.` : `Scan started ${formatTime(run.startedAt, locale)}.`,
      'Savings are estimates from file type, size and dimensions; the images themselves are not read. Nothing is changed.',
    ].join(' '),
  });
  blocks.push({
    type: 'actions',
    elements: [
      ...(running ? [] : [{ type: 'button' as const, action_id: ACTION_START, label: 'Scan again', style: 'primary' as const }]),
      { type: 'button', action_id: ACTION_REFRESH, label: 'Refresh' },
      // A link styled as a button: it navigates without a round trip through the plugin.
      { type: 'link', label: 'Settings', target: { kind: 'plugin-settings' }, appearance: 'secondary' },
    ],
  });

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: view.continued ? 'Images that could be smaller, continued.' : 'Images that could be smaller, largest estimated saving first.',
    ...(view.continued
      ? { accessory: { type: 'button' as const, action_id: ACTION_REFRESH, label: 'Back to top' } }
      : {}),
  });
  blocks.push(resultsTable(view));
  if (view.skipped.total > 0) blocks.push(skippedSection(view));

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
          { label: 'Estimated saving', value: formatBytes(run.totals.estimatedSavingsBytes, locale) },
          { label: 'Images to review', value: formatCount(run.totals.flagged, locale) },
        ],
      },
      ...(run.phase === 'complete' ? [] : [{ type: 'context' as const, text: 'Scan in progress.' }]),
      { type: 'actions', elements: [report] },
    ],
  };
}
