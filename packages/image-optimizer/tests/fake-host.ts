/**
 * In-memory stand-ins for the plugin context with the host's semantics: revisioned KV, newest-first
 * keyset media listing, indexed storage queries with cursors, and settings and cron. Every context
 * method counts as one bridge call, as it does in the Cloudflare sandbox.
 */
import type { PluginContext } from 'emdash/plugin';

import { SCAN_STATE_KEY, type ScanDeps, type ScanRun, type StoredResult } from '../src/job.ts';

export interface FakeMedia {
  id: string;
  filename: string;
  mimeType: string;
  size: number | null;
  width?: number | null;
  height?: number | null;
}

type Where = Record<string, unknown>;

function matches(data: Record<string, unknown>, where: Where = {}): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = data[field];
    if (typeof condition === 'object' && condition !== null && 'lt' in condition) {
      return (value as string) < (condition as { lt: string }).lt;
    }
    return value === condition;
  });
}

export function jpegs(count: number, overrides: Partial<FakeMedia> = {}, prefix = 'm'): FakeMedia[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${String(index).padStart(4, '0')}`,
    filename: `photo-${index}.jpg`,
    mimeType: 'image/jpeg',
    size: 600_000,
    width: 1200,
    height: 800,
    ...overrides,
  }));
}

export function fakeHost(library: FakeMedia[]) {
  const kv = new Map<string, { value: unknown; revision: number }>();
  const results = new Map<string, StoredResult>();
  const settings = new Map<string, unknown>();
  const tasks = new Map<string, { schedule: string }>();
  const listCalls: Array<string | undefined> = [];
  const logs: Array<{ level: string; message: string }> = [];
  let calls = 0;
  let revisions = 0;
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  let beforeList: (() => Promise<void>) | undefined;
  let beforeCas: (() => Promise<void>) | undefined;

  /** Wraps every method so each call is counted as one bridge call. */
  function bridge<T extends object>(methods: T): T {
    return Object.fromEntries(
      Object.entries(methods).map(([name, method]) => [
        name,
        (...args: unknown[]) => {
          calls += 1;
          return (method as (...args: unknown[]) => unknown)(...args);
        },
      ]),
    ) as T;
  }

  const kvAccess = bridge({
    async get<T>(key: string) {
      return (structuredClone(kv.get(key)?.value) as T | undefined) ?? null;
    },
    async getVersioned<T>(key: string) {
      const entry = kv.get(key);
      return entry ? { value: structuredClone(entry.value) as T, revision: String(entry.revision) } : null;
    },
    async compareAndSet(key: string, expected: string | null, value: unknown) {
      const hook = beforeCas;
      beforeCas = undefined;
      await hook?.();
      const entry = kv.get(key);
      if ((entry ? String(entry.revision) : null) !== expected) return { applied: false } as const;
      revisions += 1;
      kv.set(key, { value: structuredClone(value), revision: revisions });
      return { applied: true, revision: String(revisions) } as const;
    },
  });

  const media = bridge({
    async list(options?: { limit?: number; cursor?: string; mimeType?: string }) {
      listCalls.push(options?.cursor);
      const hook = beforeList;
      beforeList = undefined;
      await hook?.();
      const prefix = options?.mimeType ?? '';
      const matching = library.filter((item) => item.mimeType.startsWith(prefix));
      // Keyset cursor, like the host: the next page starts after the last listed item, so items
      // added at the front (newer uploads) are never reached.
      const start = options?.cursor ? matching.findIndex((item) => item.id === options.cursor) + 1 : 0;
      const limit = options?.limit ?? 50;
      const items = matching.slice(start, start + limit);
      const hasMore = start + limit < matching.length;
      return {
        items: items.map((item) => ({ ...item, url: '', createdAt: '' })),
        hasMore,
        ...(hasMore ? { cursor: items.at(-1)!.id } : {}),
      };
    },
    async get(id: string) {
      const item = library.find((candidate) => candidate.id === id);
      return item ? { ...item, url: '', createdAt: '' } : null;
    },
  });

  const storage = bridge({
    async put(id: string, data: StoredResult) {
      results.set(id, structuredClone(data));
    },
    async putMany(items: Array<{ id: string; data: StoredResult }>) {
      for (const { id, data } of items) results.set(id, structuredClone(data));
    },
    async query(options: { where?: Where; orderBy?: Record<string, 'desc'>; limit?: number; cursor?: string }) {
      let matching = [...results].filter(([, data]) => matches(data as unknown as Record<string, unknown>, options.where));
      const [orderField] = Object.keys(options.orderBy ?? {});
      if (orderField) {
        matching = matching.sort(
          ([, a], [, b]) =>
            ((b as unknown as Record<string, number>)[orderField] ?? 0) -
            ((a as unknown as Record<string, number>)[orderField] ?? 0),
        );
      }
      if (options.cursor !== undefined && !/^\d+$/.test(options.cursor)) throw new Error('Invalid pagination cursor');
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = options.limit ?? 50;
      const hasMore = start + limit < matching.length;
      return {
        items: matching.slice(start, start + limit).map(([id, data]) => ({ id, data })),
        hasMore,
        ...(hasMore ? { cursor: String(start + limit) } : {}),
      };
    },
    async count(where?: Where) {
      return [...results.values()].filter((data) => matches(data as unknown as Record<string, unknown>, where)).length;
    },
    async deleteMany(ids: string[]) {
      for (const id of ids) results.delete(id);
      return ids.length;
    },
  });

  const settingsAccess = bridge({
    async get<T>(key: string) {
      return (settings.get(key) as T | undefined) ?? null;
    },
    async list() {
      return [...settings].map(([key, value]) => ({ key, value }));
    },
  });

  const cron = bridge({
    async schedule(name: string, options: { schedule: string }) {
      tasks.set(name, { schedule: options.schedule });
    },
    async cancel(name: string) {
      tasks.delete(name);
    },
  });

  const log = bridge({
    debug: (message: string) => void logs.push({ level: 'debug', message }),
    info: (message: string) => void logs.push({ level: 'info', message }),
    warn: (message: string) => void logs.push({ level: 'warn', message }),
    error: (message: string) => void logs.push({ level: 'error', message }),
  });

  const deps: ScanDeps = {
    kv: kvAccess as unknown as ScanDeps['kv'],
    media: media as unknown as ScanDeps['media'],
    results: storage as unknown as ScanDeps['results'],
    log: log as unknown as ScanDeps['log'],
    now: () => new Date((clock += 1000)),
  };

  const ctx = {
    plugin: { id: 'image-optimizer', version: '0.1.0' },
    kv: kvAccess,
    settings: settingsAccess,
    storage: { results: storage },
    media,
    cron,
    log,
  } as unknown as PluginContext;

  return {
    deps,
    ctx,
    results,
    settings,
    tasks,
    logs,
    listCalls,
    library,
    state: () => kv.get(SCAN_STATE_KEY)?.value as ScanRun | undefined,
    /** Bridge calls made while `action` runs. */
    async callsDuring(action: () => Promise<unknown>): Promise<number> {
      const before = calls;
      await action();
      return calls - before;
    },
    onNextList(hook: () => Promise<void>) {
      beforeList = hook;
    },
    onNextCompareAndSet(hook: () => Promise<void>) {
      beforeCas = hook;
    },
    /** Changes the scan state's revision without a counted call, as another invocation would. */
    touchState() {
      const entry = kv.get(SCAN_STATE_KEY);
      if (!entry) return;
      revisions += 1;
      kv.set(SCAN_STATE_KEY, { value: entry.value, revision: revisions });
    },
  };
}
