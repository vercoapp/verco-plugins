export type CompatibilityReason =
  | 'missing-host-operation'
  | 'host-discovery-failed'
  | 'unqualified-host';

export interface MediaOperationAvailability {
  scan: true;
  apply: false;
  restore: false;
  reason: CompatibilityReason;
  message: string;
}

export class UnsupportedMediaHostError extends Error {
  readonly code = 'UNSUPPORTED_MEDIA_HOST';

  constructor() {
    super('Apply and restore require a qualified safe media host implementation.');
    this.name = 'UnsupportedMediaHostError';
  }
}

/** Discovery is injected until a versioned EmDash host bridge exists. */
export interface HostDiscovery {
  discover?: () => Promise<unknown>;
}

export function createMediaHostAdapter(host: HostDiscovery = {}) {
  async function availability(): Promise<MediaOperationAvailability> {
    let reason: CompatibilityReason = 'missing-host-operation';
    let message = 'This host does not expose safe media operations. Scanning is available.';

    if (host.discover) {
      try {
        const support = await host.discover();
        if (support !== null && support !== undefined) {
          reason = 'unqualified-host';
          message = 'This host has not been qualified for safe media operations. Scanning is available.';
        }
      } catch {
        reason = 'host-discovery-failed';
        message = 'Safe media host support could not be checked. Scanning is available.';
      }
    }

    // No host profile has passed publication, recovery and delivery qualification.
    return { scan: true, apply: false, restore: false, reason, message };
  }

  async function rejectMutation(): Promise<never> {
    throw new UnsupportedMediaHostError();
  }

  return { availability, apply: rejectMutation, restore: rejectMutation };
}
