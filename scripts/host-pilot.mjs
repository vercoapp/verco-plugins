// Create the disposable patched EmDash worktree (.upstream/emdash-pilot) from the pinned commit and
// the patches in host/emdash/patches, or verify that the patches apply to a pristine tree with --check.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkout, git, patchDirectory, pilot, requirePinnedCheckout, root, target } from './lib/pilot.mjs';

requirePinnedCheckout();
const patches = readdirSync(patchDirectory).filter((name) => name.endsWith('.patch')).sort();
const check = process.argv.includes('--check');
if (check) mkdirSync(join(root, '.qualification-runs'), { recursive: true });
const directory = check ? mkdtempSync(join(root, '.qualification-runs', 'patch-check-')) : pilot;

if (!check && existsSync(pilot)) {
  throw new Error(`${pilot} already exists. Export your work with pnpm host:patch-export, then remove it with git -C .upstream/emdash worktree remove --force ../emdash-pilot.`);
}
try {
  git(['worktree', 'add', '--detach', directory, target.commit], checkout);
  const manifest = JSON.parse(readFileSync(join(patchDirectory, 'patches.json'), 'utf8'));
  for (const name of patches) {
    git(['apply', '--index', '--whitespace=nowarn', join(patchDirectory, name)], directory);
    // The tree is a content hash: it proves the result is exactly what was exported.
    const expected = manifest.patches.find((entry) => entry.name === name)?.resultingTree;
    const actual = git(['write-tree'], directory).trim();
    if (actual !== expected) throw new Error(`${name} produced tree ${actual}; patches.json records ${expected}.`);
  }
  console.log(`${check ? 'Patches apply cleanly' : 'Created'} at ${target.commit.slice(0, 12)}: ${patches.join(', ') || 'no patches'}`);
  if (!check) console.log(`Install with: cd ${resolve(pilot)} && pnpm install --frozen-lockfile --ignore-scripts`);
} finally {
  if (check) {
    git(['worktree', 'remove', '--force', directory], checkout);
    rmSync(directory, { recursive: true, force: true });
  }
}
