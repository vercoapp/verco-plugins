/**
 * Metadata-only scan: decides from type, byte size and dimensions whether an image is likely
 * larger than it needs to be. It never reads image bytes, so every saving is an estimate.
 */

/** The subset of EmDash's plugin `MediaItem` the scan reads. */
export interface ScanMediaItem {
  id: string;
  mimeType: string;
  size: number | null;
  width?: number | null;
  height?: number | null;
}

export interface ScanOptions {
  /** Longest edge, in pixels, an image needs for the site. */
  maxDimension: number;
  /** Smallest estimated saving worth reporting. */
  minSavingsBytes: number;
  /** Smallest estimated saving, as a fraction of the file size, worth reporting. */
  minSavingsRatio: number;
}

export const DEFAULT_SCAN_OPTIONS: Readonly<ScanOptions> = Object.freeze({
  maxDimension: 2560,
  minSavingsBytes: 50_000,
  minSavingsRatio: 0.2,
});

export type ImageFormat = 'jpeg' | 'webp' | 'avif' | 'png' | 'bmp' | 'tiff';

export type FindingCode =
  /** The longest edge exceeds `maxDimension`. */
  | 'oversized-dimensions'
  /** A lossy file uses more bytes per pixel than a typical web encoding. */
  | 'heavy-encoding'
  /** A PNG dense enough to suggest photographic content. Advisory: no saving is estimated. */
  | 'possible-photo-as-png'
  /** BMP or TIFF, which browsers handle poorly and which are rarely compressed. Advisory. */
  | 'uncompressed-format';

export type SkipReason =
  | 'not-an-image'
  /** An image type the scan has no model for, such as GIF, SVG or HEIC. */
  | 'unsupported-format'
  | 'missing-size'
  | 'missing-dimensions'
  /** Metadata present but not usable: not a positive safe integer, or not a string. */
  | 'invalid-metadata';

/**
 * `resize` covers only scaling down to `maxDimension`; `resize-and-reencode` also assumes a
 * typical encoding density for the same format.
 */
export type EstimateBasis = 'resize' | 'resize-and-reencode';

export interface SavingsEstimate {
  bytes: number;
  basis: EstimateBasis;
}

export type ScanResult =
  | { status: 'flagged'; id: string; format: ImageFormat; findings: FindingCode[]; estimate: SavingsEstimate | null }
  | { status: 'ok'; id: string; format: ImageFormat }
  | { status: 'skipped'; id: string; reason: SkipReason };

export interface ScanSummary {
  scanned: number;
  flagged: number;
  ok: number;
  skipped: Record<SkipReason, number>;
  estimatedSavingsBytes: number;
  /** Flagged results with only advisory findings, so no saving is included for them. */
  unestimated: number;
}

const FORMATS: Readonly<Record<string, ImageFormat>> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/png': 'png',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/tiff': 'tiff',
};

/*
 * Calibration (calibration/calibrate.mjs): the Kodak suite, 24 photographs at 768 x 512, encoded with
 * Sharp 0.35.4 at its default qualities (JPEG and WebP 80, AVIF 50). Rerun it on other photographs
 * before changing these values. Larger photographs encode to fewer bytes per pixel, so values from
 * this small-image corpus err towards reporting less.
 */

/**
 * Bytes per pixel of a web-quality encoding of a photograph: the 75th percentile of the
 * calibration corpus (medians: JPEG 0.187, WebP 0.146, AVIF 0.069). With the default 20% minimum
 * saving, a file is reported only above 1.25 times this, so already-optimized images are rarely
 * reported, and detailed photographs are reported less often than they could be.
 */
const TYPICAL_BYTES_PER_PIXEL: Readonly<Record<'jpeg' | 'webp' | 'avif', number>> = {
  jpeg: 0.24,
  webp: 0.21,
  avif: 0.1,
};

/**
 * Re-encoding at a smaller size keeps more bytes than the area alone suggests, because detail per
 * pixel rises. Halving the width kept a median 0.285 of JPEG size against 0.25 of the area;
 * `0.25 ** 0.9` is 0.287.
 */
const RESIZE_EXPONENT = 0.9;

/**
 * A PNG above this density is more likely a photograph than a graphic. Calibration photographs as
 * PNG measured 1.34 to 2.26 B/px; flat synthetic graphics with text measured 0.03 to 0.06.
 */
const PNG_PHOTO_BYTES_PER_PIXEL = 1;

const SKIP_REASONS: readonly SkipReason[] = [
  'not-an-image',
  'unsupported-format',
  'missing-size',
  'missing-dimensions',
  'invalid-metadata',
];

/** Merges caller options over the defaults and rejects values the scan cannot use. */
export function resolveScanOptions(options: Partial<ScanOptions> = {}): ScanOptions {
  const resolved = { ...DEFAULT_SCAN_OPTIONS, ...options };
  if (!Number.isSafeInteger(resolved.maxDimension) || resolved.maxDimension < 1) {
    throw new RangeError('maxDimension must be a positive integer');
  }
  if (!Number.isSafeInteger(resolved.minSavingsBytes) || resolved.minSavingsBytes < 0) {
    throw new RangeError('minSavingsBytes must be a non-negative integer');
  }
  if (!Number.isFinite(resolved.minSavingsRatio) || resolved.minSavingsRatio < 0 || resolved.minSavingsRatio > 1) {
    throw new RangeError('minSavingsRatio must be between 0 and 1');
  }
  return resolved;
}

/** Maps a MIME type to a format the scan models, `null` for other images, `undefined` for non-images. */
export function imageFormat(mimeType: string): ImageFormat | null | undefined {
  const essence = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (!essence.startsWith('image/')) return undefined;
  return FORMATS[essence] ?? null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function scanItem(item: ScanMediaItem, options: ScanOptions = DEFAULT_SCAN_OPTIONS): ScanResult {
  const { id } = item;
  if (typeof item.mimeType !== 'string') return { status: 'skipped', id, reason: 'invalid-metadata' };

  const format = imageFormat(item.mimeType);
  if (format === undefined) return { status: 'skipped', id, reason: 'not-an-image' };
  if (format === null) return { status: 'skipped', id, reason: 'unsupported-format' };

  const { size, width, height } = item;
  if (size === null || size === undefined) return { status: 'skipped', id, reason: 'missing-size' };
  if (!isPositiveInteger(size)) return { status: 'skipped', id, reason: 'invalid-metadata' };
  if (width === null || width === undefined || height === null || height === undefined) {
    return { status: 'skipped', id, reason: 'missing-dimensions' };
  }
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    return { status: 'skipped', id, reason: 'invalid-metadata' };
  }

  const pixels = width * height;
  const bytesPerPixel = size / pixels;
  const scale = Math.min(1, options.maxDimension / Math.max(width, height));
  const sizeRatio = (scale * scale) ** RESIZE_EXPONENT;

  const findings: FindingCode[] = [];
  let estimate: SavingsEstimate | null = null;

  if (format === 'jpeg' || format === 'webp' || format === 'avif') {
    const typical = TYPICAL_BYTES_PER_PIXEL[format];
    const heavy = bytesPerPixel > typical;
    const targetBytes = pixels * Math.min(bytesPerPixel, typical) * sizeRatio;
    if (scale < 1) findings.push('oversized-dimensions');
    if (heavy) findings.push('heavy-encoding');
    if (findings.length > 0) {
      estimate = { bytes: Math.round(size - targetBytes), basis: heavy ? 'resize-and-reencode' : 'resize' };
    }
  } else if (scale < 1) {
    // No model of lossless recompression, so only the resize is estimated.
    findings.push('oversized-dimensions');
    estimate = { bytes: Math.round(size * (1 - sizeRatio)), basis: 'resize' };
  }

  if (estimate !== null && !worthReporting(estimate.bytes, size, options)) {
    findings.length = 0;
    estimate = null;
  }

  if (format === 'png' && bytesPerPixel > PNG_PHOTO_BYTES_PER_PIXEL) findings.push('possible-photo-as-png');
  if (format === 'bmp' || format === 'tiff') findings.push('uncompressed-format');

  if (findings.length === 0) return { status: 'ok', id, format };
  return { status: 'flagged', id, format, findings, estimate };
}

function worthReporting(savings: number, size: number, options: ScanOptions): boolean {
  return savings > 0 && savings >= options.minSavingsBytes && savings / size >= options.minSavingsRatio;
}

export function summarizeScan(results: Iterable<ScanResult>): ScanSummary {
  const skipped = Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<SkipReason, number>;
  const summary: ScanSummary = { scanned: 0, flagged: 0, ok: 0, skipped, estimatedSavingsBytes: 0, unestimated: 0 };
  for (const result of results) {
    summary.scanned += 1;
    if (result.status === 'skipped') {
      skipped[result.reason] += 1;
    } else if (result.status === 'ok') {
      summary.ok += 1;
    } else {
      summary.flagged += 1;
      if (result.estimate) summary.estimatedSavingsBytes += result.estimate.bytes;
      else summary.unestimated += 1;
    }
  }
  return summary;
}
