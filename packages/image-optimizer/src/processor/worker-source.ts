/**
 * Source of the worker process that runs Sharp, kept as a string so it needs no file of its own in
 * the published package. It runs as an ES module with an empty environment and talks to the parent
 * over the IPC channel, one image per process:
 *
 *   parent → { type: 'input', bytes, maxPixels }
 *   worker → { type: 'header', header }        or { type: 'decode-error', message }
 *   parent → { type: 'encode', encoder, xmp, greyscale }   (or kills the worker)
 *   worker → { type: 'result', output, header, versions, maxRssBytes }  or { type: 'encode-error', message }
 *
 * Reading the header first lets the parent check limits and reserve the pixel budget before any
 * pixels are decoded. Only the JPEG, PNG and WebP loaders are enabled, so other formats are never
 * parsed. `fault` makes the worker hang, crash, exit or send a malformed message at a stage; it
 * exists for tests.
 */
export const WORKER_SOURCE = `
const { sharpUrl, threads, fault } = JSON.parse(process.argv[1]);
const inbox = [];
let wake;
process.on('message', (message) => { inbox.push(message); if (wake) wake(); });
process.on('disconnect', () => process.exit(0));
const next = () => inbox.length > 0
  ? Promise.resolve(inbox.shift())
  : new Promise((resolve) => { wake = () => { wake = undefined; resolve(inbox.shift()); }; });
const send = (message) => new Promise((resolve) => process.send(message, () => resolve()));
const finish = async (message) => { await send(message); process.exit(0); };
const inject = (stage) => {
  if (!fault || fault.stage !== stage) return;
  if (fault.kind === 'hang') for (;;) {}
  if (fault.kind === 'crash') process.abort();
  if (fault.kind === 'exit') process.exit(3);
  if (fault.kind === 'garbage') {
    process.send({ type: 'header', header: { format: 'jpeg', width: 1, height: 1, pages: 1, channels: 3, space: 'srgb', depth: 'uchar', hasAlpha: false, orientation: null, icc: 'x' } });
    return new Promise(() => {});
  }
};
const describe = async (sharp, bytes, options) => {
  const meta = await sharp(bytes, options).metadata();
  const icc = meta.icc;
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    pages: meta.pages ?? 1,
    space: meta.space,
    channels: meta.channels,
    depth: meta.depth,
    hasAlpha: meta.hasAlpha === true,
    orientation: meta.orientation ?? null,
    icc: icc ? {
      bytes: icc.length,
      sha256: (await import('node:crypto')).createHash('sha256').update(icc).digest('hex'),
      space: icc.length >= 20 ? icc.subarray(16, 20).toString('latin1') : '',
      version: icc.length >= 9 ? icc[8] : 0,
    } : null,
    hasExif: meta.exif !== undefined,
    hasXmp: meta.xmp !== undefined,
    hasIptc: meta.iptc !== undefined,
  };
};

await inject('start');
const { bytes, maxPixels } = await next();
let sharp;
try {
  sharp = (await import(sharpUrl)).default;
} catch (error) {
  await finish({ type: 'unavailable', message: String(error && error.message) });
}
sharp.cache(false);
sharp.concurrency(threads);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'] });
const decode = { limitInputPixels: maxPixels, failOn: 'warning', sequentialRead: true };
let header;
try {
  // No pixel limit for the header read, which decodes no pixels: the parent judges the size.
  header = await describe(sharp, bytes, { failOn: 'warning' });
} catch (error) {
  await finish({ type: 'decode-error', message: String(error && error.message) });
}
await send({ type: 'header', header });
const { encoder, xmp, greyscale } = await next();
inject('encode');
let output;
try {
  let pipeline = sharp(bytes, decode).keepMetadata();
  if (typeof xmp === 'string') pipeline = pipeline.withXmp(xmp);
  if (greyscale) pipeline = pipeline.toColourspace('b-w');
  output = await pipeline[encoder.format](encoder.options).toBuffer();
} catch (error) {
  await finish({ type: 'encode-error', message: String(error && error.message) });
}
inject('result');
let result;
try {
  result = await describe(sharp, output, {});
} catch (error) {
  await finish({ type: 'encode-error', message: 'output does not decode: ' + String(error && error.message) });
}
await finish({
  type: 'result',
  output,
  header: result,
  versions: { sharp: sharp.versions.sharp, vips: sharp.versions.vips },
  maxRssBytes: process.resourceUsage().maxRSS * 1024,
});
`;
