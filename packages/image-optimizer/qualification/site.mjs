// Packaging, building, starting and stopping the disposable qualification site.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Versions the site installs next to the patched `emdash`: the pinned EmDash workspace's catalog. */
export const SITE_DEPENDENCIES = {
  '@astrojs/node': '11.1.5',
  '@astrojs/react': '6.0.5',
  astro: '7.3.2',
  react: '19.2.4',
  'react-dom': '19.2.4',
  sharp: '0.35.4',
};

const PNPM_HOST = 'pnpm@11.9.0';
const PNPM_REPO = 'pnpm@10.18.3';

export function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

/**
 * Builds the patched `emdash` package of the pilot worktree and packs it. Returns the tarball path and
 * what identifies the build: the pinned commit and the git tree of the patched sources.
 */
export function packHost(pilot, packages) {
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: pilot }).trim();
  const tree = run('git', ['write-tree'], { cwd: pilot }).trim();
  const unstaged = run('git', ['diff', '--name-only'], { cwd: pilot }).trim();
  if (unstaged) throw new Error(`The pilot worktree has changes that no patch records:\n${unstaged}`);
  const core = join(pilot, 'packages/core');
  run('npx', ['-y', PNPM_HOST, 'build'], { cwd: core });
  const before = new Set(readdirSync(packages));
  run('npx', ['-y', PNPM_HOST, 'pack', '--pack-destination', packages], { cwd: core });
  const tarball = readdirSync(packages).find((name) => name.startsWith('emdash-') && !before.has(name)) ?? 'emdash-1.1.0.tgz';
  return { tarball: join(packages, tarball), commit, tree };
}

/** Builds the plugin package and packs it, once as built and once with its version bumped for the upgrade. */
export async function packPlugin(pluginDirectory, packages, upgradeVersion) {
  run('npx', ['-y', PNPM_REPO, 'build'], { cwd: pluginDirectory });
  const manifest = JSON.parse(readFileSync(join(pluginDirectory, 'package.json'), 'utf8'));
  run('npm', ['pack', '--pack-destination', packages], { cwd: pluginDirectory });
  const current = join(packages, `${manifest.name}-${manifest.version}.tgz`);

  // The upgrade: the same build under a new version in every place the version is recorded.
  const scratch = await mkdtemp(join(tmpdir(), 'image-optimizer-upgrade-'));
  try {
    run('tar', ['xzf', current, '-C', scratch]);
    const replace = async (file, from, to) => {
      const path = join(scratch, 'package', file);
      const text = await readFile(path, 'utf8');
      if (!text.includes(from)) throw new Error(`${file} does not contain ${from}`);
      await writeFile(path, text.replace(from, to));
    };
    await replace('package.json', `"version": "${manifest.version}"`, `"version": "${upgradeVersion}"`);
    await replace('dist/native.mjs', `PLUGIN_VERSION = "${manifest.version}"`, `PLUGIN_VERSION = "${upgradeVersion}"`);
    await replace('dist/index.mjs', `"version": "${manifest.version}"`, `"version": "${upgradeVersion}"`);
    await replace('dist/manifest.json', `"version": "${manifest.version}"`, `"version": "${upgradeVersion}"`);
    const upgraded = join(packages, `${manifest.name}-${upgradeVersion}.tgz`);
    run('tar', ['czf', upgraded, '-C', scratch, 'package']);
    return { name: manifest.name, version: manifest.version, current, upgradeVersion, upgraded };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Copies the site template and installs it with the patched host and the plugin tarball. */
export async function createSite({ template, siteDirectory, hostTarball, pluginTarball }) {
  await rm(siteDirectory, { recursive: true, force: true });
  await cp(template, siteDirectory, { recursive: true });
  const manifest = {
    name: 'image-optimizer-qualification-site',
    private: true,
    type: 'module',
    dependencies: { ...SITE_DEPENDENCIES, emdash: `file:${hostTarball}`, 'image-optimizer': `file:${pluginTarball}` },
  };
  await writeFile(join(siteDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: siteDirectory });
}

/** Replaces the installed plugin with another tarball (the upgrade). */
export function installPlugin(siteDirectory, pluginTarball) {
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', `image-optimizer@file:${pluginTarball}`], { cwd: siteDirectory });
}

export function installedPluginVersion(siteDirectory) {
  return JSON.parse(readFileSync(join(siteDirectory, 'node_modules/image-optimizer/package.json'), 'utf8')).version;
}

/** Writes the site's `qualify.json` and runs `astro build`. */
export async function buildSite(siteDirectory, config) {
  await writeFile(join(siteDirectory, 'qualify.json'), `${JSON.stringify(config, null, 2)}\n`);
  await rm(join(siteDirectory, 'dist'), { recursive: true, force: true });
  run(join(siteDirectory, 'node_modules/.bin/astro'), ['build'], { cwd: siteDirectory, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });
}

/** Starts the built site on 127.0.0.1 and waits until it answers. */
export async function startSite(siteDirectory, { port, logFile }) {
  await mkdir(join(logFile, '..'), { recursive: true });
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, ['dist/server/entry.mjs'], {
    cwd: siteDirectory,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exited) throw new Error(`The site exited during startup (${JSON.stringify(exited)}); see ${logFile}`);
    try {
      const response = await fetch(`${origin}/_emdash/api/health`);
      if (response.status < 500) break;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
    if (attempt === 119) throw new Error(`The site did not answer within 60 s; see ${logFile}`);
  }
  return {
    origin,
    pid: child.pid,
    exited: () => exited,
    async stop() {
      if (exited) return exited;
      const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const result = await done;
      clearTimeout(timer);
      log.end();
      return result;
    },
  };
}

export function exists(path) {
  return existsSync(path);
}
