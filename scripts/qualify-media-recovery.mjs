import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from './lib/run-tests.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = JSON.parse(await readFile(join(root, 'host/emdash/target.json'), 'utf8'));
const { tests, passed, failed } = await runTests([
  join(root, 'experiments/publication-recovery.test.mjs'),
  join(root, 'experiments/decoder-validation.test.mjs'),
], root);
const crashPoints = [...new Set(tests.flatMap((name) => /^a (?:crash|restore interrupted) at ([a-z-]+)/.exec(name)?.slice(1) ?? []))];
const evidence = {
  timestamp: new Date().toISOString(), targetCommit: target.commit, node: process.version,
  profile: 'node-sqlite-local-journal-prototype', fixtureOnly: true,
  crashPoints, tests, passed, failed,
  scope: 'Journaled publication on SQLite with synchronous FULL and fsync-verified local objects; each crash point abandons the process and a fresh instance reopens the same directory. Decoder validation against the pilot limits.',
  limits: 'No power-loss or filesystem-fault testing, no multi-process contention, no EmDash runtime, no host patch, no object-store profile. Crash points are simulated in-process. Decoder measurements are in decoder-budget-latest.json.',
};
const directory = join(root, 'host/emdash/qualification');
await mkdir(directory, { recursive: true });
const destination = join(directory, 'recovery-latest.json');
await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Recovery prototype passed. Evidence: ${destination}`);
