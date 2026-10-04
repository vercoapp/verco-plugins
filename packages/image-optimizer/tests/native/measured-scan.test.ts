/**
 * The native edition's measured scan and sample, driven through its hooks and routes over the fake
 * plugin context, with the real local processor on generated images.
 */
import { validateBlockResponse } from '@emdash-cms/blocks/server';
import type { PluginContext } from 'emdash/plugin';
import { describe, expect, it } from 'vitest';

import type { StoredResult } from '../../src/job.ts';
import { MAX_ATTEMPTS, MEASURED_ITEMS_PER_TICK, MEASURED_TICK_WALL_MS, type MeasureLimits } from '../../src/measure.ts';
import { createNativePlugin } from '../../src/native.ts';
import { DEFAULT_PROCESSOR_LIMITS } from '../../src/processor/limits.ts';
import sandboxPlugin from '../../src/plugin.ts';
import { ImageProcessorError, type ImageProcessor, type ProcessorErrorCode } from '../../src/processor/contract.ts';
import { createLocalProcessor } from '../../src/processor/local.ts';
import { presetOptions } from '../../src/processor/presets.ts';
import { fakeHost, type FakeMedia } from '../fake-host.ts';
import { apng, containsGpsRational, EXIF_WITH_GPS, photo } from './fixtures.ts';

const processor = createLocalProcessor();

const heavy = await photo().jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer();
const light = await photo().jpeg({ quality: 50 }).toBuffer();
const png = await photo(4).png({ compressionLevel: 0 }).toBuffer();
const animated = apng(await photo().png().toBuffer());
const gps = await photo().withExif(EXIF_WITH_GPS).jpeg({ quality: 98 }).toBuffer();

function media(id: string, mimeType: string, bytes: Uint8Array): FakeMedia {
  return { id, filename: `${id}.${mimeType.split('/')[1]}`, mimeType, size: bytes.byteLength, width: 320, height: 240, bytes };
}

function library(): FakeMedia[] {
  return [
    media('heavy', 'image/jpeg', heavy),
    media('light', 'image/jpeg', light),
    media('png', 'image/png', png),
    media('animated', 'image/png', animated),
    media('broken', 'image/jpeg', heavy.subarray(0, 300)),
    media('gif', 'image/gif', new Uint8Array([0x47, 0x49, 0x46])),
    media('gps', 'image/jpeg', gps),
  ];
}

/** Everything the host stores about media, bytes included, copied for a later comparison. */
function snapshot(items: FakeMedia[]) {
  return items.map((item) => ({ ...item, bytes: item.bytes ? Buffer.from(item.bytes).toString('base64') : null }));
}

type Host = ReturnType<typeof fakeHost>;
type Handler = (...args: unknown[]) => Promise<unknown>;

function nativeEdition(options: { processor?: ImageProcessor | null; limits?: Partial<MeasureLimits>; clock?: () => number } = {}) {
  const plugin = createNativePlugin({
    processor: () => (options.processor === undefined ? processor : options.processor),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const handler = (entry: unknown) =>
    (typeof entry === 'function' ? entry : (entry as { handler: Handler }).handler) as Handler;
  return {
    route: (host: Host, name: string, input?: unknown) =>
      handler(plugin.routes[name])({ ...host.ctx, input, request: new Request('https://site.test/', { method: 'POST' }) }),
    cron: (host: Host) => handler(plugin.hooks.cron)({ name: 'scan-step', scheduledAt: '' }, host.ctx),
    upload: (host: Host, item: FakeMedia) =>
      handler(plugin.hooks['media:afterUpload'])({ media: { ...item, bytes: undefined, url: '', createdAt: '' } }, host.ctx),
  };
}

type Edition = ReturnType<typeof nativeEdition>;

async function finish(edition: Pick<Edition, 'cron'>, host: Host, ticks = 40): Promise<number> {
  for (let tick = 1; tick <= ticks; tick += 1) {
    await edition.cron(host);
    if (host.state()?.phase === 'complete') return tick;
  }
  throw new Error(`The scan did not complete in ${ticks} ticks`);
}

function stored(host: Host, id: string): StoredResult {
  const result = host.results.get(id);
  if (!result) throw new Error(`No result for ${id}`);
  return result;
}

/** Fails `codes` in order for the given media's bytes, then processes for real. */
function failing(target: Uint8Array, codes: ProcessorErrorCode[]): ImageProcessor & { calls: () => number } {
  let calls = 0;
  return {
    capabilities: () => processor.capabilities(),
    async process(request) {
      if (request.bytes === target) {
        calls += 1;
        const code = codes.shift();
        if (code) throw new ImageProcessorError(code, `injected ${code}`);
      }
      return processor.process(request);
    },
    calls: () => calls,
  };
}

const REPORT = { type: 'page_load', page: '/report' };
type Page = { blocks: Array<Record<string, unknown> & { type: string }>; toast?: { type: string; message: string } };

function allBlocks(page: Page) {
  return page.blocks.flatMap((block) => (block.type === 'accordion' ? [block, ...(block.blocks as Page['blocks'])] : [block]));
}

describe('measured scan', () => {
  it('measures every image without changing media bytes or metadata', async () => {
    const host = fakeHost(library(), { readBytes: true });
    host.settings.set('minSavingsKB', 1);
    host.settings.set('minSavingsPercent', 5);
    host.settings.set('removeGps', true);
    const before = snapshot(host.library);
    const edition = nativeEdition();

    expect(await edition.route(host, 'scan-start')).toMatchObject({ ok: true, started: true });
    await finish(edition, host);

    expect(snapshot(host.library)).toEqual(before);
    // GPS removal applies to the measured output only; the stored file keeps its position.
    expect(containsGpsRational(host.library.find(({ id }) => id === 'gps')!.bytes!)).toBe(true);
    // GIF is skipped by type, unread; every other image was read once.
    expect([...host.readCalls].sort()).toEqual(['animated', 'broken', 'gps', 'heavy', 'light', 'png']);

    const run = host.state()!;
    expect(run.measure).toEqual({
      preset: 'balanced',
      removeGps: true,
      processor: 'local-sharp',
      processorVersion: processor.capabilities().version,
    });

    const top = stored(host, 'heavy');
    expect(top).toMatchObject({ status: 'flagged', basis: 'measured', format: 'jpeg', width: 320, height: 240 });
    expect(top.measured).toMatchObject({ inputBytes: heavy.byteLength, preset: 'balanced', removeGps: true });
    expect(top.measured!.outputBytes).toBeLessThan(heavy.byteLength);
    expect(top.estimateBytes).toBe(heavy.byteLength - top.measured!.outputBytes);

    expect(stored(host, 'animated')).toMatchObject({ status: 'skipped', reason: 'animated', basis: 'measured' });
    expect(stored(host, 'broken')).toMatchObject({ status: 'skipped', reason: 'malformed', basis: 'measured' });
    expect(stored(host, 'gif')).toMatchObject({ status: 'skipped', reason: 'unsupported-format' });
    // Quality 50 re-encoded at 80 does not get smaller enough: measured, not flagged.
    expect(stored(host, 'light')).toMatchObject({ status: 'ok', basis: 'measured', estimateBytes: 0 });
    expect(stored(host, 'light').measured!.outputBytes).toBeGreaterThan(0);

    const flagged = [...host.results.values()].filter(({ status }) => status === 'flagged');
    expect(flagged.length).toBeGreaterThanOrEqual(2);
    expect(run.totals).toMatchObject({
      scanned: 7,
      flagged: flagged.length,
      measured: 4,
      measuredSavingsBytes: flagged.reduce((sum, { estimateBytes }) => sum + estimateBytes, 0),
      estimatedSavingsBytes: 0,
      skipped: { animated: 1, malformed: 1, 'unsupported-format': 1 },
      failed: 0,
    });
    expect(host.tasks.size).toBe(0);
  });

  it('applies the configured thresholds to measured savings', async () => {
    const host = fakeHost(library(), { readBytes: true });
    // The defaults, 50 KB and 20%: the heavy JPEG saves less than 50 KB, the uncompressed PNG more.
    const edition = nativeEdition();
    await edition.route(host, 'scan-start');
    await finish(edition, host);

    const measured = [...host.results].filter(([, data]) => data.measured);
    expect(measured.length).toBe(4);
    for (const [id, data] of measured) {
      const saving = data.measured!.inputBytes - data.measured!.outputBytes;
      const worth = saving >= 50_000 && saving / data.measured!.inputBytes >= 0.2;
      expect(data.status, id).toBe(worth ? 'flagged' : 'ok');
      expect(data.estimateBytes, id).toBe(worth ? saving : 0);
    }
    expect(stored(host, 'heavy')).toMatchObject({ status: 'ok', estimateBytes: 0 });
    expect(stored(host, 'png')).toMatchObject({ status: 'flagged' });
    expect(host.state()!.totals).toMatchObject({ flagged: 1, measuredSavingsBytes: stored(host, 'png').estimateBytes });
  });

  it('bounds each tick by image count and resumes inside a page', async () => {
    const host = fakeHost(library(), { readBytes: true });
    const edition = nativeEdition({ limits: { items: 2 } });
    await edition.route(host, 'scan-start');

    await edition.cron(host);
    expect(host.readCalls).toEqual(['heavy', 'light']);
    expect(host.state()).toMatchObject({ phase: 'sweep', offset: 2, lastId: 'light', totals: { scanned: 2 } });

    // Media earlier in the page is deleted; the sweep resumes after the last item it handled.
    host.library.splice(0, 1);
    await edition.cron(host);
    expect(host.readCalls).toEqual(['heavy', 'light', 'png', 'animated']);
    expect(await finish(edition, host)).toBe(2);
    expect(host.state()!.totals.scanned).toBe(7);
  });

  it('bounds each tick by wall time, and still makes progress on a slow host', async () => {
    let now = 0;
    // Every reading of the clock is one tick's whole wall-time budget later.
    const clock = () => (now += MEASURED_TICK_WALL_MS);
    const host = fakeHost(library(), { readBytes: true });
    const edition = nativeEdition({ clock });
    await edition.route(host, 'scan-start');

    await edition.cron(host);
    expect(host.state()!.totals.scanned).toBe(1);
    await edition.cron(host);
    expect(host.state()!.totals.scanned).toBe(2);
  });

  it('uses conservative defaults', () => {
    expect(MEASURED_ITEMS_PER_TICK).toBeLessThanOrEqual(20);
    expect(MEASURED_TICK_WALL_MS).toBeLessThanOrEqual(30_000);
    // A tick whose last image runs to the processor's kill still ends inside the one-minute cron interval.
    expect(MEASURED_TICK_WALL_MS + DEFAULT_PROCESSOR_LIMITS.wallTimeMs).toBeLessThan(60_000);
    // ...and a tick that meets only the slowest measured 24 MP encode (12.3 s) ends within half of it.
    expect(MEASURED_TICK_WALL_MS + 12_300).toBeLessThanOrEqual(30_000);
  });

  it('retries busy, crashed and aborted items in a later tick, and records them when they keep failing', async () => {
    const recovers = failing(heavy, ['busy', 'aborted']);
    const host = fakeHost(library().slice(0, 3), { readBytes: true });
    const edition = nativeEdition({ processor: recovers });
    await edition.route(host, 'scan-start');

    // A busy processor stops the tick: nothing after it starts.
    await edition.cron(host);
    expect(host.state()).toMatchObject({ retries: [{ id: 'heavy', attempts: 1 }], totals: { scanned: 0 } });
    expect(host.results.has('heavy')).toBe(false);

    await edition.cron(host);
    expect(host.state()).toMatchObject({ retries: [{ id: 'heavy', attempts: 2 }], phase: 'cleanup', totals: { scanned: 2 } });

    await finish(edition, host);
    expect(recovers.calls()).toBe(3);
    expect(stored(host, 'heavy')).toMatchObject({ basis: 'measured', failure: null });
    expect(['ok', 'flagged']).toContain(stored(host, 'heavy').status);
    expect(host.state()!.totals).toMatchObject({ scanned: 3, failed: 0 });

    const crashes = failing(heavy, Array(MAX_ATTEMPTS).fill('crashed'));
    const second = fakeHost(library().slice(0, 1), { readBytes: true });
    const failingEdition = nativeEdition({ processor: crashes });
    await failingEdition.route(second, 'scan-start');
    expect(await finish(failingEdition, second)).toBe(MAX_ATTEMPTS);
    expect(crashes.calls()).toBe(MAX_ATTEMPTS);
    expect(stored(second, 'heavy')).toMatchObject({
      status: 'failed',
      basis: 'measured',
      failure: { code: 'crashed', attempts: MAX_ATTEMPTS },
    });
    expect(second.state()!.totals).toMatchObject({ scanned: 1, failed: 1 });
  });

  it('records other processor errors as failures without retrying', async () => {
    const timesOut = failing(heavy, ['timeout']);
    const host = fakeHost(library().slice(0, 1), { readBytes: true });
    const edition = nativeEdition({ processor: timesOut });
    await edition.route(host, 'scan-start');
    expect(await finish(edition, host)).toBe(1);
    expect(timesOut.calls()).toBe(1);
    expect(stored(host, 'heavy')).toMatchObject({ status: 'failed', failure: { code: 'timeout', attempts: 1 } });

    const page = (await edition.route(host, 'admin', REPORT)) as Page;
    const failed = allBlocks(page).find((block) => block.block_id === 'failed') as { rows: unknown[] } | undefined;
    expect(failed?.rows).toEqual([{ file: 'heavy.jpeg', reason: 'Processing took longer than the time limit.', attempts: 1 }]);
  });

  it('skips files larger than the host lets a plugin read, without reading them', async () => {
    const host = fakeHost([{ ...media('huge', 'image/jpeg', heavy), size: 17 * 1024 * 1024 }], { readBytes: true });
    const edition = nativeEdition();
    await edition.route(host, 'scan-start');
    await finish(edition, host);
    expect(host.readCalls).toEqual([]);
    expect(stored(host, 'huge')).toMatchObject({ status: 'skipped', reason: 'over-byte-limit' });
  });

  it('estimates instead when the context cannot read bytes or Sharp is missing', async () => {
    for (const [host, edition] of [
      [fakeHost(library()), nativeEdition()],
      [fakeHost(library(), { readBytes: true }), nativeEdition({ processor: null })],
    ] as const) {
      await edition.route(host, 'scan-start');
      await finish(edition, host);
      expect(host.state()!.measure).toBeUndefined();
      expect(host.readCalls).toEqual([]);
      expect(stored(host, 'heavy').basis).toBe('estimated');
      expect(stored(host, 'heavy').measured).toBeUndefined();
    }
  });

  it('refuses to start with a preset that does not exist', async () => {
    const host = fakeHost(library(), { readBytes: true });
    host.settings.set('preset', 'smallest');
    expect(await nativeEdition().route(host, 'scan-start')).toMatchObject({ ok: false, error: 'INVALID_SETTINGS' });
    expect(host.state()).toBeUndefined();
  });

  it('is continued with estimates by the sandboxed edition, without counting an item twice', async () => {
    const host = fakeHost(library(), { readBytes: true });
    const edition = nativeEdition({ limits: { items: 2 } });
    await edition.route(host, 'scan-start');
    await edition.cron(host);

    const cron = (sandboxPlugin.hooks!.cron as Handler);
    await cron({ name: 'scan-step', scheduledAt: '' }, host.ctx as PluginContext);
    expect(host.state()).toMatchObject({ phase: 'complete', totals: { scanned: 7, measured: 2 } });
    expect(stored(host, 'heavy').basis).toBe('measured');
    expect(stored(host, 'png').basis).toBe('estimated');
  });
});

describe('measured report', () => {
  it('labels measured and estimated savings and shows the preset options', async () => {
    const host = fakeHost(library(), { readBytes: true });
    host.settings.set('minSavingsKB', 1);
    host.settings.set('minSavingsPercent', 5);
    host.settings.set('preset', 'high-fidelity');
    const edition = nativeEdition();
    await edition.route(host, 'scan-start');
    await finish(edition, host);
    // An upload after the scan is estimated from metadata, and labelled so.
    const upload: FakeMedia = { id: 'new', filename: 'new.jpg', mimeType: 'image/jpeg', size: 6_000_000, width: 4000, height: 3000 };
    host.library.unshift(upload);
    await edition.upload(host, upload);
    expect(stored(host, 'new')).toMatchObject({ basis: 'estimated', status: 'flagged' });

    const page = (await edition.route(host, 'admin', REPORT)) as Page;
    expect(validateBlockResponse(page, { pluginPagePaths: ['/report'] }).errors).toEqual([]);
    const blocks = allBlocks(page);
    const table = blocks.find((block) => block.block_id === 'results') as unknown as {
      columns: Array<{ key: string; label: string }>;
      rows: Array<Record<string, unknown>>;
    };
    expect(table.columns.find(({ key }) => key === 'saving')?.label).toBe('Saving');
    expect(table.rows.find(({ file }) => file === 'new.jpg')?.saving).toMatch(/, estimated$/);
    expect(table.rows.find(({ file }) => file === 'heavy.jpeg')?.saving).toMatch(/ measured \(\d+%\)$/);
    expect(table.rows.find(({ file }) => file === 'heavy.jpeg')?.sample).toMatchObject({
      type: 'button',
      action_id: 'sample_image',
      value: { mediaId: 'heavy' },
    });

    const outcome = blocks.find((block) => block.block_id === 'outcome') as unknown as { items: Array<{ label: string; description?: string }> };
    expect(outcome.items[0]).toMatchObject({ label: 'Measured saving', description: expect.stringMatching(/estimated/) });
    const code = blocks.find((block) => block.type === 'code') as unknown as { code: string };
    expect(JSON.parse(code.code)).toEqual(presetOptions('high-fidelity'));
    expect(JSON.stringify(page)).toContain('high-fidelity preset');

    const widget = await edition.route(host, 'admin', { type: 'page_load', page: 'widget:savings' });
    expect(JSON.stringify(widget)).toContain('Measured saving');
  });

  it('keeps the sandboxed report unchanged for estimated results', async () => {
    const host = fakeHost(library());
    const admin = (sandboxPlugin.routes!.admin as { handler: Handler }).handler;
    const start = (sandboxPlugin.routes!['scan-start'] as { handler: Handler }).handler;
    await start({}, host.ctx);
    await (sandboxPlugin.hooks!.cron as Handler)({ name: 'scan-step', scheduledAt: '' }, host.ctx);
    const page = (await admin({ input: REPORT }, host.ctx)) as Page;
    const text = JSON.stringify(page);
    expect(text).toContain('Estimated saving');
    expect(text).not.toMatch(/measured|sample_image|Encoder options/i);
  });
});

describe('sample', () => {
  it('processes one image and shows before and after numbers, leaving media and results unchanged', async () => {
    const host = fakeHost(library(), { readBytes: true });
    host.settings.set('minSavingsKB', 1);
    const edition = nativeEdition();
    await edition.route(host, 'scan-start');
    await finish(edition, host);
    const before = snapshot(host.library);
    const results = structuredClone([...host.results]);
    const state = structuredClone(host.state());

    const page = (await edition.route(host, 'admin', {
      type: 'block_action',
      action_id: 'sample_image',
      value: { mediaId: 'heavy' },
      page: '/report',
    })) as Page;

    expect(validateBlockResponse(page, { pluginPagePaths: ['/report'] }).errors).toEqual([]);
    const fields = page.blocks.find((block) => block.block_id === 'sample') as unknown as { fields: Array<{ label: string; value: string }> };
    const byLabel = Object.fromEntries(fields.fields.map(({ label, value }) => [label, value]));
    expect(byLabel.Before).toMatch(/^[\d.]+ kB, 320 × 240 JPEG$/);
    expect(byLabel.After).toMatch(/^[\d.]+ kB, 320 × 240 JPEG$/);
    expect(byLabel.Saving).toMatch(/\(\d+%\)$/);
    const code = page.blocks.find((block) => block.type === 'code') as unknown as { code: string };
    expect(JSON.parse(code.code)).toEqual(presetOptions('balanced').jpeg);
    // Numbers only: no image block.
    expect(allBlocks(page).some((block) => block.type === 'image')).toBe(false);

    expect(snapshot(host.library)).toEqual(before);
    expect([...host.results]).toEqual(results);
    expect(host.state()).toEqual(state);
  });

  it('samples the top result from the report and reports skips and missing images', async () => {
    const host = fakeHost(library(), { readBytes: true });
    host.settings.set('minSavingsKB', 1);
    const edition = nativeEdition();
    await edition.route(host, 'scan-start');
    await finish(edition, host);

    const report = (await edition.route(host, 'admin', REPORT)) as Page;
    const actions = report.blocks.find((block) => block.type === 'actions') as unknown as { elements: Array<Record<string, unknown>> };
    const top = [...host.results].filter(([, data]) => data.status === 'flagged').sort(([, a], [, b]) => b.estimateBytes - a.estimateBytes)[0]![0];
    expect(actions.elements).toContainEqual(expect.objectContaining({ label: 'Sample top result', value: { mediaId: top } }));

    const sample = (input: unknown) => edition.route(host, 'admin', { type: 'block_action', action_id: 'sample_image', value: input });
    expect(JSON.stringify(await sample({ mediaId: 'animated' }))).toContain('Sample of animated.png: skipped');
    expect(JSON.stringify(await sample({ mediaId: 'gone' }))).toContain('The image no longer exists.');
  });
});
