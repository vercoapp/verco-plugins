import { describe, expect, it } from 'vitest';

import { ImageProcessorError, type ProcessResult } from '../../src/processor/contract.ts';
import { DEFAULT_PROCESSOR_LIMITS, createPixelAdmission, resolveProcessorLimits } from '../../src/processor/limits.ts';
import { createLocalProcessor, type LocalProcessorOptions } from '../../src/processor/local.ts';
import { HEIGHT, WIDTH, photo } from './fixtures.ts';

const PIXELS = WIDTH * HEIGHT;
const jpeg = await photo().jpeg({ quality: 95 }).toBuffer();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function rejection(promise: Promise<unknown>): Promise<ImageProcessorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ImageProcessorError);
    return error as ImageProcessorError;
  }
  throw new Error('expected a rejection');
}

/** Counts timer ticks while `promise` runs, to show the parent's event loop is not blocked. */
async function ticksDuring<T>(promise: Promise<T>): Promise<{ result: PromiseSettledResult<T>; ticks: number }> {
  let ticks = 0;
  const interval = setInterval(() => (ticks += 1), 20);
  const [result] = await Promise.allSettled([promise]);
  clearInterval(interval);
  return { result: result!, ticks };
}

function processed(result: ProcessResult) {
  if (result.status !== 'processed') throw new Error(`expected processed, got ${result.reason}`);
  return result;
}

describe('limits', () => {
  it('rejects unusable limits', () => {
    expect(() => resolveProcessorLimits({ maxPixels: 0 })).toThrow(RangeError);
    expect(() => resolveProcessorLimits({ wallTimeMs: 1.5 })).toThrow(RangeError);
    expect(() => resolveProcessorLimits({ maxPixels: 10, maxInFlightPixels: 9 })).toThrow(/at least one/);
    expect(resolveProcessorLimits()).toEqual(DEFAULT_PROCESSOR_LIMITS);
  });

  it('admits pixels up to the budget and releases each reservation once', () => {
    const admission = createPixelAdmission(100);
    const first = admission.tryAcquire(60);
    expect(first).not.toBeNull();
    expect(admission.tryAcquire(41)).toBeNull();
    const second = admission.tryAcquire(40);
    expect(admission.inFlightPixels()).toBe(100);
    first!();
    first!();
    expect(admission.inFlightPixels()).toBe(40);
    second!();
    expect(admission.inFlightPixels()).toBe(0);
    expect(admission.tryAcquire(0)).toBeNull();
    expect(admission.tryAcquire(Number.NaN)).toBeNull();
  });
});

describe('local processor', () => {
  it('describes what it can do', () => {
    const capabilities = createLocalProcessor().capabilities();
    expect(capabilities).toMatchObject({
      processor: 'local-sharp',
      formats: ['jpeg', 'png', 'webp'],
      presets: ['balanced', 'high-fidelity'],
      sameFormat: true,
      sameDimensions: true,
      metadata: { keptByDefault: true, canRemoveGps: true },
      limits: DEFAULT_PROCESSOR_LIMITS,
    });
    expect(capabilities.version).toMatch(/\+sharp-0\.35\.4$/);
  });

  it('encodes in a worker process and reports what it measured', async () => {
    const pids: (number | undefined)[] = [];
    const processor = createLocalProcessor({ onSpawn: (pid) => pids.push(pid) });
    const result = processed(await processor.process({ bytes: jpeg, preset: 'balanced' }));
    expect(pids).toHaveLength(1);
    expect(pids[0]).not.toBe(process.pid);
    // The result arrives only after the worker has exited, with its slot and pixels released.
    expect(isAlive(pids[0]!)).toBe(false);
    expect(result.input).toMatchObject({ format: 'jpeg', bytes: jpeg.length, width: WIDTH, height: HEIGHT });
    expect(result.result).toMatchObject({ format: 'jpeg', bytes: result.output.length, width: WIDTH, height: HEIGHT });
    expect(result.output.length).toBeLessThan(jpeg.length);
    expect(result.encoder).toMatchObject({ preset: 'balanced', sharp: '0.35.4', options: { format: 'jpeg' } });
    expect(result.workerMaxRssBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(result.elapsedMs).toBeGreaterThan(0);
  });

  it('rejects an unknown preset and non-byte input', async () => {
    const processor = createLocalProcessor();
    // @ts-expect-error: not a preset
    await expect(processor.process({ bytes: jpeg, preset: 'lossy-max' })).rejects.toThrow(RangeError);
    // @ts-expect-error: not bytes
    await expect(processor.process({ bytes: 'abc', preset: 'balanced' })).rejects.toThrow(TypeError);
  });

  it('kills a hung encode at its wall time while the parent keeps running', async () => {
    const pids: number[] = [];
    const options: LocalProcessorOptions = {
      limits: { wallTimeMs: 1500, maxWorkers: 1, maxPixels: PIXELS, maxInFlightPixels: PIXELS },
      fault: { kind: 'hang', stage: 'encode' },
      onSpawn: (pid) => pids.push(pid!),
    };
    const processor = createLocalProcessor(options);
    const started = Date.now();
    const { result, ticks } = await ticksDuring(processor.process({ bytes: jpeg, preset: 'balanced' }));
    const elapsed = Date.now() - started;

    expect(result.status).toBe('rejected');
    const error = (result as PromiseRejectedResult).reason as ImageProcessorError;
    expect(error).toBeInstanceOf(ImageProcessorError);
    expect(error.code).toBe('timeout');
    expect(error.retryable).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(5000);
    // A 20 ms interval kept firing for the whole wait.
    expect(ticks).toBeGreaterThan(40);
    await expect.poll(() => isAlive(pids[0]!)).toBe(false);

    // The worker slot and the pixel budget were both released: the next image runs.
    delete options.fault;
    processed(await processor.process({ bytes: jpeg, preset: 'balanced' }));
  });

  it('kills a worker that hangs before reading its input', async () => {
    const processor = createLocalProcessor({ limits: { wallTimeMs: 1000 }, fault: { kind: 'hang', stage: 'start' } });
    expect((await rejection(processor.process({ bytes: jpeg, preset: 'balanced' }))).code).toBe('timeout');
  });

  it('reports a crashing encode without affecting the parent', async () => {
    const options: LocalProcessorOptions = {
      limits: { maxWorkers: 1, maxPixels: PIXELS, maxInFlightPixels: PIXELS },
      fault: { kind: 'crash', stage: 'encode' },
    };
    const processor = createLocalProcessor(options);
    const error = await rejection(processor.process({ bytes: jpeg, preset: 'balanced' }));
    expect(error.code).toBe('crashed');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/SIGABRT/);

    delete options.fault;
    processed(await processor.process({ bytes: jpeg, preset: 'balanced' }));
  });

  it('reports a worker that exits after encoding without sending its result', async () => {
    const processor = createLocalProcessor({ fault: { kind: 'exit', stage: 'result' } });
    const error = await rejection(processor.process({ bytes: jpeg, preset: 'balanced' }));
    expect(error.code).toBe('crashed');
    expect(error.message).toMatch(/exit code 3/);
  });

  it('kills a worker that sends a malformed header, without throwing in the parent', async () => {
    const pids: number[] = [];
    const processor = createLocalProcessor({
      fault: { kind: 'garbage', stage: 'start' },
      onSpawn: (pid) => pids.push(pid!),
    });
    const error = await rejection(processor.process({ bytes: jpeg, preset: 'balanced' }));
    expect(error.code).toBe('crashed');
    expect(error.message).toMatch(/invalid header/);
    expect(isAlive(pids[0]!)).toBe(false);
  });

  it('refuses work beyond the decoded-pixel budget instead of queueing it', async () => {
    const options: LocalProcessorOptions = {
      limits: { wallTimeMs: 3000, maxWorkers: 2, maxPixels: PIXELS, maxInFlightPixels: PIXELS },
      fault: { kind: 'hang', stage: 'encode' },
    };
    const processor = createLocalProcessor(options);
    const first = processor.process({ bytes: jpeg, preset: 'balanced' });
    const second = processor.process({ bytes: jpeg, preset: 'balanced' });
    const [a, b] = await Promise.allSettled([first, second]);
    const codes = [a, b].map((outcome) => ((outcome as PromiseRejectedResult).reason as ImageProcessorError).code);
    // One encode held the whole budget and was killed at its wall time; the other was refused.
    expect(codes.sort()).toEqual(['busy', 'timeout']);
    const busy = [a, b].find((outcome) => (outcome as PromiseRejectedResult).reason.code === 'busy');
    expect(((busy as PromiseRejectedResult).reason as ImageProcessorError).retryable).toBe(true);

    delete options.fault;
    processed(await processor.process({ bytes: jpeg, preset: 'balanced' }));
  });

  it('refuses work beyond the worker limit', async () => {
    const processor = createLocalProcessor({ limits: { maxWorkers: 1 } });
    const first = processor.process({ bytes: jpeg, preset: 'balanced' });
    const error = await rejection(processor.process({ bytes: jpeg, preset: 'balanced' }));
    expect(error.code).toBe('busy');
    processed(await first);
    processed(await processor.process({ bytes: jpeg, preset: 'balanced' }));
  });

  it('kills the worker when the caller aborts', async () => {
    const pids: number[] = [];
    const processor = createLocalProcessor({
      fault: { kind: 'hang', stage: 'encode' },
      onSpawn: (pid) => pids.push(pid!),
    });
    const controller = new AbortController();
    const pending = processor.process({ bytes: jpeg, preset: 'balanced', signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    expect((await rejection(pending)).code).toBe('aborted');
    await expect.poll(() => isAlive(pids[0]!)).toBe(false);

    const aborted = AbortSignal.abort();
    expect((await rejection(processor.process({ bytes: jpeg, preset: 'balanced', signal: aborted }))).code).toBe(
      'aborted',
    );
  });

  it('reports Sharp as unavailable when it cannot be loaded', async () => {
    const processor = createLocalProcessor({ sharpPath: '/nonexistent/sharp/index.cjs' });
    expect(processor.capabilities().version).toMatch(/\+sharp-unavailable$/);
    const error = await rejection(processor.process({ bytes: jpeg, preset: 'balanced' }));
    expect(error.code).toBe('unavailable');
    expect(error.retryable).toBe(false);
  });
});
