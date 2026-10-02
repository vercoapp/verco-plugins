import { afterEach, describe, expect, it } from 'vitest';

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from '@emdash-cms/plugin-test';

import type { ScanRun, StoredResult } from '../src/job.ts';

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

const BYTES = new Uint8Array([0]);

async function library(runtime: PluginRuntimeTestHost) {
  const heavy = await runtime.fixtures.media({
    filename: 'heavy.jpg',
    mimeType: 'image/jpeg',
    bytes: BYTES,
    reportedSize: 6_000_000,
    width: 4000,
    height: 3000,
  });
  const fine = await runtime.fixtures.media({
    filename: 'fine.jpg',
    mimeType: 'image/jpeg',
    bytes: BYTES,
    reportedSize: 200_000,
    width: 1200,
    height: 800,
  });
  const gif = await runtime.fixtures.media({ filename: 'a.gif', mimeType: 'image/gif', bytes: BYTES });
  await runtime.fixtures.media({ filename: 'a.pdf', mimeType: 'application/pdf', bytes: BYTES });
  return { heavy: heavy.id, fine: fine.id, gif: gif.id };
}

describe('scan through the sandbox runtime', () => {
  it('scans the library from the start route and stops the scheduled task', async () => {
    host = await createPluginRuntimeTestHost();
    const ids = await library(host);

    const response = (await host.transport.invokeRoute('scan-start')) as { ok: boolean; run: ScanRun };
    expect(response).toMatchObject({ ok: true, started: true, run: { phase: 'complete' } });
    expect(response.run.totals).toMatchObject({
      scanned: 3,
      flagged: 1,
      ok: 1,
      skipped: { 'unsupported-format': 1 },
      estimatedSavingsBytes: 4_771_200,
    });

    const stored = await host.inspect.storage.list<StoredResult>('results');
    expect(stored.map(({ id }) => id).sort()).toEqual([ids.heavy, ids.fine, ids.gif].sort());
    expect(await host.inspect.storage.get<StoredResult>('results', ids.heavy)).toMatchObject({
      filename: 'heavy.jpg',
      status: 'flagged',
      findings: ['oversized-dimensions', 'heavy-encoding'],
      estimateBytes: 4_771_200,
    });
    expect(await host.inspect.scheduledTasks()).toEqual([]);

    const status = await host.transport.invokeRoute('scan-status');
    expect(status).toEqual({ ok: true, run: response.run });
  });

  it('leaves a large library to the scheduled task, which finishes it and stops', async () => {
    host = await createPluginRuntimeTestHost();
    // One more image than the start route takes in its first pass of five 100-item pages.
    for (let index = 0; index < 501; index += 1) {
      await host.fixtures.media({ filename: `${index}.gif`, mimeType: 'image/gif', bytes: BYTES });
    }

    const response = (await host.transport.invokeRoute('scan-start')) as { run: ScanRun };
    expect(response.run).toMatchObject({ phase: 'sweep', totals: { scanned: 500 } });
    expect(await host.inspect.scheduledTasks()).toEqual([
      expect.objectContaining({ name: 'scan-step', schedule: '* * * * *' }),
    ]);

    await host.transport.invokeHook('cron', { name: 'scan-step', scheduledAt: new Date().toISOString() });

    expect(await host.inspect.kv.get<ScanRun>('state:scan')).toMatchObject({
      phase: 'complete',
      totals: { scanned: 501, skipped: { 'unsupported-format': 501 } },
    });
    expect(await host.inspect.scheduledTasks()).toEqual([]);
  });

  it('scans an upload from the upload hook', async () => {
    host = await createPluginRuntimeTestHost();
    await host.transport.invokeRoute('scan-start');
    const { id } = await host.fixtures.media({
      filename: 'new.png',
      mimeType: 'image/png',
      bytes: BYTES,
      reportedSize: 2_000_000,
      width: 1000,
      height: 1000,
    });

    const media = { id, filename: 'new.png', mimeType: 'image/png', size: 2_000_000, url: '', createdAt: '' };
    await host.transport.invokeHook('media:afterUpload', { media });

    expect(await host.inspect.storage.get('results', id)).toMatchObject({
      status: 'flagged',
      findings: ['possible-photo-as-png'],
    });
    expect(await host.inspect.kv.get<ScanRun>('state:scan')).toMatchObject({ totals: { scanned: 1, flagged: 1 } });
  });

  it('refuses to start with invalid settings', async () => {
    host = await createPluginRuntimeTestHost();
    await host.fixtures.plugin.setting('maxDimension', 0);

    expect(await host.transport.invokeRoute('scan-start')).toMatchObject({ ok: false, error: 'INVALID_SETTINGS' });
    expect(await host.inspect.kv.get('state:scan')).toBeNull();
  });
});
