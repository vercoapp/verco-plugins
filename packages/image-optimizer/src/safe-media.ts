/**
 * The host's safe-media access (`ctx.media.safe`), as far as this plugin uses it. Published EmDash
 * 1.1.0 has no such access and no types for it: it exists only on the patched host, for native
 * plugins that declare `media:bytes:replace`, on sites that configure `safeMedia`. These structural
 * types follow that host's protocol 1, and `safeMediaOf()` detects the access at run time, so the
 * plugin builds against the published package and stays read-only on a host without it.
 *
 * Types only, apart from the detection: the sandboxed entry never imports this module.
 */
import type { PluginContext } from 'emdash/plugin';

/** The capability that grants `ctx.media.safe` on the patched host. Unknown to published EmDash. */
export const SAFE_MEDIA_CAPABILITY = 'media:bytes:replace';

export interface SafeMediaSupport {
  protocol: number;
  /** Runtime, database, storage and locks of the host, as configured. */
  profile: Readonly<Record<string, string>>;
  formats: readonly string[];
  geometry: string;
  limits: { maxBytes: number; maxPixels: number };
}

/** The active revision of a ready media item. */
export interface SafeMediaRevision {
  mediaId: string;
  revisionId: string;
  mimeType: string;
  size: number | null;
  width: number | null;
  height: number | null;
  /** Null until the host has digested these bytes. */
  sha256: string | null;
}

export interface PublishedReceipt {
  status: 'published';
  operationId: string;
  kind: string;
  mediaId: string;
  expectedRevisionId: string;
  newRevisionId: string;
  /** For a restore, the restored original. */
  candidateSha256: string;
  /** The bytes this operation replaced, retained by the host. */
  originalSha256: string | null;
  size: number;
  width: number;
  height: number;
  mimeType: string;
}

export interface RejectedReceipt {
  status: 'rejected';
  code: string;
  operationId: string;
}

export type SafeMediaResult =
  | { ok: true; receipt: PublishedReceipt; replayed: boolean }
  | { ok: false; code: string; message: string; retryable: boolean; receipt?: RejectedReceipt };

export interface SafeMediaReplaceRequest {
  mediaId: string;
  operationId: string;
  expectedRevisionId: string;
  bytes: Uint8Array;
  expectedSha256?: string;
}

export interface SafeMediaRestoreRequest {
  mediaId: string;
  operationId: string;
  expectedRevisionId: string;
  originalSha256?: string;
}

export interface RestorableOriginal {
  sha256: string;
  size: number;
  mimeType: string;
  /** The revision whose exact bytes these are. */
  sourceRevisionId: string;
  retainedByOperationId: string;
  retainedByKind: string;
  /** The revision the retaining operation published in their place. */
  replacedByRevisionId: string | null;
  retainedAt: string | null;
}

/** Why the host refused to read a retained original. Only `ORIGINAL_UNREADABLE` is retryable. */
export type ReadOriginalRefusal =
  | 'INVALID_REQUEST'
  | 'MEDIA_UNAVAILABLE'
  | 'NO_ORIGINAL'
  | 'TOO_LARGE'
  | 'ORIGINAL_MISSING'
  | 'ORIGINAL_CORRUPT'
  | 'ORIGINAL_UNREADABLE';

export type ReadOriginalResult =
  | { ok: true; mediaId: string; sha256: string; mimeType: string; size: number; bytes: Uint8Array }
  | { ok: false; code: ReadOriginalRefusal; message: string; retryable: boolean };

/** The host's default and largest read: the same limits as `ctx.media.readBytes`. */
export const READ_ORIGINAL_MAX_BYTES = 16 * 1024 * 1024;

export interface SafeMediaOperationStatus {
  state: string;
  kind: string;
  receipt: PublishedReceipt | RejectedReceipt | null;
}

export interface SafeMediaAccess {
  support(): Promise<SafeMediaSupport>;
  revision(mediaId: string): Promise<SafeMediaRevision | null>;
  replace(request: SafeMediaReplaceRequest): Promise<SafeMediaResult>;
  restore(request: SafeMediaRestoreRequest): Promise<SafeMediaResult>;
  /** Newest first. */
  listRestorableOriginals(mediaId: string): Promise<RestorableOriginal[]>;
  /**
   * The bytes of an original retained for this media item, verified by the host against `sha256`.
   * Read-only: nothing is published or recorded, and no URL is returned. Absent on a host without
   * it (one that offers safe media but not this read).
   */
  readOriginal?(mediaId: string, sha256: string, options?: { maxBytes?: number }): Promise<ReadOriginalResult>;
  /** Null for unknown operation IDs and for operations another caller started. */
  operation(mediaId: string, operationId: string): Promise<SafeMediaOperationStatus | null>;
}

const METHODS = ['support', 'revision', 'replace', 'restore', 'listRestorableOriginals', 'operation'] as const;

/** The context's safe-media access, or `null` when the host does not offer every method this plugin uses. */
export function safeMediaOf(ctx: Pick<PluginContext, 'media'>): SafeMediaAccess | null {
  const safe: unknown = (ctx.media as { safe?: unknown } | undefined)?.safe;
  if (typeof safe !== 'object' || safe === null) return null;
  const record = safe as Record<string, unknown>;
  return METHODS.every((name) => typeof record[name] === 'function') ? (safe as SafeMediaAccess) : null;
}

/** Operation states after which the host will not change an operation again. */
export function isFinalState(state: string): boolean {
  return state === 'published' || state === 'rejected' || state === 'aborted';
}
