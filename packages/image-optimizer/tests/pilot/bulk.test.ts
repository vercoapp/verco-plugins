/**
 * A small bulk run end to end on the patched host: a measured scan, an apply run over its results
 * and a restore run, driven by the runtime's cron dispatch and the plugin's routes. Skipped when the
 * pilot checkout is absent; see `vitest.config.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BulkView } from '../../src/admin.ts';
import { BULK_TASK, type StartOutcome } from '../../src/bulk.ts';
import { SCAN_TASK } from '../../src/job.ts';
import { photo } from '../native/fixtures.ts';
import { core, LOCAL_PROFILE, startPilot, type Pilot } from './pilot-runtime.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!core)('bulk runs on the patched host', () => {
  let root: string;
  let site: Pilot;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'image-optimizer-pilot-bulk-'));
    site = await startPilot(root, [LOCAL_PROFILE]);
    // Loading the pilot's modules and migrating its database is slow under load.
  }, 60_000);

  afterAll(async () => {
    await site?.runtime.stopCron();
    await rm(root, { recursive: true, force: true });
  });

  it('optimizes the measured images in a run, then restores them all byte for byte', async () => {
    const heavy = await Promise.all(
      [0, 1, 2].map((index) => photo(3, 640 + index * 16, 480).jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer()),
    );
    const light = await photo(3, 640, 480).jpeg({ quality: 40 }).toBuffer();
    const keys = ['01HZBULKA.jpg', '01HZBULKB.jpg', '01HZBULKC.jpg'];
    const ids = await Promise.all(heavy.map((bytes, index) => site.addImage(keys[index]!, bytes, 640 + index * 16, 480)));
    const lightId = await site.addImage('01HZBULKLIGHT.jpg', light, 640, 480);
    const before = await Promise.all(ids.map((id) => site.media.findById(id)));

    // A measured scan first: the run takes its measured results.
    expect(await site.route('scan-start', {})).toMatchObject({ ok: true, started: true });
    for (let tick = 0; tick < 5; tick += 1) await site.cron(SCAN_TASK);

    const started = await site.route<StartOutcome>('bulk-start', {});
    expect(started).toMatchObject({ ok: true, run: { kind: 'apply' } });
    // A second run cannot start beside it.
    expect(await site.route<StartOutcome>('bulk-start', {})).toMatchObject({ ok: false, error: 'RUN_ACTIVE' });
    for (let tick = 0; tick < 5; tick += 1) await site.cron(BULK_TASK);

    const applied = await site.route<BulkView>('bulk-status', {});
    expect(applied.run).toMatchObject({ status: 'complete', counts: { optimized: 3, failed: 0, conflict: 0 } });
    for (const [index, key] of keys.entries()) {
      const served = await site.served(key);
      expect(served.byteLength).toBeLessThan(heavy[index]!.byteLength);
    }
    expect(sha(await site.served('01HZBULKLIGHT.jpg'))).toBe(sha(light));
    // ID, address and editorial fields stay.
    const after = await Promise.all(ids.map((id) => site.media.findById(id)));
    for (const [index, row] of after.entries()) {
      expect(row).toMatchObject({ id: before[index]!.id, storageKey: before[index]!.storageKey, alt: 'A gradient', focalX: 0.25 });
    }

    expect(await site.route<StartOutcome>('bulk-start', { kind: 'restore' })).toMatchObject({ ok: true });
    for (let tick = 0; tick < 5; tick += 1) await site.cron(BULK_TASK);
    const restored = await site.route<BulkView>('bulk-status', {});
    expect(restored.run).toMatchObject({ kind: 'restore', status: 'complete', counts: { restored: 3 } });
    for (const [index, key] of keys.entries()) expect(sha(await site.served(key))).toBe(sha(heavy[index]!));
    void lightId;
  });
});
