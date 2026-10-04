/**
 * The plugin's private staging area for processed output, between processing and the host commit.
 * Native edition only (Node file system).
 *
 * Why it exists when one invocation processes and commits: the host refuses an operation ID repeated
 * with different bytes (`CONFLICTING_OPERATION`). If the site process stops, or the commit's response
 * is lost, after the host recorded the operation but before it finished, the retry must submit the
 * same bytes under the same deterministic operation ID. An encoder is not guaranteed to reproduce its
 * output byte for byte, so the output is kept here, keyed by operation ID, until the host's outcome
 * is final. It also spares the retry a second encode.
 *
 * Output bytes never go to plugin storage, KV or settings. Entries are files named
 * `<operation ID>.<sha256>.out` in a directory only this process's user can read, written to a
 * temporary name, flushed and renamed, and verified against their digest when read. Each one is
 * removed once the host's outcome is final, and anything older than `maxAgeMs` is swept.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Longer than the host's reconciliation grace (10 minutes), after which the host ends an interrupted
 * operation itself and a retry needs a new operation ID anyway.
 */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const ENTRY = /^([A-Za-z0-9._-]+)\.([0-9a-f]{64})\.out$/;
const TEMPORARY = /\.tmp-[0-9a-f]+$/;
const OPERATION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export interface StagedOutput {
  bytes: Uint8Array;
  sha256: string;
}

export interface Staging {
  readonly directory: string;
  put(operationId: string, bytes: Uint8Array): Promise<StagedOutput>;
  /** The staged output, or `null` when there is none or it no longer matches its digest. */
  get(operationId: string): Promise<StagedOutput | null>;
  remove(operationId: string): Promise<void>;
  /** Removes entries and leftover temporary files older than `maxAgeMs`; returns how many. */
  sweep(now?: number): Promise<number>;
  /** Operation IDs with a staged entry. */
  list(): Promise<string[]>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The default directory: one per site directory, under the system temporary directory, so two sites
 * on one machine do not share entries.
 */
export function defaultStagingDirectory(): string {
  const site = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16);
  return join(tmpdir(), `emdash-image-optimizer-${site}`, 'staging');
}

function checkId(operationId: string): void {
  if (!OPERATION_ID.test(operationId)) throw new RangeError('Invalid operation ID for staging');
}

export function createStaging(options: { directory?: string; maxAgeMs?: number } = {}): Staging {
  const directory = options.directory ?? defaultStagingDirectory();
  const maxAgeMs = options.maxAgeMs ?? STAGING_MAX_AGE_MS;

  const ensure = () => mkdir(directory, { recursive: true, mode: 0o700 });

  async function names(): Promise<string[]> {
    try {
      return await readdir(directory);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return [];
      throw error;
    }
  }

  async function entriesOf(operationId: string): Promise<Array<{ name: string; sha256: string }>> {
    return (await names()).flatMap((name) => {
      const match = ENTRY.exec(name);
      return match && match[1] === operationId ? [{ name, sha256: match[2]! }] : [];
    });
  }

  async function remove(operationId: string): Promise<void> {
    checkId(operationId);
    for (const { name } of await entriesOf(operationId)) await rm(join(directory, name), { force: true });
  }

  return {
    directory,

    async put(operationId, bytes) {
      checkId(operationId);
      await ensure();
      const sha256 = sha256Hex(bytes);
      // One entry per operation: a different output for the same ID replaces the old one.
      await remove(operationId);
      const target = join(directory, `${operationId}.${sha256}.out`);
      const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      return { bytes, sha256 };
    },

    async get(operationId) {
      checkId(operationId);
      for (const { name, sha256 } of await entriesOf(operationId)) {
        const path = join(directory, name);
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await readFile(path));
        } catch {
          continue;
        }
        if (sha256Hex(bytes) === sha256) return { bytes, sha256 };
        // Damaged: never submit it.
        await rm(path, { force: true });
      }
      return null;
    },

    remove,

    async sweep(now = Date.now()) {
      let removed = 0;
      for (const name of await names()) {
        if (!ENTRY.test(name) && !TEMPORARY.test(name)) continue;
        const path = join(directory, name);
        try {
          if (now - (await stat(path)).mtimeMs < maxAgeMs) continue;
          await rm(path, { force: true });
          removed += 1;
        } catch {
          // Removed meanwhile.
        }
      }
      return removed;
    },

    async list() {
      return (await names()).flatMap((name) => {
        const match = ENTRY.exec(name);
        return match ? [match[1]!] : [];
      });
    },
  };
}
