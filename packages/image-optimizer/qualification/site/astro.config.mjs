// The disposable EmDash site of the image optimizer's site qualification. `qualify-site.mjs` copies
// this directory and writes `qualify.json` beside it before each build: which edition of the plugin
// is registered (native, sandbox-format in process, or none), the data directories and the origin.
import { readFileSync } from 'node:fs';

import node from '@astrojs/node';
import react from '@astrojs/react';
import { defineConfig, sessionDrivers } from 'astro/config';
import emdash, { local } from 'emdash/astro';
import { sqlite } from 'emdash/db';

const site = JSON.parse(readFileSync(new URL('./qualify.json', import.meta.url), 'utf8'));

async function plugins() {
  if (site.edition === 'native') {
    const { imageOptimizerPlugin } = await import('image-optimizer');
    return [imageOptimizerPlugin({ qualifiedProfiles: site.qualifiedProfiles, stagingDirectory: site.stagingDirectory })];
  }
  if (site.edition === 'sandbox') {
    // The registry edition's descriptor (sandboxed format), registered in process.
    const { default: descriptor } = await import('image-optimizer/descriptor');
    return [descriptor];
  }
  return [];
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  site: site.origin,
  // Sessions are site state: kept with the data, not in `node_modules/.astro` beside the code.
  ...(site.sessionsDirectory ? { session: { driver: sessionDrivers.fsLite({ base: site.sessionsDirectory }) } } : {}),
  integrations: [
    react(),
    emdash({
      siteUrl: site.origin,
      database: sqlite({ url: `file:${site.databasePath}` }),
      storage: local({ directory: site.uploadsDirectory, baseUrl: '/_emdash/api/media/file' }),
      safeMedia: { privateDirectory: site.privateDirectory },
      plugins: await plugins(),
    }),
  ],
  devToolbar: { enabled: false },
  telemetry: false,
});
