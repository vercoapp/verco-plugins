/**
 * Test images, generated with Sharp: no photographs or downloaded media. "Photo" content is smooth
 * gradients with deterministic noise, so lossy encoders behave roughly as on a photograph.
 */
import { crc32 } from 'node:zlib';

import sharp, { type Sharp } from 'sharp';

export const WIDTH = 320;
export const HEIGHT = 240;

/** A small deterministic PRNG, so fixtures are identical on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function photoPixels(channels: 1 | 2 | 3 | 4, width = WIDTH, height = HEIGHT): Buffer {
  const next = random(width * 31 + height * 17 + channels);
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * channels;
      const noise = (next() - 0.5) * 24;
      const values = [
        (x / width) * 200 + 30 + noise,
        (y / height) * 180 + 40 + noise,
        ((x + y) / (width + height)) * 160 + 60 + noise,
      ];
      for (let channel = 0; channel < channels; channel++) {
        const alpha = (channels === 2 && channel === 1) || channel === 3;
        // Alpha: a soft vertical ramp with a fully transparent band on the left.
        const value = alpha ? (x < width / 8 ? 0 : (x / width) * 255) : values[channels <= 2 ? 0 : channel]!;
        pixels[base + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  }
  return pixels;
}

export function photo(channels: 1 | 2 | 3 | 4 = 3, width = WIDTH, height = HEIGHT): Sharp {
  const image = sharp(photoPixels(channels, width, height), { raw: { width, height, channels } });
  return channels <= 2 ? image.toColourspace('b-w') : image;
}

export const COPYRIGHT = 'Copyright Example Owner';
/** A GPS latitude whose seconds (3011/100) are easy to find in the bytes. */
export const GPS_EXIF = {
  GPSLatitudeRef: 'N',
  GPSLatitude: '37/1 48/1 3011/100',
  GPSLongitudeRef: 'W',
  GPSLongitude: '122/1 25/1 1234/100',
};
export const EXIF_WITH_GPS = { IFD0: { Copyright: COPYRIGHT, Artist: 'Example Artist' }, IFD3: GPS_EXIF };

export const XMP_WITH_GPS =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="37,48.5018N">' +
  `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${COPYRIGHT}</rdf:li></rdf:Alt></dc:rights>` +
  '<exif:GPSLongitude>122,25.2057W</exif:GPSLongitude><exif:GPSVersionID/>' +
  '</rdf:Description></rdf:RDF></x:xmpmeta>';

/** Whether the GPS latitude's seconds rational (3011/100) appears, in either byte order. */
export function containsGpsRational(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = Buffer.alloc(8);
  le.writeUInt32LE(3011, 0);
  le.writeUInt32LE(100, 4);
  const be = Buffer.alloc(8);
  be.writeUInt32BE(3011, 0);
  be.writeUInt32BE(100, 4);
  return buffer.includes(le) || buffer.includes(be);
}

export function includesText(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(text, 'latin1'));
}

// --- Hand-built container parts Sharp cannot write --------------------------------------------------

export function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** Inserts chunks right after IHDR (signature 8 bytes + IHDR 25 bytes). */
export function withPngChunks(png: Buffer, ...chunks: Buffer[]): Buffer {
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
}

export function pngText(keyword: string, text: string): Buffer {
  return pngChunk('tEXt', Buffer.from(`${keyword}\0${text}`, 'latin1'));
}

/** An APNG: the still image plus an animation control chunk, which libvips ignores. */
export function apng(png: Buffer): Buffer {
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0); // frames
  actl.writeUInt32BE(0, 4); // loop forever
  return withPngChunks(png, pngChunk('acTL', actl));
}

/** Inserts JPEG segments right after SOI. */
export function withJpegSegments(jpeg: Buffer, ...segments: Buffer[]): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

export function jpegSegment(marker: number, body: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
}

/** APP13 Photoshop block holding an IPTC copyright notice (2:116). */
export function iptcSegment(text: string): Buffer {
  const value = Buffer.from(text, 'latin1');
  const dataset = Buffer.concat([Buffer.from([0x1c, 0x02, 0x74, 0, 0]), value]);
  dataset.writeUInt16BE(value.length, 3);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(dataset.length, 0);
  const resource = Buffer.concat([
    Buffer.from('8BIM', 'latin1'),
    Buffer.from([0x04, 0x04, 0, 0]), // resource 0x0404, empty name padded to even
    size,
    dataset,
    dataset.length % 2 ? Buffer.from([0]) : Buffer.alloc(0),
  ]);
  return jpegSegment(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), resource]));
}

export async function rawPixels(bytes: Uint8Array): Promise<{ data: Buffer; channels: number }> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return { data, channels: info.channels };
}
