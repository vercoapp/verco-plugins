import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import type { ImageInfo, ProcessorFormat, ProcessResult } from '../../src/processor/contract.ts';
import { checkOutput, createLocalProcessor } from '../../src/processor/local.ts';
import {
  COPYRIGHT,
  EXIF_WITH_GPS,
  XMP_WITH_GPS,
  containsGpsRational,
  includesText,
  iptcSegment,
  jpegSegment,
  photo,
  pngChunk,
  pngText,
  withJpegSegments,
  withPngChunks,
} from './fixtures.ts';

const processor = createLocalProcessor();
const FORMATS: ProcessorFormat[] = ['jpeg', 'png', 'webp'];

function processed(result: ProcessResult) {
  if (result.status !== 'processed') throw new Error(`expected processed, got ${result.reason} (${result.detail})`);
  return result;
}

function tagged(format: ProcessorFormat) {
  return photo()
    .withExif(EXIF_WITH_GPS)
    .withXmp(XMP_WITH_GPS)
    .withMetadata({ orientation: 3 })
    .toFormat(format, format === 'png' ? {} : { quality: 98 })
    .toBuffer();
}

async function metadataOf(bytes: Uint8Array) {
  const meta = await sharp(bytes).metadata();
  return { exif: meta.exif ?? Buffer.alloc(0), xmp: meta.xmpAsString ?? '', orientation: meta.orientation, meta };
}

describe.each(FORMATS)('%s metadata', (format) => {
  it('keeps all metadata by default, GPS included', async () => {
    const source = await tagged(format);
    expect(containsGpsRational(source)).toBe(true);
    const result = processed(await processor.process({ bytes: source, preset: 'balanced' }));
    expect(result.input).toMatchObject({ hasExif: true, hasXmp: true, hasGps: true });
    expect(result.result).toMatchObject({ hasExif: true, hasXmp: true, hasGps: true, orientation: 3 });
    const { exif, xmp } = await metadataOf(result.output);
    expect(includesText(exif, COPYRIGHT)).toBe(true);
    expect(includesText(exif, 'Example Artist')).toBe(true);
    expect(containsGpsRational(exif)).toBe(true);
    expect(xmp).toContain(COPYRIGHT);
    expect(xmp).toContain('exif:GPSLongitude');
  });

  it('removes the GPS position, and only it, when the setting is on', async () => {
    const source = await tagged(format);
    const result = processed(
      await processor.process({ bytes: source, preset: 'balanced', metadata: { removeGps: true } }),
    );
    expect(result.input.hasGps).toBe(true);
    expect(result.result).toMatchObject({ hasExif: true, hasXmp: true, hasGps: false, orientation: 3 });
    const { exif, xmp } = await metadataOf(result.output);
    // The position is gone from the file, not just unreferenced.
    expect(containsGpsRational(result.output)).toBe(false);
    expect(xmp).not.toMatch(/GPS/);
    expect(includesText(exif, COPYRIGHT)).toBe(true);
    expect(includesText(exif, 'Example Artist')).toBe(true);
    expect(xmp).toContain(COPYRIGHT);
  });

  it('changes nothing when GPS removal is on but there is no GPS', async () => {
    const source = await photo()
      .withExif({ IFD0: { Copyright: COPYRIGHT } })
      .toFormat(format)
      .toBuffer();
    const result = processed(
      await processor.process({ bytes: source, preset: 'balanced', metadata: { removeGps: true } }),
    );
    expect(result.result.hasGps).toBe(false);
    expect(includesText((await metadataOf(result.output)).exif, COPYRIGHT)).toBe(true);
  });
});

describe('metadata libvips does not write', () => {
  it('keeps JPEG IPTC and comments', async () => {
    const plain = await photo().jpeg({ quality: 98 }).toBuffer();
    const source = withJpegSegments(plain, iptcSegment(COPYRIGHT), jpegSegment(0xfe, Buffer.from('A comment')));
    const result = processed(await processor.process({ bytes: source, preset: 'balanced' }));
    expect(result.result.hasIptc).toBe(true);
    expect(includesText((await sharp(result.output).metadata()).iptc!, COPYRIGHT)).toBe(true);
    expect(includesText(result.output, 'A comment')).toBe(true);
    // Comments go after the application segments and the image still decodes.
    await sharp(result.output, { failOn: 'warning' }).raw().toBuffer();
  });

  it('keeps PNG text chunks such as Copyright', async () => {
    const plain = await photo().png({ compressionLevel: 1 }).toBuffer();
    const source = withPngChunks(plain, pngText('Copyright', COPYRIGHT), pngText('Comment', 'A comment'));
    const result = processed(await processor.process({ bytes: source, preset: 'high-fidelity' }));
    const { comments } = await sharp(result.output).metadata();
    expect(comments).toEqual([
      { keyword: 'Copyright', text: COPYRIGHT },
      { keyword: 'Comment', text: 'A comment' },
    ]);
    await sharp(result.output, { failOn: 'warning' }).raw().toBuffer();
  });

  it('skips a PNG with a raw EXIF text chunk when GPS must be removed, since it cannot be cleaned', async () => {
    const plain = await photo().png().toBuffer();
    const source = withPngChunks(plain, pngChunk('zTXt', Buffer.from('Raw profile type exif\0\0x', 'latin1')));
    expect(await processor.process({ bytes: source, preset: 'balanced', metadata: { removeGps: true } })).toMatchObject(
      {
        status: 'skipped',
        reason: 'unhandled-metadata',
      },
    );
    processed(await processor.process({ bytes: source, preset: 'balanced' }));
  });

  it('skips when a GPS property in XMP cannot be removed', async () => {
    // A GPS property name inside an XML comment is not an element or attribute, so the cleaner
    // leaves it, and the image is skipped rather than published with something GPS-like in it.
    const xmp = XMP_WITH_GPS.replace('<exif:GPSVersionID/>', '<!-- exif:GPSAltitude 12 -->');
    const source = await photo().withXmp(xmp).jpeg().toBuffer();
    expect(await processor.process({ bytes: source, preset: 'balanced', metadata: { removeGps: true } })).toMatchObject(
      {
        status: 'skipped',
        reason: 'unhandled-metadata',
        detail: 'XMP GPS',
      },
    );
  });
});

describe('output check', () => {
  const input: ImageInfo = {
    format: 'jpeg',
    bytes: 1000,
    width: 40,
    height: 30,
    channels: 3,
    hasAlpha: false,
    orientation: 6,
    iccProfile: { bytes: 500, sha256: 'a'.repeat(64) },
    hasExif: true,
    hasXmp: false,
    hasIptc: false,
    hasGps: true,
  };

  it('accepts an output that keeps format, dimensions, channels, alpha, orientation and profile', () => {
    expect(checkOutput(input, { ...input, bytes: 600 }, false)).toBeNull();
    expect(checkOutput(input, { ...input, hasGps: false }, true)).toBeNull();
    // An input without orientation is stored as orientation 1.
    expect(checkOutput({ ...input, orientation: null }, { ...input, orientation: 1 }, false)).toBeNull();
  });

  it.each([
    [{ format: 'png' as const }, /format png/],
    [{ width: 41 }, /dimensions 41x30/],
    [{ height: 29 }, /dimensions 40x29/],
    [{ channels: 1 }, /1 channels/],
    [{ hasAlpha: true }, /alpha/],
    [{ orientation: 1 }, /orientation 1/],
    [{ iccProfile: null }, /ICC profile/],
    [{ iccProfile: { bytes: 500, sha256: 'b'.repeat(64) } }, /ICC profile/],
  ])('rejects an output that changes %o', (change, message) => {
    const error = checkOutput(input, { ...input, ...change }, false);
    expect(error?.code).toBe('invalid-output');
    expect(error?.message).toMatch(message);
  });

  it('withholds an output that still has GPS when removal was asked for', () => {
    expect(checkOutput(input, input, false)).toBeNull();
    expect(checkOutput(input, input, true)?.code).toBe('metadata-policy-failed');
  });
});
