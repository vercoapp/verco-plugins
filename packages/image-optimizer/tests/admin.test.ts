import { afterEach, describe, expect, it } from 'vitest';

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from '@emdash-cms/plugin-test';

import { formatBytes, resolveLocale } from '../src/admin.ts';

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

    const page = await host.admin.act('/report', 'start_scan');

    expect(page.toast).toEqual({ type: 'success', message: 'Scan finished.' });
    expect(find(page.blocks, 'banner')).toBeUndefined();
    expect(find(page.blocks, 'stats')?.items).toEqual([
      { label: 'Images scanned', value: '4' },
      { label: 'Could be smaller', value: '3', description: '1 without a saving estimate' },
      { label: 'Estimated saving', value: '721 kB', description: 'From metadata only' },
      { label: 'Skipped', value: '1', description: '1 unsupported format' },
    ]);

    const table = find(page.blocks, 'table', 'results');
    expect(table?.rows).toEqual([
      {
        file: 'photo-1.jpg',
        format: 'JPEG',
        dimensions: '1200 × 800',
        size: '601 kB',
        saving: '361 kB',
        findings: 'Heavy encoding',
      },
      expect.objectContaining({ file: 'photo-0.jpg', saving: '360 kB' }),
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
    const first = await host.admin.act('/report', 'start_scan');
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
    await host.admin.act('/report', 'start_scan');

    const page = await host.admin.act('/report', 'results_page', { value: { cursor: 'not-a-cursor' } });
    expect(find(page.blocks, 'table', 'results')?.rows).toHaveLength(1);
    expect(find(page.blocks, 'section')?.text).toBe('Images that could be smaller, largest estimated saving first.');
  });

  it('shows progress and the last confirmed update while a scan runs', async () => {
    host = await createPluginRuntimeTestHost();
    for (let index = 0; index < 501; index += 1) {
      await host.fixtures.media({ filename: `${index}.gif`, mimeType: 'image/gif', bytes: BYTES });
    }
    const page = await host.admin.act('/report', 'start_scan');

    expect(page.toast).toEqual({ type: 'success', message: 'Scan started. It continues in the background.' });
    expect(find(page.blocks, 'banner')).toMatchObject({
      title: 'Scan in progress',
      description: expect.stringMatching(/^500 images scanned so far\. Last confirmed update .+ UTC\./),
    });
    const actions = find(page.blocks, 'actions')!;
    expect(actions.elements.map((element) => element.label)).toEqual(['Refresh', 'Settings']);

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
    // The heavy JPEG saves 360 kB, 60% of its size.
    await host.fixtures.plugin.setting('minSavingsPercent', 61);
    expect(find((await host.admin.act('/report', 'start_scan')).blocks, 'stats')?.items[1]).toMatchObject({ value: '0' });

    await host.fixtures.plugin.setting('minSavingsPercent', 60);
    await host.fixtures.plugin.setting('minSavingsKB', 361);
    expect(find((await host.admin.act('/report', 'start_scan')).blocks, 'stats')?.items[1]).toMatchObject({ value: '0' });

    await host.fixtures.plugin.setting('minSavingsKB', 360);
    expect(find((await host.admin.act('/report', 'start_scan')).blocks, 'stats')?.items[1]).toMatchObject({ value: '1' });
  });

  it('formats numbers for the admin locale', async () => {
    host = await createPluginRuntimeTestHost();
    // 1.29 B/px; target 960_000 * 0.25 = 240_000, so the saving is 994_567 bytes.
    await host.fixtures.media({
      filename: 'big.jpg',
      mimeType: 'image/jpeg',
      bytes: BYTES,
      reportedSize: 1_234_567,
      width: 1200,
      height: 800,
    });
    const german = await host.admin.act('/report', 'start_scan', { locale: 'de' });
    expect(find(german.blocks, 'stats')?.items[2]?.value).toBe('994,6 kB');
    expect(find(german.blocks, 'table', 'results')?.rows[0]).toMatchObject({ size: '1,2 MB', dimensions: '1200 × 800' });

    const english = await host.admin.loadPage('/report', { locale: 'en' });
    expect(find(english.blocks, 'stats')?.items[2]?.value).toBe('994.6 kB');
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
    await host.admin.act('/report', 'start_scan');
    const widget = await host.admin.loadWidget('savings');
    expect(widget.blocks).toEqual([
      {
        type: 'stats',
        items: [
          { label: 'Estimated saving', value: '360 kB' },
          { label: 'Images to review', value: '1' },
        ],
      },
      { type: 'actions', elements: [report] },
    ]);
  });
});
