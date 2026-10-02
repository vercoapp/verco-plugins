/**
 * Byte-level reading and editing of JPEG, PNG and WebP containers, for what Sharp cannot do: tell
 * an animated PNG from a still one, remove a GPS position without dropping the rest of the EXIF,
 * and carry JPEG comments (which libvips drops) and PNG text it did not rewrite into the output.
 *
 * Parsing walks segment and chunk headers only, never compressed image data, and every offset is
 * bounds-checked: a container it cannot walk is reported as invalid, never guessed at. Node only
 * (`node:zlib` for PNG checksums and compressed XMP).
 */

import { crc32, inflateSync } from 'node:zlib';

import type { ProcessorFormat } from './contract.ts';

/** Compressed PNG text (XMP included) larger than this is not inflated; a GPS check then fails closed. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const XMP_KEYWORD = 'XML:com.adobe.xmp';
const JPEG_EXIF = 'Exif\0\0';
const JPEG_XMP = 'http://ns.adobe.com/xap/1.0/\0';
const JPEG_XMP_EXTENSION = 'http://ns.adobe.com/xmp/extension/\0';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GPS_IFD_POINTER = 0x8825;

interface Range {
  start: number;
  end: number;
}

interface ExifRange extends Range {
  /** PNG only: where the chunk's type starts and its data ends, the span its CRC covers. */
  crc?: Range;
}

/** A PNG text chunk or JPEG comment segment, verbatim, to carry into the output. */
interface CarriedSegment {
  bytes: Uint8Array;
  /** PNG keyword, or `null` for a JPEG comment. */
  keyword: string | null;
  /** The decoded text, to recognise the same text written differently; `null` if unreadable. */
  text: string | null;
}

export interface ContainerInfo {
  /** Format by signature, `null` for anything that is not JPEG, PNG or WebP. */
  format: ProcessorFormat | null;
  /** Whether the segment or chunk structure could be walked to the image data. */
  valid: boolean;
  /**
   * APNG (`acTL` before the image data), which libvips decodes as its first frame without saying
   * so. Animated WebP is recognised from the decoded frame count instead.
   */
  animated: boolean;
  /** WebP with a lossless (VP8L) bitstream. */
  lossless: boolean;
  /** TIFF structures of every EXIF block, as ranges into the bytes. */
  exif: ExifRange[];
  /** XMP packets as text; `null` entries could not be read (compressed beyond limits, corrupt). */
  xmp: (string | null)[];
  /**
   * PNG text chunks and JPEG comments, XMP excluded. libvips drops JPEG comments and rewrites PNG
   * text as zTXt; `carryMetadata` restores what is missing.
   */
  carried: CarriedSegment[];
  /** PNG colour chunks, for deciding whether the colour can be preserved. */
  png?: { iccp: boolean; srgb: boolean; gamma: number | null; chrm: boolean };
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (start < 0 || start + length > bytes.length) return '';
  return latin1.decode(bytes.subarray(start, start + length));
}

function startsWith(bytes: Uint8Array, start: number, text: string): boolean {
  return ascii(bytes, start, text.length) === text;
}

/** A copy, also for a Node `Buffer`, whose `slice` returns a view. */
function copyOf(bytes: Uint8Array, start = 0, end = bytes.length): Uint8Array {
  return Uint8Array.prototype.slice.call(bytes, start, end);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function sniffFormat(bytes: Uint8Array): ProcessorFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'png';
  if (bytes.length >= 12 && startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')) return 'webp';
  return null;
}

function emptyInfo(format: ProcessorFormat | null): ContainerInfo {
  return { format, valid: false, animated: false, lossless: false, exif: [], xmp: [], carried: [] };
}

export function inspectContainer(bytes: Uint8Array): ContainerInfo {
  const format = sniffFormat(bytes);
  if (format === 'jpeg') return inspectJpeg(bytes);
  if (format === 'png') return inspectPng(bytes);
  if (format === 'webp') return inspectWebp(bytes);
  return emptyInfo(null);
}

function inspectJpeg(bytes: Uint8Array): ContainerInfo {
  const info = emptyInfo('jpeg');
  const data = view(bytes);
  const extended: string[] = [];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return info;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) return info; // EOI before any scan
    const length = data.getUint16(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) return info;
    const body = offset + 4;
    if (marker === 0xe1 && startsWith(bytes, body, JPEG_EXIF)) {
      info.exif.push({ start: body + JPEG_EXIF.length, end });
    } else if (marker === 0xe1 && startsWith(bytes, body, JPEG_XMP)) {
      info.xmp.push(utf8.decode(bytes.subarray(body + JPEG_XMP.length, end)));
    } else if (marker === 0xe1 && startsWith(bytes, body, JPEG_XMP_EXTENSION)) {
      // GUID (32), full length (4) and offset (4) precede each portion.
      extended.push(utf8.decode(bytes.subarray(Math.min(end, body + JPEG_XMP_EXTENSION.length + 40), end)));
    } else if (marker === 0xfe) {
      info.carried.push({ bytes: copyOf(bytes, offset, end), keyword: null, text: ascii(bytes, body, end - body) });
    }
    if (marker === 0xda) {
      info.valid = true; // start of scan: only entropy-coded data follows
      break;
    }
    offset = end;
  }
  if (extended.length > 0) info.xmp.push(extended.join(''));
  return info;
}

function pngChunks(bytes: Uint8Array): { type: string; start: number; data: Range; end: number }[] | null {
  const data = view(bytes);
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = data.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    chunks.push({ type, start: offset, data: { start: offset + 8, end: offset + 8 + length }, end });
    if (type === 'IEND') return chunks;
    offset = end;
  }
  return null;
}

/** Splits a PNG text chunk into keyword and the text, inflated when compressed. */
function pngText(bytes: Uint8Array, type: string, range: Range): { keyword: string; text: string | null } | null {
  const body = bytes.subarray(range.start, range.end);
  const separator = body.indexOf(0);
  if (separator < 1) return null;
  const keyword = latin1.decode(body.subarray(0, separator));
  try {
    if (type === 'tEXt') return { keyword, text: latin1.decode(body.subarray(separator + 1)) };
    if (type === 'zTXt') return { keyword, text: latin1.decode(inflate(body.subarray(separator + 2))) };
    // iTXt: compression flag, method, language tag, translated keyword, then text.
    const compressed = body[separator + 1] === 1;
    let cursor = separator + 3;
    for (let field = 0; field < 2; field++) {
      const next = body.indexOf(0, cursor);
      if (next < 0) return { keyword, text: null };
      cursor = next + 1;
    }
    const text = body.subarray(cursor);
    return { keyword, text: utf8.decode(compressed ? inflate(text) : text) };
  } catch {
    return { keyword, text: null };
  }
}

function inflate(bytes: Uint8Array): Uint8Array {
  return inflateSync(bytes, { maxOutputLength: MAX_TEXT_BYTES });
}

function inspectPng(bytes: Uint8Array): ContainerInfo {
  const info = emptyInfo('png');
  const chunks = pngChunks(bytes);
  if (!chunks) return info;
  const png = { iccp: false, srgb: false, gamma: null as number | null, chrm: false };
  let seenImage = false;
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'IDAT':
        seenImage = true;
        break;
      case 'acTL':
        if (!seenImage) info.animated = true;
        break;
      case 'eXIf':
        info.exif.push({ ...skipExifHeader(bytes, chunk.data), crc: { start: chunk.start + 4, end: chunk.data.end } });
        break;
      case 'iCCP':
        png.iccp = true;
        break;
      case 'sRGB':
        png.srgb = true;
        break;
      case 'cHRM':
        png.chrm = true;
        break;
      case 'gAMA':
        if (chunk.data.end - chunk.data.start === 4) png.gamma = view(bytes).getUint32(chunk.data.start);
        break;
      case 'tEXt':
      case 'zTXt':
      case 'iTXt': {
        const text = pngText(bytes, chunk.type, chunk.data);
        if (text?.keyword === XMP_KEYWORD) info.xmp.push(text.text);
        else {
          const segment = copyOf(bytes, chunk.start, chunk.end);
          info.carried.push({ bytes: segment, keyword: text?.keyword ?? '', text: text?.text ?? null });
        }
        break;
      }
    }
  }
  info.png = png;
  info.valid = seenImage;
  return info;
}

/** WebP and PNG EXIF should start with the TIFF header, but writers (libvips among them) add JPEG's. */
function skipExifHeader(bytes: Uint8Array, range: Range): Range {
  return startsWith(bytes, range.start, JPEG_EXIF) ? { start: range.start + JPEG_EXIF.length, end: range.end } : range;
}

function webpChunks(bytes: Uint8Array): { type: string; start: number; data: Range }[] | null {
  const data = view(bytes);
  const riffEnd = 8 + data.getUint32(4, true);
  if (riffEnd > bytes.length) return null;
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const type = ascii(bytes, offset, 4);
    const length = data.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (end > riffEnd) return null;
    chunks.push({ type, start: offset, data: { start: offset + 8, end } });
    offset = end + (length % 2); // chunks are padded to an even length
  }
  return chunks;
}

function inspectWebp(bytes: Uint8Array): ContainerInfo {
  const info = emptyInfo('webp');
  const chunks = webpChunks(bytes);
  if (!chunks) return info;
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'ANMF':
        info.valid = true; // animation frames hold the bitstreams
        break;
      case 'VP8L':
        info.lossless = true;
        info.valid = true;
        break;
      case 'VP8 ':
        info.valid = true;
        break;
      case 'EXIF':
        info.exif.push(skipExifHeader(bytes, chunk.data));
        break;
      case 'XMP ':
        info.xmp.push(utf8.decode(bytes.subarray(chunk.data.start, chunk.data.end)));
        break;
    }
  }
  return info;
}

// --- EXIF ---------------------------------------------------------------------------------------

const TIFF_TYPE_SIZES: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};

interface Tiff {
  data: DataView;
  little: boolean;
  length: number;
}

function openTiff(tiff: Uint8Array): Tiff | null {
  if (tiff.length < 8) return null;
  const order = ascii(tiff, 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const data = view(tiff);
  if (data.getUint16(2, little) !== 42) return null;
  return { data, little, length: tiff.length };
}

/** Offsets of IFD0 and IFD1, the directories that may point to the GPS directory. */
function topDirectories(tiff: Tiff): number[] | null {
  const offsets: number[] = [];
  let offset = tiff.data.getUint32(4, tiff.little);
  while (offset !== 0 && offsets.length < 2) {
    if (offset + 2 > tiff.length || offsets.includes(offset)) return null;
    const count = tiff.data.getUint16(offset, tiff.little);
    const next = offset + 2 + count * 12;
    if (next + 4 > tiff.length) return null;
    offsets.push(offset);
    offset = tiff.data.getUint32(next, tiff.little);
  }
  return offsets;
}

function findEntry(tiff: Tiff, directory: number, tag: number): number | null {
  const count = tiff.data.getUint16(directory, tiff.little);
  for (let index = 0; index < count; index++) {
    const entry = directory + 2 + index * 12;
    if (tiff.data.getUint16(entry, tiff.little) === tag) return entry;
  }
  return null;
}

/** `true` if the TIFF structure points to a GPS directory, `null` if it cannot be walked. */
export function exifHasGps(tiffBytes: Uint8Array): boolean | null {
  const tiff = openTiff(tiffBytes);
  const directories = tiff && topDirectories(tiff);
  if (!tiff || !directories) return null;
  return directories.some((directory) => findEntry(tiff, directory, GPS_IFD_POINTER) !== null);
}

/**
 * Removes the GPS directory in place: zeroes its entries and the values they point to, then drops
 * the pointer to it, so no reader finds a position and none of its bytes remain. Returns `null` if
 * the structure cannot be walked.
 */
function removeGpsFromTiff(tiffBytes: Uint8Array): boolean | null {
  const tiff = openTiff(tiffBytes);
  const directories = tiff && topDirectories(tiff);
  if (!tiff || !directories) return null;
  const { data, little } = tiff;
  let removed = false;
  for (const directory of directories) {
    const pointer = findEntry(tiff, directory, GPS_IFD_POINTER);
    if (pointer === null) continue;
    const gps = data.getUint32(pointer + 8, little);
    if (gps + 2 <= tiff.length) {
      const count = data.getUint16(gps, little);
      const end = Math.min(tiff.length, gps + 2 + count * 12 + 4);
      for (let entry = gps + 2; entry + 12 <= end; entry += 12) {
        const size = (TIFF_TYPE_SIZES[data.getUint16(entry + 2, little)] ?? 1) * data.getUint32(entry + 4, little);
        const value = data.getUint32(entry + 8, little);
        if (size > 4 && value + size <= tiff.length) tiffBytes.fill(0, value, value + size);
      }
      tiffBytes.fill(0, gps, end);
    }
    // Shift the later entries and the next-directory offset over the pointer entry.
    const count = data.getUint16(directory, little);
    const tail = directory + 2 + count * 12 + 4;
    tiffBytes.copyWithin(pointer, pointer + 12, tail);
    tiffBytes.fill(0, tail - 12, tail);
    data.setUint16(directory, count - 1, little);
    removed = true;
  }
  return removed;
}

export type GpsRemoval =
  | { status: 'removed' | 'none'; bytes: Uint8Array }
  /** An EXIF block exists but its structure cannot be walked, so GPS cannot be ruled out. */
  | { status: 'unreadable' };

/** Returns a copy of the image with the GPS directory removed from every EXIF block. */
export function removeExifGps(bytes: Uint8Array, info: ContainerInfo): GpsRemoval {
  const copy = copyOf(bytes);
  let removed = false;
  for (const range of info.exif) {
    const result = removeGpsFromTiff(copy.subarray(range.start, range.end));
    if (result === null) return { status: 'unreadable' };
    if (result && range.crc) view(copy).setUint32(range.crc.end, crc32(copy.subarray(range.crc.start, range.crc.end)));
    removed ||= result;
  }
  return { status: removed ? 'removed' : 'none', bytes: removed ? copy : bytes };
}

// --- XMP ----------------------------------------------------------------------------------------

/** Any property named `GPS…` in any namespace, as an element or an attribute. */
const XMP_GPS = /[A-Za-z_][\w.-]*:GPS[A-Za-z]*/;
const XMP_GPS_ATTRIBUTE = /\s+([A-Za-z_][\w.-]*:GPS[A-Za-z]*)\s*=\s*(?:"[^"]*"|'[^']*')/g;
const XMP_GPS_EMPTY_ELEMENT = /<([A-Za-z_][\w.-]*:GPS[A-Za-z]*)\b[^>]*\/>/g;
const XMP_GPS_ELEMENT = /<([A-Za-z_][\w.-]*:GPS[A-Za-z]*)\b[^>]*>[\s\S]*?<\/\1\s*>/g;

export function xmpHasGps(xmp: string): boolean {
  return XMP_GPS.test(xmp);
}

/** Removes `GPS…` properties from an XMP packet; `null` if some remain that it could not remove. */
export function removeXmpGps(xmp: string): string | null {
  const cleaned = xmp.replace(XMP_GPS_ATTRIBUTE, '').replace(XMP_GPS_EMPTY_ELEMENT, '').replace(XMP_GPS_ELEMENT, '');
  return xmpHasGps(cleaned) ? null : cleaned;
}

/** Whether the image carries a GPS position in EXIF or XMP; `null` if that cannot be determined. */
export function containerHasGps(bytes: Uint8Array, info: ContainerInfo): boolean | null {
  let unknown = false;
  for (const range of info.exif) {
    const gps = exifHasGps(bytes.subarray(range.start, range.end));
    if (gps) return true;
    if (gps === null) unknown = true;
  }
  for (const xmp of info.xmp) {
    if (xmp === null) unknown = true;
    else if (xmpHasGps(xmp)) return true;
  }
  return unknown ? null : false;
}

// --- Carrying metadata libvips drops ------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Inserts the source's PNG text chunks before the output's image data, or its JPEG comments after
 * the output's application segments. Segments already present byte for byte are not repeated.
 * Returns `null` if the output cannot be walked.
 */
export function carryMetadata(output: Uint8Array, source: ContainerInfo): Uint8Array | null {
  if (source.carried.length === 0) return output;
  const target = inspectContainer(output);
  if (!target.valid || target.format !== source.format) return null;
  const same = (a: CarriedSegment, b: CarriedSegment) =>
    sameBytes(a.bytes, b.bytes) || (a.text !== null && a.keyword === b.keyword && a.text === b.text);
  const missing = source.carried
    .filter((segment) => !target.carried.some((present) => same(present, segment)))
    .map((segment) => segment.bytes);
  if (missing.length === 0) return output;

  let at: number | undefined;
  if (target.format === 'png') {
    at = pngChunks(output)?.find((chunk) => chunk.type === 'IDAT')?.start;
  } else if (target.format === 'jpeg') {
    // After SOI and any APPn segments, before the tables.
    at = 2;
    while (at + 4 <= output.length && output[at] === 0xff && output[at + 1]! >= 0xe0 && output[at + 1]! <= 0xef) {
      at += 2 + view(output).getUint16(at + 2);
    }
  }
  if (at === undefined || at > output.length) return null;
  return concat([output.subarray(0, at), ...missing, output.subarray(at)]);
}
