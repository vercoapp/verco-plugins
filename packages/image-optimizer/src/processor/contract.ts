/**
 * The `ImageProcessor` contract: bytes in, bytes of the same format and dimensions out, with what
 * was measured on both sides. The local Sharp processor implements it; provider adapters can
 * implement it later without changing the code that calls it.
 *
 * A processor reports two kinds of non-result. A skip is a property of the image (animated, over
 * the limits, a colour profile it cannot preserve) and repeats on every attempt, so a caller records
 * it and moves on. An `ImageProcessorError` is a failure of the attempt (timed out, crashed, busy)
 * and says whether retrying can help.
 *
 * This module has no runtime dependencies, so the sandboxed entry and the admin may import it.
 */

import type { ProcessorLimits } from './limits.ts';
import type { EncoderOptions, PresetName } from './presets.ts';

/** Still image formats the processor reads and writes. Output always has the input's format. */
export type ProcessorFormat = 'jpeg' | 'png' | 'webp';

export const PROCESSOR_FORMATS: readonly ProcessorFormat[] = Object.freeze(['jpeg', 'png', 'webp']);

export interface MetadataPolicy {
  /**
   * Remove GPS position: the EXIF GPS directory and `exif:GPS*` properties in XMP. Everything else
   * (EXIF including copyright, XMP, IPTC, ICC profile, comments) is kept either way.
   */
  removeGps: boolean;
}

export const DEFAULT_METADATA_POLICY: Readonly<MetadataPolicy> = Object.freeze({ removeGps: false });

export interface ProcessRequest {
  bytes: Uint8Array;
  preset: PresetName;
  /** Defaults to `DEFAULT_METADATA_POLICY`: keep all metadata. */
  metadata?: MetadataPolicy;
  /** Aborting kills the work in progress and rejects with `aborted`. */
  signal?: AbortSignal;
}

/** What the processor measured on an image, decoded from its bytes rather than taken from a MIME type. */
export interface ImageInfo {
  format: ProcessorFormat;
  bytes: number;
  /** Stored dimensions, before any EXIF orientation is applied. */
  width: number;
  height: number;
  channels: number;
  hasAlpha: boolean;
  /** EXIF orientation 1 to 8, or `null` without one. */
  orientation: number | null;
  /** The embedded ICC profile's size and SHA-256, or `null` without one. */
  iccProfile: { bytes: number; sha256: string } | null;
  hasExif: boolean;
  hasXmp: boolean;
  hasIptc: boolean;
  /** Whether EXIF or XMP carries a GPS position. */
  hasGps: boolean;
  /** WebP only: whether the bitstream is lossless (VP8L). */
  lossless?: boolean;
}

export interface EncoderInfo {
  preset: PresetName;
  /** The exact Sharp output options used, as listed by `presetOptions()`. */
  options: EncoderOptions;
  sharp: string;
  vips: string;
}

export interface ProcessedImage {
  status: 'processed';
  output: Uint8Array;
  input: ImageInfo;
  result: ImageInfo;
  encoder: EncoderInfo;
  /** Wall time from start to result, including process start-up. */
  elapsedMs: number;
  /** Peak resident memory of the worker process, for re-measuring limits on new hardware. */
  workerMaxRssBytes: number;
}

export type ProcessSkipReason =
  /** Not JPEG, PNG or WebP by its content, whatever its name or MIME type says. */
  | 'unsupported-format'
  /** The bytes do not decode: truncated, corrupt, or a container the decoder rejects. */
  | 'malformed'
  /** Animated WebP or PNG (APNG): re-encoding would keep only the first frame. */
  | 'animated'
  | 'over-byte-limit'
  | 'over-pixel-limit'
  /** CMYK, Lab, or a profile that does not match the pixels; re-encoding would change colours. */
  | 'unhandled-colour-profile'
  /** More than 8 bits per sample; the encoder would reduce the depth. */
  | 'unhandled-bit-depth'
  /** Metadata the policy cannot be applied to, such as a raw EXIF text chunk when GPS must be removed. */
  | 'unhandled-metadata';

export const PROCESS_SKIP_REASONS: readonly ProcessSkipReason[] = Object.freeze([
  'unsupported-format',
  'malformed',
  'animated',
  'over-byte-limit',
  'over-pixel-limit',
  'unhandled-colour-profile',
  'unhandled-bit-depth',
  'unhandled-metadata',
]);

export interface SkippedImage {
  status: 'skipped';
  reason: ProcessSkipReason;
  /** Short technical detail for logs and the report, never image content. */
  detail?: string;
  /** Measurements available before the skip was decided, if the image got that far. */
  input?: Partial<ImageInfo>;
}

export type ProcessResult = ProcessedImage | SkippedImage;

export type ProcessorErrorCode =
  /** The pixel or worker budget is in use; retry later. */
  | 'busy'
  /** The worker exceeded its wall time and was killed. */
  | 'timeout'
  /** The worker exited without a result: a native crash, out of memory, or a bug. */
  | 'crashed'
  | 'aborted'
  /** Sharp is not installed or the worker could not start. */
  | 'unavailable'
  /** The encoder failed on an image that decoded. */
  | 'encode-failed'
  /** The output failed the processor's own checks (format, dimensions, alpha, profile, orientation). */
  | 'invalid-output'
  /** The metadata policy could not be verified on the output; the output is withheld. */
  | 'metadata-policy-failed';

const RETRYABLE: Readonly<Record<ProcessorErrorCode, boolean>> = {
  busy: true,
  timeout: false,
  crashed: true,
  aborted: true,
  unavailable: false,
  'encode-failed': false,
  'invalid-output': false,
  'metadata-policy-failed': false,
};

export class ImageProcessorError extends Error {
  readonly code: ProcessorErrorCode;
  /** Whether the same request could succeed later. A timeout repeats, so it is not retryable. */
  readonly retryable: boolean;

  constructor(code: ProcessorErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImageProcessorError';
    this.code = code;
    this.retryable = RETRYABLE[code];
  }
}

export interface ProcessorCapabilities {
  /** Stable identifier, part of a result's identity together with `version`. */
  processor: string;
  /** Changes whenever the same input and preset could produce different bytes. */
  version: string;
  formats: readonly ProcessorFormat[];
  presets: readonly PresetName[];
  /** Output keeps the input's format and stored dimensions; the processor never resizes or converts. */
  sameFormat: true;
  sameDimensions: true;
  metadata: { keptByDefault: true; canRemoveGps: boolean };
  limits: Readonly<ProcessorLimits>;
}

export interface ImageProcessor {
  capabilities(): ProcessorCapabilities;
  /** Resolves with a processed or skipped image; rejects only with `ImageProcessorError`. */
  process(request: ProcessRequest): Promise<ProcessResult>;
}
