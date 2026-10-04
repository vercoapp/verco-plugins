export type CompatibilityReason =
  | 'missing-host-operation'
  | 'host-discovery-failed'
  | 'unknown-protocol'
  | 'unqualified-host';

/** A host profile as discovery reports it (runtime, database, storage, locks). */
export type HostProfile = Readonly<Record<string, string>>;

export interface ReadOnlyAvailability {
  scan: true;
  apply: false;
  restore: false;
  reason: CompatibilityReason;
  message: string;
}

export interface MutableAvailability {
  scan: true;
  apply: true;
  restore: true;
  reason: 'qualified-host';
  message: string;
  protocol: number;
  profile: HostProfile;
}

export type MediaOperationAvailability = ReadOnlyAvailability | MutableAvailability;

export class UnsupportedMediaHostError extends Error {
  readonly code = 'UNSUPPORTED_MEDIA_HOST';
  readonly reason: CompatibilityReason;

  constructor(reason: CompatibilityReason = 'unqualified-host') {
    super('Apply and restore require a qualified safe media host implementation.');
    this.name = 'UnsupportedMediaHostError';
    this.reason = reason;
  }
}

/** Safe-media protocol versions this adapter understands. */
export const KNOWN_PROTOCOLS: readonly number[] = Object.freeze([1]);

/**
 * Host profiles on which apply and restore have passed qualification. None has
 * yet, so every host stays read-only.
 */
export const QUALIFIED_HOST_PROFILES: readonly HostProfile[] = Object.freeze([]);

/**
 * The host's discovery and operations, injected by the caller. `discover`
 * resolves to the host's support description, or to null or undefined when the
 * host offers no safe media operations.
 */
export interface HostDiscovery {
  discover?: () => Promise<unknown>;
  apply?: (request: unknown) => Promise<unknown>;
  restore?: (request: unknown) => Promise<unknown>;
}

export interface MediaHostAdapterOptions {
  /** Defaults to {@link QUALIFIED_HOST_PROFILES}. */
  qualifiedProfiles?: readonly HostProfile[];
}

function readOnly(reason: CompatibilityReason, message: string): ReadOnlyAvailability {
  return { scan: true, apply: false, restore: false, reason, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A profile made only of string fields, or null if the value is not one. */
function readProfile(value: unknown): HostProfile | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([, field]) => typeof field !== 'string')) return null;
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

function sameProfile(a: HostProfile, b: HostProfile): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function describeProfile(profile: HostProfile): string {
  return Object.entries(profile).map(([key, value]) => `${key} ${value}`).join(', ');
}

export function createMediaHostAdapter(host: HostDiscovery = {}, options: MediaHostAdapterOptions = {}) {
  const qualifiedProfiles = (options.qualifiedProfiles ?? QUALIFIED_HOST_PROFILES)
    .map((profile) => readProfile(profile))
    .filter((profile) => profile !== null);

  async function availability(): Promise<MediaOperationAvailability> {
    if (!host.discover) {
      return readOnly('missing-host-operation', 'This host does not expose safe media operations. Scanning is available.');
    }
    let support: unknown;
    try {
      support = await host.discover();
    } catch {
      return readOnly('host-discovery-failed', 'Safe media host support could not be checked. Scanning is available.');
    }
    if (support === null || support === undefined) {
      return readOnly('missing-host-operation', 'This host does not expose safe media operations. Scanning is available.');
    }
    const protocol = isRecord(support) ? support.protocol : undefined;
    const profile = isRecord(support) ? readProfile(support.profile) : null;
    if (typeof protocol === 'number' && !KNOWN_PROTOCOLS.includes(protocol)) {
      return readOnly(
        'unknown-protocol',
        'This host uses a safe media protocol this plugin does not support. Scanning is available.',
      );
    }
    if (typeof protocol !== 'number' || !profile) {
      return readOnly('unqualified-host', 'This host has not been qualified for safe media operations. Scanning is available.');
    }
    if (!qualifiedProfiles.some((qualified) => sameProfile(qualified, profile))) {
      return readOnly(
        'unqualified-host',
        `This host profile (${describeProfile(profile)}) has not been qualified for safe media operations. Scanning is available.`,
      );
    }
    return {
      scan: true,
      apply: true,
      restore: true,
      reason: 'qualified-host',
      message: 'This host profile is qualified for safe media operations.',
      protocol,
      profile,
    };
  }

  /** Mutation runs only after discovery confirms a qualified host at the time of the call. */
  async function guarded(operation: HostDiscovery['apply'], request: unknown): Promise<unknown> {
    // With nothing qualified there is nothing to discover.
    if (qualifiedProfiles.length === 0) throw new UnsupportedMediaHostError();
    const status = await availability();
    if (!status.apply) throw new UnsupportedMediaHostError(status.reason);
    if (!operation) throw new UnsupportedMediaHostError('missing-host-operation');
    return operation(request);
  }

  return {
    availability,
    apply: (request?: unknown) => guarded(host.apply, request),
    restore: (request?: unknown) => guarded(host.restore, request),
  };
}
