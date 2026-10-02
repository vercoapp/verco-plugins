/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest';

import { createPluginRuntimeTestHost, createPluginTestHost, type PluginRuntimeTestHost } from '@emdash-cms/plugin-test';
import type { PluginUiContext } from 'emdash/plugin';

import packageJson from '../package.json';
import type { ScanRun, StoredResult } from '../src/job.ts';
import { createPlugin, imageOptimizerPlugin, PLUGIN_ID, PLUGIN_VERSION } from '../src/native.ts';
import { editions, type Edition } from './editions.ts';
import { fakeHost, type FakeMedia } from './fake-host.ts';

const LIBRARY: FakeMedia[] = [
  { id: 'heavy', filename: 'heavy.jpg', mimeType: 'image/jpeg', size: 6_000_000, width: 4000, height: 3000 },
  { id: 'fine', filename: 'fine.jpg', mimeType: 'image/jpeg', size: 200_000, width: 1200, height: 800 },
  { id: 'gif', filename: 'a.gif', mimeType: 'image/gif', size: 1000 },
  { id: 'pdf', filename: 'a.pdf', mimeType: 'application/pdf', size: 1000 },
];

const TICK = { name: 'scan-step', scheduledAt: '2026-10-01T00:00:00.000Z' };
const NEW_PNG = { id: 'new', filename: 'new.png', mimeType: 'image/png', size: 2_000_000, width: 1000, height: 1000 };
const REPORT = { type: 'page_load', page: '/report' };
const START = { type: 'block_action', action_id: 'start_scan', page: '/report' };

type Host = ReturnType<typeof fakeHost>;

async function finishScan(edition: Edition, host: Host): Promise<ScanRun> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await edition.hook(host.ctx, 'cron', TICK);
    if (host.state()?.phase === 'complete') return host.state()!;
  }
  throw new Error('The scan did not complete in 20 ticks');
}

/** Timestamps and run IDs come from the clock; the rest of a result must be the same in both editions. */
function withoutTimes<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>'));
}

describe.each(editions)('$name edition', (edition) => {
  it('starts a scan from the route, scans in the scheduled task and stops the task', async () => {
    const host = fakeHost(LIBRARY);

    expect(await edition.route(host.ctx, 'scan-start')).toMatchObject({
      ok: true,
      started: true,
      run: { phase: 'sweep', totals: { scanned: 0 } },
    });
    expect([...host.tasks]).toEqual([['scan-step', { schedule: '* * * * *' }]]);

    const run = await finishScan(edition, host);
    expect(run.totals).toMatchObject({
      scanned: 3,
      flagged: 1,
      ok: 1,
      skipped: { 'unsupported-format': 1 },
      estimatedSavingsBytes: 4_710_218,
    });
    expect(host.results.get('heavy')).toMatchObject({
      filename: 'heavy.jpg',
      status: 'flagged',
      findings: ['oversized-dimensions', 'heavy-encoding'],
      estimateBytes: 4_710_218,
    });
    expect([...host.results.keys()].sort()).toEqual(['fine', 'gif', 'heavy']);
    expect(host.tasks.size).toBe(0);
    expect(await edition.route(host.ctx, 'scan-status')).toEqual({ ok: true, run });
  });

  it('reports a scan that is already running instead of starting another', async () => {
    const host = fakeHost(LIBRARY);
    await edition.route(host.ctx, 'scan-start');

    expect(await edition.route(host.ctx, 'scan-start')).toMatchObject({ ok: true, started: false });
  });

  it('ignores scheduled tasks that are not its own', async () => {
    const host = fakeHost(LIBRARY);
    await edition.route(host.ctx, 'scan-start');
    await edition.hook(host.ctx, 'cron', { ...TICK, name: 'other-task' });

    expect(host.state()).toMatchObject({ phase: 'sweep', totals: { scanned: 0 } });
  });

  it('refuses to start with invalid settings', async () => {
    const host = fakeHost(LIBRARY);
    host.settings.set('maxDimension', 0);

    expect(await edition.route(host.ctx, 'scan-start')).toMatchObject({ ok: false, error: 'INVALID_SETTINGS' });
    expect(host.state()).toBeUndefined();
    expect(host.tasks.size).toBe(0);
  });

  it('reads the settings the site configured', async () => {
    const host = fakeHost(LIBRARY);
    host.settings.set('maxDimension', 5000);
    await edition.route(host.ctx, 'scan-start');
    await finishScan(edition, host);

    expect(host.results.get('heavy')).toMatchObject({ findings: ['heavy-encoding'] });
  });

  it('scans an upload from the upload hook', async () => {
    const host = fakeHost([...LIBRARY, NEW_PNG]);
    await edition.route(host.ctx, 'scan-start');
    await finishScan(edition, host);

    await edition.hook(host.ctx, 'media:afterUpload', {
      media: { ...NEW_PNG, url: '', createdAt: '' },
    });

    expect(host.results.get('new')).toMatchObject({ status: 'flagged', findings: ['possible-photo-as-png'] });
  });

  it('does not fail an upload when the scan fails', async () => {
    expect(edition.hookErrorPolicy('media:afterUpload')).toBe('continue');
  });

  it('declares the routes and their methods', async () => {
    expect(edition.routes()).toEqual({ admin: undefined, 'scan-start': ['POST'], 'scan-status': ['GET'] });
  });

  it('renders the report page, starts a scan from it and renders the dashboard widget', async () => {
    const host = fakeHost(LIBRARY);

    const empty = (await edition.route(host.ctx, 'admin', REPORT)) as { blocks: Array<{ type: string }> };
    expect(empty.blocks.some((block) => block.type === 'empty')).toBe(true);

    const started = (await edition.route(host.ctx, 'admin', START)) as { toast?: unknown };
    expect(started.toast).toEqual({
      type: 'success',
      message: 'Scan started. It runs in the background, about 300 images a minute.',
    });
    await finishScan(edition, host);

    const page = (await edition.route(host.ctx, 'admin', REPORT)) as {
      blocks: Array<{ type: string; block_id?: string; rows?: Array<Record<string, string>> }>;
    };
    const table = page.blocks.find((block) => block.type === 'table' && block.block_id === 'results');
    expect(table?.rows).toEqual([expect.objectContaining({ file: 'heavy.jpg', saving: '4.7 MB' })]);

    const widget = await edition.route(host.ctx, 'admin', { type: 'page_load', page: 'widget:savings' });
    expect(JSON.stringify(widget)).toContain('4.7 MB');
  });

  it('formats numbers for the administrator locale', async () => {
    const host = fakeHost(LIBRARY);
    await edition.route(host.ctx, 'scan-start');
    await finishScan(edition, host);

    const german = await edition.route(host.ctx, 'admin', REPORT, { locale: 'de' } as PluginUiContext);
    expect(JSON.stringify(german)).toContain('4,7 MB');
  });
});

describe('the editions agree', () => {
  /** One session through every handler, recorded for comparison. */
  async function session(edition: Edition) {
    const host = fakeHost([...LIBRARY, NEW_PNG]);
    const record: unknown[] = [];
    record.push(await edition.route(host.ctx, 'admin', REPORT));
    record.push(await edition.route(host.ctx, 'admin', START));
    record.push(await finishScan(edition, host));
    await edition.hook(host.ctx, 'media:afterUpload', { media: { ...NEW_PNG, url: '', createdAt: '' } });
    record.push(await edition.route(host.ctx, 'scan-status'));
    record.push(await edition.route(host.ctx, 'admin', REPORT));
    record.push(await edition.route(host.ctx, 'admin', { type: 'page_load', page: 'widget:savings' }));
    record.push([...host.results].sort(([a], [b]) => a.localeCompare(b)));
    record.push([...host.tasks]);
    return withoutTimes(record);
  }

  it('produce the same responses, stored results and scheduled tasks', async () => {
    const [sandboxed, native] = await Promise.all(editions.map(session));
    expect(native).toEqual(sandboxed);
  });
});

describe('switching editions', () => {
  const pairs = [
    { writer: editions[0]!, reader: editions[1]! },
    { writer: editions[1]!, reader: editions[0]! },
  ];

  it.each(pairs)('keeps $writer.name results readable and extendable by the $reader.name edition', async ({ writer, reader }) => {
    const host = fakeHost([...LIBRARY, NEW_PNG]);
    host.settings.set('minSavingsKB', 10);
    await writer.route(host.ctx, 'scan-start');
    const finished = await finishScan(writer, host);
    const stored = withoutTimes([...host.results]);
    const page = withoutTimes(await writer.route(host.ctx, 'admin', REPORT));

    // The other edition sees the same state and renders the same page, without scanning again.
    expect(await reader.route(host.ctx, 'scan-status')).toEqual({ ok: true, run: finished });
    expect(withoutTimes(await reader.route(host.ctx, 'admin', REPORT))).toEqual(page);
    expect(withoutTimes([...host.results])).toEqual(stored);

    // It continues the same state: an upload joins the totals, and a new scan replaces stale results.
    await reader.hook(host.ctx, 'media:afterUpload', { media: { ...NEW_PNG, url: '', createdAt: '' } });
    expect(host.state()?.totals.scanned).toBe(finished.totals.scanned + 1);

    host.library.splice(0, 1);
    await reader.route(host.ctx, 'scan-start');
    await finishScan(reader, host);
    expect(host.results.has('heavy')).toBe(false);
    expect((host.results.get('fine') as StoredResult).runId).toBe(host.state()!.runId);
  });
});

describe('switching editions in the EmDash runtime', () => {
  let runtime: PluginRuntimeTestHost | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
  });

  it('shows in the registry edition the results the native edition stored', async () => {
    const native = editions[1]!;
    const host = fakeHost(LIBRARY);
    await native.route(host.ctx, 'scan-start');
    await finishScan(native, host);
    const nativePage = (await native.route(host.ctx, 'admin', REPORT)) as { blocks: unknown[] };

    runtime = await createPluginRuntimeTestHost();
    for (const [id, data] of host.results) await runtime.fixtures.plugin.storage('results', id, data);
    await runtime.fixtures.plugin.kv('state:scan', host.state());

    const sandboxedPage = await runtime.admin.loadPage('/report');
    expect(withoutTimes(sandboxedPage.blocks)).toEqual(withoutTimes(nativePage.blocks));
    expect(sandboxedPage.blocks.length).toBeGreaterThan(1);
  });

  it('shows in the native edition the results the registry edition stored', async () => {
    runtime = await createPluginRuntimeTestHost();
    for (const media of LIBRARY.filter((item) => item.id !== 'pdf')) {
      await runtime.fixtures.media({
        filename: media.filename,
        mimeType: media.mimeType,
        bytes: new Uint8Array([0]),
        reportedSize: media.size ?? undefined,
        width: media.width ?? undefined,
        height: media.height ?? undefined,
      });
    }
    await runtime.admin.act('/report', 'start_scan');
    await runtime.transport.invokeHook('cron', TICK);
    const sandboxedPage = await runtime.admin.loadPage('/report');

    const host = fakeHost([]);
    for (const { id, data } of await runtime.inspect.storage.list<StoredResult>('results')) host.results.set(id, data);
    host.seedState((await runtime.inspect.kv.get<ScanRun>('state:scan'))!);

    const nativePage = (await editions[1]!.route(host.ctx, 'admin', REPORT)) as { blocks: unknown[] };
    expect(withoutTimes(nativePage.blocks)).toEqual(withoutTimes(sandboxedPage.blocks));
    expect(host.results.size).toBe(3);
  });
});

describe('native declarations', () => {
  it('match the registry edition manifest', async () => {
    const host = await createPluginTestHost();
    try {
      const plugin = createPlugin();
      const { manifest } = host;

      expect(plugin.id).toBe(manifest.id);
      expect(plugin.version).toBe(manifest.version);
      expect(plugin.capabilities).toEqual(manifest.capabilities);
      expect(plugin.allowedHosts).toEqual(manifest.allowedHosts);
      expect(plugin.storage).toEqual(manifest.storage);
      expect(plugin.admin.pages).toEqual(manifest.admin.pages);
      expect(plugin.admin.widgets).toEqual(manifest.admin.widgets);
      expect(plugin.admin.settingsSchema).toEqual(manifest.admin.settingsSchema);
      // The manifest lists hooks and routes by name, or as an object when they carry options.
      const named = (entries: Array<string | { name: string }>) =>
        entries.map((entry) => (typeof entry === 'string' ? entry : entry.name)).sort();
      expect(Object.keys(plugin.hooks).sort()).toEqual(named(manifest.hooks));
      expect(Object.keys(plugin.routes).sort()).toEqual(named(manifest.routes));
      for (const entry of manifest.hooks) {
        if (typeof entry === 'object') expect(plugin.hooks['media:afterUpload']?.errorPolicy).toBe(entry.errorPolicy);
      }
      for (const entry of manifest.routes) {
        if (typeof entry === 'object') expect(plugin.routes[entry.name]?.methods).toEqual(entry.methods);
      }
    } finally {
      await host.dispose();
    }
  });

  it('use the package name and version', () => {
    expect(PLUGIN_ID).toBe('image-optimizer');
    expect(PLUGIN_VERSION).toBe(packageJson.version);
    expect(imageOptimizerPlugin()).toEqual({
      id: PLUGIN_ID,
      version: PLUGIN_VERSION,
      format: 'native',
      entrypoint: packageJson.name,
    });
  });

  it('are read-only: media:read is the only capability and there is no network', () => {
    const plugin = createPlugin();
    expect(plugin.capabilities).toEqual(['media:read']);
    expect(plugin.allowedHosts).toEqual([]);
  });
});

describe('sandbox entry', () => {
  const sources = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >;

  it('imports nothing native-only', () => {
    const shared = Object.entries(sources).filter(([path]) => !path.endsWith('/native.ts'));
    expect(shared.length).toBeGreaterThanOrEqual(5);
    for (const [path, source] of shared) {
      // Types from `emdash/plugin` are erased; a value import from `emdash` is the native runtime.
      expect(source, path).not.toMatch(/import\s+(?!type\b)[^;]*from\s+'emdash'/);
      expect(source, path).not.toMatch(/from\s+'\.\/native(\.ts)?'/);
      expect(source, path).not.toMatch(/from\s+'sharp'/);
    }
  });
});
