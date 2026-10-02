import { crc32 } from 'node:zlib';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  carryMetadata,
  exifHasGps,
  inspectContainer,
  removeExifGps,
  removeXmpGps,
  sniffFormat,
  xmpHasGps,
} from '../../src/processor/container.ts';
import { createLocalProcessor } from '../../src/processor/local.ts';
import {
  apng,
  containsGpsRational,
  includesText,
  jpegSegment,
  photo,
  pngChunk,
  pngText,
  withJpegSegments,
  withPngChunks,
} from './fixtures.ts';

/**
 * A big-endian TIFF: IFD0 with Copyright, a GPS pointer and Artist, linked to an IFD1; the GPS
 * directory holds a latitude of three rationals stored out of line. Sharp writes little-endian, so
 * this covers the other byte order.
 */
function bigEndianTiff(): Buffer {
  const tiff = Buffer.alloc(200);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  // IFD0 at 8: 3 entries, next IFD at 120.
  tiff.writeUInt16BE(3, 8);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(type, at + 2);
    tiff.writeUInt32BE(count, at + 4);
    tiff.writeUInt32BE(value, at + 8);
  };
  entry(10, 0x8298, 2, 8, 160); // Copyright, ASCII at 160
  entry(22, 0x8825, 4, 1, 60); // GPS pointer
  entry(34, 0x013b, 2, 4, 0x41424300); // Artist "ABC\0" inline
  tiff.writeUInt32BE(120, 46);
  // GPS IFD at 60: 1 entry (latitude, 3 rationals at 80), no next.
  tiff.writeUInt16BE(1, 60);
  entry(62, 0x0002, 5, 3, 80);
  tiff.writeUInt32BE(0, 74);
  [37, 1, 48, 1, 3011, 100].forEach((value, index) => tiff.writeUInt32BE(value, 80 + index * 4));
  // IFD1 at 120: no entries, no next.
  tiff.writeUInt16BE(0, 120);
  tiff.writeUInt32BE(0, 122);
  tiff.write('(c) Me\0', 160, 'latin1');
  return tiff;
}

function jpegWithExif(tiff: Buffer): Buffer {
  const app1 = jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sos, Buffer.from([0x00, 0xff, 0xd9])]);
}

describe('container inspection', () => {
  it('recognises formats by signature only', () => {
    expect(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe('jpeg');
    expect(sniffFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('webp');
    expect(sniffFormat(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'))).toBeNull();
    expect(sniffFormat(Buffer.from('GIF89a', 'latin1'))).toBeNull();
    expect(sniffFormat(new Uint8Array(0))).toBeNull();
  });

  it('reads WebP lossless and lossy bitstreams', async () => {
    expect(inspectContainer(await photo().webp({ lossless: true }).toBuffer())).toMatchObject({
      valid: true,
      lossless: true,
    });
    expect(inspectContainer(await photo().webp().toBuffer())).toMatchObject({ valid: true, lossless: false });
  });

  it('leaves WebP animation to the decoder but finds APNG, which the decoder cannot see', async () => {
    const frame = await photo().png().toBuffer();
    const webp = await sharp([frame, frame], { join: { animated: true } })
      .webp()
      .toBuffer();
    expect(inspectContainer(webp)).toMatchObject({ format: 'webp', valid: true, animated: false });
    expect(inspectContainer(apng(frame))).toMatchObject({ format: 'png', valid: true, animated: true });
  });

  it('rejects chunk lengths that run past the end', async () => {
    const png = Buffer.from(await photo().png().toBuffer());
    png.writeUInt32BE(0x7fffffff, 8); // IHDR length
    expect(inspectContainer(png)).toMatchObject({ format: 'png', valid: false });
    const webp = Buffer.from(await photo().webp().toBuffer());
    webp.writeUInt32LE(webp.length, 4); // RIFF size 8 bytes too large
    expect(inspectContainer(webp)).toMatchObject({ format: 'webp', valid: false });
  });
});

describe('EXIF GPS removal', () => {
  it('removes the GPS directory and its values from a big-endian TIFF, keeping the rest', () => {
    const jpeg = jpegWithExif(bigEndianTiff());
    const info = inspectContainer(jpeg);
    expect(info.valid).toBe(true);
    const range = info.exif[0]!;
    expect(exifHasGps(jpeg.subarray(range.start, range.end))).toBe(true);

    const removal = removeExifGps(jpeg, info);
    expect(removal.status).toBe('removed');
    if (removal.status === 'unreadable') return;
    const tiff = Buffer.from(removal.bytes.subarray(range.start, range.end));
    expect(exifHasGps(tiff)).toBe(false);
    expect(containsGpsRational(removal.bytes)).toBe(false);
    // IFD0 now has Copyright then Artist, and still links to IFD1.
    expect(tiff.readUInt16BE(8)).toBe(2);
    expect(tiff.readUInt16BE(10)).toBe(0x8298);
    expect(tiff.readUInt16BE(22)).toBe(0x013b);
    expect(tiff.readUInt32BE(34)).toBe(120);
    expect(includesText(tiff, '(c) Me')).toBe(true);
    // The input is not modified.
    expect(containsGpsRational(jpeg)).toBe(true);
  });

  it('reports EXIF it cannot walk instead of guessing', () => {
    const tiff = bigEndianTiff();
    tiff.writeUInt32BE(5000, 4); // IFD0 offset past the end
    const jpeg = jpegWithExif(tiff);
    const info = inspectContainer(jpeg);
    expect(exifHasGps(jpeg.subarray(info.exif[0]!.start, info.exif[0]!.end))).toBeNull();
    expect(removeExifGps(jpeg, info)).toEqual({ status: 'unreadable' });
  });

  it('skips an image whose EXIF cannot be walked when GPS must be removed', async () => {
    const tiff = bigEndianTiff();
    tiff.writeUInt32BE(5000, 4);
    const app1 = jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
    const bytes = withJpegSegments(await photo().jpeg().toBuffer(), app1);
    const processor = createLocalProcessor();
    expect(await processor.process({ bytes, preset: 'balanced', metadata: { removeGps: true } })).toMatchObject({
      status: 'skipped',
      reason: 'unhandled-metadata',
      detail: 'EXIF structure',
    });
  });

  it('updates the PNG chunk checksum after removing GPS', async () => {
    // With and without the JPEG-style header libvips puts in front of PNG EXIF.
    for (const prefix of ['', 'Exif\0\0']) {
      const data = Buffer.concat([Buffer.from(prefix, 'latin1'), bigEndianTiff()]);
      const png = withPngChunks(await photo().png().toBuffer(), pngChunk('eXIf', data));
      const removal = removeExifGps(png, inspectContainer(png));
      if (removal.status !== 'removed') throw new Error(removal.status);
      const out = Buffer.from(removal.bytes);
      const start = 33; // the eXIf chunk follows IHDR
      expect(out.toString('latin1', start + 4, start + 8)).toBe('eXIf');
      const end = start + 8 + data.length;
      expect(out.readUInt32BE(end), JSON.stringify(prefix)).toBe(crc32(out.subarray(start + 4, end)));
      expect(containsGpsRational(out)).toBe(false);
    }
  });
});

describe('XMP GPS removal', () => {
  it('removes GPS attributes and elements in any namespace prefix', () => {
    const xmp =
      `<rdf:Description exif:GPSLatitude="1,2N" e2:GPSAltitude='12' dc:format="image/jpeg">` +
      '<exif:GPSLongitude>3,4W</exif:GPSLongitude><exif:GPSVersionID/><dc:rights>Mine</dc:rights></rdf:Description>';
    expect(xmpHasGps(xmp)).toBe(true);
    expect(removeXmpGps(xmp)).toBe(
      '<rdf:Description dc:format="image/jpeg"><dc:rights>Mine</dc:rights></rdf:Description>',
    );
  });

  it('returns null when GPS remains that it could not remove', () => {
    expect(removeXmpGps('<x><!-- exif:GPSLatitude --></x>')).toBeNull();
    expect(removeXmpGps('<x>no position</x>')).toBe('<x>no position</x>');
  });
});

describe('carrying metadata libvips drops', () => {
  it('adds only the PNG text the output lacks', async () => {
    const plain = await photo().png().toBuffer();
    const source = inspectContainer(withPngChunks(plain, pngText('Copyright', 'Me'), pngText('Comment', 'Hi')));
    const output = withPngChunks(plain, pngText('Copyright', 'Me'));
    const carried = carryMetadata(output, source)!;
    const after = inspectContainer(carried);
    expect(after.valid).toBe(true);
    expect(after.carried.map((segment) => [segment.keyword, segment.text])).toEqual([
      ['Copyright', 'Me'],
      ['Comment', 'Hi'],
    ]);
  });

  it('refuses an output of another format', async () => {
    const source = inspectContainer(withPngChunks(await photo().png().toBuffer(), pngText('Copyright', 'Me')));
    expect(carryMetadata(await photo().jpeg().toBuffer(), source)).toBeNull();
  });
});
