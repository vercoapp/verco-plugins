import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = JSON.parse(await readFile(join(root, 'host/emdash/target.json'), 'utf8'));
const output = execFileSync(process.execPath, ['--experimental-strip-types', '--test', 'experiments/emdash-writer-participation.test.mjs'], {
  cwd: root, encoding: 'utf8', timeout: 30000,
});
process.stdout.write(output);
const handlers = {};
for (const path of ['packages/core/src/astro/routes/api/media/[id]/replace.ts', 'packages/core/src/astro/routes/api/media/[id].ts']) {
  handlers[path] = createHash('sha256').update(await readFile(join(root, target.checkout, path))).digest('hex');
}
const evidence = {
  timestamp: new Date().toISOString(), targetCommit: target.commit, node: process.version,
  profile: 'node-sqlite-local-writer-participation-prototype', fixtureOnly: true,
  routeSourceDigests: handlers,
  tests: output.split('\n').filter((line) => line.startsWith('# Subtest: ')).map((line) => line.slice('# Subtest: '.length)),
  passed: Number(/^# pass (\d+)$/m.exec(output)?.[1]),
  failed: Number(/^# fail (\d+)$/m.exec(output)?.[1]),
  scope: 'Pinned editor handlers invoked with request-scoped prototype host callbacks, two real SQLite connections, decoded fixture PNGs and immutable objects.',
  limits: 'No full EmDash runtime, deployed host patch, sandbox bridge, CSRF middleware, durable receipt or crash recovery qualification.',
};
const directory = join(root, 'host/emdash/qualification');
await mkdir(directory, { recursive: true });
const destination = join(directory, 'writers-latest.json');
await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Writer participation prototype passed. Evidence: ${destination}`);
