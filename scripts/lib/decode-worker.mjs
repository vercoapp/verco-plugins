// Child process for decoder measurements: one validation per process so the
// resource high-water mark belongs to that decode alone.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { DecodeRejection, validateDecoded } from '../../experiments/helpers/decode-budget.mjs';

const { path, expected, mode, limits } = JSON.parse(process.argv[2]);
sharp.cache(false); // deterministic memory; the host may choose otherwise
const warm = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toBuffer();
await validateDecoded(warm, { format: 'png', width: 8, height: 8 });
const baseline = process.resourceUsage().maxRSS; // KiB
const started = performance.now();
const bytes = await readFile(path);
let outcome = 'ACCEPTED';
try {
  await validateDecoded(bytes, expected, limits, mode);
} catch (error) {
  if (!(error instanceof DecodeRejection)) throw error;
  outcome = error.code;
}
const ms = performance.now() - started;
const peak = process.resourceUsage().maxRSS;
console.log(JSON.stringify({ outcome, ms, rssDeltaMiB: Math.max(0, peak - baseline) / 1024, peakRssMiB: peak / 1024 }));
