import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const target = JSON.parse(readFileSync(resolve(root, 'host/emdash/target.json'), 'utf8'));
export const checkout = resolve(root, target.checkout);
export const pilot = resolve(root, '.upstream/emdash-pilot');
export const patchDirectory = resolve(root, target.patchDirectory);

export function git(args, cwd, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
}

export function requirePinnedCheckout() {
  if (!existsSync(checkout)) throw new Error('Run pnpm host:checkout first.');
  if (git(['rev-parse', 'HEAD'], checkout).trim() !== target.commit) throw new Error('The checkout is not at the pinned commit; run pnpm host:checkout.');
}
