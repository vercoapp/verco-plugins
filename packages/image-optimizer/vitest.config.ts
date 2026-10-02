import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vitest/config';

import { isolatedPluginTest } from './vitest.plugin.ts';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * The patched EmDash checkout (`pnpm host:pilot`), read only. `EMDASH_PILOT_DIR` overrides the
 * default, for a git worktree without its own `.upstream/`. Without it the pilot tests are skipped.
 */
const pilot = resolve(process.env.EMDASH_PILOT_DIR ?? resolve(root, '../../.upstream/emdash-pilot'));
const pilotCore = resolve(pilot, 'packages/core');
const hasPilot = existsSync(resolve(pilotCore, 'src/emdash-runtime.ts'));

/** Stubs for the virtual modules EmDash's Astro integration normally provides, as the pilot's own tests do. */
const virtualStubs: Record<string, string> = {
  'virtual:emdash/wait-until': 'export const waitUntil = undefined;',
  'virtual:emdash/scheduler': 'export const createScheduler = null;',
  'virtual:emdash/config': 'export default {};',
  'virtual:emdash/env': 'export const env = undefined;',
  'virtual:emdash/build': 'export const buildTime = 0;',
};

const emdashVirtualStubs: Plugin = {
  name: 'emdash-virtual-stubs',
  resolveId: (id) => (Object.hasOwn(virtualStubs, id) ? `\0${id}` : null),
  load: (id) => (id.startsWith('\0virtual:emdash/') ? virtualStubs[id.slice(1)] : null),
};

// tests/host-rejection.test.ts is excluded: it makes workerd cancel unrelated in-flight requests
// (see the comment in that file), so `pnpm test` runs it on its own with vitest.host-rejection.config.ts.
export default defineConfig({
  test: {
    projects: [
      {
        // The sandboxed plugin, built and run inside workerd.
        plugins: [isolatedPluginTest()],
        test: { name: 'sandbox', include: ['tests/*.test.ts'], exclude: ['tests/host-rejection.test.ts', '**/node_modules/**'] },
      },
      {
        // Native-only modules (the local processor), which need Node and Sharp.
        test: { name: 'native', include: ['tests/native/**/*.test.ts'], environment: 'node', testTimeout: 30_000 },
      },
      {
        // The native edition in the patched host's runtime: `emdash` is the pilot's `definePlugin`,
        // so the plugin receives the host's safe-media access.
        plugins: [emdashVirtualStubs],
        resolve: hasPilot ? { alias: [{ find: /^emdash$/, replacement: resolve(pilotCore, 'src/plugins/define-plugin.ts') }] } : {},
        test: {
          name: 'pilot',
          include: ['tests/pilot/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          env: { EMDASH_PILOT_CORE: hasPilot ? pilotCore : '' },
        },
      },
    ],
  },
});
