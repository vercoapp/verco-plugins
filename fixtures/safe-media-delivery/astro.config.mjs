import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { fileURLToPath } from 'node:url';

const core = fileURLToPath(new URL('../../.upstream/emdash/packages/core/src/', import.meta.url));

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [{
    name: 'verco-pinned-media-delivery-fixture',
    hooks: {
      'astro:config:setup': ({ injectRoute }) => {
        injectRoute({
          pattern: '/_emdash/api/media/file/[...key]',
          entrypoint: `${core}astro/routes/api/media/file/[...key].ts`,
          prerender: false,
        });
      },
    },
  }],
  image: {
    endpoint: { entrypoint: `${core}astro/image-endpoint.ts` },
    remotePatterns: [{ protocol: 'http', hostname: '127.0.0.1' }],
  },
  vite: {
    resolve: {
      alias: {
        'emdash-source': core,
        '#api': `${core}api`,
        '#media': `${core}media`,
      },
    },
    server: { fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] } },
  },
});
