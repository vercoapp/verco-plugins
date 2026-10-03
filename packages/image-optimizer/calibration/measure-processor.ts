// Measures the local processor's wall time and worker memory per format, preset and image size, to
// set its limits (src/processor/limits.ts) on the hardware that will run it.
// Usage: node --experimental-strip-types calibration/measure-processor.ts [options] [megapixels...]
//   --content=noise|photo|both   input content (default both)
//   --concurrent=N               instead of one image at a time, run N encodes at once at the
//                                largest size and report the container's memory (cgroup v2)
//   --threads=N                  libvips threads per worker (default 1, as the processor does)
//   --defaults                   keep the processor's default limits instead of lifting them, to
//                                see what they admit, skip or refuse as busy
//
// Noise is Gaussian noise, the slowest content to encode and the largest to compress, so it is an
// upper bound for photographs of the same size. "Photo" is smooth gradients and low-frequency
// texture with fine sensor-like grain, generated here; it is a stand-in, not a real photograph.
// Each image runs in a fresh worker. Run it inside the memory and CPU cap of the deployment.
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

import sharp from 'sharp';

import { createLocalProcessor } from '../src/processor/local.ts';
import type { PresetName } from '../src/processor/presets.ts';

const flags = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith('--'))
    .map((argument) => {
      const [key, value = ''] = argument.slice(2).split('=');
      return [key, value] as const;
    }),
);
const sizes = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith('--'))
  .map(Number);
const megapixels = sizes.length > 0 ? sizes : [12, 24, 40];
const presets: PresetName[] = ['balanced', 'high-fidelity'];
const contentFlag = flags.get('content') ?? 'both';
const contents = contentFlag === 'both' ? (['noise', 'photo'] as const) : ([contentFlag] as ('noise' | 'photo')[]);
const concurrent = Number(flags.get('concurrent') ?? 0);
const threads = Number(flags.get('threads') ?? 1);

const INPUTS = {
  jpeg: (image: sharp.Sharp) => image.jpeg({ quality: 95 }),
  png: (image: sharp.Sharp) => image.png({ compressionLevel: 1 }),
  webp: (image: sharp.Sharp) => image.webp({ quality: 95 }),
  'webp-lossless': (image: sharp.Sharp) => image.webp({ lossless: true, effort: 0 }),
};

// A worker's own `resourceUsage().maxRSS` also counts its parent's resident memory at the moment it
// was forked (Linux carries the old address space's high-water mark across exec), so a large
// parent inflates it. The kernel's per-process `VmHWM` for the worker's pid does not, so it is
// sampled here while the worker runs, and the last value seen before it exits is its peak.
const workerPeaks = new Map<number, number>();
function samplePeaks(): void {
  for (const pid of workerPeaks.keys()) {
    try {
      const match = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmHWM:\s+(\d+) kB/m);
      if (match) workerPeaks.set(pid, Math.max(workerPeaks.get(pid) ?? 0, Number(match[1]) * 1024));
    } catch {
      // the worker has exited
    }
  }
}
setInterval(samplePeaks, 10).unref();
function takePeaks(): number[] {
  const peaks = [...workerPeaks.values()];
  workerPeaks.clear();
  return peaks;
}

const defaults = flags.has('defaults');
const processor = createLocalProcessor({
  threads,
  onSpawn: (pid) => {
    if (pid !== undefined) workerPeaks.set(pid, 0);
  },
  ...(defaults
    ? {}
    : {
        limits: {
          maxInputBytes: 2 ** 31 - 1,
          maxPixels: 200_000_000,
          maxInFlightPixels: 200_000_000,
          wallTimeMs: 600_000,
          maxWorkers: Math.max(2, concurrent),
          maxPixelsByEncoder: {},
          pixelWeightByEncoder: {},
        },
      }),
});

const mb = (value: number) => (value / 1024 / 1024).toFixed(1);

function cgroup(file: string): string | null {
  try {
    return readFileSync(`/sys/fs/cgroup/${file}`, 'utf8');
  } catch {
    return null;
  }
}
function oomKills(): number | null {
  const match = cgroup('memory.events')?.match(/^oom_kill (\d+)/m);
  return match ? Number(match[1]) : null;
}

async function noiseRaw(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } },
  })
    .raw()
    .toBuffer();
}

/** Smooth gradients, low-frequency texture and fine grain: closer to a camera image than noise. */
async function photoRaw(width: number, height: number): Promise<Buffer> {
  const small = 64;
  const texture = await sharp({
    create: {
      width: small,
      height: Math.round((small * height) / width),
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 50 },
    },
  })
    .resize(width, height, { kernel: 'cubic' })
    .raw()
    .toBuffer();
  const grain = await sharp({
    create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 6 } },
  })
    .raw()
    .toBuffer();
  const out = Buffer.allocUnsafe(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const sky = 140 + 90 * (y / height);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const base = 60 * Math.sin((x / width) * 5) * Math.cos((y / height) * 3);
      for (let c = 0; c < 3; c += 1) {
        const value = sky * (0.75 + 0.1 * c) + base + (texture[i + c]! - 128) * 0.35 + (grain[i + c]! - 128) * 0.5;
        out[i + c] = value < 0 ? 0 : value > 255 ? 255 : value;
      }
    }
  }
  return out;
}

console.log(`${cpus()[0]?.model ?? 'unknown CPU'}, Node ${process.version}, ${cpus().length} CPUs visible, threads ${threads}`);
console.log('content\tMP\tinput\tpreset\tinput MB\toutput MB\tseconds\tworker peak RSS MB (VmHWM)\treported maxRSS MB');

const sizeList = concurrent > 0 ? [Math.max(...megapixels)] : megapixels;
for (const content of contents) {
  for (const mp of sizeList) {
    const width = Math.round(Math.sqrt((mp * 1e6 * 4) / 3));
    const height = Math.round((mp * 1e6) / width);
    const raw = await (content === 'noise' ? noiseRaw(width, height) : photoRaw(width, height));
    for (const [name, encode] of Object.entries(INPUTS)) {
      const bytes = await encode(sharp(raw, { raw: { width, height, channels: 3 } })).toBuffer();
      for (const preset of presets) {
        if (concurrent > 0) {
          const before = oomKills();
          let peak = 0;
          const sampler = setInterval(() => {
            peak = Math.max(peak, Number(cgroup('memory.current') ?? 0));
          }, 100);
          const started = performance.now();
          const results = await Promise.allSettled(
            Array.from({ length: concurrent }, () => processor.process({ bytes, preset })),
          );
          clearInterval(sampler);
          const rss = results.map((result) =>
            result.status === 'rejected'
              ? `error:${(result.reason as Error).message.slice(0, 40)}`
              : result.value.status === 'processed'
                ? mb(result.value.workerMaxRssBytes)
                : `skipped:${result.value.reason}`,
          );
          console.log(
            [
              content,
              mp,
              name,
              preset,
              `x${concurrent}`,
              `${((performance.now() - started) / 1000).toFixed(1)}s`,
              `worker peak RSS MB ${takePeaks().map(mb).join(' + ')}`,
              `reported maxRSS MB ${rss.join(' + ')}`,
              `cgroup peak MB ${mb(peak)}`,
              `oom_kill ${before}->${oomKills()}`,
            ].join('\t'),
          );
          continue;
        }
        const result = await processor.process({ bytes, preset });
        if (result.status !== 'processed') {
          console.log(`${content}\t${mp}\t${name}\t${preset}\tskipped: ${result.reason}`);
          continue;
        }
        console.log(
          [
            content,
            mp,
            name,
            preset,
            mb(bytes.length),
            mb(result.output.length),
            (result.elapsedMs / 1000).toFixed(1),
            mb(Math.max(0, ...takePeaks())),
            mb(result.workerMaxRssBytes),
          ].join('\t'),
        );
      }
    }
  }
}
