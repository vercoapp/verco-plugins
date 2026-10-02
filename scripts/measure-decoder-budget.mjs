import { execFile } from 'node:child_process';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PILOT_LIMITS } from '../experiments/helpers/decode-budget.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = join(root, 'scripts/lib/decode-worker.mjs');
await mkdir(join(root, '.qualification-runs'), { recursive: true });
const runs = await mkdtemp(join(root, '.qualification-runs', 'decoder-'));
const REPETITIONS = 3;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value, digits = 1) => Number(value.toFixed(digits));

async function decodeOnce(path, expected, mode, limits = PILOT_LIMITS, options = {}) {
  const { stdout } = await execFileAsync(process.execPath, [worker, JSON.stringify({ path, expected, mode, limits })], { encoding: 'utf8', ...options });
  return JSON.parse(stdout);
}

async function measure(path, expected, mode, limits) {
  const results = [];
  for (let i = 0; i < REPETITIONS; i++) results.push(await decodeOnce(path, expected, mode, limits));
  return {
    outcome: results[0].outcome, msMedian: round(median(results.map((r) => r.ms))), msMax: round(Math.max(...results.map((r) => r.ms))),
    rssDeltaMiBMax: round(Math.max(...results.map((r) => r.rssDeltaMiB))),
  };
}

// Smooth gradient plus xorshift noise: compresses like a photo rather than a flat fill.
function pixelsFor(width, height) {
  const data = Buffer.allocUnsafe(width * height * 3);
  let state = 0x9e3779b9;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const noise = (state >>> 0) % 24;
      data[i++] = ((x * 255) / width + noise) & 255;
      data[i++] = ((y * 255) / height + noise) & 255;
      data[i++] = (((x + y) * 127) / (width + height) + noise) & 255;
    }
  }
  return data;
}
const dimensions = (megapixels) => {
  const width = Math.round(Math.sqrt((megapixels * 1e6 * 4) / 3));
  return { width, height: Math.round((megapixels * 1e6) / width) };
};
const encode = (raw, { width, height }, format) => {
  const image = sharp(raw, { raw: { width, height, channels: 3 }, limitInputPixels: false });
  return (format === 'jpeg' ? image.jpeg({ quality: 85 }) : format === 'png' ? image.png() : image.webp()).toBuffer();
};

try {
  const corpus = [];
  for (const megapixels of [1, 4, 12, 24, 48]) {
    const size = dimensions(megapixels);
    const raw = pixelsFor(size.width, size.height);
    for (const format of ['jpeg', 'png', 'webp']) {
      const bytes = await encode(raw, size, format);
      const path = join(runs, `${megapixels}mp.${format}`);
      await writeFile(path, bytes);
      corpus.push({ megapixels, format, ...size, path, bytes: bytes.length });
    }
  }

  const matrix = [];
  for (const item of corpus) {
    const expected = { format: item.format, width: item.width, height: item.height };
    const row = { format: item.format, megapixels: item.megapixels, width: item.width, height: item.height, bytes: item.bytes };
    // Photographic PNG exceeds the byte limit before the pixel limit. Record that, then measure the
    // decode itself with the byte limit lifted so memory and time at each size remain comparable.
    row.pilotLimitsOutcome = (await decodeOnce(item.path, expected, 'stream')).outcome;
    row.byteLimitLifted = row.pilotLimitsOutcome === 'TOO_LARGE_BYTES';
    const limits = row.byteLimitLifted ? { ...PILOT_LIMITS, maxBytes: Number.MAX_SAFE_INTEGER } : PILOT_LIMITS;
    for (const mode of ['stream', 'buffer']) {
      row[mode] = await measure(item.path, expected, mode, limits);
      if (row[mode].outcome !== 'ACCEPTED') throw new Error(`Corpus case ${item.format} ${item.megapixels}MP was not decodable: ${row[mode].outcome}`);
    }
    matrix.push(row);
    console.log(`${item.format} ${item.megapixels}MP: stream ${row.stream.msMedian}ms/${row.stream.rssDeltaMiBMax}MiB, buffer ${row.buffer.msMedian}ms/${row.buffer.rssDeltaMiBMax}MiB`);
  }

  // Concurrency: N simultaneous decodes of one 12 MP image in separate processes.
  const subject = corpus.find((item) => item.megapixels === 12 && item.format === 'jpeg');
  const subjectExpected = { format: subject.format, width: subject.width, height: subject.height };
  const concurrency = [];
  for (const parallel of [1, 2, 4, 8]) {
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: parallel }, () => decodeOnce(subject.path, subjectExpected, 'stream')));
    concurrency.push({
      parallel, wallMs: round(performance.now() - started), perJobMsMedian: round(median(results.map((r) => r.ms))),
      perJobMsMax: round(Math.max(...results.map((r) => r.ms))), totalRssDeltaMiB: round(results.reduce((sum, r) => sum + r.rssDeltaMiB, 0)),
    });
  }

  // Hostile and invalid inputs, measured against the pilot limits.
  const twelve = corpus.filter((item) => item.megapixels === 12);
  const hostile = [];
  async function hostileCase(name, path, expected, mode = 'stream', limits = PILOT_LIMITS) {
    const result = await measure(path, expected, mode, limits);
    hostile.push({ name, ...result });
    console.log(`hostile ${name}: ${result.outcome} in ${result.msMedian}ms`);
  }
  for (const item of twelve) {
    const expected = { format: item.format, width: item.width, height: item.height };
    const bytes = await readFile(item.path);
    const truncated = join(runs, `truncated.${item.format}`);
    await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.5)));
    await hostileCase(`truncated-${item.format}-12mp`, truncated, expected);
    const damaged = Buffer.from(bytes);
    for (let i = Math.floor(damaged.length * 0.4); i < Math.floor(damaged.length * 0.4) + 4096; i++) damaged[i] ^= 0xa5;
    const damagedPath = join(runs, `damaged.${item.format}`);
    await writeFile(damagedPath, damaged);
    await hostileCase(`damaged-body-${item.format}-12mp`, damagedPath, expected);
  }
  const jpeg12 = twelve.find((item) => item.format === 'jpeg');
  await hostileCase('wrong-format-jpeg-as-png-12mp', jpeg12.path, { format: 'png', width: jpeg12.width, height: jpeg12.height });
  await hostileCase('changed-dimensions-12mp', jpeg12.path, { format: 'jpeg', width: jpeg12.width - 1, height: jpeg12.height });
  const oversized = join(runs, 'oversized.jpeg');
  await writeFile(oversized, jpeg12 ? await readFile(jpeg12.path) : Buffer.alloc(0));
  await hostileCase('over-byte-limit-12mp', oversized, { format: 'jpeg', width: jpeg12.width, height: jpeg12.height }, 'stream', { ...PILOT_LIMITS, maxBytes: 1024 });
  const frames = [];
  for (const colour of ['#c03030', '#30c030', '#3030c0']) frames.push(await sharp({ create: { width: 512, height: 384, channels: 3, background: colour } }).png().toBuffer());
  const animatedPath = join(runs, 'animated.webp');
  await writeFile(animatedPath, await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100, 100] }).toBuffer());
  await hostileCase('animated-webp-3-frames', animatedPath, { format: 'webp', width: 512, height: 384 });
  // A small file that declares 144 MP: header rejection must happen before any pixel allocation.
  const bombPath = join(runs, 'pixel-bomb.png');
  await writeFile(bombPath, await sharp({ create: { width: 12000, height: 12000, channels: 3, background: '#123456' }, limitInputPixels: false }).png({ compressionLevel: 9 }).toBuffer());
  await hostileCase('pixel-bomb-png-144mp', bombPath, { format: 'png', width: 12000, height: 12000 });
  hostile.find((entry) => entry.name === 'pixel-bomb-png-144mp').fileBytes = (await readFile(bombPath)).length;

  // A decode in flight cannot be cancelled in-process; prove a parent can terminate it.
  const slowest = matrix.filter((row) => row.megapixels === 48).sort((a, b) => b.stream.msMedian - a.stream.msMedian)[0];
  const subjectOfKill = corpus.find((item) => item.megapixels === 48 && item.format === slowest.format);
  const killAt = 150;
  const killStarted = performance.now();
  let killed = false;
  await decodeOnce(subjectOfKill.path, { format: slowest.format, width: slowest.width, height: slowest.height }, 'stream', { ...PILOT_LIMITS, maxBytes: Number.MAX_SAFE_INTEGER }, { timeout: killAt, killSignal: 'SIGKILL' })
    .catch((error) => { killed = Boolean(error.killed); });
  if (!killed) throw new Error('The in-flight decode was not terminated by the parent timeout.');
  const termination = { format: slowest.format, megapixels: 48, timeoutMs: killAt, decodeMsWithoutTimeout: slowest.stream.msMedian, killed, elapsedMs: round(performance.now() - killStarted) };

  // Derive proposed budgets from the measurements, then state what they are not.
  const atLimit = matrix.filter((row) => row.megapixels === 48);
  const worstMsAtLimit = Math.max(...atLimit.map((row) => row.stream.msMax));
  const worstMiBPerMegapixel = Math.max(...matrix.filter((row) => row.megapixels >= 4).map((row) => row.stream.rssDeltaMiBMax / row.megapixels));
  const memoryBudgetMiB = 1024;
  const proposed = {
    maxBytes: PILOT_LIMITS.maxBytes, maxPixels: PILOT_LIMITS.maxPixels, maxFrames: PILOT_LIMITS.maxFrames, formats: PILOT_LIMITS.formats,
    wallTimeMs: Math.ceil((worstMsAtLimit * 5) / 5000) * 5000,
    decodeMemoryBudgetMiB: memoryBudgetMiB,
    maxInFlightPixels: Math.floor((memoryBudgetMiB / worstMiBPerMegapixel) / 10) * 10 * 1e6,
    validationMode: 'stream',
    derivation: `wall time is five times the slowest ${PILOT_LIMITS.maxPixels / 1e6} MP stream decode (${round(worstMsAtLimit)} ms) rounded up to 5 s and enforced by terminating a child process; in-flight pixels are the memory budget divided by the worst measured ${round(worstMiBPerMegapixel)} MiB per megapixel (WebP), rounded down to 10 MP; admit a decode only while the sum of in-flight pixels stays within it. Stream mode is chosen because its worst-case memory is lower than buffer mode, although it is slower.`,
  };

  const evidence = {
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version, platform: `${os.platform()} ${os.arch()} ${os.release()}`, cpu: os.cpus()[0]?.model, cpus: os.availableParallelism(),
      totalMemoryMiB: Math.round(os.totalmem() / 1048576), sharp: sharp.versions.sharp, vips: sharp.versions.vips,
      codecs: { jpeg: sharp.versions.mozjpeg, png: sharp.versions.png, webp: sharp.versions.webp }, sharpConcurrency: sharp.concurrency(), sharpCache: false,
    },
    method: 'One decode per child process after a warm-up; RSS is the child high-water mark above its post-warm-up baseline; three repetitions, median time and maximum RSS. Corpus is synthetic gradient-with-noise 4:3 images.',
    repetitions: REPETITIONS,
    modes: { stream: 'sequentialRead plus stats(): every pixel is decoded and discarded', buffer: 'raw().toBuffer(): materializes the decoded image; shown only for comparison' },
    corpus: matrix, concurrency: { subject: '12 MP JPEG, stream mode', results: concurrency }, hostile, termination, proposed,
    limits: 'One Apple-silicon development machine, synthetic still images, no deployed runtime, no memory-constrained container, no concurrent HTTP load. Proposed values are pilot limits, not production guarantees; deployed-runtime measurements remain for tasks 3.2 and 3.3.',
  };
  const directory = join(root, 'host/emdash/qualification');
  await mkdir(directory, { recursive: true });
  const destination = join(directory, 'decoder-budget-latest.json');
  await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Decoder budget measured. Evidence: ${destination}`);
} finally {
  await rm(runs, { recursive: true, force: true });
}
