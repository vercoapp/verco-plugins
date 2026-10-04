import { isolatedPluginTest } from './vitest.plugin.ts';
import { defineConfig } from 'vitest/config';

// tests/host-rejection.test.ts is excluded: it makes workerd cancel unrelated in-flight requests
// (see the comment in that file), so `pnpm test` runs it on its own with vitest.host-rejection.config.ts.
export default defineConfig({
  plugins: [isolatedPluginTest()],
  test: { exclude: ['tests/host-rejection.test.ts', '**/node_modules/**'] },
});
