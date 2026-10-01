import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = JSON.parse(readFileSync(resolve(root, 'host/emdash/target.json'), 'utf8'));
const checkout = resolve(root, target.checkout);
function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

if (!existsSync(checkout)) {
  mkdirSync(dirname(checkout), { recursive: true });
  git(['clone', '--depth', '1', target.repository, checkout]);
}
if (git(['remote', 'get-url', 'origin'], checkout) !== target.repository) {
  throw new Error('Checkout origin does not match the pinned implementation target.');
}
if (git(['status', '--porcelain'], checkout)) {
  throw new Error('Checkout has local changes; preserve them before selecting the pinned target.');
}
if (git(['rev-parse', 'HEAD'], checkout) !== target.commit) {
  git(['fetch', '--depth', '1', 'origin', target.commit], checkout);
}
git(['checkout', '--detach', target.commit], checkout);
console.log(`EmDash target: ${git(['rev-parse', 'HEAD'], checkout)} (${checkout})`);
