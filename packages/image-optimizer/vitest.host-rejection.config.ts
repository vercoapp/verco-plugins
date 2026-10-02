import { isolatedPluginTest } from './vitest.plugin.ts';
import { defineConfig } from 'vitest/config';

// Its own Vitest process, so its own workerd, run after the main suite. See tests/host-rejection.test.ts.
export default defineConfig({
  plugins: [isolatedPluginTest()],
  test: { include: ['tests/host-rejection.test.ts'] },
});
