import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const IMPORT = /^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'|^\s*import\s+'([^']+)'/gm;

/** Every module `entry` reaches through static imports, as relative paths or bare specifiers. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2]!;
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
      else seen.add(specifier);
    }
  };
  visit(resolve(src, entry));
  return seen;
}

describe('the sandboxed entry', () => {
  it('does not reach Sharp, Node built-ins, the native processor or the measured scan', () => {
    const modules = [...reachable('plugin.ts')].map((module) => module.replace(`${src}/`, ''));
    expect(modules).toContain('plugin.ts');
    expect(modules).toContain('handlers.ts');
    expect(
      modules.filter((module) =>
        /sharp|^node:|processor\/(local|container|worker-source|index)|^measure\.ts$|^native\.ts$/.test(module),
      ),
    ).toEqual([]);
  });

  it('reaches the measured scan only through the native entry', () => {
    const native = [...reachable('native.ts')].map((module) => module.replace(`${src}/`, ''));
    expect(native).toEqual(expect.arrayContaining(['measure.ts', 'processor/index.ts', 'processor/local.ts']));
  });

  it('may use the processor types, presets and limits, which import nothing at runtime', () => {
    for (const module of ['processor/contract.ts', 'processor/presets.ts', 'processor/limits.ts']) {
      const imports = [...reachable(module)].filter((name) => !name.startsWith(src));
      expect(imports, module).toEqual([]);
    }
  });
});
