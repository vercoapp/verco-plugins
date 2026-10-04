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
  /** The file, for hosts created with `readBytes`. */
  bytes?: Uint8Array;
  /** ISO time of the upload; media lists newest first, so later items should not be newer. */
  createdAt?: string;
}

type Where = Record<string, unknown>;

/** Equality, `in`, and the range filters `lt`, `lte`, `gt` and `gte`, as the host's storage offers. */
function matches(data: Record<string, unknown>, where: Where = {}): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = data[field] as string | number | undefined | null;
    if (typeof condition === 'object' && condition !== null) {
      const filter = condition as { in?: unknown[]; lt?: string | number; lte?: string | number; gt?: string | number; gte?: string | number };
      if (filter.in) return filter.in.includes(value);
      // A missing field compares as unknown in SQL: no range matches it.
      if (value === undefined || value === null) return false;
      if (filter.lt !== undefined && !(value < filter.lt)) return false;
      if (filter.lte !== undefined && !(value <= filter.lte)) return false;
      if (filter.gt !== undefined && !(value > filter.gt)) return false;
      if (filter.gte !== undefined && !(value >= filter.gte)) return false;
      return true;
    }
    return value === condition;
  });
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Declared indexes per collection; queries on other fields are refused, as by the host. */
export type IndexDeclarations = Record<string, { indexes: ReadonlyArray<string | readonly string[]> }>;

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

/** A media item as the host lists it: metadata only. */
function listed({ bytes: _bytes, ...item }: FakeMedia) {
  return { url: '', createdAt: '', ...item };
}

/**
 * `readBytes`: give the context `media.readBytes`, as the native edition's `media:bytes:read` does. It
 * returns the stored array itself, not a copy, so writing into it would change the library and a
 * before-and-after comparison would see it.
 */
export function fakeHost(library: FakeMedia[], options: { readBytes?: boolean; storage?: IndexDeclarations } = {}) {
  const kv = new Map<string, { value: unknown; revision: number }>();
  const readCalls: string[] = [];
  const results = new Map<string, StoredResult>();
  /**
   * Revisions of stored documents by object identity: every write stores a new object, so a test
   * that sets a document on a collection's map directly also changes its revision.
   */
  const documentRevisions = new WeakMap<object, string>();
  const collections = new Map<string, Map<string, unknown>>([['results', results as Map<string, unknown>]]);
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
    async compareAndDelete(key: string, expected: string) {
      const entry = kv.get(key);
      if (!entry || String(entry.revision) !== expected) return { applied: false } as const;
      kv.delete(key);
      return { applied: true } as const;
    },
    async set(key: string, value: unknown) {
      revisions += 1;
      kv.set(key, { value: structuredClone(value), revision: revisions });
    },
    async delete(key: string) {
      return kv.delete(key);
    },
    async list(prefix = '') {
      return [...kv]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({ key, value: structuredClone(entry.value) }));
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
        items: items.map(listed),
        hasMore,
        ...(hasMore ? { cursor: items.at(-1)!.id } : {}),
      };
    },
    async get(id: string) {
      const item = library.find((candidate) => candidate.id === id);
      return item ? listed(item) : null;
    },
    ...(options.readBytes
      ? {
          async readBytes(id: string, read?: { maxBytes?: number }) {
            readCalls.push(id);
            const item = library.find((candidate) => candidate.id === id);
            if (!item?.bytes) throw new Error('Media item is not ready or does not exist');
            // The host's limit error is a RangeError, as in EmDash.
            if (item.bytes.byteLength > (read?.maxBytes ?? 10 * 1024 * 1024)) throw new RangeError('Media exceeds the limit');
            return { bytes: item.bytes, filename: item.filename, mimeType: item.mimeType, size: item.bytes.byteLength };
          },
        }
      : {}),
  });

  let documentSequence = 0;
  function revisionOf(document: unknown): string {
    const object = document as object;
    let revision = documentRevisions.get(object);
    if (!revision) {
      revision = `doc-${(documentSequence += 1)}`;
      documentRevisions.set(object, revision);
    }
    return revision;
  }

  function collection(name: string) {
    let documents = collections.get(name);
    if (!documents) {
      documents = new Map();
      collections.set(name, documents);
    }
    const store = documents;
    const declared = options.storage?.[name];
    const indexed = declared ? new Set(declared.indexes.flatMap((index) => (typeof index === 'string' ? [index] : [...index]))) : null;
    const checkFields = (fields: string[]) => {
      for (const field of fields) if (indexed && !indexed.has(field)) throw new Error(`Cannot query on non-indexed field '${field}'.`);
    };
    const write = (id: string, data: unknown) => {
      const copy = structuredClone(data);
      store.set(id, copy);
      return revisionOf(copy);
    };
    return bridge({
      async get(id: string) {
        return store.has(id) ? structuredClone(store.get(id)) : null;
      },
      async getMany(ids: string[]) {
        return new Map(ids.filter((id) => store.has(id)).map((id) => [id, structuredClone(store.get(id))]));
      },
      async getVersioned(id: string) {
        if (!store.has(id)) return null;
        const document = store.get(id);
        return { value: structuredClone(document), revision: revisionOf(document) };
      },
      async compareAndSet(id: string, expected: string | null, data: unknown) {
        const current = store.has(id) ? revisionOf(store.get(id)) : null;
        if (current !== expected) return { applied: false } as const;
        return { applied: true, revision: write(id, data) } as const;
      },
      async put(id: string, data: unknown) {
        write(id, data);
      },
      async putMany(items: Array<{ id: string; data: unknown }>) {
        for (const { id, data } of items) write(id, data);
      },
      async delete(id: string) {
        return store.delete(id);
      },
      async query(query: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'>; limit?: number; cursor?: string }) {
        checkFields([...Object.keys(query.where ?? {}), ...Object.keys(query.orderBy ?? {})]);
        let matching = [...store].filter(([, data]) => matches(data as Record<string, unknown>, query.where));
        const [order] = Object.entries(query.orderBy ?? {});
        if (order) {
          const [field, direction] = order;
          const sign = direction === 'desc' ? -1 : 1;
          matching = matching.sort(
            ([, a], [, b]) =>
              sign * compare((a as Record<string, unknown>)[field] ?? 0, (b as Record<string, unknown>)[field] ?? 0),
          );
        }
        if (query.cursor !== undefined && !/^\d+$/.test(query.cursor)) throw new Error('Invalid pagination cursor');
        const start = query.cursor ? Number(query.cursor) : 0;
        const limit = Math.min(query.limit ?? 50, 100);
        const hasMore = start + limit < matching.length;
        return {
          items: matching.slice(start, start + limit).map(([id, data]) => ({ id, data: structuredClone(data) })),
          hasMore,
          ...(hasMore ? { cursor: String(start + limit) } : {}),
        };
      },
      async count(where?: Where) {
        checkFields(Object.keys(where ?? {}));
        return [...store.values()].filter((data) => matches(data as Record<string, unknown>, where)).length;
      },
      async deleteMany(ids: string[]) {
        for (const id of ids) store.delete(id);
        return ids.length;
      },
    });
  }

  const storage = collection('results');

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
    storage: { results: storage, runs: collection('runs'), items: collection('items') },
    media,
    cron,
    log,
  } as unknown as PluginContext;

  return {
    deps,
    ctx,
    results,
    /** Every collection's documents by ID, as stored. */
    collections,
    settings,
    tasks,
    logs,
    listCalls,
    /** Media IDs passed to `readBytes`, in order. */
    readCalls,
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
    /** Writes the scan state as another edition's invocation would have left it. */
    seedState(run: ScanRun) {
      revisions += 1;
      kv.set(SCAN_STATE_KEY, { value: structuredClone(run), revision: revisions });
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
