import sharp from 'sharp';

/** Proposed pilot limits for still JPEG/PNG/WebP output. */
export const PILOT_LIMITS = Object.freeze({
  maxBytes: 50 * 1024 * 1024, // upstream DEFAULT_MAX_UPLOAD_SIZE
  maxPixels: 50_000_000,
  maxFrames: 1,
  formats: ['jpeg', 'png', 'webp'],
});

export class DecodeRejection extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const reject = (code, message) => { throw new DecodeRejection(code, message); };

/**
 * Validate candidate bytes by decoding every pixel without keeping the decoded image.
 * `mode: 'buffer'` materializes the raw image and exists only to compare memory use.
 * Decoding cannot be cancelled once started; a host must bound it with a worker or
 * child process it can terminate.
 */
export async function validateDecoded(bytes, expected, limits = PILOT_LIMITS, mode = 'stream') {
  if (bytes.length === 0) reject('EMPTY', 'Output is empty.');
  if (bytes.length > limits.maxBytes) reject('TOO_LARGE_BYTES', 'Output exceeds the byte limit.');
  const options = { limitInputPixels: limits.maxPixels, failOn: 'warning', sequentialRead: mode === 'stream' };
  let metadata;
  try {
    metadata = await sharp(bytes, options).metadata();
  } catch (error) {
    reject(/pixel limit/.test(error.message) ? 'TOO_MANY_PIXELS' : 'UNDECODABLE', 'Output header could not be read.');
  }
  if (!limits.formats.includes(metadata.format)) reject('UNSUPPORTED_FORMAT', `Unsupported decoded format ${metadata.format}.`);
  if (metadata.format !== expected.format) reject('WRONG_FORMAT', 'Decoded format differs from the source format.');
  if ((metadata.pages ?? 1) > limits.maxFrames) reject('ANIMATED', 'Animated output is not supported.');
  if (metadata.width * metadata.height > limits.maxPixels) reject('TOO_MANY_PIXELS', 'Output exceeds the pixel limit.');
  if (metadata.width !== expected.width || metadata.height !== expected.height) reject('DIMENSIONS_CHANGED', 'Output dimensions differ from the source.');
  try {
    if (mode === 'buffer') await sharp(bytes, options).raw().toBuffer();
    else await sharp(bytes, options).stats();
  } catch (error) {
    reject(/pixel limit/.test(error.message) ? 'TOO_MANY_PIXELS' : 'CORRUPT', 'Output failed full decode.');
  }
  return { format: metadata.format, width: metadata.width, height: metadata.height };
}
