import { defineConfig } from 'vite';

// The native entry as one ES module next to the sandbox bundle. EmDash is the host's, so it stays
// external; the report's own modules are bundled in, as in the sandbox bundle.
export default defineConfig({
  build: {
    lib: { entry: 'src/native.ts', formats: ['es'], fileName: () => 'native.mjs' },
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    rollupOptions: { external: [/^emdash(\/|$)/] },
  },
});
