/**
 * An in-memory `ctx.media.safe` that follows the patched host's semantics (protocol 1), for the
 * apply and restore tests. It works on the fake host's media library, so `readBytes` reads whatever
 * revision is active:
 *
 * - Revisions: every publication makes a new revision ID; a baseline revision has no digest until an
 *   operation retains its bytes.
 * - Fencing: replace and restore publish only while `expectedRevisionId` is the active revision, and
 *   record a `CONFLICT` otherwise.
 * - Idempotency: an operation ID is bound to its request (kind, revision, bytes digest, caller); the
 *   same request replays the stored outcome or resumes an open operation, a different one is refused
 *   with `CONFLICTING_OPERATION`. Operations ended by reconciliation are `INTERRUPTED`.
 * - Geometry and format: output must decode, keep the format and the dimensions.
 * - Originals: the replaced bytes are retained by digest; restore publishes one retained by an
 *   operation on the same item, byte for byte, and retains the bytes it replaces.
 * - Ownership: `operation()` answers only the caller that started an operation, and another caller
 *   cannot reuse its ID.
 *
 * Fault injection simulates a process that stops after the host recorded an operation, and a
 * response lost after the host published.
 */
import { createHash } from 'node:crypto';

import sharp from 'sharp';

import type {
  PublishedReceipt,
  RejectedReceipt,
  RestorableOriginal,
  SafeMediaAccess,
  SafeMediaResult,
  SafeMediaSupport,
} from '../../src/safe-media.ts';
import type { FakeMedia } from '../fake-host.ts';

export const LOCAL_PROFILE = Object.freeze({ runtime: 'node', database: 'sqlite', storage: 'local', locks: 'in-process' });
export const OWNER = 'plugin:image-optimizer';

/** A media item with the editorial fields the host must keep across a replacement. */
export interface EditorialMedia extends FakeMedia {
  url: string;
  alt: string | null;
  caption: string | null;
  focalX: number | null;
  focalY: number | null;
}

interface Revision {
  id: string;
  mediaId: string;
  bytes: Uint8Array;
  sha256: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
}

interface Operation {
  mediaId: string;
  operationId: string;
  kind: 'replace' | 'restore';
  owner: string;
  fingerprint: string;
  expectedRevisionId: string;
  state: 'intent' | 'published' | 'rejected' | 'aborted';
  receipt: PublishedReceipt | RejectedReceipt | null;
  originalSha256: string | null;
  candidateRevisionId: string | null;
  completed: number;
}

/**
 * `after-intent`: the process stops after the host recorded the operation. `after-publish`: the
 * response is lost after the host published. `unreachable-after-publish`: as `after-publish`, and
 * the next status lookup fails too.
 */
type Fault = 'after-intent' | 'after-publish' | 'unreachable-after-publish';

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function fakeSafeMedia(
  library: FakeMedia[],
  options: { profile?: Record<string, string>; protocol?: number; maxBytes?: number } = {},
) {
  const revisions = new Map<string, Revision>();
  const active = new Map<string, string>();
  const originals = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const operations = new Map<string, Operation>();
  const publications: Array<{ mediaId: string; operationId: string; kind: string }> = [];
  const calls = { support: 0, replace: 0, restore: 0 };
  const faults: Fault[] = [];
  let sequence = 0;
  let lookupFails = false;

  const support: SafeMediaSupport = {
    protocol: options.protocol ?? 1,
    profile: { ...(options.profile ?? LOCAL_PROFILE) },
    formats: ['jpeg', 'png', 'webp'],
    geometry: 'unchanged',
    limits: { maxBytes: options.maxBytes ?? 16 * 1024 * 1024, maxPixels: 40_000_000 },
  };

  const item = (mediaId: string) => library.find(({ id }) => id === mediaId);
  const key = (mediaId: string, operationId: string) => `${mediaId}\u0000${operationId}`;
  const takeFault = (fault: Fault) => {
    const index = faults.indexOf(fault);
    if (index < 0) return false;
    faults.splice(index, 1);
    return true;
  };

  /** The active revision, creating the baseline for media never handled by an operation. */
  function activeRevision(mediaId: string): Revision | null {
    const media = item(mediaId);
    if (!media?.bytes) return null;
    let id = active.get(mediaId);
    if (!id) {
      id = `rev-${(sequence += 1)}`;
      revisions.set(id, {
        id,
        mediaId,
        bytes: media.bytes,
        sha256: null,
        mimeType: media.mimeType,
        width: media.width ?? null,
        height: media.height ?? null,
      });
      active.set(mediaId, id);
    }
    return revisions.get(id)!;
  }

  function publish(mediaId: string, bytes: Uint8Array, sha256: string, from: Revision): Revision {
    const media = item(mediaId)!;
    const id = `rev-${(sequence += 1)}`;
    const revision: Revision = { id, mediaId, bytes, sha256, mimeType: from.mimeType, width: from.width, height: from.height };
    revisions.set(id, revision);
    active.set(mediaId, id);
    // The host moves the revision pointer and byte-derived fields; editorial fields stay.
    media.bytes = bytes;
    media.size = bytes.byteLength;
    return revision;
  }

  function refused(code: string): Extract<SafeMediaResult, { ok: false }> {
    return { ok: false, code, message: `refused: ${code}`, retryable: false };
  }

  function finish(operation: Operation, code: string, state: 'rejected' | 'aborted' = 'rejected'): SafeMediaResult {
    operation.state = state;
    const receipt: RejectedReceipt = { status: 'rejected', code, operationId: operation.operationId };
    operation.receipt = receipt;
    operation.completed = sequence += 1;
    return { ...refused(code), receipt };
  }

  function replay(operation: Operation): SafeMediaResult | null {
    if (operation.state === 'intent') return null;
    if (operation.receipt?.status === 'published') return { ok: true, receipt: operation.receipt, replayed: true };
    const receipt = operation.receipt?.status === 'rejected' ? operation.receipt : undefined;
    return { ...refused(receipt?.code ?? 'CONFLICT'), ...(receipt ? { receipt } : {}) };
  }

  /** Records intent, or finds the earlier identical request. */
  function begin(
    owner: string,
    request: { mediaId: string; operationId: string; expectedRevisionId: string },
    kind: Operation['kind'],
    candidateSha256: string,
  ): Operation | SafeMediaResult {
    const existing = operations.get(key(request.mediaId, request.operationId));
    const fingerprint = JSON.stringify([kind, request.expectedRevisionId, candidateSha256, owner]);
    if (existing) {
      if (existing.owner !== owner || existing.fingerprint !== fingerprint) return refused('CONFLICTING_OPERATION');
      return replay(existing) ?? existing;
    }
    const operation: Operation = {
      mediaId: request.mediaId,
      operationId: request.operationId,
      kind,
      owner,
      fingerprint,
      expectedRevisionId: request.expectedRevisionId,
      state: 'intent',
      receipt: null,
      originalSha256: null,
      candidateRevisionId: null,
      completed: 0,
    };
    operations.set(key(request.mediaId, request.operationId), operation);
    return operation;
  }

  /** Retains the active bytes of `source` as an original; `null` when they changed under their digest. */
  function retain(source: Revision): string | null {
    const digest = sha(source.bytes);
    if (source.sha256 !== null && source.sha256 !== digest) return null;
    source.sha256 = digest;
    if (!originals.has(digest)) originals.set(digest, { bytes: Uint8Array.from(source.bytes), mimeType: source.mimeType });
    return digest;
  }

  function published(operation: Operation, revision: Revision, originalSha256: string, from: Revision): SafeMediaResult {
    const receipt: PublishedReceipt = {
      status: 'published',
      operationId: operation.operationId,
      kind: operation.kind,
      mediaId: operation.mediaId,
      expectedRevisionId: operation.expectedRevisionId,
      newRevisionId: revision.id,
      candidateSha256: revision.sha256!,
      originalSha256,
      size: revision.bytes.byteLength,
      width: from.width ?? 0,
      height: from.height ?? 0,
      mimeType: revision.mimeType,
    };
    operation.state = 'published';
    operation.receipt = receipt;
    operation.originalSha256 = originalSha256;
    operation.candidateRevisionId = revision.id;
    operation.completed = sequence += 1;
    publications.push({ mediaId: operation.mediaId, operationId: operation.operationId, kind: operation.kind });
    if (takeFault('unreachable-after-publish')) {
      lookupFails = true;
      throw new Error('Simulated lost response after publication');
    }
    if (takeFault('after-publish')) throw new Error('Simulated lost response after publication');
    return { ok: true, receipt, replayed: false };
  }

  function retaining(mediaId: string): Operation[] {
    return [...operations.values()]
      .filter((operation) => operation.mediaId === mediaId && operation.state === 'published' && operation.originalSha256)
      .sort((a, b) => b.completed - a.completed);
  }

  function access(owner = OWNER): SafeMediaAccess {
    return {
      async support() {
        calls.support += 1;
        return structuredClone(support);
      },

      async revision(mediaId) {
        const revision = activeRevision(mediaId);
        if (!revision) return null;
        return {
          mediaId,
          revisionId: revision.id,
          mimeType: revision.mimeType,
          size: revision.bytes.byteLength,
          width: revision.width,
          height: revision.height,
          sha256: revision.sha256,
        };
      },

      async replace(request) {
        calls.replace += 1;
        if (
          !IDENTIFIER.test(request.operationId) ||
          !request.mediaId ||
          !request.expectedRevisionId ||
          !(request.bytes instanceof Uint8Array)
        ) {
          return refused('INVALID_REQUEST');
        }
        const bytes = Uint8Array.from(request.bytes);
        const candidateSha256 = sha(bytes);
        const begun = begin(owner, request, 'replace', candidateSha256);
        if (!('fingerprint' in begun)) return begun;
        const operation = begun;
        if (takeFault('after-intent')) throw new Error('Simulated stop after the intent was recorded');

        const source = revisions.get(request.expectedRevisionId);
        if (!source || source.mediaId !== request.mediaId || active.get(request.mediaId) !== source.id || !item(request.mediaId)) {
          return finish(operation, 'CONFLICT');
        }
        if (request.expectedSha256 !== undefined && request.expectedSha256 !== candidateSha256) return finish(operation, 'DIGEST_MISMATCH');
        if (bytes.byteLength > support.limits.maxBytes) return finish(operation, 'TOO_LARGE_BYTES');
        let metadata;
        try {
          metadata = await sharp(bytes).metadata();
        } catch {
          return finish(operation, 'UNDECODABLE');
        }
        if (MIME[metadata.format ?? ''] !== source.mimeType) return finish(operation, 'WRONG_FORMAT');
        if (metadata.width !== source.width || metadata.height !== source.height) return finish(operation, 'DIMENSIONS_CHANGED');

        const originalSha256 = retain(source);
        if (!originalSha256) return finish(operation, 'SOURCE_CHANGED');
        const revision = publish(request.mediaId, bytes, candidateSha256, source);
        return published(operation, revision, originalSha256, source);
      },

      async restore(request) {
        calls.restore += 1;
        if (
          !IDENTIFIER.test(request.operationId) ||
          !request.mediaId ||
          !request.expectedRevisionId ||
          (request.originalSha256 !== undefined && !/^[0-9a-f]{64}$/.test(request.originalSha256))
        ) {
          return refused('INVALID_REQUEST');
        }
        const chosen = retaining(request.mediaId).find((operation) =>
          request.originalSha256 === undefined
            ? operation.candidateRevisionId === request.expectedRevisionId
            : operation.originalSha256 === request.originalSha256,
        );
        if (!chosen?.originalSha256 || !originals.has(chosen.originalSha256)) return refused('NO_ORIGINAL');
        const originalSha256 = chosen.originalSha256;
        const begun = begin(owner, request, 'restore', originalSha256);
        if (!('fingerprint' in begun)) return begun;
        const operation = begun;
        if (takeFault('after-intent')) throw new Error('Simulated stop after the intent was recorded');

        const current = activeRevision(request.mediaId);
        if (!current || current.id !== request.expectedRevisionId) return finish(operation, 'CONFLICT');
        const original = originals.get(originalSha256)!;
        if (sha(original.bytes) !== originalSha256) return finish(operation, 'ORIGINAL_UNAVAILABLE');
        if (original.mimeType !== current.mimeType) return finish(operation, 'WRONG_FORMAT');
        const replaced = retain(current);
        if (!replaced) return finish(operation, 'SOURCE_CHANGED');
        const sourceOfOriginal = revisions.get(chosen.expectedRevisionId) ?? current;
        const revision = publish(request.mediaId, Uint8Array.from(original.bytes), originalSha256, sourceOfOriginal);
        return published(operation, revision, replaced, sourceOfOriginal);
      },

      async listRestorableOriginals(mediaId): Promise<RestorableOriginal[]> {
        const seen = new Set<string>();
        const result: RestorableOriginal[] = [];
        for (const operation of retaining(mediaId)) {
          const digest = operation.originalSha256!;
          if (seen.has(digest) || !originals.has(digest)) continue;
          seen.add(digest);
          const original = originals.get(digest)!;
          result.push({
            sha256: digest,
            size: original.bytes.byteLength,
            mimeType: original.mimeType,
            sourceRevisionId: operation.expectedRevisionId,
            retainedByOperationId: operation.operationId,
            retainedByKind: operation.kind,
            replacedByRevisionId: operation.candidateRevisionId,
            retainedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, operation.completed)).toISOString(),
          });
        }
        return result;
      },

      async operation(mediaId, operationId) {
        if (lookupFails) {
          lookupFails = false;
          throw new Error('Simulated host error');
        }
        const operation = operations.get(key(mediaId, operationId));
        if (!operation || operation.owner !== owner) return null;
        return { state: operation.state, kind: operation.kind, receipt: operation.receipt };
      },
    };
  }

  return {
    access,
    calls,
    publications,
    originals,
    operations,
    support,
    /** Fails the next matching step once. */
    failNext(...next: Fault[]) {
      faults.push(...next);
    },
    /** An editor replaces the file outside safe media: a new revision, digest unknown. */
    editorReplace(mediaId: string, bytes: Uint8Array) {
      const current = activeRevision(mediaId)!;
      const id = `rev-${(sequence += 1)}`;
      revisions.set(id, { ...current, id, bytes, sha256: null });
      active.set(mediaId, id);
      const media = item(mediaId)!;
      media.bytes = bytes;
      media.size = bytes.byteLength;
    },
    /** Damages a retained original, as a storage fault would. */
    damageOriginal(sha256: string) {
      const original = originals.get(sha256)!;
      original.bytes = Uint8Array.from([...original.bytes.subarray(0, 10), 0]);
    },
    /** Ends operations left open, as the host's reconciliation does after its grace period. */
    reconcile() {
      for (const operation of operations.values()) {
        if (operation.state === 'intent') finish(operation, 'INTERRUPTED', 'aborted');
      }
    },
    activeRevisionId: (mediaId: string) => activeRevision(mediaId)?.id ?? null,
  };
}

export type FakeSafeMedia = ReturnType<typeof fakeSafeMedia>;

export const sha256 = sha;
