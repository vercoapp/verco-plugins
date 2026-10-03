/**
 * Limits for local processing, and admission control over decoded pixels in flight.
 *
 * An encode's memory grows with the decoded pixel count, not with the file size, so the processor
 * admits work by pixels: the sum over running encodes stays within `maxInFlightPixels`, and work
 * that does not fit is refused as `busy` rather than queued behind an unbounded wait. Encoders that
 * need more memory per pixel than the rest can have a lower pixel limit of their own and count each
 * pixel more than once against the budget.
 *
 * The defaults below record where they come from; re-measure them on the hosting hardware with
 * `calibration/measure-processor.ts`.
 */

import type { EncoderTarget } from './presets.ts';

export interface ProcessorLimits {
  /** Largest input accepted, in bytes. Checked before any work. */
  maxInputBytes: number;
  /** Largest decoded image, in pixels. Checked from the header, before pixels are decoded. */
  maxPixels: number;
  /** Wall time for one image, from starting the worker to its result. The worker is killed after it. */
  wallTimeMs: number;
  /** Decoded pixels allowed across all encodes running at once, each counted with its weight. */
  maxInFlightPixels: number;
  /** Worker processes allowed at once, each holding one encode. */
  maxWorkers: number;
  /** A lower `maxPixels` for encoders whose memory per pixel does not fit the global one. */
  maxPixelsByEncoder: Readonly<Partial<Record<EncoderTarget, number>>>;
  /** How many pixels of the in-flight budget one decoded pixel takes, for encoders heavier than 1. */
  pixelWeightByEncoder: Readonly<Partial<Record<EncoderTarget, number>>>;
}

/**
 * Measured with `calibration/measure-processor.ts` on one VPS (4 vCPU AMD EPYC 9J45, Debian 13 host)
 * inside a container capped at 2 CPUs and 3 GiB, Node 22.16, Sharp 0.35.4, one libvips thread per
 * worker, on Gaussian noise (the slowest and largest content to encode) and on generated
 * photograph-like images. The figures are the worker's peak resident memory (MiB, the larger
 * of the two presets), noise, at 24 MP:
 *
 * | input             | encode time (balanced / high fidelity) | peak memory | per megapixel |
 * | ----------------- | -------------------------------------- | ----------- | ------------- |
 * | PNG               | 2.1 s                                  | 340 MiB     | 14 MiB        |
 * | JPEG              | 4.8 s / 9.3 s                          | 550 MiB     | 23 MiB        |
 * | lossy WebP        | 4.2 s / 12.3 s                         | 810 MiB     | 34 MiB        |
 * | lossless WebP     | 4.1 s                                  | 1310 MiB    | 55-58 MiB     |
 *
 * Photograph-like content used 58-96% of the noise memory (lossless WebP 1260 MiB at 24 MP). It
 * encoded JPEG and lossy WebP in 20-40% of the noise time, but PNG and lossless WebP slower (5.5 s
 * and 5.3 s at 24 MP, against 2.1 s and 4.1 s), because noise is the cheap case for their
 * compression; none came near the 12.3 s of the slowest noise encode. Two lossless WebP encodes of
 * 24 MP at once reached the container's 3 GiB limit and the kernel killed their workers; that is the
 * case these limits exist to prevent.
 *
 * - `maxPixels` 24 MP: most camera images. One lossy encode of it peaks at 810 MiB.
 * - `maxPixelsByEncoder` lossless WebP 12 MP: it needs about 58 MiB per megapixel, so 12 MP is 700 MiB
 *   and 24 MP is 1300 MiB, too much to share a 3 GiB container with the site. Larger lossless WebP
 *   images are skipped as over the pixel limit.
 * - `pixelWeightByEncoder` lossless WebP 2: a pixel of it takes about twice the memory of a lossy
 *   WebP pixel, the next most expensive, so it counts twice against the budget. PNG and JPEG cost
 *   less than lossy WebP and are counted as one pixel, which over-reserves them.
 * - `maxInFlightPixels` 24 M: one 24 MP lossy image, two 12 MP images, or one 12 MP lossless WebP,
 *   whichever mix is running. Every mix stays under about 900 MiB of worker memory (two 12 MP lossy
 *   WebP encodes, 890 MiB, is the worst), which leaves at least 1.5 GiB of the 3 GiB cap for the site (the
 *   whole container peaked at 1.5 GiB with two 12 MP encodes, measuring script included).
 * - `maxWorkers` 2: the container has two CPUs, one thread per worker, and the pixel budget bounds
 *   memory whatever the count. Two concurrent 24 MP encodes took 4-13 s, as one alone does.
 * - `wallTimeMs` 40 s: three times the slowest 24 MP encode, high-fidelity lossy WebP of noise at
 *   12.3 s alone or 12.8 s beside another worker, to allow for the site using the same two CPUs. A
 *   tick that starts an image just before its own bound (`MEASURED_TICK_WALL_MS`) then still ends
 *   inside the one-minute cron interval.
 * - `maxInputBytes` 16 MiB: the host's `media.readBytes` limit, so nothing larger can be read from
 *   it anyway; the parent holds the input, a copy for the worker and the output, so this bounds
 *   its memory too.
 *
 * One VPS under one container cap is what was measured; other hardware, other Sharp versions or a
 * busy site can differ, so re-measure before relying on these for a different deployment.
 */
export const DEFAULT_PROCESSOR_LIMITS: Readonly<ProcessorLimits> = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxPixels: 24_000_000,
  wallTimeMs: 40_000,
  maxInFlightPixels: 24_000_000,
  maxWorkers: 2,
  maxPixelsByEncoder: Object.freeze({ 'webp-lossless': 12_000_000 }),
  pixelWeightByEncoder: Object.freeze({ 'webp-lossless': 2 }),
});

const SCALAR_LIMITS = ['maxInputBytes', 'maxPixels', 'wallTimeMs', 'maxInFlightPixels', 'maxWorkers'] as const;

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function resolveProcessorLimits(overrides: Partial<ProcessorLimits> = {}): ProcessorLimits {
  const limits = { ...DEFAULT_PROCESSOR_LIMITS, ...overrides };
  for (const name of SCALAR_LIMITS) {
    if (!positive(limits[name])) throw new RangeError(`Processor limit ${name} must be a positive integer`);
  }
  for (const name of ['maxPixelsByEncoder', 'pixelWeightByEncoder'] as const) {
    const table: unknown = limits[name];
    if (typeof table !== 'object' || table === null) throw new RangeError(`Processor limit ${name} must be an object`);
    for (const [target, value] of Object.entries(table)) {
      if (!positive(value)) throw new RangeError(`Processor limit ${name}.${target} must be a positive integer`);
    }
  }
  if (limits.maxInFlightPixels < limits.maxPixels) {
    throw new RangeError('maxInFlightPixels must admit at least one image of maxPixels');
  }
  return limits;
}

/**
 * The pixel limit and budget weight that apply to one encoder. An image whose weighted pixels
 * exceed the whole budget could never be admitted, so the limit is lowered to what can be.
 */
export function encoderLimits(limits: ProcessorLimits, target: EncoderTarget): { maxPixels: number; weight: number } {
  const weight = limits.pixelWeightByEncoder[target] ?? 1;
  const maxPixels = Math.min(
    limits.maxPixels,
    limits.maxPixelsByEncoder[target] ?? Number.POSITIVE_INFINITY,
    Math.floor(limits.maxInFlightPixels / weight),
  );
  return { maxPixels, weight };
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
