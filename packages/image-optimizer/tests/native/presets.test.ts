import sharp, { type JpegOptions, type PngOptions, type WebpOptions } from 'sharp';
import { describe, expect, it } from 'vitest';

import type { ProcessResult } from '../../src/processor/contract.ts';
import { createLocalProcessor } from '../../src/processor/local.ts';
import {
  PRESET_NAMES,
  encoderOptions,
  presetOptions,
  type JpegEncoderOptions,
  type PngEncoderOptions,
  type PresetName,
  type WebpEncoderOptions,
} from '../../src/processor/presets.ts';
import { HEIGHT, WIDTH, photo, rawPixels } from './fixtures.ts';

const processor = createLocalProcessor();

function processed(result: ProcessResult) {
  if (result.status !== 'processed') throw new Error(`expected processed, got ${result.reason} (${result.detail})`);
  return result;
}

// The preset option types must stay assignable to Sharp's own, so the worker can pass them through.
const typeCheck: [JpegOptions, PngOptions, WebpOptions] = [
  {} as JpegEncoderOptions,
  {} as PngEncoderOptions,
  {} as WebpEncoderOptions,
];
void typeCheck;

describe('preset options', () => {
  it('lists every Sharp option each preset uses', () => {
    expect(presetOptions('balanced')).toEqual({
      jpeg: {
        format: 'jpeg',
        options: {
          quality: 80,
          progressive: true,
          chromaSubsampling: '4:2:0',
          optimiseCoding: true,
          trellisQuantisation: true,
          overshootDeringing: true,
          optimiseScans: true,
          quantisationTable: 3,
        },
      },
      png: {
        format: 'png',
        options: { compressionLevel: 9, adaptiveFiltering: true, palette: false, progressive: false },
      },
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
      'webp-lossless': {
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
      },
    });
    expect(presetOptions('high-fidelity')).toMatchObject({
      jpeg: { options: { quality: 90, chromaSubsampling: '4:4:4' } },
      png: presetOptions('balanced').png,
      webp: { options: { quality: 90, smartSubsample: true, effort: 4, lossless: false } },
      'webp-lossless': presetOptions('balanced')['webp-lossless'],
    });
  });

  it('never quantizes PNG to a palette or encodes PNG lossily', () => {
    for (const preset of PRESET_NAMES) {
      expect(encoderOptions(preset, 'png')).toMatchObject({ format: 'png', options: { palette: false } });
      expect(encoderOptions(preset, 'webp', true)).toMatchObject({ options: { lossless: true, exact: true } });
    }
  });

  it('is frozen, so callers cannot change what a preset means', () => {
    const options = presetOptions('balanced').jpeg.options as JpegEncoderOptions;
    expect(() => {
      options.quality = 10;
    }).toThrow(TypeError);
    expect(() => presetOptions('maximum' as PresetName)).toThrow(RangeError);
  });
});

const PRESETS: PresetName[] = ['balanced', 'high-fidelity'];

describe.each(PRESETS)('%s preset', (preset) => {
  it('re-encodes JPEG as a smaller JPEG of the same size, keeping orientation and ICC profile', async () => {
    // Orientation 6 (rotate 90°) is kept as a tag: stored pixels are not rotated.
    const source = await photo().withIccProfile('p3').withMetadata({ orientation: 6 }).jpeg({ quality: 98 }).toBuffer();
    const result = processed(await processor.process({ bytes: source, preset }));
    expect(result.result).toMatchObject({ format: 'jpeg', width: WIDTH, height: HEIGHT, orientation: 6, channels: 3 });
    expect(result.result.iccProfile).toEqual(result.input.iccProfile);
    expect(result.input.iccProfile).not.toBeNull();
    expect(result.output.length).toBeLessThan(source.length);
    const meta = await sharp(result.output).metadata();
    expect([meta.format, meta.width, meta.height, meta.orientation]).toEqual(['jpeg', WIDTH, HEIGHT, 6]);
    expect(meta.isProgressive).toBe(true);
    expect(meta.chromaSubsampling).toBe(preset === 'balanced' ? '4:2:0' : '4:4:4');
  });

  it('re-encodes lossy WebP as lossy WebP, keeping alpha', async () => {
    const source = await photo(4).webp({ quality: 100, alphaQuality: 100 }).toBuffer();
    const result = processed(await processor.process({ bytes: source, preset }));
    expect(result.input.lossless).toBe(false);
    expect(result.result).toMatchObject({
      format: 'webp',
      width: WIDTH,
      height: HEIGHT,
      hasAlpha: true,
      lossless: false,
    });
    expect(result.output.length).toBeLessThan(source.length);
    // Alpha is encoded at full quality: the transparent band stays transparent.
    const { data } = await rawPixels(result.output);
    expect(data[3]).toBe(0);
  });

  it('re-encodes lossless WebP losslessly: decoded pixels are unchanged', async () => {
    const source = await photo(4).webp({ lossless: true, effort: 0, exact: true }).toBuffer();
    const result = processed(await processor.process({ bytes: source, preset }));
    expect(result.encoder.options).toEqual(presetOptions(preset)['webp-lossless']);
    expect(result.result).toMatchObject({ format: 'webp', lossless: true, hasAlpha: true });
    expect((await rawPixels(result.output)).data.equals((await rawPixels(source)).data)).toBe(true);
  });

  it('recompresses PNG losslessly: decoded pixels equal the source pixels', async () => {
    for (const channels of [1, 2, 3, 4] as const) {
      const source = await photo(channels).png({ compressionLevel: 1, adaptiveFiltering: false }).toBuffer();
      const result = processed(await processor.process({ bytes: source, preset }));
      expect(result.result).toMatchObject({ format: 'png', width: WIDTH, height: HEIGHT, channels });
      expect(result.result.hasAlpha).toBe(channels === 2 || channels === 4);
      expect(result.output.length).toBeLessThan(source.length);
      const before = await rawPixels(source);
      const after = await rawPixels(result.output);
      expect(after.channels).toBe(before.channels);
      expect(after.data.equals(before.data)).toBe(true);
    }
  });

  it('keeps a palette PNG lossless, without quantizing', async () => {
    const source = await photo(3).png({ palette: true, colours: 64, dither: 0 }).toBuffer();
    const result = processed(await processor.process({ bytes: source, preset }));
    expect((await rawPixels(result.output)).data.equals((await rawPixels(source)).data)).toBe(true);
  });

  it('keeps the PNG ICC profile and the pixels it describes', async () => {
    const source = await photo(4).withIccProfile('p3').png({ compressionLevel: 0 }).toBuffer();
    const result = processed(await processor.process({ bytes: source, preset }));
    expect(result.input.iccProfile).not.toBeNull();
    expect(result.result.iccProfile).toEqual(result.input.iccProfile);
    const raw = (bytes: Uint8Array) => sharp(bytes).keepIccProfile().raw().toBuffer();
    expect((await raw(result.output)).equals(await raw(source))).toBe(true);
  });
});
