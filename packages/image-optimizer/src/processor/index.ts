/**
 * Local image processing for the native edition (Node only). The sandboxed entry must not import
 * this module: `local.ts` starts child processes and `container.ts` uses `node:zlib`. Types,
 * presets and limits can be imported from their own modules anywhere.
 */
export * from './contract.ts';
export * from './limits.ts';
export * from './presets.ts';
export { checkOutput, createLocalProcessor, LOCAL_PROCESSOR_ID } from './local.ts';
export type { LocalProcessorOptions, WorkerFault } from './local.ts';
