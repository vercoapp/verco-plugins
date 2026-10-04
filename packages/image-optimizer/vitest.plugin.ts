import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { buildPlugin } from '@emdash-cms/plugin-cli';

/**
 * The same setup as `emdashPluginTest()` from `@emdash-cms/plugin-test/config`, except that every
 * build writes to its own temporary directory.
 *
 * That function builds the plugin once per test file, and every build writes `dist/manifest.json`
 * and `dist/plugin.mjs` in the package. Builds from other test files, and from other Vitest runs
 * started at the same time, overwrite those files while this one reads them. A reader that lands
 * between the truncate and the write gets an empty manifest, and the first host created in that
 * file fails with "Unexpected end of JSON input". Keep the rest of this in step with the upstream
 * function when `@emdash-cms/plugin-test` is upgraded.
 */
const virtualModules: Record<string, string> = {
  'virtual:emdash/wait-until': 'export const waitUntil = undefined;',
  'virtual:emdash/scheduler': 'export const createScheduler = null;',
  'virtual:emdash/config': 'export default {};',
  'virtual:emdash/env': 'export const env = undefined;',
  'virtual:emdash/build': 'export const buildTime = 0;',
  'virtual:emdash/object-cache': 'export const createObjectCacheBackend = null;',
};

export function isolatedPluginTest() {
  const pluginDir = resolve(process.cwd());
  const workerEntry = fileURLToPath(import.meta.resolve('@emdash-cms/plugin-test/worker'));
  return [
    {
      name: 'emdash-plugin-test-runtime-virtual-modules',
      resolveId(id: string) {
        return Object.hasOwn(virtualModules, id) ? `\0${id}` : null;
      },
      load(id: string) {
        return id.startsWith('\0virtual:emdash/') ? (virtualModules[id.slice(1)] ?? null) : null;
      },
    },
    cloudflareTest(async () => {
      const outDir = await mkdtemp(join(tmpdir(), 'image-optimizer-test-'));
      try {
        const build = await buildPlugin({ dir: pluginDir, outDir });
        const [code, manifest] = await Promise.all([
          readFile(build.files.runtime, 'utf8'),
          readFile(build.files.manifestJson, 'utf8'),
        ]);
        return {
          main: workerEntry,
          remoteBindings: false,
          additionalExports: { PluginBridge: 'WorkerEntrypoint' as const },
          miniflare: {
            compatibilityDate: '2026-08-20',
            compatibilityFlags: ['nodejs_compat'],
            d1Databases: ['DB'],
            r2Buckets: ['MEDIA'],
            workerLoaders: { LOADER: {} },
            bindings: { EMDASH_PLUGIN_CODE: code, EMDASH_PLUGIN_MANIFEST: manifest },
          },
        };
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    }),
  ];
}
