import { afterEach, describe, expect, it } from 'vitest';

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from '@emdash-cms/plugin-test';

import { formatBytes, resolveLocale } from '../src/admin.ts';
import { scanFromReport } from './runtime-helpers.ts';

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

const BYTES = new Uint8Array([0]);

type Blocks = Awaited<ReturnType<PluginRuntimeTestHost['admin']['loadPage']>>['blocks'];

function find<T extends Blocks[number]['type']>(blocks: Blocks, type: T, blockId?: string) {
  const all = blocks.flatMap((block) => (block.type === 'accordion' ? [block, ...block.blocks] : [block]));
  return all.find((block) => block.type === type && (blockId === undefined || block.block_id === blockId)) as
    | Extract<Blocks[number], { type: T }>
    | undefined;
}

async function heavyJpegs(runtime: PluginRuntimeTestHost, count: number) {
  for (let index = 0; index < count; index += 1) {
    await runtime.fixtures.media({
      filename: `photo-${index}.jpg`,
      mimeType: 'image/jpeg',
      bytes: BYTES,
      // Sizes differ so the order by estimated saving is observable.
      reportedSize: 600_000 + index * 1000,
      width: 1200,
      height: 800,
    });
  }
}

describe('report page', () => {
  it('offers to start a scan when none has run', async () => {
    host = await createPluginRuntimeTestHost();
    const page = await host.admin.loadPage('/report');

    expect(find(page.blocks, 'empty')).toMatchObject({
      title: 'No scan yet',
      actions: [{ type: 'button', action_id: 'start_scan', label: 'Start scan', style: 'primary' }],
    });
    expect(find(page.blocks, 'table')).toBeUndefined();
  });

  it('starts a scan and shows totals, flagged images and skipped images', async () => {
    host = await createPluginRuntimeTestHost();
    await heavyJpegs(host, 2);
    await host.fixtures.media({
      filename: 'photo.png',
      mimeType: 'image/png',
      bytes: BYTES,
      reportedSize: 2_000_000,
      width: 1000,
      height: 1000,
    });
    await host.fixtures.media({ filename: 'anim.gif', mimeType: 'image/gif', bytes: BYTES });

    const { started, page } = await scanFromReport(host);

    expect(started.toast).toEqual({
      type: 'success',
      message: 'Scan started. It runs in the background, about 300 images a minute.',
    });
    expect(find(started.blocks, 'banner')?.title).toBe('Scan in progress');
    expect(find(page.blocks, 'banner')).toBeUndefined();
    expect(find(page.blocks, 'stats', 'outcome')?.items).toEqual([
      { label: 'Estimated saving', value: '740.2 kB', description: 'From metadata only' },
      { label: 'Could be smaller', value: '3', description: '1 without a saving estimate' },
    ]);
    expect(find(page.blocks, 'stats', 'coverage')?.items).toEqual([
      { label: 'Images scanned', value: '4' },
      { label: 'Skipped', value: '1', description: '1 unsupported format' },
    ]);

    const table = find(page.blocks, 'table', 'results');
    // On a phone only the first columns are in view, so the saving and the reason come first.
    expect(table?.columns.map((column) => column.key)).toEqual(['file', 'saving', 'findings', 'size', 'dimensions', 'format']);
    expect(table?.rows).toEqual([
      {
        file: 'photo-1.jpg',
        format: 'JPEG',
        dimensions: '1200 × 800',
        size: '601 kB',
        saving: '370.6 kB',
        findings: 'Heavy encoding',
      },
      expect.objectContaining({ file: 'photo-0.jpg', saving: '369.6 kB' }),
      expect.objectContaining({ file: 'photo.png', saving: 'Not estimated', findings: 'PNG may be a photo' }),
    ]);
    expect(table?.next_cursor).toBeUndefined();

    const skipped = find(page.blocks, 'accordion');
    expect(skipped).toMatchObject({ label: 'Skipped images (1)', default_open: false });
    expect(find(page.blocks, 'table', 'skipped')?.rows).toEqual([
      {
        file: 'anim.gif',
        type: 'image/gif',
        reason: 'The scan has no estimate for this format (for example GIF, SVG or HEIC).',
      },
    ]);
  });

  it('pages through flagged images with the table cursor', async () => {
    host = await createPluginRuntimeTestHost();
    await heavyJpegs(host, 51);
    const { page: first } = await scanFromReport(host);
    const firstTable = find(first.blocks, 'table', 'results')!;
    expect(firstTable.rows).toHaveLength(50);
    expect(firstTable.rows[0]).toMatchObject({ file: 'photo-50.jpg' });
    expect(firstTable.next_cursor).toEqual(expect.any(String));

    const second = await host.admin.act('/report', 'results_page', {
      blockId: 'results',
      value: { cursor: firstTable.next_cursor, sort: null },
    });
    const secondTable = find(second.blocks, 'table', 'results')!;
    expect(secondTable.rows).toEqual([expect.objectContaining({ file: 'photo-0.jpg' })]);
    expect(secondTable.next_cursor).toBeUndefined();
    expect(find(second.blocks, 'section')).toMatchObject({
      text: 'Images that could be smaller, continued.',
      accessory: { action_id: 'refresh', label: 'Back to top' },
    });
  });

  it('falls back to the first page for a cursor the host rejects', async () => {
    host = await createPluginRuntimeTestHost();
    await heavyJpegs(host, 1);
    await scanFromReport(host);

    const page = await host.admin.act('/report', 'results_page', { value: { cursor: 'not-a-cursor' } });
    expect(find(page.blocks, 'table', 'results')?.rows).toHaveLength(1);
    expect(find(page.blocks, 'section')?.text).toBe('Images that could be smaller, largest estimated saving first.');
  });

  it('shows progress and the last confirmed update while a scan runs', async () => {
    host = await createPluginRuntimeTestHost();
    for (let index = 0; index < 301; index += 1) {
      await host.fixtures.media({ filename: `${index}.gif`, mimeType: 'image/gif', bytes: BYTES });
    }
    await host.admin.act('/report', 'start_scan');
    await host.transport.invokeHook('cron', { name: 'scan-step', scheduledAt: new Date().toISOString() });
    const page = await host.admin.loadPage('/report');

    expect(find(page.blocks, 'banner')).toMatchObject({
      title: 'Scan in progress',
      description: expect.stringMatching(/^300 images scanned so far\. Last confirmed update .+ UTC\./),
    });
    const actions = find(page.blocks, 'actions')!;
    expect(actions.elements).toEqual([
      { type: 'button', action_id: 'refresh', label: 'Refresh' },
      { type: 'link', label: 'Settings', target: { kind: 'plugin-settings' }, appearance: 'secondary' },
    ]);

    const again = await host.admin.act('/report', 'start_scan');
    expect(again.toast).toEqual({ type: 'info', message: 'A scan is already running.' });
  });

  it('reports invalid settings instead of starting', async () => {
    host = await createPluginRuntimeTestHost();
    await host.fixtures.plugin.setting('minSavingsPercent', 150);

    const page = await host.admin.act('/report', 'start_scan');
    expect(page.toast).toEqual({
      type: 'error',
      message: 'The scan did not start. Check the plugin settings: minSavingsRatio must be between 0 and 1.',
    });
    expect(find(page.blocks, 'empty')).toBeDefined();
  });

  it('applies settings in kilobytes and percent', async () => {
    host = await createPluginRuntimeTestHost();
    await heavyJpegs(host, 1);
    // The heavy JPEG saves 369.6 kB, 61.6% of its size.
    await host.fixtures.plugin.setting('minSavingsPercent', 62);
    const flagged = async () => find((await scanFromReport(host!)).page.blocks, 'stats', 'outcome')?.items[1]?.value;
    expect(await flagged()).toBe('0');

    await host.fixtures.plugin.setting('minSavingsPercent', 61);
    await host.fixtures.plugin.setting('minSavingsKB', 370);
    expect(await flagged()).toBe('0');

    await host.fixtures.plugin.setting('minSavingsKB', 369);
    expect(await flagged()).toBe('1');
  });

  it('formats numbers for the admin locale', async () => {
    host = await createPluginRuntimeTestHost();
    // 1.56 B/px; target 960_000 * 0.24 = 230_400, so the saving is 1_269_600 bytes.
    await host.fixtures.media({
      filename: 'big.jpg',
      mimeType: 'image/jpeg',
      bytes: BYTES,
      reportedSize: 1_500_000,
      width: 1200,
      height: 800,
    });
    const { page: german } = await scanFromReport(host, { locale: 'de' });
    expect(find(german.blocks, 'stats', 'outcome')?.items[0]?.value).toBe('1,3 MB');
    expect(find(german.blocks, 'table', 'results')?.rows[0]).toMatchObject({ size: '1,5 MB', dimensions: '1200 × 800' });

    const english = await host.admin.loadPage('/report', { locale: 'en' });
    expect(find(english.blocks, 'stats', 'outcome')?.items[0]?.value).toBe('1.3 MB');
  });

  it('falls back to English for a locale Intl does not accept', () => {
    expect(resolveLocale('de-CH')).toBe('de-CH');
    expect(resolveLocale('not a locale')).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });
});

describe('savings widget', () => {
  it('links to the report before and after a scan', async () => {
    host = await createPluginRuntimeTestHost();
    const report = { type: 'link', label: 'Open report', target: { kind: 'plugin-page', path: '/report' } };

    const empty = await host.admin.loadWidget('savings');
    expect(empty.blocks).toEqual([
      { type: 'context', text: 'No scan yet.' },
      { type: 'actions', elements: [report] },
    ]);

    await heavyJpegs(host, 1);
    await scanFromReport(host);
    const widget = await host.admin.loadWidget('savings');
    expect(widget.blocks).toEqual([
      {
        type: 'stats',
        items: [
          { label: 'Estimated saving', value: '369.6 kB' },
          { label: 'Images to review', value: '1' },
        ],
      },
      { type: 'actions', elements: [report] },
    ]);
  });
});
