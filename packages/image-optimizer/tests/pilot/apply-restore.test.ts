/**
 * End to end on the patched host: the native edition registered in a real EmDash runtime (the pilot
 * checkout at `.upstream/emdash-pilot`, SQLite, local storage, `safeMedia` configured), applying and
 * restoring through its routes. Skipped when the pilot checkout is absent; see `vitest.config.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ActionOutcome } from '../../src/admin.ts';
import { photo } from '../native/fixtures.ts';
import { core, LOCAL_PROFILE, startPilot, type Pilot } from './pilot-runtime.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!core)('the native edition on the patched host', () => {
  let root: string;
  let site: Pilot | undefined;

  // The runtime caches its database per process, so the tests share one site directory.
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'image-optimizer-pilot-'));
  });

  afterEach(async () => {
    await site?.runtime.stopCron();
    site = undefined;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function start(qualifiedProfiles: Array<Record<string, string>>, key: string) {
    site = await startPilot(root, qualifiedProfiles);
    // Large enough to pass the default thresholds (50 KB and 20%).
    const original = await photo(3, 640, 480).jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer();
    const id = await site.addImage(key, original, 640, 480);
    return { id, original, media: site.media, setSetting: site.setSetting };
  }

  const route = (name: string, mediaId: string) => site!.route<ActionOutcome>(name, { mediaId });
  const served = (key: string) => site!.served(key);

  /** What a replacement must keep: identity, address and editorial fields. */
  const kept = (row: Record<string, unknown> | null) => ({
    id: row?.id,
    filename: row?.filename,
    storageKey: row?.storageKey,
    alt: row?.alt,
    caption: row?.caption,
    focalX: row?.focalX,
    focalY: row?.focalY,
    width: row?.width,
    height: row?.height,
    mimeType: row?.mimeType,
  });

  it('stays read-only with the shipped allowlist', async () => {
    const { id, original } = await start([], '01HZPILOTREADONLY.jpg');
    expect(await route('apply', id)).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
    expect(await route('restore', id)).toMatchObject({ outcome: 'unavailable', reason: 'unqualified-host' });
    expect(sha(await served('01HZPILOTREADONLY.jpg'))).toBe(sha(original));
  });

  it('applies in place, keeps the item, and restores the original byte for byte', async () => {
    const { id, original, media } = await start([LOCAL_PROFILE], '01HZPILOTOPT.jpg');
    const before = kept(await media.findById(id));
    expect(before).toMatchObject({ alt: 'A gradient', focalX: 0.25 });

    const applied = await route('apply', id);
    expect(applied).toMatchObject({ outcome: 'optimized', replayed: false, inputBytes: original.byteLength });
    if (applied.outcome !== 'optimized') return;
    const optimized = await served('01HZPILOTOPT.jpg');
    expect(optimized.byteLength).toBe(applied.outputBytes);
    expect(optimized.byteLength).toBeLessThan(original.byteLength);
    expect(kept(await media.findById(id))).toEqual(before);
    expect((await media.findById(id))?.size).toBe(applied.outputBytes);

    // Applying again with the same settings changes nothing.
    expect(await route('apply', id)).toMatchObject({ outcome: 'skipped', reason: 'already-optimized' });

    const restored = await route('restore', id);
    expect(restored).toMatchObject({ outcome: 'restored', sha256: sha(original) });
    expect(sha(await served('01HZPILOTOPT.jpg'))).toBe(sha(original));
    expect(kept(await media.findById(id))).toEqual(before);
  });

  it('re-optimizes from the privately read original when the preset changes, never making it active', async () => {
    const { id, original, media, setSetting } = await start([LOCAL_PROFILE], '01HZPILOTREOPT.jpg');
    const before = kept(await media.findById(id));
    const first = await route('apply', id);
    expect(first).toMatchObject({ outcome: 'optimized' });
    const balanced = sha(await served('01HZPILOTREOPT.jpg'));

    await setSetting('preset', 'high-fidelity');
    const again = await route('apply', id);
    // The input was the original's bytes, not the balanced output.
    expect(again).toMatchObject({ outcome: 'optimized', reoptimized: true, inputBytes: original.byteLength });
    const fidelity = sha(await served('01HZPILOTREOPT.jpg'));
    expect(fidelity).not.toBe(balanced);
    expect(fidelity).not.toBe(sha(original));
    expect(kept(await media.findById(id))).toEqual(before);

    // The host's own records: two replacements and no restore. The re-optimization was fenced on the
    // balanced revision the first one published, so no revision came between them, and the only
    // revision with the original's bytes is the one the first replacement started from.
    const operations = await site!.operations(id);
    expect(operations.map(({ kind, state }) => [kind, state])).toEqual([
      ['replace', 'published'],
      ['replace', 'published'],
    ]);
    const firstOperation = operations.find(({ operation_id }) => operation_id.startsWith('imgopt.replace.'))!;
    const reoptimization = operations.find(({ operation_id }) => operation_id.startsWith(`imgopt.reopt.`))!;
    expect(reoptimization.operation_id).toContain(sha(original));
    expect(firstOperation).toMatchObject({ candidate_sha256: balanced, original_sha256: sha(original) });
    expect(reoptimization).toMatchObject({
      expected_revision_id: firstOperation.candidate_revision_id,
      candidate_sha256: fidelity,
      original_sha256: balanced,
    });
    const revisions = await site!.revisions(id);
    expect(revisions.filter(({ sha256 }) => sha256 === sha(original)).map(({ id }) => id)).toEqual([firstOperation.expected_revision_id]);

    expect(await route('restore', id)).toMatchObject({ outcome: 'restored', sha256: sha(original) });
    expect(sha(await served('01HZPILOTREOPT.jpg'))).toBe(sha(original));
  });
});
