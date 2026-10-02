/**
 * Bulk runs and upload automation, for the native edition only. A run applies (or restores) many
 * images through the same fenced single-image path as the report's buttons (`mutations.ts`), one at
 * a time, in bounded scheduled ticks, so it continues without an open browser and survives restarts.
 *
 * - **Storage.** One record per run in the `runs` collection, one per image in `items` (keyed
 *   `<run ID>:<media ID>`). KV holds the pointer to the active run (`state:bulk`) and the upload
 *   automation's state (`state:automation`). Output bytes never go to storage; they wait in the
 *   private staging area, keyed by host operation ID.
 * - **Item states.** `queued → processing → ready_to_commit → committing → optimized`, plus
 *   `skipped`, `retry_wait`, `conflict`, `failed` and `restored`. A restore run goes from `queued`
 *   to `committing` directly.
 * - **Leases.** A worker claims an item with a conditional write (the item's storage revision), which
 *   records it as the lease holder until the lease expires. Each later step (output staged, commit
 *   started, outcome) is another conditional write from the revision the holder wrote last, so a
 *   worker whose item was taken over after its lease expired cannot advance it and does not commit.
 *   A worker that takes over resumes the same host operation (deterministic operation IDs, the staged
 *   output reused), so the host's replay is the backstop when a commit outlives its lease.
 * - **One run at a time.** The active run's ID sits in a KV record written with compare-and-set. A
 *   run does not start, and does not advance, while a scan is running, and a scan does not start
 *   while a run is active, so their records never interleave.
 * - **Upload automation** (a native setting, off by default) only enqueues uploads into a standing
 *   queue, which ticks work through when no run is active. A reconciliation pass lists recent media
 *   and enqueues what the hook missed; an image is enqueued at most once, because its item is created
 *   only when absent.
 */
import { randomUUID } from 'node:crypto';

import type { MediaAfterUploadEvent, PluginContext } from 'emdash/plugin';

import type { BlockResponse } from '@emdash-cms/blocks/server';

import {
  ACTION_BULK_APPLY_ALL,
  ACTION_BULK_APPLY_PAGE,
  ACTION_BULK_CANCEL,
  ACTION_BULK_PAUSE,
  ACTION_BULK_RECONCILE,
  ACTION_BULK_RESTORE_ALL,
  ACTION_BULK_RESUME,
  ACTION_BULK_RETRY,
  type ActionOutcome,
  type AppliedRecord,
  type BulkCounts,
  type BulkItemView,
  type BulkView,
} from './admin.ts';
import type { NativeMutations } from './handlers.ts';
import { readScan, type StoredResult } from './job.ts';
import { MEASURED_ITEMS_PER_TICK, MEASURED_TICK_WALL_MS, type MeasureLimits } from './measure.ts';
import { APPLIED_PREFIX } from './mutations.ts';

export const BULK_TASK = 'bulk-step';
export const BULK_TASK_SCHEDULE = '* * * * *';
/** The active run's ID. */
export const BULK_STATE_KEY = 'state:bulk';
/** Upload automation: when it was switched on, and the reconciliation pass's progress. */
export const AUTOMATION_KEY = 'state:automation';
/** The standing queue that upload automation fills. */
export const AUTOMATION_RUN_ID = 'automation';
/** The native setting that switches upload automation on. */
export const AUTOMATION_SETTING = 'autoOptimize';

/**
 * Longer than one image can take: the read, the processor's 60 s wall-time kill, and the commit. A
 * lease that expires earlier only lets a second worker resume the same host operation.
 */
export const LEASE_MS = 5 * 60_000;
/** Claims of one item before it is recorded as failed; a lease that expired counts as one. */
export const MAX_ITEM_ATTEMPTS = 5;
/** First wait before a retry; it doubles with each attempt, up to `RETRY_MAX_MS`. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;
/** Images one request may select. */
export const MAX_SELECTION = 1000;
/** Pages of 100 results enqueued per tick while a run prepares. */
export const ENQUEUE_PAGES_PER_TICK = 20;
/** How often the reconciliation pass looks for uploads the hook missed, and pages per tick. */
export const RECONCILE_INTERVAL_MS = 60 * 60_000;
export const RECONCILE_PAGES_PER_TICK = 3;
/** Items whose state the report lists by name. */
const ITEMS_SHOWN = 20;
const PAGE = 100;

export const ITEM_STATES = [
  'queued',
  'processing',
  'ready_to_commit',
  'committing',
  'retry_wait',
  'optimized',
  'restored',
  'skipped',
  'conflict',
  'failed',
] as const;
export type ItemState = (typeof ITEM_STATES)[number];
/** States an item can still leave. A run is finished when none of its items is in one. */
export const OPEN_STATES: readonly ItemState[] = ['queued', 'processing', 'ready_to_commit', 'committing', 'retry_wait'];
/** States held under a lease. */
const HELD_STATES: readonly ItemState[] = ['processing', 'ready_to_commit', 'committing'];

export type RunKind = 'apply' | 'restore';
export type RunStatus = 'running' | 'paused' | 'cancelling' | 'complete' | 'cancelled';
export type Selection =
  /** Apply: every flagged, measured result. */
  | { mode: 'eligible' }
  /** Restore: every image this plugin has optimized. */
  | { mode: 'optimized' }
  | { mode: 'selected'; mediaIds: string[] }
  /** The automation queue, filled by uploads and reconciliation. */
  | { mode: 'uploads' };

export interface BulkRun {
  runId: string;
  kind: RunKind;
  status: RunStatus;
  selection: Selection;
  /** Whether every selected image has an item. Items are processed only after that. */
  prepared: boolean;
  /** While preparing: where enqueueing continues. */
  cursor: string | null;
  enqueued: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface BulkItem {
  runId: string;
  mediaId: string;
  filename: string;
  kind: RunKind;
  state: ItemState;
  /** Processing order within the run: largest measured saving first. */
  order: number;
  /** Claims so far. */
  attempts: number;
  /** `retry_wait` only: when the item may be claimed again. */
  nextAttemptAt: string;
  leaseOwner: string | null;
  /** Empty when no lease is held, so it sorts before every time. */
  leaseExpiresAt: string;
  /** The host operation, once output is staged for it. */
  operationId: string | null;
  /** Why the item ended as it did: a skip reason, a host code or a processor error code. */
  code: string | null;
  message: string | null;
  inputBytes: number | null;
  outputBytes: number | null;
  /** The host had already made the change and returned its earlier receipt. */
  replayed: boolean;
  updatedAt: string;
}

interface AutomationState {
  /** Uploads from this time on are optimized; switching the setting off forgets it. */
  enabledAt: string;
  /** The reconciliation pass: the media list cursor while one is in progress. */
  cursor: string | null;
  passing: boolean;
  lastPassAt: string | null;
}

/** Collections of the native edition only. The sandboxed manifest does not declare them. */
export const BULK_STORAGE = {
  runs: { indexes: ['status', 'createdAt'] },
  items: {
    indexes: [
      'runId',
      'mediaId',
      ['runId', 'state'],
      ['runId', 'state', 'order'],
      ['runId', 'state', 'nextAttemptAt'],
      ['runId', 'state', 'leaseExpiresAt'],
    ],
  },
} as const;

type Settings = ReadonlyMap<string, unknown>;
type Toast = NonNullable<BlockResponse['toast']>;
type Collection = PluginContext['storage'][string];

export interface BulkOptions {
  mutations: NativeMutations;
  now?: () => Date;
  /** Milliseconds from a monotonic clock, for the tick's wall-time bound. */
  clock?: () => number;
  limits?: Partial<MeasureLimits>;
}

export type StartOutcome =
  | { ok: true; run: BulkRun }
  | { ok: false; error: 'RUN_ACTIVE' | 'SCAN_RUNNING' | 'UNAVAILABLE' | 'INVALID_SELECTION' | 'CRON_UNAVAILABLE'; message: string };

export type ControlOutcome = { ok: true; run: BulkRun; changed: number } | { ok: false; error: 'NO_RUN' | 'NOT_ALLOWED' | 'RUN_ACTIVE'; message: string };

export interface TickReport {
  runId: string | null;
  /** Items claimed by this tick. */
  claimed: number;
  /** Whether more work is waiting: an active run, or automation switched on. */
  active: boolean;
}

const isOpen = (state: ItemState) => OPEN_STATES.includes(state);
const itemId = (runId: string, mediaId: string) => `${runId}:${mediaId}`;

function storage(ctx: PluginContext): { runs: Collection; items: Collection; results: Collection | undefined } {
  const { runs, items, results } = ctx.storage;
  if (!runs || !items) throw new Error('The runs and items storage collections are not declared');
  return { runs, items, results };
}

async function settingsOf(ctx: PluginContext): Promise<Settings> {
  return new Map((await ctx.settings.list()).map(({ key, value }) => [key, value]));
}

/** Whether upload automation is switched on in the settings. */
export function automationEnabled(settings: Settings): boolean {
  return settings.get(AUTOMATION_SETTING) === true;
}

const MEASURABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Queries every page of `where` and calls `each` with the items of each page. */
async function eachPage(
  collection: Collection,
  where: Record<string, unknown>,
  each: (items: Array<{ id: string; data: BulkItem }>) => Promise<void>,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const listed = await collection.query({ where: where as never, limit: PAGE, ...(cursor ? { cursor } : {}) });
    await each(listed.items as Array<{ id: string; data: BulkItem }>);
    if (!listed.hasMore || !listed.cursor) return;
    cursor = listed.cursor;
  }
}

export function createBulk(options: BulkOptions) {
  const { mutations } = options;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (() => performance.now());
  const limits = { items: MEASURED_ITEMS_PER_TICK, wallTimeMs: MEASURED_TICK_WALL_MS, ...options.limits };
  const iso = () => now().toISOString();
  const later = (ms: number) => new Date(now().getTime() + ms).toISOString();

  async function activeRunId(ctx: PluginContext): Promise<string | null> {
    return (await ctx.kv.get<{ runId: string }>(BULK_STATE_KEY))?.runId ?? null;
  }

  async function readRun(ctx: PluginContext, runId: string): Promise<{ run: BulkRun; revision: string } | null> {
    const found = await storage(ctx).runs.getVersioned(runId);
    return found ? { run: found.value as BulkRun, revision: found.revision } : null;
  }

  /** Rewrites a run with conditional writes; `change` returns `null` to leave it as it is. */
  async function updateRun(
    ctx: PluginContext,
    runId: string,
    change: (run: BulkRun) => BulkRun | null,
  ): Promise<BulkRun | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const found = await readRun(ctx, runId);
      if (!found) return null;
      const next = change(found.run);
      if (!next) return found.run;
      const written = await storage(ctx).runs.compareAndSet(runId, found.revision, { ...next, updatedAt: iso() });
      if (written.applied) return { ...next, updatedAt: iso() };
    }
    return null;
  }

  /** Clears the active-run pointer if it still names `runId`. */
  async function release(ctx: PluginContext, runId: string): Promise<void> {
    const pointer = await ctx.kv.getVersioned<{ runId: string }>(BULK_STATE_KEY);
    if (pointer?.value.runId === runId) await ctx.kv.compareAndDelete(BULK_STATE_KEY, pointer.revision);
  }

  function newItem(run: Pick<BulkRun, 'runId' | 'kind'>, mediaId: string, filename: string, order: number): BulkItem {
    return {
      runId: run.runId,
      mediaId,
      filename,
      kind: run.kind,
      state: 'queued',
      order,
      attempts: 0,
      nextAttemptAt: '',
      leaseOwner: null,
      leaseExpiresAt: '',
      operationId: null,
      code: null,
      message: null,
      inputBytes: null,
      outputBytes: null,
      replayed: false,
      updatedAt: iso(),
    };
  }

  /** Creates the item unless the run already has one for this image. Returns whether it was created. */
  async function enqueue(ctx: PluginContext, item: BulkItem): Promise<boolean> {
    const written = await storage(ctx).items.compareAndSet(itemId(item.runId, item.mediaId), null, item);
    return written.applied;
  }

  // --- Starting and controlling runs ---------------------------------------------------------

  async function start(ctx: PluginContext, kind: RunKind, selection: Selection): Promise<StartOutcome> {
    if (selection.mode === 'selected') {
      const ids = [...new Set(selection.mediaIds)];
      if (ids.length === 0 || ids.length > MAX_SELECTION || ids.some((id) => typeof id !== 'string' || !id || id.length > 128)) {
        return { ok: false, error: 'INVALID_SELECTION', message: `Select between 1 and ${MAX_SELECTION} images.` };
      }
      selection = { mode: 'selected', mediaIds: ids };
    }
    if ((kind === 'apply' && selection.mode === 'optimized') || (kind === 'restore' && selection.mode === 'eligible') || selection.mode === 'uploads') {
      return { ok: false, error: 'INVALID_SELECTION', message: 'That selection does not fit this kind of run.' };
    }
    const view = await mutations.allowed(ctx);
    if (kind === 'apply' ? !view.apply : !view.restore) return { ok: false, error: 'UNAVAILABLE', message: view.message };
    if (!ctx.cron) return { ok: false, error: 'CRON_UNAVAILABLE', message: 'This site cannot run scheduled tasks.' };
    const scan = await readScan(ctx);
    if (scan && scan.phase !== 'complete') {
      return { ok: false, error: 'SCAN_RUNNING', message: 'A scan is running. Start the run once it has finished.' };
    }

    const pointer = await ctx.kv.getVersioned<{ runId: string }>(BULK_STATE_KEY);
    if (pointer) {
      const current = await readRun(ctx, pointer.value.runId);
      if (current && (current.run.status === 'running' || current.run.status === 'paused' || current.run.status === 'cancelling')) {
        return { ok: false, error: 'RUN_ACTIVE', message: 'A run is already active. Pause, cancel or wait for it first.' };
      }
    }
    const createdAt = iso();
    const run: BulkRun = {
      runId: `${createdAt}-${randomUUID().slice(0, 8)}`,
      kind,
      status: 'running',
      selection,
      prepared: false,
      cursor: null,
      enqueued: 0,
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
    };
    // The record first, so a tick never finds the pointer without it; then the pointer, which of two
    // requests starting a run at once only one moves.
    await storage(ctx).runs.put(run.runId, run);
    const claimed = await ctx.kv.compareAndSet(BULK_STATE_KEY, pointer?.revision ?? null, { runId: run.runId });
    if (!claimed.applied) {
      await storage(ctx).runs.delete(run.runId);
      return { ok: false, error: 'RUN_ACTIVE', message: 'Another run started at the same time.' };
    }
    await ctx.cron.schedule(BULK_TASK, { schedule: BULK_TASK_SCHEDULE });
    return { ok: true, run };
  }

  /** The active run, or else the most recent one. */
  async function currentRun(ctx: PluginContext): Promise<BulkRun | null> {
    const active = await activeRunId(ctx);
    if (active) {
      const found = await readRun(ctx, active);
      if (found) return found.run;
    }
    const recent = await storage(ctx).runs.query({ orderBy: { createdAt: 'desc' }, limit: 2 });
    const manual = recent.items.map(({ data }) => data as BulkRun).find((run) => run.runId !== AUTOMATION_RUN_ID);
    return manual ?? null;
  }

  async function control(ctx: PluginContext, action: 'pause' | 'resume' | 'cancel'): Promise<ControlOutcome> {
    const runId = await activeRunId(ctx);
    if (!runId) return { ok: false, error: 'NO_RUN', message: 'No run is active.' };
    const allowed: Record<typeof action, RunStatus[]> = {
      pause: ['running'],
      resume: ['paused'],
      cancel: ['running', 'paused'],
    };
    const target: Record<typeof action, RunStatus> = { pause: 'paused', resume: 'running', cancel: 'cancelling' };
    let refused = false;
    const run = await updateRun(ctx, runId, (current) => {
      if (!allowed[action].includes(current.status)) {
        refused = true;
        return null;
      }
      // Cancelling stops selecting images too: the run ends once the items it has are settled.
      return action === 'cancel'
        ? { ...current, status: target[action], prepared: true, cursor: null }
        : { ...current, status: target[action] };
    });
    if (!run) return { ok: false, error: 'NO_RUN', message: 'No run is active.' };
    if (refused) return { ok: false, error: 'NOT_ALLOWED', message: `The run is ${run.status}; it cannot ${action} now.` };
    if (action !== 'pause') await ctx.cron?.schedule(BULK_TASK, { schedule: BULK_TASK_SCHEDULE });
    return { ok: true, run, changed: 1 };
  }

  /** Queues the failed items of the active or most recent run again, reopening a finished run. */
  async function retryFailed(ctx: PluginContext): Promise<ControlOutcome> {
    const run = await currentRun(ctx);
    if (!run) return { ok: false, error: 'NO_RUN', message: 'There is no run to retry.' };
    if (run.status === 'cancelling') return { ok: false, error: 'NOT_ALLOWED', message: 'The run is being cancelled.' };
    if (run.status === 'complete' || run.status === 'cancelled') {
      // Reopening takes the pointer, so it cannot overlap another run.
      const pointer = await ctx.kv.getVersioned<{ runId: string }>(BULK_STATE_KEY);
      if (pointer && pointer.value.runId !== run.runId) return { ok: false, error: 'RUN_ACTIVE', message: 'Another run is active.' };
      const scan = await readScan(ctx);
      if (scan && scan.phase !== 'complete') return { ok: false, error: 'NOT_ALLOWED', message: 'A scan is running.' };
      const claimed = await ctx.kv.compareAndSet(BULK_STATE_KEY, pointer?.revision ?? null, { runId: run.runId });
      if (!claimed.applied) return { ok: false, error: 'RUN_ACTIVE', message: 'Another run started at the same time.' };
    }
    const { items } = storage(ctx);
    let changed = 0;
    await eachPage(items, { runId: run.runId, state: 'failed' }, async (page) => {
      for (const { id } of page) {
        const found = await items.getVersioned(id);
        const item = found?.value as BulkItem | undefined;
        if (!found || item?.state !== 'failed') continue;
        const next: BulkItem = { ...item, state: 'queued', attempts: 0, code: null, message: null, updatedAt: iso() };
        if ((await items.compareAndSet(id, found.revision, next)).applied) changed += 1;
      }
    });
    const reopened = await updateRun(ctx, run.runId, (current) =>
      current.status === 'complete' || current.status === 'cancelled' ? { ...current, status: 'running', finishedAt: null } : null,
    );
    await ctx.cron?.schedule(BULK_TASK, { schedule: BULK_TASK_SCHEDULE });
    return { ok: true, run: reopened ?? run, changed };
  }

  // --- Upload automation ---------------------------------------------------------------------

  async function ensureAutomation(ctx: PluginContext, since?: string): Promise<AutomationState> {
    let state = await ctx.kv.get<AutomationState>(AUTOMATION_KEY);
    if (!state) {
      const fresh: AutomationState = { enabledAt: since ?? iso(), cursor: null, passing: true, lastPassAt: null };
      const written = await ctx.kv.compareAndSet(AUTOMATION_KEY, null, fresh);
      state = written.applied ? fresh : ((await ctx.kv.get<AutomationState>(AUTOMATION_KEY)) ?? fresh);
    }
    // The queue's record, created once; also after a stop between the two writes.
    const { runs } = storage(ctx);
    const run: BulkRun = {
      runId: AUTOMATION_RUN_ID,
      kind: 'apply',
      status: 'running',
      selection: { mode: 'uploads' },
      prepared: true,
      cursor: null,
      enqueued: 0,
      createdAt: state.enabledAt,
      updatedAt: state.enabledAt,
      finishedAt: null,
    };
    await runs.compareAndSet(AUTOMATION_RUN_ID, null, run);
    return state;
  }

  async function enqueueUpload(ctx: PluginContext, media: { id: string; filename: string; mimeType: string }, since?: string) {
    if (!MEASURABLE.has(media.mimeType.toLowerCase())) return false;
    await ensureAutomation(ctx, since);
    // The order of uploads: newest last.
    return enqueue(ctx, newItem({ runId: AUTOMATION_RUN_ID, kind: 'apply' }, media.id, media.filename, now().getTime()));
  }

  /**
   * The upload hook: enqueues the new image when automation is on, and never processes it here.
   * Never throws: an upload must succeed whatever happens to its optimization.
   */
  async function onUpload(event: MediaAfterUploadEvent, ctx: PluginContext): Promise<void> {
    try {
      // Nothing is queued where the host does not allow changes: the queue could never be worked.
      if (!automationEnabled(await settingsOf(ctx)) || !(await mutations.allowed(ctx)).apply) return;
      const since = event.media.createdAt || undefined;
      if (await enqueueUpload(ctx, event.media, since)) await ctx.cron?.schedule(BULK_TASK, { schedule: BULK_TASK_SCHEDULE });
    } catch (error) {
      ctx.log.warn('Upload not queued for optimization; the reconciliation pass will find it', {
        mediaId: event.media.id,
        error: String(error),
      });
    }
  }

  /**
   * One bounded step of the reconciliation pass: media newest first, from the cursor, until an item
   * older than the time automation was switched on. Every eligible image gets an item unless it has
   * one already. Runs once per `RECONCILE_INTERVAL_MS`. Returns how many it enqueued.
   */
  async function reconcile(ctx: PluginContext, state: AutomationState, force = false): Promise<number> {
    const media = ctx.media;
    if (!media) return 0;
    const due = state.passing || force || !state.lastPassAt || Date.parse(state.lastPassAt) + RECONCILE_INTERVAL_MS <= now().getTime();
    if (!due) return 0;
    let cursor = state.passing ? state.cursor : null;
    let done = false;
    let added = 0;
    for (let page = 0; page < RECONCILE_PAGES_PER_TICK && !done; page += 1) {
      const listed = await media.list({ limit: PAGE, mimeType: 'image/', ...(cursor ? { cursor } : {}) });
      for (const item of listed.items) {
        if (item.createdAt && item.createdAt < state.enabledAt) {
          done = true;
          break;
        }
        if (await enqueueUpload(ctx, item)) added += 1;
      }
      if (!listed.hasMore || !listed.cursor) done = true;
      else cursor = listed.cursor;
    }
    const next: AutomationState = done
      ? { ...state, cursor: null, passing: false, lastPassAt: iso() }
      : { ...state, cursor, passing: true };
    const current = await ctx.kv.getVersioned<AutomationState>(AUTOMATION_KEY);
    if (current && current.value.enabledAt === state.enabledAt) await ctx.kv.compareAndSet(AUTOMATION_KEY, current.revision, next);
    return added;
  }

  // --- Preparing a run -----------------------------------------------------------------------

  /** Creates the items of a run being prepared, a bounded number of pages per tick. */
  async function prepare(ctx: PluginContext, run: BulkRun): Promise<BulkRun> {
    const { results } = storage(ctx);
    let { cursor, enqueued } = run;
    let prepared = false;
    const add = async (mediaId: string, filename: string) => {
      if (await enqueue(ctx, newItem(run, mediaId, filename, enqueued))) enqueued += 1;
    };

    if (run.selection.mode === 'eligible') {
      if (!results) throw new Error('The results storage collection is not declared');
      for (let page = 0; page < ENQUEUE_PAGES_PER_TICK; page += 1) {
        const listed = await results.query({
          where: { status: 'flagged' },
          orderBy: { estimateBytes: 'desc' },
          limit: PAGE,
          ...(cursor ? { cursor } : {}),
        });
        for (const { id, data } of listed.items as Array<{ id: string; data: StoredResult }>) {
          // Measured savings only: an estimate from metadata is not a reason to change a file.
          if (data.basis !== 'measured' || data.optimized || !MEASURABLE.has(data.mimeType.toLowerCase())) continue;
          await add(id, data.filename);
        }
        if (!listed.hasMore || !listed.cursor) {
          prepared = true;
          break;
        }
        cursor = listed.cursor;
      }
    } else if (run.selection.mode === 'selected') {
      const ids = run.selection.mediaIds;
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(ids.length, start + ENQUEUE_PAGES_PER_TICK * PAGE);
      for (let offset = start; offset < end; offset += PAGE) {
        const chunk = ids.slice(offset, Math.min(end, offset + PAGE));
        const known = results ? ((await results.getMany(chunk)) as Map<string, StoredResult>) : new Map<string, StoredResult>();
        for (const id of chunk) await add(id, known.get(id)?.filename ?? id);
      }
      cursor = String(end);
      prepared = end >= ids.length;
    } else if (run.selection.mode === 'optimized') {
      const records = (await mutations.records(ctx)).filter((record) => record.state === 'optimized');
      records.sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
      for (const record of records) await add(record.mediaId, record.filename);
      prepared = true;
    } else {
      prepared = true;
    }
    return (
      (await updateRun(ctx, run.runId, (current) => (current.prepared ? null : { ...current, cursor: prepared ? null : cursor, enqueued, prepared }))) ??
      run
    );
  }

  // --- Claiming and working items ------------------------------------------------------------

  /** Items a worker may claim now, oldest obligations first: expired leases, due retries, then the queue. */
  async function candidates(ctx: PluginContext, run: BulkRun, limit: number): Promise<string[]> {
    const { items } = storage(ctx);
    const at = iso();
    const ids: string[] = [];
    const take = (listed: { items: Array<{ id: string }> }) => ids.push(...listed.items.map(({ id }) => id));
    const held = run.status === 'running' ? [...HELD_STATES] : ['committing'];
    take(await items.query({ where: { runId: run.runId, state: { in: held }, leaseExpiresAt: { lt: at } }, limit }));
    if (run.status !== 'running') return ids;
    if (ids.length < limit) {
      take(await items.query({ where: { runId: run.runId, state: 'retry_wait', nextAttemptAt: { lte: at } }, limit: limit - ids.length }));
    }
    if (ids.length < limit) {
      take(await items.query({ where: { runId: run.runId, state: 'queued' }, orderBy: { order: 'asc' }, limit: limit - ids.length }));
    }
    return ids;
  }

  interface Held {
    id: string;
    item: BulkItem;
    revision: string;
  }

  /**
   * Claims an item with a conditional write from the revision read, so of two workers only one
   * holds it. An item whose lease is still live, or that is no longer claimable, is left alone.
   */
  async function claim(ctx: PluginContext, run: BulkRun, id: string, owner: string): Promise<Held | 'exhausted' | null> {
    const { items } = storage(ctx);
    const found = await items.getVersioned(id);
    if (!found) return null;
    const item = found.value as BulkItem;
    const at = iso();
    const leased = HELD_STATES.includes(item.state);
    const claimable =
      (item.state === 'queued' && run.status === 'running') ||
      (item.state === 'retry_wait' && run.status === 'running' && item.nextAttemptAt <= at) ||
      (leased && item.leaseExpiresAt < at && (run.status === 'running' || item.state === 'committing'));
    if (!claimable) return null;
    // An item that was committing is always resolved, whatever its attempts: the host may have published.
    if (item.attempts >= MAX_ITEM_ATTEMPTS && item.state !== 'committing') {
      const failed: BulkItem = {
        ...item,
        state: 'failed',
        code: 'attempts-exhausted',
        message: 'Gave up after repeated attempts.',
        leaseOwner: null,
        leaseExpiresAt: '',
        updatedAt: at,
      };
      const written = await items.compareAndSet(id, found.revision, failed);
      return written.applied ? 'exhausted' : null;
    }
    const next: BulkItem = {
      ...item,
      // A restore has no processing step. An item taken over keeps the step it reached.
      state: leased ? item.state : item.kind === 'restore' ? 'committing' : 'processing',
      attempts: item.attempts + 1,
      leaseOwner: owner,
      leaseExpiresAt: later(LEASE_MS),
      updatedAt: at,
    };
    const written = await items.compareAndSet(id, found.revision, next);
    return written.applied ? { id, item: next, revision: written.revision } : null;
  }

  /** Advances a held item from the revision this worker wrote last; `false` when it lost the lease. */
  async function advance(ctx: PluginContext, held: Held, patch: Partial<BulkItem>): Promise<boolean> {
    const next: BulkItem = { ...held.item, ...patch, updatedAt: iso() };
    const written = await storage(ctx).items.compareAndSet(held.id, held.revision, next);
    if (!written.applied) return false;
    held.item = next;
    held.revision = written.revision;
    return true;
  }

  const released = { leaseOwner: null, leaseExpiresAt: '' } as const;

  function retryOrFail(held: Held, code: string, message: string): Partial<BulkItem> {
    if (held.item.attempts >= MAX_ITEM_ATTEMPTS) return { ...released, state: 'failed', code, message };
    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, held.item.attempts - 1));
    return { ...released, state: 'retry_wait', nextAttemptAt: later(wait), code, message };
  }

  /** The item's final patch for an apply outcome. `null`: put it back in the queue (host unavailable). */
  async function applied(ctx: PluginContext, held: Held, outcome: ActionOutcome): Promise<Partial<BulkItem> | null> {
    switch (outcome.outcome) {
      case 'optimized':
        return {
          ...released,
          state: 'optimized',
          inputBytes: outcome.inputBytes,
          outputBytes: outcome.outputBytes,
          replayed: outcome.replayed,
          code: null,
          message: null,
        };
      case 'skipped': {
        if (outcome.reason === 'already-optimized' && held.item.operationId) {
          // This item's own operation, published by a worker that stopped before recording it.
          const record = await ctx.kv.get<AppliedRecord>(`${APPLIED_PREFIX}${held.item.mediaId}`);
          if (record?.state === 'optimized' && record.operationId === held.item.operationId) {
            return { ...released, state: 'optimized', inputBytes: record.inputBytes, outputBytes: record.outputBytes, replayed: true, code: null, message: null };
          }
        }
        return {
          ...released,
          state: 'skipped',
          code: outcome.reason,
          message: outcome.message,
          inputBytes: outcome.inputBytes ?? null,
          outputBytes: outcome.outputBytes ?? null,
        };
      }
      case 'conflict':
        return { ...released, state: 'conflict', code: 'conflict', message: outcome.message };
      case 'uncertain':
        return retryOrFail(held, 'uncertain', outcome.message);
      case 'unavailable':
        return null;
      case 'failed':
        if (outcome.code === 'not-found') {
          if (!(await ctx.media?.get(held.item.mediaId))) {
            return { ...released, state: 'skipped', code: 'deleted', message: 'The image was deleted.' };
          }
          // Not ready yet, for example an upload still being processed by the host.
          return retryOrFail(held, outcome.code, outcome.message);
        }
        if (outcome.retryable) return retryOrFail(held, outcome.code, outcome.message);
        return { ...released, state: 'failed', code: outcome.code, message: outcome.message };
      default:
        return { ...released, state: 'failed', code: outcome.outcome, message: 'Unexpected outcome.' };
    }
  }

  /** The item's final patch for a restore outcome, with the per-item outcomes a restore can have. */
  async function restored(ctx: PluginContext, held: Held, outcome: ActionOutcome): Promise<Partial<BulkItem> | null> {
    switch (outcome.outcome) {
      case 'restored':
        return { ...released, state: 'restored', outputBytes: outcome.bytes, replayed: outcome.replayed, code: null, message: null };
      case 'nothing-to-restore': {
        // Restored during this run by a worker that stopped before recording it on the item.
        const [record, run] = await Promise.all([
          ctx.kv.get<AppliedRecord>(`${APPLIED_PREFIX}${held.item.mediaId}`),
          storage(ctx).runs.get(held.item.runId) as Promise<BulkRun | null>,
        ]);
        if (held.item.attempts > 1 && record?.state === 'restored' && run && (record.restoredAt ?? '') >= run.createdAt) {
          return { ...released, state: 'restored', outputBytes: record.inputBytes, replayed: true, code: null, message: null };
        }
        return { ...released, state: 'conflict', code: 'nothing-to-restore', message: outcome.message };
      }
      case 'conflict':
        return { ...released, state: 'conflict', code: 'conflict', message: outcome.message };
      case 'no-original':
        return { ...released, state: 'failed', code: 'missing-original', message: outcome.message };
      case 'uncertain':
        return retryOrFail(held, 'uncertain', outcome.message);
      case 'unavailable':
        return null;
      case 'failed':
        if (outcome.retryable) return retryOrFail(held, outcome.code, outcome.message);
        return { ...released, state: 'failed', code: outcome.code, message: outcome.message };
      default:
        return { ...released, state: 'failed', code: outcome.outcome, message: 'Unexpected outcome.' };
    }
  }

  /** Works one claimed item to an outcome. Returns `false` when the host stopped allowing changes. */
  async function work(ctx: PluginContext, settings: Settings, held: Held): Promise<boolean> {
    const { runs } = storage(ctx);
    const { item } = held;
    let outcome: ActionOutcome;
    try {
      if (item.kind === 'restore') {
        outcome = await mutations.restore(ctx, item.mediaId);
      } else {
        outcome = await mutations.apply(ctx, settings, item.mediaId, {
          beforeCommit: async (operationId) => {
            // An item already committing finishes whatever happened to the run meanwhile.
            if (held.item.state === 'committing' && held.item.operationId === operationId) return true;
            const status = ((await runs.get(item.runId)) as BulkRun | null)?.status;
            if (status === 'running') {
              if (
                (await advance(ctx, held, { state: 'ready_to_commit', operationId, leaseExpiresAt: later(LEASE_MS) })) &&
                (await advance(ctx, held, { state: 'committing', leaseExpiresAt: later(LEASE_MS) }))
              ) {
                return true;
              }
            } else if (status === 'paused') {
              // Kept with its staged output; resuming the run submits it.
              if (await advance(ctx, held, { state: 'ready_to_commit', operationId, ...released })) return false;
            } else {
              const message = 'The run was cancelled before this image was submitted.';
              if (await advance(ctx, held, { ...released, state: 'skipped', operationId, code: 'cancelled', message })) {
                await mutations.discard(operationId);
                return false;
              }
            }
            // The write failed: another worker took the item over after this worker's lease expired.
            // Once that worker has settled the item, nobody will submit this output.
            const current = (await storage(ctx).items.get(held.id)) as BulkItem | null;
            if (!current || !isOpen(current.state)) await mutations.discard(operationId);
            return false;
          },
        });
      }
    } catch (error) {
      ctx.log.warn('Bulk item failed unexpectedly', { mediaId: item.mediaId, error: String(error) });
      await advance(ctx, held, retryOrFail(held, 'internal', 'The image could not be processed.'));
      return true;
    }
    if (outcome.outcome === 'deferred') return true;
    const patch = item.kind === 'restore' ? await restored(ctx, held, outcome) : await applied(ctx, held, outcome);
    if (!patch) {
      // The host no longer allows changes: back to the queue, without counting the attempt.
      await advance(ctx, held, { ...released, state: 'queued', attempts: Math.max(0, held.item.attempts - 1) });
      return false;
    }
    // When the lease was lost meanwhile, the new holder records the outcome from the host's receipt.
    await advance(ctx, held, patch);
    return true;
  }

  /** Cancelling: items not started end as skipped; items committing are left to finish. */
  async function cancelPass(ctx: PluginContext, run: BulkRun): Promise<void> {
    const { items } = storage(ctx);
    const at = iso();
    const cancel = async (id: string) => {
      const found = await items.getVersioned(id);
      if (!found) return;
      const item = found.value as BulkItem;
      const idle =
        item.state === 'queued' ||
        item.state === 'retry_wait' ||
        ((item.state === 'processing' || item.state === 'ready_to_commit') && item.leaseExpiresAt < at);
      if (!idle) return;
      const written = await items.compareAndSet(id, found.revision, {
        ...item,
        ...released,
        state: 'skipped',
        code: 'cancelled',
        message: 'The run was cancelled before this image was submitted.',
        updatedAt: at,
      });
      if (written.applied && item.operationId) await mutations.discard(item.operationId);
    };
    await eachPage(items, { runId: run.runId, state: { in: ['queued', 'retry_wait'] } }, async (page) => {
      for (const { id } of page) await cancel(id);
    });
    const stale = await items.query({
      where: { runId: run.runId, state: { in: ['processing', 'ready_to_commit'] }, leaseExpiresAt: { lt: at } },
      limit: PAGE,
    });
    for (const { id } of stale.items) await cancel(id);
  }

  async function openCount(ctx: PluginContext, runId: string): Promise<number> {
    return storage(ctx).items.count({ runId, state: { in: [...OPEN_STATES] } });
  }

  /**
   * One scheduled tick: prepares the active run, or works its items one at a time within the tick's
   * bounds (`limits.items` images, no new image after `limits.wallTimeMs`), and finishes it when no
   * item is open. Without an active run it works the automation queue, when automation is on.
   */
  async function tick(ctx: PluginContext): Promise<TickReport> {
    const owner = randomUUID();
    const settings = await settingsOf(ctx);
    const switchedOn = automationEnabled(settings);
    // Where the host does not allow changes, the automation queue waits, and so does the task.
    const automation = switchedOn && (await mutations.allowed(ctx)).apply;
    const report: TickReport = { runId: null, claimed: 0, active: automation };

    // Switching automation off forgets when it was switched on; switching it on again starts anew.
    let automationState: AutomationState | null = null;
    if (automation) automationState = await ensureAutomation(ctx);
    else if (!switchedOn && (await ctx.kv.get(AUTOMATION_KEY))) await ctx.kv.delete(AUTOMATION_KEY);

    // A scan and a run never interleave: the run waits.
    const scan = await readScan(ctx);
    if (scan && scan.phase !== 'complete') return { ...report, active: true };

    const runId = await activeRunId(ctx);
    let manual = runId ? ((await readRun(ctx, runId))?.run ?? null) : null;
    if (runId && !manual) await release(ctx, runId);
    if (manual && (manual.status === 'complete' || manual.status === 'cancelled')) {
      await release(ctx, manual.runId);
      manual = null;
    }
    if (automationState) await reconcile(ctx, automationState);
    const chosen = manual ?? (automation ? ((await readRun(ctx, AUTOMATION_RUN_ID))?.run ?? null) : null);
    if (!chosen) return report;
    let run: BulkRun = chosen;
    report.runId = run.runId;
    report.active = true;

    if (run.status === 'cancelling') {
      await cancelPass(ctx, run);
    } else if (!run.prepared) {
      run = await prepare(ctx, run);
    }

    if (run.prepared) {
      const started = clock();
      let budget = limits.items;
      const canStart = () => budget > 0 && (budget === limits.items || clock() - started < limits.wallTimeMs);
      let stop = false;
      while (!stop && canStart()) {
        const ids = await candidates(ctx, run, budget);
        if (ids.length === 0) break;
        let progressed = false;
        for (const id of ids) {
          if (!canStart()) break;
          // Pause and cancel take effect between images.
          const current = (await readRun(ctx, run.runId))?.run;
          if (!current) {
            stop = true;
            break;
          }
          run = current;
          const held = await claim(ctx, run, id, owner);
          if (!held) continue;
          budget -= 1;
          report.claimed += 1;
          progressed = true;
          if (held === 'exhausted') continue;
          if (!(await work(ctx, settings, held))) {
            stop = true;
            break;
          }
        }
        if (!progressed) break;
      }
    }

    if (run.runId !== AUTOMATION_RUN_ID && run.prepared && (run.status === 'running' || run.status === 'cancelling')) {
      if ((await openCount(ctx, run.runId)) === 0) {
        const from = run.status;
        const status: RunStatus = from === 'cancelling' ? 'cancelled' : 'complete';
        await updateRun(ctx, run.runId, (current) => (current.status === from ? { ...current, status, finishedAt: iso() } : null));
        await release(ctx, run.runId);
        report.active = automation;
      }
    }
    return report;
  }

  // --- Reporting -----------------------------------------------------------------------------

  async function counts(ctx: PluginContext, runId: string): Promise<BulkCounts> {
    const { items } = storage(ctx);
    const entries = await Promise.all(ITEM_STATES.map(async (state) => [state, await items.count({ runId, state })] as const));
    return Object.fromEntries(entries) as BulkCounts;
  }

  /** The source reduction of a run's optimized items: what its files shrank by. */
  async function runReduction(ctx: PluginContext, runId: string): Promise<number> {
    let bytes = 0;
    await eachPage(
      storage(ctx).items,
      { runId, state: 'optimized' },
      async (page) => {
        for (const { data } of page) bytes += (data.inputBytes ?? 0) - (data.outputBytes ?? 0);
      },
      50,
    );
    return bytes;
  }

  async function itemsNeedingAttention(ctx: PluginContext, runId: string): Promise<BulkItemView[]> {
    const listed = await storage(ctx).items.query({ where: { runId, state: { in: ['failed', 'conflict'] } }, limit: ITEMS_SHOWN });
    return listed.items.map(({ data }) => {
      const item = data as BulkItem;
      return { mediaId: item.mediaId, filename: item.filename, state: item.state, code: item.code, message: item.message };
    });
  }

  async function view(ctx: PluginContext, settings: Settings): Promise<BulkView> {
    const run = await currentRun(ctx);
    const automation = automationEnabled(settings);
    const automationRun = automation ? (await readRun(ctx, AUTOMATION_RUN_ID))?.run ?? null : null;
    const scan = await readScan(ctx);
    return {
      run: run
        ? {
            runId: run.runId,
            kind: run.kind,
            status: run.status,
            prepared: run.prepared,
            createdAt: run.createdAt,
            finishedAt: run.finishedAt,
            counts: await counts(ctx, run.runId),
            grossReductionBytes: await runReduction(ctx, run.runId),
            attention: await itemsNeedingAttention(ctx, run.runId),
          }
        : null,
      automation: {
        enabled: automation,
        counts: automationRun ? await counts(ctx, AUTOMATION_RUN_ID) : null,
      },
      scanRunning: Boolean(scan && scan.phase !== 'complete'),
    };
  }

  /** A message when a scan must not start now: while a run is active, a scan would change its input. */
  async function busy(ctx: PluginContext): Promise<string | null> {
    const runId = await activeRunId(ctx);
    if (!runId) return null;
    const found = await readRun(ctx, runId);
    if (!found || found.run.status === 'complete' || found.run.status === 'cancelled') return null;
    return 'An optimization run is active. Scan again once it has finished or been cancelled.';
  }

  async function reconcileNow(ctx: PluginContext): Promise<number | null> {
    if (!automationEnabled(await settingsOf(ctx))) return null;
    const added = await reconcile(ctx, await ensureAutomation(ctx), true);
    await ctx.cron?.schedule(BULK_TASK, { schedule: BULK_TASK_SCHEDULE });
    return added;
  }

  /** A bulk action from the report, answered with a toast. */
  async function act(ctx: PluginContext, action: string, mediaIds: string[] | null): Promise<Toast> {
    const started = (outcome: StartOutcome, what: string): Toast =>
      outcome.ok
        ? { type: 'success', message: `${what} started. It runs in the background, about 20 images a minute.` }
        : { type: outcome.error === 'UNAVAILABLE' ? 'error' : 'info', message: `${what} did not start. ${outcome.message}` };
    const controlled = (outcome: ControlOutcome, done: string): Toast =>
      outcome.ok ? { type: 'success', message: done } : { type: 'info', message: outcome.message };
    switch (action) {
      case ACTION_BULK_APPLY_ALL:
        return started(await start(ctx, 'apply', { mode: 'eligible' }), 'The optimization run');
      case ACTION_BULK_APPLY_PAGE:
        return started(await start(ctx, 'apply', { mode: 'selected', mediaIds: mediaIds ?? [] }), 'The optimization run');
      case ACTION_BULK_RESTORE_ALL:
        return started(await start(ctx, 'restore', { mode: 'optimized' }), 'The restore run');
      case ACTION_BULK_PAUSE:
        return controlled(await control(ctx, 'pause'), 'Paused. An image already being submitted finishes.');
      case ACTION_BULK_RESUME:
        return controlled(await control(ctx, 'resume'), 'Resumed.');
      case ACTION_BULK_CANCEL:
        return controlled(await control(ctx, 'cancel'), 'Cancelling. Images not yet submitted are skipped.');
      case ACTION_BULK_RETRY: {
        const outcome = await retryFailed(ctx);
        return controlled(outcome, outcome.ok ? `${outcome.changed} failed images queued again.` : '');
      }
      case ACTION_BULK_RECONCILE: {
        const added = await reconcileNow(ctx);
        return added === null
          ? { type: 'info', message: 'Upload automation is off.' }
          : { type: 'success', message: `${added} missed uploads queued.` };
      }
      default:
        return { type: 'error', message: 'Unknown action.' };
    }
  }

  return {
    start,
    control,
    retryFailed,
    tick,
    view,
    busy,
    act,
    onUpload,
    reconcile: reconcileNow,
    currentRun,
  };
}

export type Bulk = ReturnType<typeof createBulk>;
