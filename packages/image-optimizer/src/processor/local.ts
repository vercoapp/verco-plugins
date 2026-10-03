/**
 * The local `ImageProcessor`: Sharp in a child process, one image per process (Node only).
 *
 * An encode already running cannot be cancelled inside a process, and a native crash or an
 * out-of-memory kill takes its process with it, so every image gets a fresh worker that the parent
 * can kill. The worker starts with an empty environment in the temp directory, loads Sharp only
 * then, and reports the image header before decoding any pixels. The parent checks the header
 * against the limits and reserves the decoded pixels from a shared budget before letting it encode.
 * A wall-time timer covers the worker's whole life.
 *
 * The parent also does what libvips cannot: removes GPS without dropping other EXIF, and copies PNG
 * text chunks and JPEG comments into the output. Its checks on the output (same format, dimensions,
 * alpha, orientation and ICC profile; no GPS when removal was asked for) are an early exit; the host
 * validates the output again before publishing it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_METADATA_POLICY,
  ImageProcessorError,
  PROCESSOR_FORMATS,
  type ImageInfo,
  type ImageProcessor,
  type ProcessorCapabilities,
  type ProcessorFormat,
  type ProcessRequest,
  type ProcessResult,
  type ProcessSkipReason,
  type SkippedImage,
} from './contract.ts';
import {
  carryMetadata,
  containerHasGps,
  inspectContainer,
  removeExifGps,
  removeXmpGps,
  xmpHasGps,
  type ContainerInfo,
} from './container.ts';
import { createPixelAdmission, encoderLimits, resolveProcessorLimits, type ProcessorLimits } from './limits.ts';
import {
  encoderOptions,
  encoderTarget,
  isPresetName,
  PRESET_NAMES,
  PRESETS_REVISION,
  type PresetName,
} from './presets.ts';
import { WORKER_SOURCE } from './worker-source.ts';

export const LOCAL_PROCESSOR_ID = 'local-sharp';
/** Bump when the processing pipeline changes in a way that can change output bytes. */
const PIPELINE_REVISION = 1;

/** PNG gamma of 1/2.2, which browsers treat as sRGB. */
const PNG_SRGB_GAMMA = 45455;

/** Test hook: make the worker hang, crash, exit or send a malformed header at a stage. */
export interface WorkerFault {
  kind: 'hang' | 'crash' | 'exit' | 'garbage';
  stage: 'start' | 'encode' | 'result';
}

export interface LocalProcessorOptions {
  limits?: Partial<ProcessorLimits>;
  /** libvips threads per worker. One keeps a worker to one core; raise it for faster single images. */
  threads?: number;
  /** Absolute path of the Sharp entry point; defaults to resolving `sharp` from this package. */
  sharpPath?: string;
  /** Called with each worker's pid, for tests and diagnostics. */
  onSpawn?: (pid: number | undefined) => void;
  /** For tests only: inject a fault into every worker. */
  fault?: WorkerFault;
}

/** What the worker reports from Sharp's header read; the parent validates every field. */
interface WorkerHeader {
  format: string;
  width: number;
  height: number;
  pages: number;
  space: string;
  channels: number;
  depth: string;
  hasAlpha: boolean;
  orientation: number | null;
  icc: { bytes: number; sha256: string; space: string; version: number } | null;
  hasExif: boolean;
  hasXmp: boolean;
  hasIptc: boolean;
}

type WorkerMessage =
  | { type: 'header'; header: WorkerHeader }
  | {
      type: 'result';
      output: Uint8Array;
      header: WorkerHeader;
      versions: { sharp: string; vips: string };
      maxRssBytes: number;
    }
  | { type: 'decode-error' | 'encode-error' | 'unavailable'; message: string };

function resolveSharp(explicit: string | undefined): string | null {
  if (explicit) return explicit;
  try {
    return createRequire(import.meta.url).resolve('sharp');
  } catch {
    return null;
  }
}

/** Sharp's version from its package.json, without loading the native module into this process. */
function readSharpVersion(entry: string): string | null {
  for (let directory = dirname(entry), depth = 0; depth < 4; directory = dirname(directory), depth++) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (typeof manifest === 'object' && manifest !== null && Reflect.get(manifest, 'name') === 'sharp') {
        const version: unknown = Reflect.get(manifest, 'version');
        return typeof version === 'string' ? version : null;
      }
    } catch {
      // keep looking upwards
    }
  }
  return null;
}

function isHeader(value: unknown): value is WorkerHeader {
  if (typeof value !== 'object' || value === null) return false;
  const header = value as Record<string, unknown>;
  const positive = (key: string) => Number.isSafeInteger(header[key]) && (header[key] as number) > 0;
  return (
    typeof header.format === 'string' &&
    positive('width') &&
    positive('height') &&
    positive('pages') &&
    positive('channels') &&
    typeof header.space === 'string' &&
    typeof header.depth === 'string' &&
    typeof header.hasAlpha === 'boolean' &&
    (header.orientation === null || Number.isSafeInteger(header.orientation)) &&
    (header.icc === null || isIcc(header.icc))
  );
}

function isIcc(value: unknown): value is WorkerHeader['icc'] {
  if (typeof value !== 'object' || value === null) return false;
  const icc = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(icc.bytes) &&
    typeof icc.sha256 === 'string' &&
    typeof icc.space === 'string' &&
    Number.isSafeInteger(icc.version)
  );
}

/** Errors from the encode step that come from reading the input rather than writing the output. */
const DECODE_FAILURE = /premature end|truncat|corrupt|read error|unable to (?:parse|read)|invalid/i;

function skip(reason: ProcessSkipReason, detail?: string, input?: Partial<ImageInfo>): SkippedImage {
  return { status: 'skipped', reason, ...(detail ? { detail } : {}), ...(input ? { input } : {}) };
}

/** A header the processor can re-encode without changing colours, or the reason it cannot. */
function headerSkip(header: WorkerHeader, container: ContainerInfo, limits: ProcessorLimits): SkippedImage | null {
  if (header.format !== container.format) return skip('malformed', `content decodes as ${header.format}`);
  if (header.pages > 1 || container.animated) return skip('animated');
  const { maxPixels } = encoderLimits(limits, encoderTarget(header.format as ProcessorFormat, container.lossless));
  if (header.width * header.height > maxPixels) return skip('over-pixel-limit');
  if (header.depth !== 'uchar') return skip('unhandled-bit-depth', header.depth);
  const rgb = header.space === 'srgb' && (header.channels === 3 || header.channels === 4);
  const grey = header.space === 'b-w' && (header.channels === 1 || header.channels === 2);
  if (!rgb && !grey) return skip('unhandled-colour-profile', `${header.space}, ${header.channels} channels`);
  if (header.icc) {
    if (header.icc.space !== (rgb ? 'RGB ' : 'GRAY') || header.icc.version > 4) {
      return skip('unhandled-colour-profile', `ICC profile '${header.icc.space.trim()}' v${header.icc.version}`);
    }
  }
  const png = container.png;
  if (png && !png.iccp && !png.srgb) {
    // libvips drops gAMA and cHRM, which change how browsers show a PNG without a profile.
    if (png.chrm || (png.gamma !== null && Math.abs(png.gamma - PNG_SRGB_GAMMA) > 100)) {
      return skip('unhandled-colour-profile', 'PNG gAMA or cHRM without a profile');
    }
  }
  return null;
}

function imageInfo(header: WorkerHeader, bytes: Uint8Array, container: ContainerInfo): ImageInfo {
  return {
    format: header.format as ProcessorFormat,
    bytes: bytes.length,
    width: header.width,
    height: header.height,
    channels: header.channels,
    hasAlpha: header.hasAlpha,
    orientation: header.orientation,
    iccProfile: header.icc ? { bytes: header.icc.bytes, sha256: header.icc.sha256 } : null,
    hasExif: header.hasExif,
    hasXmp: header.hasXmp,
    hasIptc: header.hasIptc,
    hasGps: containerHasGps(bytes, container) !== false,
    ...(header.format === 'webp' ? { lossless: container.lossless } : {}),
  };
}

/**
 * The processor's own check of an output against its input: the error to fail with, or `null`.
 * An early exit only; the host validates outputs again before publishing them.
 */
export function checkOutput(input: ImageInfo, output: ImageInfo, removeGps: boolean): ImageProcessorError | null {
  const mismatch = outputMismatch(input, output);
  if (mismatch) return new ImageProcessorError('invalid-output', `The output changed the image's ${mismatch}`);
  if (removeGps && output.hasGps) {
    return new ImageProcessorError('metadata-policy-failed', 'GPS could not be ruled out in the output');
  }
  return null;
}

/** The first property of the output that differs from the input, or `null`. */
function outputMismatch(input: ImageInfo, output: ImageInfo): string | null {
  if (output.format !== input.format) return `format ${output.format}`;
  if (output.width !== input.width || output.height !== input.height)
    return `dimensions ${output.width}x${output.height}`;
  if (output.channels !== input.channels) return `${output.channels} channels`;
  if (output.hasAlpha !== input.hasAlpha) return 'alpha';
  // libvips writes orientation 1 (as stored) when the input had none; that is the same orientation.
  if ((output.orientation ?? 1) !== (input.orientation ?? 1)) return `orientation ${output.orientation}`;
  if (output.iccProfile?.sha256 !== input.iccProfile?.sha256) return 'ICC profile';
  return null;
}

interface Prepared {
  /** The request's bytes, unchanged. */
  source: Uint8Array;
  /** What the worker reads: the source, or a copy with EXIF GPS removed. */
  bytes: Uint8Array;
  container: ContainerInfo;
  /** Replacement XMP with GPS removed, or `null` to keep the input's. */
  xmp: string | null;
}

/** Applies the metadata policy to the input; a skip if it cannot be applied. */
function prepare(bytes: Uint8Array, container: ContainerInfo, removeGps: boolean): Prepared | SkippedImage {
  if (!removeGps) return { source: bytes, bytes, container, xmp: null };
  if (container.carried.some((segment) => segment.keyword?.startsWith('Raw profile type'))) {
    return skip('unhandled-metadata', 'PNG raw profile text chunk');
  }
  const exif = removeExifGps(bytes, container);
  if (exif.status === 'unreadable') return skip('unhandled-metadata', 'EXIF structure');
  let xmp: string | null = null;
  for (const [index, packet] of container.xmp.entries()) {
    if (packet === null) return skip('unhandled-metadata', 'XMP packet');
    if (!xmpHasGps(packet)) continue;
    // Only the main packet can be replaced (Sharp's `withXmp`); GPS in JPEG extended XMP is a skip.
    const cleaned = index === 0 ? removeXmpGps(packet) : null;
    if (cleaned === null) return skip('unhandled-metadata', 'XMP GPS');
    xmp = cleaned;
  }
  return { source: bytes, bytes: exif.bytes, container, xmp };
}

interface WorkerRun {
  header: WorkerHeader;
  message: WorkerMessage;
}

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Turns the worker's last message into a result, checking the output against the input. */
function workerResult(
  run: WorkerRun,
  prepared: Prepared,
  request: { preset: PresetName; removeGps: boolean },
  elapsedMs: number,
): ProcessResult {
  const { header, message } = run;
  const { source } = prepared;
  switch (message.type) {
    case 'unavailable':
      throw new ImageProcessorError('unavailable', `Sharp could not be loaded: ${truncate(message.message)}`);
    case 'decode-error':
      return skip('malformed', truncate(message.message), { format: prepared.container.format! });
    case 'encode-error':
      if (DECODE_FAILURE.test(message.message)) {
        return skip('malformed', truncate(message.message), imageInfo(header, source, prepared.container));
      }
      throw new ImageProcessorError('encode-failed', `The encoder failed: ${truncate(message.message)}`);
    case 'header':
      throw new ImageProcessorError('crashed', 'The image worker sent a second header');
  }
  if (!(message.output instanceof Uint8Array) || !isHeader(message.header)) {
    throw new ImageProcessorError('crashed', 'The image worker returned an invalid result');
  }
  const input = imageInfo(header, source, prepared.container);
  const output = carryMetadata(message.output, prepared.container);
  if (!output) throw new ImageProcessorError('invalid-output', 'The output container could not be read');
  const result = imageInfo(message.header, output, inspectContainer(output));
  const problem = checkOutput(input, result, request.removeGps);
  if (problem) throw problem;
  return {
    status: 'processed',
    output,
    input,
    result,
    encoder: {
      preset: request.preset,
      options: encoderOptions(request.preset, input.format, prepared.container.lossless),
      sharp: String(message.versions?.sharp),
      vips: String(message.versions?.vips),
    },
    elapsedMs,
    workerMaxRssBytes: Number(message.maxRssBytes) || 0,
  };
}

export function createLocalProcessor(options: LocalProcessorOptions = {}): ImageProcessor {
  const limits = resolveProcessorLimits(options.limits);
  const threads = options.threads ?? 1;
  if (!Number.isSafeInteger(threads) || threads < 1) throw new RangeError('threads must be a positive integer');
  const admission = createPixelAdmission(limits.maxInFlightPixels);
  let workers = 0;
  let sharpPath: string | null | undefined;
  let sharpVersion: string | null = null;

  const sharp = () => {
    if (sharpPath === undefined) {
      sharpPath = resolveSharp(options.sharpPath);
      sharpVersion = sharpPath ? readSharpVersion(sharpPath) : null;
    }
    return sharpPath;
  };

  function capabilities(): ProcessorCapabilities {
    sharp();
    return {
      processor: LOCAL_PROCESSOR_ID,
      version: `${PIPELINE_REVISION}.${PRESETS_REVISION}+sharp-${sharpVersion ?? 'unavailable'}`,
      formats: PROCESSOR_FORMATS,
      presets: PRESET_NAMES,
      sameFormat: true,
      sameDimensions: true,
      metadata: { keptByDefault: true, canRemoveGps: true },
      limits: Object.freeze({ ...limits }),
    };
  }

  async function processImage(request: ProcessRequest): Promise<ProcessResult> {
    const started = performance.now();
    const { bytes, preset, signal } = request;
    if (!isPresetName(preset)) throw new RangeError(`Unknown preset: ${String(preset)}`);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
    const removeGps = (request.metadata ?? DEFAULT_METADATA_POLICY).removeGps === true;
    if (signal?.aborted) throw new ImageProcessorError('aborted', 'Processing was aborted');

    if (bytes.length > limits.maxInputBytes) return skip('over-byte-limit', undefined, { bytes: bytes.length });
    const container = inspectContainer(bytes);
    if (container.format === null) return skip('unsupported-format');
    if (!container.valid) return skip('malformed', 'container structure', { format: container.format });
    if (container.animated) return skip('animated', undefined, { format: container.format });
    const prepared = prepare(bytes, container, removeGps);
    if ('status' in prepared) return prepared;

    const entry = sharp();
    if (!entry) throw new ImageProcessorError('unavailable', 'Sharp is not installed');
    if (workers >= limits.maxWorkers) throw new ImageProcessorError('busy', 'All image workers are in use');

    const run = await runWorker(entry, prepared, { preset, removeGps }, signal);
    if ('status' in run) return run;
    return workerResult(run, prepared, { preset, removeGps }, Math.round(performance.now() - started));
  }

  function runWorker(
    entry: string,
    prepared: Prepared,
    request: { preset: PresetName; removeGps: boolean },
    signal: AbortSignal | undefined,
  ): Promise<WorkerRun | SkippedImage> {
    workers += 1;
    return new Promise<WorkerRun | SkippedImage>((resolve, reject) => {
      const config = JSON.stringify({ sharpUrl: pathToFileURL(entry).href, threads, fault: options.fault });
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, ['--input-type=module', '--eval', WORKER_SOURCE, config], {
          cwd: tmpdir(),
          env: {},
          serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
      } catch (error) {
        workers -= 1;
        reject(new ImageProcessorError('unavailable', 'The image worker could not start', { cause: error }));
        return;
      }
      options.onSpawn?.(child.pid);
      // The end of the worker's stderr, to explain a crash; it never contains image data.
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });

      // The first outcome decided wins. The promise settles only once the worker has exited, so the
      // caller gets the worker slot and the pixel budget back together with the answer.
      let outcome: { value: WorkerRun | SkippedImage } | { error: ImageProcessorError } | null = null;
      let header: WorkerHeader | null = null;
      let release: (() => void) | null = null;
      let finished = false;
      const finish = (exit: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        workers -= 1;
        release?.();
        if (outcome && 'value' in outcome) resolve(outcome.value);
        else if (outcome) reject(outcome.error);
        else {
          const detail = stderr.trim() ? `: ${truncate(stderr.trim().split('\n').at(-1)!)}` : '';
          reject(new ImageProcessorError('crashed', `The image worker stopped without a result (${exit})${detail}`));
        }
      };
      const decide = (next: { value: WorkerRun | SkippedImage } | { error: ImageProcessorError }) => {
        outcome ??= next;
      };
      const kill = (error: ImageProcessorError) => {
        decide({ error });
        child.kill('SIGKILL');
      };
      const timer = setTimeout(
        () => kill(new ImageProcessorError('timeout', 'Image processing exceeded its time limit')),
        limits.wallTimeMs,
      );
      const onAbort = () => kill(new ImageProcessorError('aborted', 'Processing was aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });

      const onMessage = (raw: unknown) => {
        if (outcome) return;
        const message = raw as WorkerMessage;
        if (header === null && message?.type === 'header') {
          if (!isHeader(message.header)) {
            kill(new ImageProcessorError('crashed', 'The image worker returned an invalid header'));
            return;
          }
          const current = message.header;
          header = current;
          const skipped = headerSkip(current, prepared.container, limits);
          if (skipped) {
            decide({ value: { ...skipped, input: imageInfo(current, prepared.source, prepared.container) } });
            child.kill('SIGKILL');
            return;
          }
          const { weight } = encoderLimits(limits, encoderTarget(current.format as ProcessorFormat, prepared.container.lossless));
          release = admission.tryAcquire(current.width * current.height * weight);
          if (!release) {
            kill(new ImageProcessorError('busy', 'The decoded-pixel budget is in use'));
            return;
          }
          child.send({
            type: 'encode',
            encoder: encoderOptions(request.preset, current.format as ProcessorFormat, prepared.container.lossless),
            xmp: request.removeGps ? prepared.xmp : null,
            greyscale: current.space === 'b-w',
          });
          return;
        }
        if (header === null && message?.type !== 'decode-error' && message?.type !== 'unavailable') {
          kill(new ImageProcessorError('crashed', 'The image worker sent a result before a header'));
          return;
        }
        // The worker exits by itself after its last message.
        decide({ value: { header: header ?? ({} as WorkerHeader), message } });
      };
      child.on('message', (raw: unknown) => {
        try {
          onMessage(raw);
        } catch (error) {
          // Nothing the worker sends may throw in the parent.
          kill(new ImageProcessorError('crashed', 'The image worker sent an unreadable message', { cause: error }));
        }
      });
      child.on('error', (error) => {
        kill(new ImageProcessorError('unavailable', 'The image worker could not start', { cause: error }));
        if (child.pid === undefined) finish('not started');
      });
      // 'close' follows the worker's exit and its last IPC message.
      child.on('close', (code, exitSignal) => finish(exitSignal ?? `exit code ${code}`));
      child.send({ type: 'input', bytes: prepared.bytes, maxPixels: limits.maxPixels }, (error) => {
        if (error) child.kill('SIGKILL');
      });
    });
  }

  return { capabilities, process: processImage };
}
