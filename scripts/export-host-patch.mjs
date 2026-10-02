// Export the pilot worktree's changes as one reviewable patch against the pinned commit and record
// its digest and resulting tree in host/emdash/patches/patches.json.
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

// A private index so the worktree's own staging area is untouched; ignored files stay excluded.
const scratch = mkdtempSync(join(tmpdir(), 'verco-patch-'));
const env = { GIT_INDEX_FILE: join(scratch, 'index') };
try {
  git(['read-tree', 'HEAD'], pilot, env);
  git(['add', '-A'], pilot, env);
  const patch = git(['diff', '--cached', '--binary', '--full-index', 'HEAD'], pilot, env);
  if (!patch) throw new Error('The pilot worktree has no changes to export.');
  const tree = git(['write-tree'], pilot, env).trim();
  writeFileSync(join(patchDirectory, name), patch);
  const manifestPath = join(patchDirectory, 'patches.json');
  let manifest = { baseCommit: target.commit, patches: [] };
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* first export */ }
  manifest.baseCommit = target.commit;
  const previous = manifest.patches.find((entry) => entry.name === name) ?? {};
  manifest.patches = [...manifest.patches.filter((entry) => entry.name !== name), {
    name, tasks, ...(previous.relatedTests && { relatedTests: previous.relatedTests }), ...(previous.scope && { scope: previous.scope }), ...(previous.limits && { limits: previous.limits }), sha256: createHash('sha256').update(patch).digest('hex'), resultingTree: tree,
    files: git(['diff', '--cached', '--name-status', 'HEAD'], pilot, env).trim().split('\n'),
  }].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${name} (${patch.length} bytes), resulting tree ${tree}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
