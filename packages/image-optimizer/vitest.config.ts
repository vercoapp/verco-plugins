import { emdashPluginTest } from '@emdash-cms/plugin-test/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // The sandboxed plugin, built and run inside workerd.
        plugins: [emdashPluginTest()],
        test: { name: 'sandbox', include: ['tests/*.test.ts'] },
      },
      {
        // Native-only modules (the local processor), which need Node and Sharp.
        test: { name: 'native', include: ['tests/native/**/*.test.ts'], environment: 'node', testTimeout: 30_000 },
      },
    ],
  },
});
