// Run the tests the host patches add (plus the existing tests for behavior they touch) in the pilot
// worktree, after proving the worktree is exactly the named patch applied on its predecessors.
// Evidence is written only on a clean pass. Defaults to the last patch.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, patchDirectory, pilot, root, target } from './lib/pilot.mjs';

const manifest = JSON.parse(readFileSync(join(patchDirectory, 'patches.json'), 'utf8'));
const name = process.argv[2] ?? manifest.patches.at(-1)?.name;
const entry = manifest.patches.find((patch) => patch.name === name);
if (!entry) throw new Error(`Usage: node scripts/qualify-host-patch.mjs [patch name]; known: ${manifest.patches.map((patch) => patch.name).join(', ')}`);
if (entry !== manifest.patches.at(-1)) throw new Error('The pilot worktree can only be qualified at the last patch; earlier results stay in their evidence files.');
const included = manifest.patches.filter((patch) => patch.name <= name);
for (const patch of included) {
  if (createHash('sha256').update(readFileSync(join(patchDirectory, patch.name))).digest('hex') !== patch.sha256) throw new Error(`${patch.name} does not match patches.json; re-export it.`);
}

if (git(['rev-parse', 'HEAD'], pilot).trim() !== target.commit) throw new Error('The pilot worktree is not at the pinned commit.');

const scratch = mkdtempSync(join(tmpdir(), 'verco-qualify-'));
const index = { GIT_INDEX_FILE: join(scratch, 'index') };
git(['read-tree', 'HEAD'], pilot, index);
git(['add', '-A'], pilot, index);
const tree = git(['write-tree'], pilot, index).trim();
rmSync(scratch, { recursive: true, force: true });
if (tree !== entry.resultingTree) throw new Error(`The pilot worktree (${tree}) is not the exported patch (${entry.resultingTree}). Export or reset it first.`);

const own = included.flatMap((patch) => patch.files.filter((line) => line.startsWith('A\t') && line.endsWith('.test.ts')).map((line) => line.slice(2)));
const related = included.flatMap((patch) => patch.relatedTests ?? []);
const files = [...new Set([...own, ...related])].map((path) => path.replace(/^packages\/core\//, ''));
const output = join(mkdtempSync(join(tmpdir(), 'verco-vitest-')), 'result.json');
try {
  execFileSync('npx', ['vitest', 'run', ...files, '--reporter=json', `--outputFile=${output}`], { cwd: join(pilot, 'packages/core'), stdio: 'inherit', timeout: 600000 });
} catch {
  // vitest exits non-zero on failures; the JSON below decides.
}
const result = JSON.parse(readFileSync(output, 'utf8'));
const tests = result.testResults.flatMap((file) => file.assertionResults.map((test) => ({ file: file.name.split('packages/core/')[1], title: test.fullName, status: test.status })));
if (result.numFailedTests > 0 || result.numFailedTestSuites > 0 || result.testResults.length !== files.length || result.numPassedTests === 0) {
  console.error(tests.filter((test) => test.status !== 'passed'));
  throw new Error('Host patch tests did not pass.');
}

const evidence = {
  timestamp: new Date().toISOString(), targetCommit: target.commit, node: process.version, patch: name, patchSha256: entry.sha256, resultingTree: tree,
  patches: included.map((patch) => patch.name), tasks: [...new Set(included.flatMap((patch) => patch.tasks))], files, passed: result.numPassedTests, failed: result.numFailedTests,
  tests: tests.map((test) => `${test.file}: ${test.title}`),
  scope: entry.scope ?? 'Patch-added tests and related existing tests on Node/SQLite in the patched pilot worktree.',
  limits: entry.limits ?? 'No Postgres or D1 run, no deployed host, no runtime wiring.',
};
const directory = join(root, 'host/emdash/qualification');
mkdirSync(directory, { recursive: true });
const destination = join(directory, `${name.replace(/\.patch$/, '')}-latest.json`);
writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Host patch ${name}: ${result.numPassedTests} passed. Evidence: ${destination}`);
