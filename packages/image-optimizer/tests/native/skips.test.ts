import { crc32 } from 'node:zlib';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { createLocalProcessor } from '../../src/processor/local.ts';
import { HEIGHT, WIDTH, apng, photo, pngChunk, withPngChunks } from './fixtures.ts';

const processor = createLocalProcessor();

async function animatedWebp(): Promise<Buffer> {
  const frame = (colour: string) =>
    sharp({ create: { width: 32, height: 32, channels: 4, background: colour } })
      .png()
      .toBuffer();
  return sharp([await frame('#ff0000'), await frame('#00ff00')], { join: { animated: true } })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
}

/** A PNG whose chunk structure is intact but whose compressed pixel data is garbage. */
async function corruptPng(): Promise<Buffer> {
  const png = Buffer.from(await photo().png({ compressionLevel: 1 }).toBuffer());
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') {
      png.fill(0x5a, offset + 8 + 2, offset + 8 + length); // keep the zlib header, scramble the rest
      png.writeUInt32BE(crc32(png.subarray(offset + 4, offset + 8 + length)), offset + 8 + length);
      return png;
    }
    offset += 12 + length;
  }
  throw new Error('no IDAT');
}

describe('skip reasons come from the bytes, not a name or MIME type', () => {
  it('skips formats other than still JPEG, PNG and WebP without decoding them', async () => {
    const inputs = {
      gif: await photo().gif().toBuffer(),
      avif: await photo().avif().toBuffer(),
      tiff: await photo().tiff().toBuffer(),
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
      text: Buffer.from('not an image'),
      empty: Buffer.alloc(0),
    };
    for (const bytes of Object.values(inputs)) {
      expect(await processor.process({ bytes, preset: 'balanced' })).toEqual({
        status: 'skipped',
        reason: 'unsupported-format',
      });
    }
  });

  it('skips animated WebP from its decoded frame count', async () => {
    expect(await processor.process({ bytes: await animatedWebp(), preset: 'balanced' })).toMatchObject({
      status: 'skipped',
      reason: 'animated',
      input: { format: 'webp', width: 32, height: 32 },
    });
  });

  it('skips animated PNG, which the decoder would read as its first frame', async () => {
    const still = await photo().png().toBuffer();
    expect((await processor.process({ bytes: still, preset: 'balanced' })).status).toBe('processed');
    expect(await processor.process({ bytes: apng(still), preset: 'balanced' })).toMatchObject({
      status: 'skipped',
      reason: 'animated',
    });
  });

  it('skips input over the byte limit before starting a worker', async () => {
    const bytes = await photo().jpeg().toBuffer();
    let spawned = 0;
    const small = createLocalProcessor({ limits: { maxInputBytes: bytes.length - 1 }, onSpawn: () => spawned++ });
    expect(await small.process({ bytes, preset: 'balanced' })).toMatchObject({
      status: 'skipped',
      reason: 'over-byte-limit',
      input: { bytes: bytes.length },
    });
    expect(spawned).toBe(0);
  });

  it('skips images over the pixel limit from the header, before decoding', async () => {
    const pixels = WIDTH * HEIGHT;
    const small = createLocalProcessor({ limits: { maxPixels: pixels - 1, maxInFlightPixels: pixels - 1 } });
    for (const bytes of [
      await photo().jpeg().toBuffer(),
      await photo().png().toBuffer(),
      await photo().webp().toBuffer(),
    ]) {
      expect(await small.process({ bytes, preset: 'balanced' })).toMatchObject({
        status: 'skipped',
        reason: 'over-pixel-limit',
        input: { width: WIDTH, height: HEIGHT },
      });
    }
    const exact = createLocalProcessor({ limits: { maxPixels: pixels, maxInFlightPixels: pixels } });
    expect((await exact.process({ bytes: await photo().jpeg().toBuffer(), preset: 'balanced' })).status).toBe(
      'processed',
    );
  });

  it('skips CMYK, whose conversion would change colours', async () => {
    const bytes = await photo().toColourspace('cmyk').jpeg().toBuffer();
    expect(await processor.process({ bytes, preset: 'balanced' })).toMatchObject({
      status: 'skipped',
      reason: 'unhandled-colour-profile',
      detail: 'cmyk, 4 channels',
    });
  });

  it('skips an ICC profile that does not describe the pixels', async () => {
    // A P3 profile whose header is edited to claim CMYK or ICC version 5: RGB pixels would be
    // published with a profile browsers cannot apply.
    const jpeg = await photo().withIccProfile('p3').jpeg().toBuffer();
    const edited = (offset: number, bytes: Buffer) => {
      const copy = Buffer.from(jpeg);
      const profile = copy.indexOf(Buffer.from('ICC_PROFILE\0', 'latin1')) + 14;
      bytes.copy(copy, profile + offset);
      return copy;
    };
    expect((await processor.process({ bytes: jpeg, preset: 'balanced' })).status).toBe('processed');
    expect(
      await processor.process({ bytes: edited(16, Buffer.from('CMYK', 'latin1')), preset: 'balanced' }),
    ).toMatchObject({
      status: 'skipped',
      reason: 'unhandled-colour-profile',
      detail: "ICC profile 'CMYK' v4",
    });
    expect(await processor.process({ bytes: edited(8, Buffer.from([5])), preset: 'balanced' })).toMatchObject({
      reason: 'unhandled-colour-profile',
      detail: "ICC profile 'RGB' v5",
    });
  });

  it('skips a PNG with gamma and chromaticities but no colour profile', async () => {
    const png = await photo().png().toBuffer();
    const gamma = Buffer.alloc(4);
    gamma.writeUInt32BE(100_000, 0); // gamma 1.0, far from sRGB
    expect(
      await processor.process({ bytes: withPngChunks(png, pngChunk('gAMA', gamma)), preset: 'balanced' }),
    ).toMatchObject({
      status: 'skipped',
      reason: 'unhandled-colour-profile',
    });
    const chrm = pngChunk('cHRM', Buffer.alloc(32));
    expect(await processor.process({ bytes: withPngChunks(png, chrm), preset: 'balanced' })).toMatchObject({
      reason: 'unhandled-colour-profile',
    });
    // The sRGB gamma (1/2.2) alone is what browsers assume anyway.
    gamma.writeUInt32BE(45455, 0);
    expect(
      (await processor.process({ bytes: withPngChunks(png, pngChunk('gAMA', gamma)), preset: 'balanced' })).status,
    ).toBe('processed');
  });

  it('skips 16-bit PNG, which the encoder would reduce to 8 bits', async () => {
    const bytes = await photo().toColourspace('rgb16').png().toBuffer();
    expect((await sharp(bytes).metadata()).depth).toBe('ushort');
    expect(await processor.process({ bytes, preset: 'high-fidelity' })).toMatchObject({
      status: 'skipped',
      reason: 'unhandled-bit-depth',
      detail: 'ushort',
    });
  });

  it('skips truncated and corrupt images as malformed', async () => {
    const jpeg = await photo().jpeg().toBuffer();
    const png = await photo().png().toBuffer();
    const webp = await photo().webp().toBuffer();
    const cases = {
      // Header intact, scan data cut: found by the decoder.
      'truncated JPEG': jpeg.subarray(0, Math.floor(jpeg.length * 0.6)),
      // Chunk or RIFF lengths run past the end: found by the container walk.
      'truncated PNG': png.subarray(0, Math.floor(png.length * 0.6)),
      'truncated WebP': webp.subarray(0, Math.floor(webp.length * 0.6)),
      'JPEG signature only': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      'PNG with corrupt pixel data': await corruptPng(),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      const result = await processor.process({ bytes, preset: 'balanced' });
      expect(result, name).toMatchObject({ status: 'skipped', reason: 'malformed' });
      // Structural damage is caught before a worker starts; damaged pixel data by the decoder.
      const structural = ['truncated PNG', 'truncated WebP', 'JPEG signature only'].includes(name);
      expect(result.status === 'skipped' && result.detail === 'container structure', name).toBe(structural);
    }
  });

  it('processes an image by its content whatever it was uploaded as', async () => {
    // There is no MIME type or file name in the request at all: a PNG is processed as a PNG.
    const result = await processor.process({ bytes: await photo().png().toBuffer(), preset: 'balanced' });
    expect(result).toMatchObject({ status: 'processed', result: { format: 'png' } });
  });
});
