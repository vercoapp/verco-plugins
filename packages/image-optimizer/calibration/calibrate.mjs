// Measures the encoding densities the scanner assumes and checks its estimates against real
// re-encodes. Usage: node --experimental-strip-types calibration/calibrate.mjs [photo-directory]
//
// The directory should hold lossless photographs (PNG or TIFF). Each one is encoded the way a site
// would serve it (Sharp's default quality per format) to measure typical bytes per pixel, then as a
// heavy and as an already-optimized upload to see what the scanner predicts against what re-encoding
// actually saves. Synthetic flat graphics check the PNG photo threshold from the other side.
// Results print to the console and are written to `.calibration/results.json`, which is ignored.
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';

import { DEFAULT_SCAN_OPTIONS, scanItem } from '../src/scanner.ts';

const root = new URL('..', import.meta.url).pathname;
const directory = process.argv[2] ?? join(root, '.calibration/kodak');

/** What a site would serve: Sharp's default quality for each format. */
const WEB = {
  jpeg: (image) => image.jpeg({ quality: 80 }),
  webp: (image) => image.webp({ quality: 80 }),
  avif: (image) => image.avif({ quality: 50 }),
};
/** Uploads straight from a camera or an export with quality turned up. */
const HEAVY = {
  jpeg: (image) => image.jpeg({ quality: 95 }),
  webp: (image) => image.webp({ quality: 95 }),
  avif: (image) => image.avif({ quality: 80 }),
};
const MIME = { jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', png: 'image/png' };

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { min: sorted[0], p25: at(0.25), median: at(0.5), p75: at(0.75), max: sorted.at(-1), n: sorted.length };
}

const round = (value, digits = 3) => Number(value.toFixed(digits));
const roundAll = (stats) => Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, key === 'n' ? value : round(value)]));

async function encodedSize(source, encode, width) {
  let image = sharp(source);
  if (width !== undefined) image = image.resize({ width });
  const { info } = await encode(image).toBuffer({ resolveWithObject: true });
  return info.size;
}

/** Flat-colour graphics with text, the kind of PNG that should not be called a photo. */
function graphic(index) {
  const width = 600 + index * 40;
  const height = 400 + index * 20;
  const hue = (index * 47) % 360;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="hsl(${hue},40%,96%)"/>
      <rect x="40" y="40" width="${width / 2}" height="${height / 3}" rx="12" fill="hsl(${hue},60%,45%)"/>
      <circle cx="${width * 0.75}" cy="${height * 0.6}" r="${height / 5}" fill="hsl(${(hue + 120) % 360},55%,55%)"/>
      <text x="40" y="${height - 60}" font-family="sans-serif" font-size="32" fill="#273237">Chart ${index}: quarterly figures</text>
      <text x="40" y="${height - 24}" font-family="sans-serif" font-size="18" fill="#606b71">Source: example data, not real</text>
    </svg>`,
  );
}

const files = (await readdir(directory)).filter((name) => ['.png', '.tif', '.tiff'].includes(extname(name).toLowerCase()));
if (files.length === 0) {
  console.error(`No PNG or TIFF photographs in ${directory}. Run calibration/fetch-kodak.mjs first, or pass a directory.`);
  process.exit(1);
}

const density = { jpeg: [], webp: [], avif: [], png: [] };
const pngGraphics = [];
const prediction = { jpeg: [], webp: [], avif: [] };
const falsePositives = { jpeg: 0, webp: 0, avif: 0 };
const falsePositivesAnySize = { jpeg: 0, webp: 0, avif: 0 };
// The calibration photographs are small, so the default 50 KB minimum hides most of what the density
// model does; also evaluate without it, as a large photograph would be.
const ANY_SIZE = { ...DEFAULT_SCAN_OPTIONS, minSavingsBytes: 0 };
const resize = [];

for (const name of files) {
  const source = await sharp(join(directory, name)).removeAlpha().toBuffer();
  const { width, height } = await sharp(source).metadata();
  const pixels = width * height;

  density.png.push((await encodedSize(source, (image) => image.png({ compressionLevel: 9 }))) / pixels);
  for (const format of ['jpeg', 'webp', 'avif']) {
    const served = await encodedSize(source, WEB[format]);
    density[format].push(served / pixels);

    // A heavy upload: what the scanner predicts it would save against re-encoding it for the web.
    const heavyBytes = await encodedSize(source, HEAVY[format]);
    const item = { id: name, mimeType: MIME[format], size: heavyBytes, width, height };
    const heavy = scanItem(item, DEFAULT_SCAN_OPTIONS);
    const heavyAnySize = scanItem(item, ANY_SIZE);
    const actual = heavyBytes - served;
    prediction[format].push({
      file: name,
      heavyBytes,
      actual,
      predicted: heavyAnySize.status === 'flagged' ? (heavyAnySize.estimate?.bytes ?? 0) : 0,
      flagged: heavy.status === 'flagged',
      flaggedAnySize: heavyAnySize.status === 'flagged',
    });

    // An upload already encoded for the web should not be reported.
    const optimized = scanItem({ id: name, mimeType: MIME[format], size: served, width, height }, DEFAULT_SCAN_OPTIONS);
    if (optimized.status === 'flagged') falsePositives[format] += 1;
    const optimizedAnySize = scanItem({ id: name, mimeType: MIME[format], size: served, width, height }, ANY_SIZE);
    if (optimizedAnySize.status === 'flagged') falsePositivesAnySize[format] += 1;
  }

  // Resize: the scanner assumes bytes scale with area. Halve the width and compare.
  const half = Math.round(width / 2);
  const fullJpeg = await encodedSize(source, WEB.jpeg);
  const halfJpeg = await encodedSize(source, WEB.jpeg, half);
  resize.push({ file: name, assumed: 0.25, actual: halfJpeg / fullJpeg });
}

for (let index = 0; index < 12; index += 1) {
  const png = await sharp(graphic(index)).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  pngGraphics.push(png.info.size / (png.info.width * png.info.height));
}

const report = {
  corpus: { directory: directory.startsWith(root) ? directory.slice(root.length) : '(external)', images: files.length },
  sharp: sharp.versions.sharp,
  bytesPerPixel: Object.fromEntries(Object.entries(density).map(([format, values]) => [format, roundAll(quantiles(values))])),
  pngGraphicsBytesPerPixel: roundAll(quantiles(pngGraphics)),
  heavyUploads: Object.fromEntries(
    Object.entries(prediction).map(([format, rows]) => [
      format,
      {
        flagged: `${rows.filter((row) => row.flagged).length}/${rows.length}`,
        flaggedAnySize: `${rows.filter((row) => row.flaggedAnySize).length}/${rows.length}`,
        // Among images flagged without the byte minimum: 1 means the estimate matched re-encoding.
        predictedOverActual: roundAll(
          quantiles(rows.filter((row) => row.flaggedAnySize && row.actual > 0).map((row) => row.predicted / row.actual)),
        ),
        actualSavingRatio: roundAll(quantiles(rows.map((row) => row.actual / row.heavyBytes))),
      },
    ]),
  ),
  optimizedUploadsFlagged: Object.fromEntries(Object.entries(falsePositives).map(([format, count]) => [format, `${count}/${files.length}`])),
  optimizedUploadsFlaggedAnySize: Object.fromEntries(
    Object.entries(falsePositivesAnySize).map(([format, count]) => [format, `${count}/${files.length}`]),
  ),
  halfWidthJpegSizeRatio: roundAll(quantiles(resize.map((row) => row.actual))),
  resizeModelRatio: round(0.25 ** 0.9),
};

await mkdir(join(root, '.calibration'), { recursive: true });
await writeFile(join(root, '.calibration/results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
