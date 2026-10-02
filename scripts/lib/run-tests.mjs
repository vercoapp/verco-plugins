import { run } from 'node:test';

/**
 * Run test files and summarize results from run() events. This avoids parsing
 * reporter text, which differs across Node versions. Throws unless every test passes.
 */
export async function runTests(files, cwd) {
  const tests = [];
  let failed = 0;
  const stream = run({ files, cwd, timeout: 120000 });
  stream.on('test:pass', ({ name, details }) => {
    if (details?.type !== 'suite') tests.push(name);
  });
  stream.on('test:fail', ({ name, details, file }) => {
    if (details?.type === 'suite') return;
    failed++;
    console.error(`FAIL ${name}${file ? ` (${file})` : ''}\n${details?.error?.message ?? ''}`);
  });
  stream.on('test:stderr', ({ message }) => process.stderr.write(message));
  for await (const _ of stream); // drain until every file has finished
  if (failed > 0 || tests.length === 0) {
    throw new Error(`Qualification tests did not pass (passed ${tests.length}, failed ${failed}).`);
  }
  return { tests, passed: tests.length, failed };
}
