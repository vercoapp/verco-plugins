// Measures the local processor's wall time and worker memory per format, preset and image size, to
// set its limits (src/processor/limits.ts) on the hardware that will run it.
// Usage: node --experimental-strip-types calibration/measure-processor.ts [megapixels...]
//
// Inputs are Gaussian noise, the slowest content to encode and the largest to compress, so the
// figures are an upper bound for photographs of the same size. Each image runs alone in a fresh
// worker with one libvips thread, as the processor does by default.
import { cpus } from 'node:os';

import sharp from 'sharp';

import { createLocalProcessor } from '../src/processor/local.ts';
import type { PresetName } from '../src/processor/presets.ts';

const sizes = process.argv.slice(2).map(Number);
const megapixels = sizes.length > 0 ? sizes : [12, 24, 40];
const presets: PresetName[] = ['balanced', 'high-fidelity'];

const INPUTS = {
  jpeg: (image: sharp.Sharp) => image.jpeg({ quality: 95 }),
  png: (image: sharp.Sharp) => image.png({ compressionLevel: 1 }),
  webp: (image: sharp.Sharp) => image.webp({ quality: 95 }),
  'webp-lossless': (image: sharp.Sharp) => image.webp({ lossless: true, effort: 0 }),
};

const processor = createLocalProcessor({
  limits: { maxInputBytes: 2 ** 31 - 1, maxPixels: 200_000_000, maxInFlightPixels: 200_000_000, wallTimeMs: 600_000 },
});

console.log(`${cpus()[0]?.model ?? 'unknown CPU'}, Node ${process.version}`);
console.log('MP\tinput\tpreset\tinput MB\toutput MB\tseconds\tworker RSS MB');
for (const mp of megapixels) {
  const width = Math.round(Math.sqrt((mp * 1e6 * 4) / 3));
  const height = Math.round((mp * 1e6) / width);
  const noise = sharp({
    create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } },
  });
  const raw = await noise.raw().toBuffer();
  for (const [name, encode] of Object.entries(INPUTS)) {
    const bytes = await encode(sharp(raw, { raw: { width, height, channels: 3 } })).toBuffer();
    for (const preset of presets) {
      const result = await processor.process({ bytes, preset });
      if (result.status !== 'processed') {
        console.log(`${mp}\t${name}\t${preset}\tskipped: ${result.reason}`);
        continue;
      }
      const mb = (value: number) => (value / 1024 / 1024).toFixed(1);
      console.log(
        [
          mp,
          name,
          preset,
          mb(bytes.length),
          mb(result.output.length),
          (result.elapsedMs / 1000).toFixed(1),
          mb(result.workerMaxRssBytes),
        ].join('\t'),
      );
    }
  }
}
