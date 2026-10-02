import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { DecodeRejection, PILOT_LIMITS, validateDecoded } from './helpers/decode-budget.mjs';

const pixels = (width = 64, height = 48, background = '#3070c0') => sharp({ create: { width, height, channels: 3, background } });
const encoded = {
  jpeg: await pixels().jpeg().toBuffer(),
  png: await pixels().png().toBuffer(),
  webp: await pixels().webp().toBuffer(),
};
const source = (format) => ({ format, width: 64, height: 48 });
const code = async (bytes, expected, limits, mode) => {
  try { await validateDecoded(bytes, expected, limits, mode); } catch (error) {
    assert.ok(error instanceof DecodeRejection, `unexpected error: ${error.message}`);
    return error.code;
  }
  return 'ACCEPTED';
};

for (const mode of ['stream', 'buffer']) {
  for (const format of Object.keys(encoded)) {
    test(`${mode} validation accepts a still ${format} with unchanged dimensions`, async () => {
      assert.equal(await code(encoded[format], source(format), PILOT_LIMITS, mode), 'ACCEPTED');
    });
    test(`${mode} validation rejects a truncated ${format}`, async () => {
      const bytes = encoded[format].subarray(0, Math.floor(encoded[format].length * 0.6));
      assert.ok(['UNDECODABLE', 'CORRUPT'].includes(await code(bytes, source(format), PILOT_LIMITS, mode)));
    });
  }
}

test('validation rejects empty, oversized and garbage bytes before trusting them', async () => {
  assert.equal(await code(Buffer.alloc(0), source('png')), 'EMPTY');
  assert.equal(await code(encoded.png, source('png'), { ...PILOT_LIMITS, maxBytes: 10 }), 'TOO_LARGE_BYTES');
  assert.equal(await code(Buffer.from('not an image at all'), source('png')), 'UNDECODABLE');
});

test('validation rejects a decoded format that differs from the source format', async () => {
  assert.equal(await code(encoded.jpeg, source('png')), 'WRONG_FORMAT');
  assert.equal(await code(encoded.webp, source('jpeg')), 'WRONG_FORMAT');
});

test('validation rejects formats outside the pilot set even when they match the source', async () => {
  const gif = await pixels().gif().toBuffer();
  assert.equal(await code(gif, source('gif')), 'UNSUPPORTED_FORMAT');
});

test('validation rejects animation and changed dimensions', async () => {
  // Identical frames collapse into one still image, so the frames must differ.
  const frames = [await pixels().png().toBuffer(), await pixels(64, 48, '#c03070').png().toBuffer()];
  const animated = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  assert.equal(await code(animated, { format: 'webp', width: 64, height: 48 }), 'ANIMATED');
  assert.equal(await code(encoded.png, { format: 'png', width: 32, height: 48 }), 'DIMENSIONS_CHANGED');
  assert.equal(await code(encoded.png, { format: 'png', width: 64, height: 96 }), 'DIMENSIONS_CHANGED');
});

test('validation enforces the pixel limit from the header before a full decode', async () => {
  assert.equal(await code(encoded.png, source('png'), { ...PILOT_LIMITS, maxPixels: 64 * 48 - 1 }), 'TOO_MANY_PIXELS');
  assert.equal(await code(encoded.png, source('png'), { ...PILOT_LIMITS, maxPixels: 64 * 48 }), 'ACCEPTED');
});

test('validation rejects a corrupted payload that keeps a valid header', async () => {
  const bytes = Buffer.from(encoded.png);
  bytes.fill(0xff, bytes.length - 40, bytes.length - 12); // damage image data and checksum, keep IHDR
  assert.ok(['CORRUPT', 'UNDECODABLE'].includes(await code(bytes, source('png'))));
});
