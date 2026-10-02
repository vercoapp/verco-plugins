// Export the pilot worktree's changes as one reviewable patch and record its digest and resulting
// tree in host/emdash/patches/patches.json. Patches are cumulative in order: patch N is the
// difference between patch N-1's resulting tree and the worktree, so patch 1 is against the pinned commit.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, patchDirectory, pilot, target } from './lib/pilot.mjs';

const [name, ...tasks] = process.argv.slice(2);
if (!name?.endsWith('.patch') || !/^\d{4}-[a-z0-9-]+\.patch$/.test(name)) {
  throw new Error('Usage: node scripts/export-host-patch.mjs 0001-short-name.patch [task ...]');
}
if (git(['rev-parse', 'HEAD'], pilot).trim() !== target.commit) throw new Error('The pilot worktree is not at the pinned commit.');

const manifestPath = join(patchDirectory, 'patches.json');
let manifest = { baseCommit: target.commit, patches: [] };
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* first export */ }
const previous = manifest.patches.filter((entry) => entry.name < name).at(-1);
const baseTree = previous ? previous.resultingTree : 'HEAD';
if (previous) git(['cat-file', '-e', `${baseTree}^{tree}`], pilot); // present once host:pilot has applied the earlier patches

// A private index so the worktree's own staging area is untouched; ignored files stay excluded.
const scratch = mkdtempSync(join(tmpdir(), 'verco-patch-'));
const env = { GIT_INDEX_FILE: join(scratch, 'index') };
try {
  git(['read-tree', 'HEAD'], pilot, env);
  git(['add', '-A'], pilot, env);
  const patch = git(['diff', '--cached', '--binary', '--full-index', baseTree], pilot, env);
  if (!patch) throw new Error('The pilot worktree has no changes beyond the previous patch.');
  const tree = git(['write-tree'], pilot, env).trim();
  writeFileSync(join(patchDirectory, name), patch);
  manifest.baseCommit = target.commit;
  const existing = manifest.patches.find((entry) => entry.name === name) ?? {};
  manifest.patches = [...manifest.patches.filter((entry) => entry.name !== name), {
    name, tasks, ...(existing.relatedTests && { relatedTests: existing.relatedTests }), ...(existing.scope && { scope: existing.scope }), ...(existing.limits && { limits: existing.limits }), sha256: createHash('sha256').update(patch).digest('hex'), resultingTree: tree,
    files: git(['diff', '--cached', '--name-status', baseTree], pilot, env).trim().split('\n'),
  }].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${name} (${patch.length} bytes), resulting tree ${tree}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
