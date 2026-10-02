/**
 * Encoding presets, mapped explicitly to the Sharp output options each one uses so the admin can
 * show exactly what will happen. Every preset keeps the input's format and dimensions.
 *
 * - `balanced`: lossy JPEG and WebP at quality 80, the quality the scan's density estimates were
 *   calibrated at; PNG recompressed losslessly.
 * - `high-fidelity`: lossy JPEG and WebP at quality 90 without chroma subsampling; PNG lossless.
 *
 * A lossless WebP is re-encoded losslessly under both presets: turning a lossless source lossy is a
 * change of kind, not of size. PNG palette quantization and lossless JPEG are not available: the
 * first is lossy, the second needs jpegtran, which Sharp does not include.
 *
 * The qualities are starting points, not yet qualified on a photograph corpus. Changing any value
 * here changes output bytes, so bump `PRESETS_REVISION` with it.
 *
 * This module has no runtime dependencies, so the sandboxed entry and the admin may import it.
 */

import type { ProcessorFormat } from './contract.ts';

export type PresetName = 'balanced' | 'high-fidelity';

export const PRESET_NAMES: readonly PresetName[] = Object.freeze(['balanced', 'high-fidelity']);

/** Part of the processor version: bump on any change to the options below. */
export const PRESETS_REVISION = 1;

/** The subset of Sharp's `JpegOptions` the presets set, all of them explicitly. */
export interface JpegEncoderOptions {
  quality: number;
  progressive: boolean;
  chromaSubsampling: '4:2:0' | '4:4:4';
  optimiseCoding: boolean;
  trellisQuantisation: boolean;
  overshootDeringing: boolean;
  optimiseScans: boolean;
  quantisationTable: number;
}

/** The subset of Sharp's `PngOptions` the presets set. `palette: false` keeps PNG lossless. */
export interface PngEncoderOptions {
  compressionLevel: number;
  adaptiveFiltering: boolean;
  palette: false;
  progressive: boolean;
}

/** The subset of Sharp's `WebpOptions` the presets set. */
export interface WebpEncoderOptions {
  quality: number;
  alphaQuality: number;
  lossless: boolean;
  nearLossless: false;
  smartSubsample: boolean;
  /** Lossless only: keep the colour of fully transparent pixels, so decoded pixels stay equal. */
  exact: boolean;
  effort: number;
}

/** Which encoder a given input uses: its format, with lossless WebP kept apart. */
export type EncoderTarget = 'jpeg' | 'png' | 'webp' | 'webp-lossless';

export type EncoderOptions =
  | { format: 'jpeg'; options: Readonly<JpegEncoderOptions> }
  | { format: 'png'; options: Readonly<PngEncoderOptions> }
  | { format: 'webp'; options: Readonly<WebpEncoderOptions> };

export type PresetOptions = Readonly<Record<EncoderTarget, Readonly<EncoderOptions>>>;

// mozjpeg's defaults, spelled out: trellis quantisation, overshoot deringing, optimised scans and
// the ImageMagick quantisation table.
const MOZJPEG = { trellisQuantisation: true, overshootDeringing: true, optimiseScans: true, quantisationTable: 3 };

const PNG_LOSSLESS: EncoderOptions = {
  format: 'png',
  options: { compressionLevel: 9, adaptiveFiltering: true, palette: false, progressive: false },
};

const WEBP_LOSSLESS: EncoderOptions = {
  format: 'webp',
  options: {
    quality: 100,
    alphaQuality: 100,
    lossless: true,
    nearLossless: false,
    smartSubsample: false,
    exact: true,
    effort: 4,
  },
};

const PRESETS: Readonly<Record<PresetName, PresetOptions>> = deepFreeze({
  balanced: {
    jpeg: {
      format: 'jpeg',
      options: { quality: 80, progressive: true, chromaSubsampling: '4:2:0', optimiseCoding: true, ...MOZJPEG },
    },
    png: PNG_LOSSLESS,
    webp: {
      format: 'webp',
      options: {
        quality: 80,
        alphaQuality: 100,
        lossless: false,
        nearLossless: false,
        smartSubsample: false,
        exact: false,
        effort: 4,
      },
    },
    'webp-lossless': WEBP_LOSSLESS,
  },
  'high-fidelity': {
    jpeg: {
      format: 'jpeg',
      options: { quality: 90, progressive: true, chromaSubsampling: '4:4:4', optimiseCoding: true, ...MOZJPEG },
    },
    png: PNG_LOSSLESS,
    webp: {
      format: 'webp',
      options: {
        quality: 90,
        alphaQuality: 100,
        lossless: false,
        nearLossless: false,
        smartSubsample: true,
        exact: false,
        effort: 4,
      },
    },
    'webp-lossless': WEBP_LOSSLESS,
  },
});

export function isPresetName(value: unknown): value is PresetName {
  return typeof value === 'string' && (PRESET_NAMES as readonly string[]).includes(value);
}

/** Every encoder setting a preset uses, for display. */
export function presetOptions(preset: PresetName): PresetOptions {
  const options = PRESETS[preset];
  if (!options) throw new RangeError(`Unknown preset: ${String(preset)}`);
  return options;
}

export function encoderTarget(format: ProcessorFormat, lossless: boolean): EncoderTarget {
  return format === 'webp' && lossless ? 'webp-lossless' : format;
}

/** The options a preset uses for one input. */
export function encoderOptions(preset: PresetName, format: ProcessorFormat, lossless = false): EncoderOptions {
  return presetOptions(preset)[encoderTarget(format, lossless)];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
