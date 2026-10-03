/**
 * Apply and restore, for the native edition only: one image at a time, through the host's fenced
 * safe-media access (`ctx.media.safe`, see `safe-media.ts`).
 *
 * - **Gated by qualification.** Every call asks the media host adapter, which accepts the host only
 *   when its discovered protocol and profile are on the qualified-profile allowlist. The shipped
 *   allowlist has one profile (Node, SQLite, local storage, locks in the one site process); on
 *   every other host apply and restore are refused and the plugin stays read-only. A site operator
 *   can pass another allowlist through the descriptor's options: an empty one keeps the plugin
 *   read-only, and any other profile is unsupported.
 * - **Fenced.** Apply reads the active revision, then the bytes, processes them, and submits the
 *   output against that revision. The host publishes only if the revision is still active, keeps the
 *   replaced bytes as a retained original, and refuses output of another format or size. A conflict
 *   leaves the newer image untouched.
 * - **Idempotent.** Operation IDs are derived from the media ID, source revision, policy and
 *   processor version (and, for a re-optimization, the original's digest), so a retry after a lost
 *   response finds the host's receipt instead of publishing again. Output waits for the commit in
 *   the private staging area (`staging.ts`), never in plugin storage or KV, so a retried operation
 *   submits the same bytes.
 * - **Restore** publishes the original that this plugin's optimization retained, against the
 *   optimized revision, and checks the host's receipt names that original's digest.
 * - **Re-optimization** under a different policy starts from the retained original, never from this
 *   plugin's own output. The original is read privately (`readOriginal`), checked against its
 *   digest and size, processed, and the output replaces the optimized revision that is active, fenced
 *   on it. The original is never made active on the way. On a host without that read, or when the
 *   host refuses it, nothing changes: the optimized image is not processed again, because its bytes
 *   already lost quality, and the original is not restored to read it.
 */
import { createHash } from 'node:crypto';

import type { PluginContext } from 'emdash/plugin';

import {
  createMediaHostAdapter,
  UnsupportedMediaHostError,
  type HostProfile,
} from '../../media-host-adapter/src/index.ts';
import type {
  ActionOutcome,
  AppliedRecord,
  MutationsView,
  StorageAccounting,
} from './admin.ts';
import { scanOptionsFrom, type ApplyHooks, type NativeMutations } from './handlers.ts';
import { replaceResult, type OptimizedMarker, type StoredResult } from './job.ts';
import { HOST_READ_LIMIT_BYTES, readMeasureSettings } from './measure.ts';
import { ImageProcessorError, type ImageProcessor } from './processor/contract.ts';
import {
  isFinalState,
  READ_ORIGINAL_MAX_BYTES,
  safeMediaOf,
  type PublishedReceipt,
  type ReadOriginalResult,
  type RestorableOriginal,
  type SafeMediaAccess,
  type SafeMediaResult,
  type SafeMediaRevision,
  type SafeMediaSupport,
} from './safe-media.ts';
import { imageFormat, type ScanOptions } from './scanner.ts';
import { createStaging, sha256Hex, type Staging } from './staging.ts';

/** Apply never submits less than this saving, whatever the settings say. */
export const MIN_APPLY_SAVING_BYTES = 10 * 1024;
export const MIN_APPLY_SAVING_RATIO = 0.05;
/** Operation IDs tried for one identity: an attempt the host ended as interrupted cannot be reused. */
export const MAX_OPERATION_ATTEMPTS = 3;
/** KV records of what this plugin applied, one per media item. Never image bytes. */
export const APPLIED_PREFIX = 'applied:';
/** Optimized images listed in the report. */
export const APPLIED_SHOWN = 50;

const PREFIX = 'imgopt';
const OPERATION =
  /^imgopt\.(?:(replace|restore)\.([0-9a-f]{16})\.[0-9a-f]{32}|(reopt)\.([0-9a-f]{16})\.([0-9a-f]{64})\.[0-9a-f]{24})(?:\.\d+)?$/;
const MAX_MEDIA_ID = 128;

/** What determines the output bytes: the processor and its version, the preset and the metadata policy. */
export interface Policy {
  processor: string;
  processorVersion: string;
  preset: string;
  removeGps: boolean;
}

function digest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** A short hash of the policy, readable back from this plugin's operation IDs. */
export function policyKey(policy: Policy): string {
  return digest(['policy', 1, policy.processor, policy.processorVersion, policy.preset, policy.removeGps]).slice(0, 16);
}

/**
 * The host operation ID of one apply: derived from the media ID, the source revision, the policy
 * hash, the processor version and the kind, so the same work always gets the same ID and a retry
 * replays the host's receipt. `attempt` moves to a fresh ID only after the host ended an earlier one
 * as interrupted, which consumes it.
 */
export function replaceOperationId(
  identity: { mediaId: string; sourceRevisionId: string; policy: Policy },
  attempt = 1,
): string {
  const key = policyKey(identity.policy);
  const hash = digest([
    'replace',
    identity.mediaId,
    identity.sourceRevisionId,
    key,
    identity.policy.processorVersion,
  ]).slice(0, 32);
  return `${PREFIX}.replace.${key}.${hash}${attempt > 1 ? `.${attempt}` : ''}`;
}

/**
 * The host operation ID of a re-optimization: the retained original `originalSha256` processed under
 * `policy`, replacing the optimized revision `sourceRevisionId`. Distinct from a first optimization's
 * ID, and it names the original's full digest, so the original stays known after the host has
 * retained the optimized file this operation replaces. At most 121 characters, within the host's 128.
 */
export function reoptimizeOperationId(
  identity: { mediaId: string; sourceRevisionId: string; originalSha256: string; policy: Policy },
  attempt = 1,
): string {
  const key = policyKey(identity.policy);
  const hash = digest([
    'reopt',
    identity.mediaId,
    identity.sourceRevisionId,
    identity.originalSha256,
    key,
    identity.policy.processorVersion,
  ]).slice(0, 24);
  return `${PREFIX}.reopt.${key}.${identity.originalSha256}.${hash}${attempt > 1 ? `.${attempt}` : ''}`;
}

/** The host operation ID of restoring `originalSha256` over the revision `expectedRevisionId`. */
export function restoreOperationId(
  identity: { mediaId: string; expectedRevisionId: string; originalSha256: string },
  attempt = 1,
): string {
  const key = identity.originalSha256.slice(0, 16);
  const hash = digest(['restore', identity.mediaId, identity.expectedRevisionId, identity.originalSha256]).slice(0, 32);
  return `${PREFIX}.restore.${key}.${hash}${attempt > 1 ? `.${attempt}` : ''}`;
}

export type ParsedOperationId =
  | { kind: 'replace'; key: string }
  | { kind: 'restore'; key: string }
  | { kind: 'reopt'; key: string; originalSha256: string };

export function parseOperationId(operationId: string): ParsedOperationId | null {
  const match = OPERATION.exec(operationId);
  if (!match) return null;
  if (match[3]) return { kind: 'reopt', key: match[4]!, originalSha256: match[5]! };
  return match[1] === 'restore' ? { kind: 'restore', key: match[2]! } : { kind: 'replace', key: match[2]! };
}

export interface NativeMutationOptions {
  /** The processor, or `null` when Sharp is not installed; called when first needed. */
  processor: () => ImageProcessor | null;
  /**
   * Host profiles on which apply and restore run. Defaults to the media host adapter's list of
   * qualified profiles; an empty list keeps every host read-only.
   */
  qualifiedProfiles?: readonly HostProfile[];
  /** The private staging area; created on first use in the default directory when absent. */
  staging?: () => Staging;
  now?: () => Date;
}

type Settings = ReadonlyMap<string, unknown>;

/** A media item's active revision, when it was published by this plugin's own replace. */
interface OwnOptimization {
  /** What the operation that published the active revision retained: the bytes it replaced. */
  retained: RestorableOriginal;
  /**
   * The original this plugin's optimizations of the item started from: `retained` for a first
   * optimization, the original named in the operation ID for a re-optimization.
   */
  originalSha256: string;
  /** The host's listing of that original; `null` when it no longer lists it. */
  original: RestorableOriginal | null;
  operationId: string;
  key: string;
  reoptimized: boolean;
}

/** The retained original a re-optimization processes. */
interface OriginalSource {
  sha256: string;
  /** The size the host lists, when it lists the original. */
  size: number | null;
}

function messageFor(code: string): string {
  switch (code) {
    case 'CONFLICT':
    case 'SOURCE_CHANGED':
      return 'The image changed since it was read. The newer image was left as it is.';
    case 'DIMENSIONS_CHANGED':
      return 'The host refused the output because its dimensions differ from the image.';
    case 'NO_ORIGINAL':
      return 'The host has no retained original for this image.';
    case 'ORIGINAL_UNAVAILABLE':
      return 'The retained original is missing or damaged, so nothing was restored.';
    case 'CONFLICTING_OPERATION':
      return 'The host already holds a different request under this operation. Try again after the host has reconciled it.';
    default:
      return `The host refused the change (${code}).`;
  }
}

/** A result from an operation's stored status, or `null` while the operation is still open. */
function resultFromStatus(status: Awaited<ReturnType<SafeMediaAccess['operation']>>): SafeMediaResult | null {
  if (!status || !isFinalState(status.state)) return null;
  const receipt = status.receipt;
  if (receipt?.status === 'published') return { ok: true, receipt, replayed: true };
  const code = receipt?.status === 'rejected' ? receipt.code : 'INTERRUPTED';
  return { ok: false, code, message: messageFor(code), retryable: false, ...(receipt ? { receipt } : {}) };
}

function interrupted(result: SafeMediaResult | null): boolean {
  return result !== null && !result.ok && result.code === 'INTERRUPTED';
}

/**
 * The storage effect of this plugin's operations, from its records of the host's receipts.
 *
 * - Gross source reduction: for images that are optimized now, the bytes the active files shrank by.
 * - Retained originals: every distinct file the host keeps because of an operation of this plugin:
 *   the original an apply replaced, and the optimized file a restore or a re-optimization replaced,
 *   each counted once by digest. The host keeps them until it prunes them, which this plugin cannot
 *   see.
 * - Net storage change: retained bytes minus the gross reduction. While originals are retained it is
 *   an increase: an optimized image costs its new file on top of its original.
 */
export function storageAccounting(records: readonly AppliedRecord[]): StorageAccounting {
  let optimized = 0;
  let grossReductionBytes = 0;
  const retained = new Map<string, number>();
  for (const record of records) {
    if (record.state === 'optimized') {
      optimized += 1;
      grossReductionBytes += record.inputBytes - record.outputBytes;
    }
    // Records written before `retained` existed: the original the apply replaced.
    const entries = record.retained ?? (record.originalSha256 ? { [record.originalSha256]: record.inputBytes } : {});
    for (const [sha256, size] of Object.entries(entries)) retained.set(sha256, size);
  }
  const retainedOriginalBytes = [...retained.values()].reduce((sum, size) => sum + size, 0);
  return {
    optimized,
    grossReductionBytes,
    retainedOriginalBytes,
    netStorageChangeBytes: retainedOriginalBytes - grossReductionBytes,
  };
}

/** Why a re-optimization did not get the original's bytes; nothing was changed. */
type OriginalRefusal =
  | { outcome: 'skipped'; reason: string; message: string }
  | { outcome: 'failed'; code: string; message: string; retryable?: boolean };

/** The item outcome for each refusal of the host's private read of a retained original. */
function originalRefusal(code: string, retryable: boolean): OriginalRefusal {
  const unchanged = 'The optimized image stays active; nothing was changed.';
  switch (code) {
    case 'TOO_LARGE':
      return { outcome: 'skipped', reason: 'original-too-large', message: `The retained original is larger than the plugin may read. ${unchanged}` };
    case 'MEDIA_UNAVAILABLE':
      return { outcome: 'failed', code: 'not-found', message: 'The image no longer exists or is not ready.' };
    case 'NO_ORIGINAL':
      return { outcome: 'failed', code: 'original-not-retained', message: `The host no longer keeps the original this image was optimized from, so it cannot be optimized again under new settings. ${unchanged}` };
    case 'ORIGINAL_MISSING':
      return { outcome: 'failed', code: 'original-missing', message: `The host records the original, but its file is gone. ${unchanged}` };
    case 'ORIGINAL_CORRUPT':
      return { outcome: 'failed', code: 'original-corrupt', message: `The host's copy of the original no longer matches its digest. ${unchanged}` };
    case 'ORIGINAL_UNREADABLE':
      return { outcome: 'failed', code: 'original-unreadable', retryable: true, message: `The host could not read the original just now. ${unchanged} Try again later.` };
    case 'INVALID_REQUEST':
      return { outcome: 'failed', code: 'invalid-request', message: `The host refused the request to read the original. ${unchanged}` };
    default:
      return { outcome: 'failed', code: `original-${code.toLowerCase()}`, retryable, message: `The host refused to read the original (${code}). ${unchanged}` };
  }
}

/**
 * Reads a retained original privately and checks it is exactly that original: the digest asked for,
 * the size listed, within `maxBytes`. Never processes anything else.
 */
async function readOriginalBytes(
  readOriginal: NonNullable<SafeMediaAccess['readOriginal']>,
  mediaId: string,
  original: OriginalSource,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; outcome: OriginalRefusal }> {
  let read: ReadOriginalResult;
  try {
    read = await readOriginal(mediaId, original.sha256, { maxBytes });
  } catch {
    return { ok: false, outcome: { outcome: 'failed', code: 'read-failed', message: 'The retained original could not be read. Nothing was changed.' } };
  }
  if (!read.ok) return { ok: false, outcome: originalRefusal(read.code, read.retryable) };
  const { bytes } = read;
  if (
    !(bytes instanceof Uint8Array) ||
    read.mediaId !== mediaId ||
    read.sha256 !== original.sha256 ||
    read.size !== bytes.byteLength ||
    (original.size !== null && original.size !== bytes.byteLength) ||
    bytes.byteLength > maxBytes ||
    sha256Hex(bytes) !== original.sha256
  ) {
    return {
      ok: false,
      outcome: { outcome: 'failed', code: 'original-mismatch', message: 'The host returned other bytes than the retained original. Nothing was changed.' },
    };
  }
  return { ok: true, bytes };
}

export function createNativeMutations(options: NativeMutationOptions): NativeMutations {
  const now = options.now ?? (() => new Date());
  let staging: Staging | undefined;
  const stagingArea = () => (staging ??= options.staging?.() ?? createStaging());

  function gate(safe: SafeMediaAccess | null) {
    let support: SafeMediaSupport | null = null;
    const adapter = createMediaHostAdapter(
      safe
        ? {
            discover: async () => (support = await safe.support()),
            apply: (request) => safe.replace(request as Parameters<SafeMediaAccess['replace']>[0]),
            restore: (request) => safe.restore(request as Parameters<SafeMediaAccess['restore']>[0]),
          }
        : {},
      options.qualifiedProfiles ? { qualifiedProfiles: options.qualifiedProfiles } : {},
    );
    return { adapter, support: () => support };
  }

  async function availability(ctx: PluginContext) {
    const safe = safeMediaOf(ctx);
    const { adapter, support } = gate(safe);
    const status = await adapter.availability();
    const processor = options.processor();
    const canProcess = Boolean(processor && ctx.media?.readBytes);
    return {
      safe,
      adapter,
      support,
      processor,
      status,
      apply: status.apply && canProcess,
      restore: status.restore,
      message: !status.apply
        ? status.message
        : canProcess
          ? status.message
          : 'Restore is available. Applying needs Sharp installed in the site and byte access.',
    };
  }

  async function records(ctx: PluginContext): Promise<AppliedRecord[]> {
    return (await ctx.kv.list(APPLIED_PREFIX)).map(({ value }) => value as AppliedRecord);
  }

  async function record(ctx: PluginContext, value: AppliedRecord): Promise<void> {
    await ctx.kv.set(`${APPLIED_PREFIX}${value.mediaId}`, value);
  }

  async function updateRecord(
    ctx: PluginContext,
    mediaId: string,
    patch: Partial<AppliedRecord>,
    retained?: { sha256: string | null; size: number },
  ): Promise<AppliedRecord | null> {
    const existing = await ctx.kv.get<AppliedRecord>(`${APPLIED_PREFIX}${mediaId}`);
    if (!existing) return null;
    const next = { ...existing, ...patch, ...(retained ? { retained: withRetained(existing, retained) } : {}) };
    await record(ctx, next);
    return next;
  }

  /** The record's retained files plus the ones added, keyed by digest: each file counts once. */
  function withRetained(
    existing: AppliedRecord | null,
    ...added: Array<{ sha256: string | null; size: number }>
  ): Record<string, number> {
    const retained = { ...(existing?.retained ?? (existing?.originalSha256 ? { [existing.originalSha256]: existing.inputBytes } : {})) };
    for (const { sha256, size } of added) if (sha256 && retained[sha256] === undefined) retained[sha256] = size;
    return retained;
  }

  /**
   * Brings the media item's scan result up to date after an apply or restore, so the report does not
   * keep offering a saving already made. Changes only an existing result; a failure here does not
   * change the outcome of the operation, which the host has already published.
   */
  async function refreshResult(ctx: PluginContext, mediaId: string, update: (old: StoredResult) => StoredResult): Promise<void> {
    const results = ctx.storage.results;
    if (!results) return;
    try {
      await replaceResult({ kv: ctx.kv, results, now }, mediaId, update);
    } catch (error) {
      ctx.log.warn('Scan result not updated after a media change', { mediaId, error: String(error) });
    }
  }

  function optimizedResult(marker: OptimizedMarker): (old: StoredResult) => StoredResult {
    return (old) => ({
      ...old,
      status: 'ok',
      reason: null,
      findings: [],
      estimateBytes: 0,
      size: marker.outputBytes,
      optimized: marker,
    });
  }

  /** After a restore, the result shows the saving that was measured when the image was optimized. */
  function restoredResult(old: StoredResult): StoredResult {
    const marker = old.optimized;
    if (!marker) return old;
    return {
      ...old,
      status: 'flagged',
      reason: null,
      findings: [],
      estimateBytes: Math.max(0, marker.inputBytes - marker.outputBytes),
      estimateBasis: null,
      size: marker.inputBytes,
      basis: 'measured',
      measured: {
        inputBytes: marker.inputBytes,
        outputBytes: marker.outputBytes,
        preset: marker.preset,
        removeGps: marker.removeGps,
        processor: marker.processor,
        processorVersion: marker.processorVersion,
      },
      optimized: null,
    };
  }

  /** Whether the active revision is this plugin's optimization, and which original it retained. */
  async function ownOptimization(
    safe: SafeMediaAccess,
    mediaId: string,
    revision: SafeMediaRevision,
  ): Promise<OwnOptimization | null> {
    const listed = await safe.listRestorableOriginals(mediaId);
    const retained = listed.find((candidate) => candidate.replacedByRevisionId === revision.revisionId);
    if (!retained || retained.retainedByKind !== 'replace') return null;
    const parsed = parseOperationId(retained.retainedByOperationId);
    if (!parsed || parsed.kind === 'restore') return null;
    // The host answers only for operations this plugin started.
    const status = await safe.operation(mediaId, retained.retainedByOperationId);
    if (status?.state !== 'published') return null;
    const base = { retained, operationId: retained.retainedByOperationId, key: parsed.key };
    if (parsed.kind === 'replace') return { ...base, originalSha256: retained.sha256, original: retained, reoptimized: false };
    // A re-optimization retained the optimized file it replaced; its ID names the original it processed.
    const original = listed.find((candidate) => candidate.sha256 === parsed.originalSha256) ?? null;
    return { ...base, originalSha256: parsed.originalSha256, original, reoptimized: true };
  }

  /**
   * This plugin's record of the image when, by the host's receipt, its own apply published the
   * active revision although the host no longer lists the original that apply replaced.
   */
  async function ownOutputWithoutOriginal(
    ctx: PluginContext,
    safe: SafeMediaAccess,
    mediaId: string,
    revision: SafeMediaRevision,
  ): Promise<AppliedRecord | null> {
    const known = await ctx.kv.get<AppliedRecord>(`${APPLIED_PREFIX}${mediaId}`);
    if (known?.state !== 'optimized' || known.revisionId !== revision.revisionId) return null;
    const parsed = parseOperationId(known.operationId);
    if (!parsed || parsed.kind === 'restore') return null;
    const status = await safe.operation(mediaId, known.operationId);
    const receipt = status?.state === 'published' ? status.receipt : null;
    return receipt?.status === 'published' && receipt.newRevisionId === revision.revisionId ? known : null;
  }

  /** The receipt of this plugin's restore that published the active revision, if one did. */
  async function ownRestore(
    safe: SafeMediaAccess,
    mediaId: string,
    revision: SafeMediaRevision,
  ): Promise<PublishedReceipt | null> {
    const retained = (await safe.listRestorableOriginals(mediaId)).find(
      (candidate) => candidate.replacedByRevisionId === revision.revisionId,
    );
    if (!retained || parseOperationId(retained.retainedByOperationId)?.kind !== 'restore') return null;
    const status = await safe.operation(mediaId, retained.retainedByOperationId);
    return status?.state === 'published' && status.receipt?.status === 'published' ? status.receipt : null;
  }

  /**
   * The first operation ID for `idFor` that the host has not ended as interrupted, with its stored
   * result if it has one.
   */
  async function operationFor(
    safe: SafeMediaAccess,
    mediaId: string,
    idFor: (attempt: number) => string,
  ): Promise<{ operationId: string; existing: SafeMediaResult | null } | null> {
    for (let attempt = 1; attempt <= MAX_OPERATION_ATTEMPTS; attempt += 1) {
      const operationId = idFor(attempt);
      const existing = resultFromStatus(await safe.operation(mediaId, operationId));
      if (!interrupted(existing)) return { operationId, existing };
      await stagingArea().remove(operationId);
    }
    return null;
  }

  /**
   * Submits through the adapter, which checks qualification again. When the call fails without an
   * answer, the host's record of the operation decides; `null` means the outcome is still unknown.
   */
  async function submit(
    safe: SafeMediaAccess,
    mediaId: string,
    operationId: string,
    send: () => Promise<unknown>,
  ): Promise<SafeMediaResult | null | UnsupportedMediaHostError> {
    try {
      return (await send()) as SafeMediaResult;
    } catch (error) {
      if (error instanceof UnsupportedMediaHostError) return error;
      try {
        return resultFromStatus(await safe.operation(mediaId, operationId));
      } catch {
        return null;
      }
    }
  }

  /** Restores the original `own` retained over `revision`. */
  async function restoreOwn(
    gated: Awaited<ReturnType<typeof availability>>,
    safe: SafeMediaAccess,
    mediaId: string,
    revision: SafeMediaRevision,
    own: OwnOptimization,
  ): Promise<SafeMediaResult | 'uncertain' | 'exhausted' | UnsupportedMediaHostError> {
    const { originalSha256 } = own;
    const operation = await operationFor(safe, mediaId, (attempt) =>
      restoreOperationId({ mediaId, expectedRevisionId: revision.revisionId, originalSha256 }, attempt),
    );
    if (!operation) return 'exhausted';
    const result =
      operation.existing ??
      (await submit(safe, mediaId, operation.operationId, () =>
        gated.adapter.restore({
          mediaId,
          operationId: operation.operationId,
          expectedRevisionId: revision.revisionId,
          originalSha256,
        }),
      ));
    if (result === null) return 'uncertain';
    if (result instanceof UnsupportedMediaHostError) return result;
    // Byte-exact: the host must have published exactly the retained original's digest.
    if (result.ok && result.receipt.candidateSha256 !== originalSha256) {
      return { ok: false, code: 'UNEXPECTED_RECEIPT', message: 'The host restored other bytes than asked.', retryable: false };
    }
    return result;
  }

  async function apply(ctx: PluginContext, settings: Settings, mediaId: string, hooks: ApplyHooks = {}): Promise<ActionOutcome> {
    const base = { action: 'apply' as const, mediaId, filename: null as string | null };
    if (!mediaId || mediaId.length > MAX_MEDIA_ID) return { ...base, outcome: 'failed', code: 'invalid-request', message: 'No valid media ID.' };
    const gated = await availability(ctx);
    const { safe, processor } = gated;
    if (!gated.apply || !safe || !processor || !ctx.media?.readBytes) {
      return { ...base, outcome: 'unavailable', reason: gated.status.reason, message: gated.message };
    }
    let measure;
    let scanOptions: ScanOptions;
    try {
      measure = readMeasureSettings(settings);
      scanOptions = scanOptionsFrom(settings);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return { ...base, outcome: 'failed', code: 'invalid-settings', message: `Check the plugin settings: ${error.message}.` };
    }
    const area = stagingArea();
    await area.sweep();

    const [item, active] = await Promise.all([ctx.media.get(mediaId), safe.revision(mediaId)]);
    const named = { ...base, filename: item?.filename ?? null };
    if (!item || !active) return { ...named, outcome: 'failed', code: 'not-found', message: 'The image no longer exists or is not ready.' };

    const support = gated.support();
    const format = imageFormat(active.mimeType);
    const capabilities = processor.capabilities();
    if (!format || !support?.formats.includes(format) || !capabilities.formats.includes(format as never)) {
      return { ...named, outcome: 'skipped', reason: 'unsupported-format', message: 'The host or the processor cannot replace this format.' };
    }
    const policy: Policy = {
      processor: capabilities.processor,
      processorVersion: capabilities.version,
      preset: measure.preset,
      removeGps: measure.removeGps,
    };
    const key = policyKey(policy);

    const own = await ownOptimization(safe, mediaId, active);
    if (own?.key === key) {
      const known = await ctx.kv.get<AppliedRecord>(`${APPLIED_PREFIX}${mediaId}`);
      const published = resultFromStatus(await safe.operation(mediaId, own.operationId));
      if (published?.ok && (known?.state !== 'optimized' || known.operationId !== own.operationId)) {
        // The response to this apply was lost: complete it from the host's receipt. The revision it
        // replaced is the one whose bytes it retained.
        const replaced: SafeMediaRevision = {
          mediaId,
          revisionId: own.retained.sourceRevisionId,
          mimeType: own.retained.mimeType,
          size: own.retained.size,
          width: null,
          height: null,
          sha256: own.retained.sha256,
        };
        const from = own.reoptimized ? { sha256: own.originalSha256, size: own.original?.size ?? null } : null;
        return finish(ctx, named, own.operationId, published, replaced, policy, null, from);
      }
      return { ...named, outcome: 'skipped', reason: 'already-optimized', message: 'Already optimized with the current settings.' };
    }
    const orphan = own ? null : await ownOutputWithoutOriginal(ctx, safe, mediaId, active);
    if (orphan) {
      // This plugin's output is active, but the host no longer lists the original it replaced.
      // Processing the active bytes again would compound the loss, so nothing is done.
      return orphan.policyKey === key
        ? { ...named, outcome: 'skipped', reason: 'already-optimized', message: 'Already optimized with the current settings.' }
        : { ...named, ...originalRefusal('NO_ORIGINAL', false), reoptimized: true };
    }
    // A different policy starts again from the retained original, never from this plugin's output:
    // re-optimization processes the original instead of the active bytes.
    const original: OriginalSource | null = own ? { sha256: own.originalSha256, size: own.original?.size ?? null } : null;
    const reoptimized = original !== null;
    const readOriginal = typeof safe.readOriginal === 'function' ? safe.readOriginal.bind(safe) : null;
    if (original && !readOriginal) {
      return {
        ...named,
        outcome: 'skipped',
        reason: 'reoptimize-unsupported',
        message:
          'This host cannot read a retained original without publishing it, so the image cannot be optimized again under new settings. The optimized image stays active; restore it first to optimize the original.',
        reoptimized,
      };
    }

    const operation = await operationFor(safe, mediaId, (attempt) =>
      original
        ? reoptimizeOperationId({ mediaId, sourceRevisionId: active.revisionId, originalSha256: original.sha256, policy }, attempt)
        : replaceOperationId({ mediaId, sourceRevisionId: active.revisionId, policy }, attempt),
    );
    if (!operation) {
      return { ...named, outcome: 'failed', code: 'attempts-exhausted', message: 'The host ended earlier attempts as interrupted. Try again later.', reoptimized };
    }
    const { operationId } = operation;
    if (operation.existing) {
      // A retry after a lost response: the host's stored outcome, without processing again.
      return finish(ctx, named, operationId, operation.existing, active, policy, null, original);
    }

    let staged = await area.get(operationId);
    let inputBytes = original ? (original.size ?? 0) : (active.size ?? 0);
    if (!staged) {
      const limit = Math.min(HOST_READ_LIMIT_BYTES, READ_ORIGINAL_MAX_BYTES, capabilities.limits.maxInputBytes, support.limits.maxBytes);
      let bytes: Uint8Array;
      if (original && readOriginal) {
        const read = await readOriginalBytes(readOriginal, mediaId, original, limit);
        if (!read.ok) return { ...named, ...read.outcome, reoptimized };
        bytes = read.bytes;
      } else {
        try {
          bytes = (await ctx.media.readBytes(mediaId, { maxBytes: limit })).bytes;
        } catch (error) {
          if (error instanceof RangeError) return { ...named, outcome: 'skipped', reason: 'over-byte-limit', message: 'The image is larger than the plugin may read.', reoptimized };
          return { ...named, outcome: 'failed', code: 'read-failed', message: 'The image bytes could not be read.', reoptimized };
        }
        // Bytes that are not the revision read above are never processed.
        if (active.sha256 && sha256Hex(bytes) !== active.sha256) {
          return { ...named, outcome: 'conflict', message: 'The image changed while it was read. The newer image was left as it is.', reoptimized };
        }
      }
      inputBytes = bytes.byteLength;
      let processed;
      try {
        processed = await processor.process({ bytes, preset: measure.preset, metadata: { removeGps: measure.removeGps } });
      } catch (error) {
        const code = error instanceof ImageProcessorError ? error.code : 'internal';
        const retryable = error instanceof ImageProcessorError && error.retryable;
        return { ...named, outcome: 'failed', code, retryable, message: 'The image could not be processed. Nothing was changed.', reoptimized };
      }
      if (processed.status === 'skipped') {
        return { ...named, outcome: 'skipped', reason: processed.reason, message: 'The processor skipped this image. Nothing was changed.', reoptimized };
      }
      const outputBytes = processed.output.byteLength;
      const saving = inputBytes - outputBytes;
      const minBytes = Math.max(MIN_APPLY_SAVING_BYTES, scanOptions.minSavingsBytes);
      const minRatio = Math.max(MIN_APPLY_SAVING_RATIO, scanOptions.minSavingsRatio);
      if (saving < minBytes || saving < inputBytes * minRatio) {
        return {
          ...named,
          outcome: 'skipped',
          reason: 'below-threshold',
          message: reoptimized
            ? 'Re-encoding the original does not save enough under the current settings. The optimized image stays active; nothing was submitted.'
            : 'Re-encoding does not save enough under the current settings. Nothing was submitted.',
          inputBytes,
          outputBytes,
          reoptimized,
        };
      }
      staged = await area.put(operationId, processed.output);
    }

    // A bulk run holds the commit back when it was paused or lost its lease meanwhile. The staged
    // output stays, so whoever resumes this operation submits the same bytes.
    if (hooks.beforeCommit && !(await hooks.beforeCommit(operationId))) {
      return { ...named, outcome: 'deferred', message: 'Processed, but not submitted: the run was paused or another worker took this image over.', reoptimized };
    }

    const result = await submit(safe, mediaId, operationId, () =>
      gated.adapter.apply({
        mediaId,
        operationId,
        expectedRevisionId: active.revisionId,
        bytes: staged.bytes,
        expectedSha256: staged.sha256,
      }),
    );
    if (result instanceof UnsupportedMediaHostError) {
      await area.remove(operationId);
      return { ...named, outcome: 'unavailable', reason: result.reason, message: gated.message, reoptimized };
    }
    return finish(ctx, named, operationId, result, active, policy, { inputBytes, sha256: staged.sha256 }, original);
  }

  /**
   * `source` is the revision the replace was fenced on, whose bytes the host retains; `original`,
   * for a re-optimization, the retained original that was processed instead of them.
   */
  async function finish(
    ctx: PluginContext,
    named: { action: 'apply'; mediaId: string; filename: string | null },
    operationId: string,
    result: SafeMediaResult | null,
    source: SafeMediaRevision,
    policy: Policy,
    submitted: { inputBytes: number; sha256: string } | null,
    original: OriginalSource | null,
  ): Promise<ActionOutcome> {
    const area = stagingArea();
    const reoptimized = original !== null;
    if (result === null) {
      // Keep the output: the next attempt resumes this operation with the same bytes.
      return { ...named, outcome: 'uncertain', message: 'The host did not confirm the change. Apply again to finish it; the same operation is resumed.', reoptimized };
    }
    if (!result.ok) {
      if (result.retryable) return { ...named, outcome: 'failed', code: result.code, retryable: true, message: messageFor(result.code), reoptimized };
      await area.remove(operationId);
      if (result.code === 'CONFLICT' || result.code === 'SOURCE_CHANGED') {
        return { ...named, outcome: 'conflict', message: messageFor(result.code), reoptimized };
      }
      return { ...named, outcome: 'failed', code: result.code, message: messageFor(result.code), reoptimized };
    }
    const receipt: PublishedReceipt = result.receipt;
    if (
      receipt.expectedRevisionId !== source.revisionId ||
      receipt.mediaId !== named.mediaId ||
      (submitted && receipt.candidateSha256 !== submitted.sha256)
    ) {
      return { ...named, outcome: 'failed', code: 'unexpected-receipt', message: 'The host confirmed a different change than the one submitted.', reoptimized };
    }
    await area.remove(operationId);
    const inputBytes = submitted?.inputBytes ?? (original ? (original.size ?? 0) : (source.size ?? 0));
    /** The file this operation replaced, which the host now retains: the source revision's bytes. */
    const replacedBytes = source.size ?? inputBytes;
    const existing = await ctx.kv.get<AppliedRecord>(`${APPLIED_PREFIX}${named.mediaId}`);
    const appliedAt = now().toISOString();
    await record(ctx, {
      mediaId: named.mediaId,
      filename: named.filename ?? named.mediaId,
      state: 'optimized',
      operationId,
      sourceRevisionId: receipt.expectedRevisionId,
      revisionId: receipt.newRevisionId,
      // The original restore puts back: for a re-optimization, the one processed, not the file replaced.
      originalSha256: original?.sha256 ?? receipt.originalSha256,
      inputBytes,
      outputBytes: receipt.size,
      preset: policy.preset,
      removeGps: policy.removeGps,
      policyKey: policyKey(policy),
      appliedAt,
      retained: withRetained(
        existing,
        { sha256: receipt.originalSha256, size: replacedBytes },
        ...(original ? [{ sha256: original.sha256, size: inputBytes }] : []),
      ),
    });
    await refreshResult(
      ctx,
      named.mediaId,
      optimizedResult({
        inputBytes,
        outputBytes: receipt.size,
        preset: policy.preset as OptimizedMarker['preset'],
        removeGps: policy.removeGps,
        processor: policy.processor,
        processorVersion: policy.processorVersion,
        at: appliedAt,
      }),
    );
    return {
      ...named,
      outcome: 'optimized',
      replayed: result.replayed,
      inputBytes,
      outputBytes: receipt.size,
      revisionId: receipt.newRevisionId,
      reoptimized,
    };
  }

  function failure(
    named: { action: 'apply' | 'restore'; mediaId: string; filename: string | null },
    result: Exclude<Awaited<ReturnType<typeof restoreOwn>>, UnsupportedMediaHostError>,
    fallback: string,
  ): ActionOutcome {
    if (result === 'uncertain') {
      return { ...named, outcome: 'uncertain', message: 'The host did not confirm the restore. Try again to finish it; the same operation is resumed.' };
    }
    if (result === 'exhausted') {
      return { ...named, outcome: 'failed', code: 'attempts-exhausted', message: 'The host ended earlier attempts as interrupted. Try again later.' };
    }
    if (result.ok) throw new Error('Not a failure');
    if (result.code === 'CONFLICT') return { ...named, outcome: 'conflict', message: messageFor(result.code) };
    if (result.code === 'NO_ORIGINAL' || result.code === 'ORIGINAL_UNAVAILABLE') {
      return { ...named, outcome: 'no-original', retryable: result.retryable, message: messageFor(result.code) };
    }
    return { ...named, outcome: 'failed', code: result.code, retryable: result.retryable, message: `${fallback} ${messageFor(result.code)}` };
  }

  async function restore(ctx: PluginContext, mediaId: string): Promise<ActionOutcome> {
    const base = { action: 'restore' as const, mediaId, filename: null as string | null };
    if (!mediaId || mediaId.length > MAX_MEDIA_ID) return { ...base, outcome: 'failed', code: 'invalid-request', message: 'No valid media ID.' };
    const gated = await availability(ctx);
    const { safe } = gated;
    if (!gated.restore || !safe) return { ...base, outcome: 'unavailable', reason: gated.status.reason, message: gated.message };

    const [item, active] = await Promise.all([ctx.media?.get(mediaId), safe.revision(mediaId)]);
    const named = { ...base, filename: item?.filename ?? null };
    if (!active) return { ...named, outcome: 'failed', code: 'not-found', message: 'The image no longer exists or is not ready.' };
    const own = await ownOptimization(safe, mediaId, active);
    if (!own) {
      const known = await ctx.kv.get<AppliedRecord>(`${APPLIED_PREFIX}${mediaId}`);
      // This plugin's own restore published the active revision, but its caller stopped before
      // recording it (a lost response, or a restart): complete it from the host's receipt.
      const replayed = known?.state === 'optimized' ? await ownRestore(safe, mediaId, active) : null;
      if (replayed && known) {
        await updateRecord(
          ctx,
          mediaId,
          { state: 'restored', restoredAt: now().toISOString(), revisionId: replayed.newRevisionId },
          { sha256: replayed.originalSha256, size: known.outputBytes },
        );
        await refreshResult(ctx, mediaId, restoredResult);
        return {
          ...named,
          outcome: 'restored',
          replayed: true,
          sha256: replayed.candidateSha256,
          bytes: replayed.size,
          revisionId: replayed.newRevisionId,
        };
      }
      // Changed by someone else since, or already restored: restoring would overwrite that image.
      if (known?.state === 'optimized') await updateRecord(ctx, mediaId, { state: 'superseded' });
      return {
        ...named,
        outcome: 'nothing-to-restore',
        message: 'The active image is not an optimization made by this plugin, so there is nothing to restore. It may have been changed or restored since.',
      };
    }
    const result = await restoreOwn(gated, safe, mediaId, active, own);
    if (result instanceof UnsupportedMediaHostError) {
      return { ...named, outcome: 'unavailable', reason: result.reason, message: gated.message };
    }
    if (result === 'uncertain' || result === 'exhausted' || !result.ok) {
      return failure(named, result, 'Nothing was restored.');
    }
    await updateRecord(
      ctx,
      mediaId,
      { state: 'restored', restoredAt: now().toISOString(), revisionId: result.receipt.newRevisionId },
      { sha256: result.receipt.originalSha256, size: active.size ?? 0 },
    );
    await refreshResult(ctx, mediaId, restoredResult);
    return {
      ...named,
      outcome: 'restored',
      replayed: result.replayed,
      sha256: result.receipt.candidateSha256,
      bytes: result.receipt.size,
      revisionId: result.receipt.newRevisionId,
    };
  }

  return {
    async allowed(ctx) {
      const gated = await availability(ctx);
      return { apply: gated.apply, restore: gated.restore, message: gated.message };
    },
    async view(ctx): Promise<MutationsView> {
      const gated = await availability(ctx);
      const all = await records(ctx);
      const optimized = all
        .filter((entry) => entry.state === 'optimized')
        .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
        .slice(0, APPLIED_SHOWN);
      return {
        apply: gated.apply,
        restore: gated.restore,
        reason: gated.status.reason,
        message: gated.message,
        optimized,
        accounting: storageAccounting(all),
      };
    },
    apply,
    restore,
    records,
    discard: (operationId) => stagingArea().remove(operationId),
  };
}
