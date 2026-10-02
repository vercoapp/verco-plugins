/**
 * Limits for local processing, and admission control over decoded pixels in flight.
 *
 * An encode's memory grows with the decoded pixel count, not with the file size, so the processor
 * admits work by pixels: the sum over running encodes stays within `maxInFlightPixels`, and work
 * that does not fit is refused as `busy` rather than queued behind an unbounded wait.
 *
 * The defaults below record where they come from; re-measure them on the hosting hardware with
 * `calibration/measure-processor.ts`.
 */

export interface ProcessorLimits {
  /** Largest input accepted, in bytes. Checked before any work. */
  maxInputBytes: number;
  /** Largest decoded image, in pixels. Checked from the header, before pixels are decoded. */
  maxPixels: number;
  /** Wall time for one image, from starting the worker to its result. The worker is killed after it. */
  wallTimeMs: number;
  /** Decoded pixels allowed across all encodes running at once. */
  maxInFlightPixels: number;
  /** Worker processes allowed at once, each holding one encode. */
  maxWorkers: number;
}

/**
 * Starting points from `calibration/measure-processor.ts` on an Apple M1 Pro (Node 24, Sharp
 * 0.35.4, one libvips thread per worker), with Gaussian noise inputs, the slowest and largest
 * content to encode. At 24 MP the slowest encode was high-fidelity WebP at 12 s, and worker memory
 * per megapixel was about 64 MB for lossless WebP (1.5 GB in all), 35-44 MB for lossy WebP, 12-21 MB
 * for JPEG and 12 MB for PNG. At 40 MP lossless WebP needed 2.2 GB.
 *
 * - `maxPixels` 24 MP: most camera images, while one worker stays near 1.5 GB at worst.
 * - `maxInFlightPixels` equal to it: one image of the maximum size at a time, or several smaller.
 * - `wallTimeMs` 60 s: five times the slowest measured encode, for slower host CPUs.
 * - `maxInputBytes` 50 MiB: the host's limit for a replacement image, so larger files could not be
 *   published anyway.
 *
 * Host hardware is usually slower and has less memory: re-measure there before relying on these.
 */
export const DEFAULT_PROCESSOR_LIMITS: Readonly<ProcessorLimits> = Object.freeze({
  maxInputBytes: 50 * 1024 * 1024,
  maxPixels: 24_000_000,
  wallTimeMs: 60_000,
  maxInFlightPixels: 24_000_000,
  maxWorkers: 2,
});

export function resolveProcessorLimits(overrides: Partial<ProcessorLimits> = {}): ProcessorLimits {
  const limits = { ...DEFAULT_PROCESSOR_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Processor limit ${name} must be a positive integer`);
    }
  }
  if (limits.maxInFlightPixels < limits.maxPixels) {
    throw new RangeError('maxInFlightPixels must admit at least one image of maxPixels');
  }
  return limits;
}

export interface PixelAdmission {
  /** Reserves `pixels` and returns its release function, or `null` if they do not fit now. */
  tryAcquire(pixels: number): (() => void) | null;
  inFlightPixels(): number;
}

export function createPixelAdmission(maxInFlightPixels: number): PixelAdmission {
  let inFlight = 0;
  return {
    tryAcquire(pixels) {
      if (!Number.isSafeInteger(pixels) || pixels <= 0) return null;
      if (inFlight + pixels > maxInFlightPixels) return null;
      inFlight += pixels;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= pixels;
      };
    },
    inFlightPixels: () => inFlight,
  };
}
