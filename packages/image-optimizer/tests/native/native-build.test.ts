import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('the native bundle', () => {
  it('keeps Node built-ins as imports instead of browser stubs', async () => {
    const output = (await build({
      root,
      configFile: resolve(root, 'vite.native.config.ts'),
      logLevel: 'silent',
      build: { write: false },
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
    const [bundle] = Array.isArray(output) ? output : [output];
    const chunk = bundle!.output.find((file) => file.type === 'chunk' && file.fileName === 'native.mjs');
    const code = chunk && 'code' in chunk ? chunk.code : '';

    expect(code).not.toContain('browser-external');
    for (const module of ['node:child_process', 'node:module', 'node:zlib', 'emdash']) {
      expect(code).toMatch(new RegExp(`from ['"]${module}['"]`));
    }
    expect(code).not.toMatch(/from ['"]sharp['"]/);
  });
});
