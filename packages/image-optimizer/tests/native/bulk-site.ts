/**
 * A site for the bulk-run tests: the fake plugin context with the declared indexes enforced, the
 * fake `ctx.media.safe`, a settable clock, a private staging directory, and the native plugin, which
 * a test can restart (a new plugin instance over the same storage, host and staging, as after a
 * process restart).
 */
import { createHash } from 'node:crypto';

import type { ActionOutcome } from '../../src/admin.ts';
import { BULK_STORAGE, BULK_TASK, type BulkItem, type BulkRun } from '../../src/bulk.ts';
import type { StoredResult } from '../../src/job.ts';
import { createNativePlugin } from '../../src/native.ts';
import type { ImageProcessor, ProcessRequest, ProcessResult } from '../../src/processor/contract.ts';
import { createLocalProcessor } from '../../src/processor/local.ts';
import { createStaging } from '../../src/staging.ts';
import { fakeHost, type FakeMedia } from '../fake-host.ts';
import { fakeSafeMedia, LOCAL_PROFILE } from './fake-safe-media.ts';

export const START = Date.parse('2026-10-01T00:00:00.000Z');
const RESULT_INDEXES = { results: { indexes: ['runId', 'status', ['status', 'estimateBytes']] } };

type Handler = (...args: unknown[]) => Promise<unknown>;
export type Page = { blocks: Array<Record<string, unknown> & { type: string }>; toast?: { type: string; message: string } };

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * The real local processor behind a cache by input digest and settings: identical inputs are encoded
 * once. Everything after the encode (staging, fencing, the host's checks) runs for every image.
 */
export function cachedProcessor(base: ImageProcessor = createLocalProcessor()): ImageProcessor & { encodes: () => number } {
  const cache = new Map<string, Promise<ProcessResult>>();
  let encodes = 0;
  return {
    capabilities: () => base.capabilities(),
    async process(request: ProcessRequest) {
      const key = `${sha(request.bytes)}:${request.preset}:${request.metadata?.removeGps ?? false}`;
      let result = cache.get(key);
      if (!result) {
        encodes += 1;
        result = base.process({ ...request, bytes: Uint8Array.from(request.bytes) });
        cache.set(key, result);
        result.catch(() => cache.delete(key));
      }
      const done = await result;
      return done.status === 'processed' ? { ...done, output: Uint8Array.from(done.output) } : done;
    },
    encodes: () => encodes,
  };
}

export interface SiteImage {
  id: string;
  bytes: Uint8Array;
  mimeType?: string;
  width: number;
  height: number;
  createdAt?: string;
}

export interface SiteOptions {
  images: SiteImage[];
  stagingDirectory: string;
  processor?: ImageProcessor;
  /** Defaults to the fake host's profile; `[]` is the shipped, empty allowlist. */
  qualifiedProfiles?: Array<Record<string, string>>;
  limits?: { items?: number; wallTimeMs?: number };
}

export function bulkSite(options: SiteOptions) {
  const library: FakeMedia[] = options.images.map((image) => ({
    id: image.id,
    filename: `${image.id}.${(image.mimeType ?? 'image/jpeg').split('/')[1]}`,
    mimeType: image.mimeType ?? 'image/jpeg',
    size: image.bytes.byteLength,
    width: image.width,
    height: image.height,
    bytes: Uint8Array.from(image.bytes),
    createdAt: image.createdAt ?? new Date(START - 3_600_000).toISOString(),
  }));
  const host = fakeHost(library, { readBytes: true, storage: { ...RESULT_INDEXES, ...BULK_STORAGE } });
  host.settings.set('minSavingsKB', 1);
  host.settings.set('minSavingsPercent', 5);
  const safe = fakeSafeMedia(library);
  (host.ctx.media as unknown as { safe: unknown }).safe = safe.access();
  const staging = createStaging({ directory: options.stagingDirectory });
  const processor = options.processor ?? cachedProcessor();
  let time = START;
  const now = () => new Date(time);

  const make = () =>
    createNativePlugin({
      processor: () => processor,
      qualifiedProfiles: options.qualifiedProfiles ?? [LOCAL_PROFILE],
      staging: () => staging,
      now,
      ...(options.limits ? { limits: options.limits } : {}),
    });
  let plugin = make();

  const handler = (entry: unknown) => (typeof entry === 'function' ? entry : (entry as { handler: Handler }).handler) as Handler;
  const route = (name: string, input?: unknown) =>
    handler(plugin.routes[name as keyof typeof plugin.routes])({
      ...host.ctx,
      input,
      request: new Request('https://site.test/', { method: 'POST' }),
    });
  const cron = (name: string) => handler(plugin.hooks.cron)({ name, scheduledAt: now().toISOString() }, host.ctx);

  const items = (runId?: string) =>
    [...(host.collections.get('items') ?? new Map()).values()].filter((item) => !runId || (item as BulkItem).runId === runId) as BulkItem[];

  return {
    host,
    safe,
    library,
    staging,
    processor,
    get plugin() {
      return plugin;
    },
    /** A new plugin instance over the same site, as after the process restarted. */
    restart() {
      plugin = make();
    },
    now,
    advance(ms: number) {
      time += ms;
    },
    route,
    admin: (input: unknown) => route('admin', input) as Promise<Page>,
    apply: (mediaId: string) => route('apply', { mediaId }) as Promise<ActionOutcome>,
    /** One tick of the bulk task, as the scheduler runs it. */
    tick: () => cron(BULK_TASK),
    /**
     * Ticks a minute apart, as the scheduler runs them, until no run is active or `max` ticks have
     * run; returns the ticks run.
     */
    async drain(max = 200) {
      for (let tick = 1; tick <= max; tick += 1) {
        await cron(BULK_TASK);
        if (!host.tasks.has(BULK_TASK)) return tick;
        time += 60_000;
      }
      return max;
    },
    async scan(ticks = 20) {
      await route('admin', { type: 'block_action', action_id: 'start_scan' });
      for (let tick = 0; tick < ticks && host.state()?.phase !== 'complete'; tick += 1) await cron('scan-step');
    },
    items,
    item: (runId: string, mediaId: string) => host.collections.get('items')?.get(`${runId}:${mediaId}`) as BulkItem | undefined,
    run: (runId: string) => host.collections.get('runs')?.get(runId) as BulkRun | undefined,
    media: (id: string) => library.find((item) => item.id === id),
    /** Measured, flagged results as a measured scan would have stored them, for every image given. */
    seedMeasured(ids: string[], runId = '2026-09-30T00:00:00.000Z') {
      ids.forEach((id, index) => {
        const media = library.find((item) => item.id === id)!;
        const result: StoredResult = {
          runId,
          filename: media.filename,
          mimeType: media.mimeType,
          size: media.size,
          width: media.width ?? null,
          height: media.height ?? null,
          status: 'flagged',
          reason: null,
          format: media.mimeType === 'image/png' ? 'png' : media.mimeType === 'image/webp' ? 'webp' : 'jpeg',
          findings: [],
          // Larger first in the order given.
          estimateBytes: 1_000_000 - index,
          estimateBasis: null,
          scannedAt: runId,
          basis: 'measured',
          measured: null,
        };
        host.results.set(id, result);
      });
    },
  };
}

export type BulkSite = ReturnType<typeof bulkSite>;

/** A promise and the function that settles it. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
