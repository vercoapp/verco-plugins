// Packaging, building, starting and stopping the disposable qualification site. Build steps (git,
// pnpm, npm, tar, astro) can run elsewhere than the site, through a wrapper; see `useBuildWrapper`.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

let buildWrapper = null;

/**
 * Runs every later build step as `<wrapper> <directory> env <NAME=VALUE...> <command> <args...>`: the
 * wrapper runs the command in that directory of a build environment that sees the same paths, such
 * as a container with the work directory mounted at the same absolute path (a mount, not a symlink:
 * Astro records real paths in the build). Without a wrapper, build
 * steps run in this process's environment.
 */
export function useBuildWrapper(wrapper) {
  buildWrapper = wrapper;
}

/** A build step: run directly, or through the build wrapper with the given extra environment. */
export function build(command, args, { cwd, env = {} }) {
  if (!buildWrapper) return run(command, args, { cwd, env: { ...process.env, ...env } });
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  return run(buildWrapper, [cwd, 'env', ...assignments, command, ...args]);
}

/**
 * Builds the patched `emdash` package of the pilot worktree and packs it. Returns the tarball path and
 * what identifies the build: the pinned commit and the git tree of the patched sources.
 */
export function packHost(pilot, packages) {
  const commit = build('git', ['rev-parse', 'HEAD'], { cwd: pilot }).trim();
  const tree = build('git', ['write-tree'], { cwd: pilot }).trim();
  const unstaged = build('git', ['diff', '--name-only'], { cwd: pilot }).trim();
  if (unstaged) throw new Error(`The pilot worktree has changes that no patch records:\n${unstaged}`);
  const core = join(pilot, 'packages/core');
  build('npx', ['-y', PNPM_HOST, 'build'], { cwd: core });
  const before = new Set(readdirSync(packages));
  build('npx', ['-y', PNPM_HOST, 'pack', '--pack-destination', packages], { cwd: core });
  const tarball = readdirSync(packages).find((name) => name.startsWith('emdash-') && !before.has(name)) ?? 'emdash-1.1.0.tgz';
  return { tarball: join(packages, tarball), commit, tree };
}

/** Builds the plugin package and packs it, once as built and once with its version bumped for the upgrade. */
export async function packPlugin(pluginDirectory, packages, upgradeVersion) {
  build('npx', ['-y', PNPM_REPO, 'build'], { cwd: pluginDirectory });
  const manifest = JSON.parse(readFileSync(join(pluginDirectory, 'package.json'), 'utf8'));
  build('npm', ['pack', '--pack-destination', packages], { cwd: pluginDirectory });
  const current = join(packages, `${manifest.name}-${manifest.version}.tgz`);

  // The upgrade: the same build under a new version in every place the version is recorded. The
  // scratch directory is in the work directory, which a build wrapper sees at the same path.
  const scratch = await mkdtemp(join(packages, '.upgrade-'));
  try {
    build('tar', ['xzf', current, '-C', scratch], { cwd: packages });
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
    build('tar', ['czf', upgraded, '-C', scratch, 'package'], { cwd: packages });
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
  build('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: siteDirectory });
}

/** Replaces the installed plugin with another tarball (the upgrade). */
export function installPlugin(siteDirectory, pluginTarball) {
  build('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', `image-optimizer@file:${pluginTarball}`], { cwd: siteDirectory });
}

/** Replaces the installed `emdash` with another build of the host (another patch level). */
export function installHost(siteDirectory, hostTarball) {
  build('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', `emdash@file:${hostTarball}`], { cwd: siteDirectory });
}

/**
 * Whether the installed `emdash` build records public storage cleanups (host patch 0010): its
 * built files name the column. Tells the two patch levels of a migration apart.
 */
export function hostRecordsPublicCleanups(siteDirectory) {
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (walk(path)) return true;
      } else if (/\.(mjs|js|ts)$/.test(entry.name) && readFileSync(path, 'utf8').includes('public_cleaned_at')) {
        return true;
      }
    }
    return false;
  };
  const root = join(siteDirectory, 'node_modules/emdash');
  return ['dist', 'src'].some((directory) => existsSync(join(root, directory)) && walk(join(root, directory)));
}

export function installedPluginVersion(siteDirectory) {
  return JSON.parse(readFileSync(join(siteDirectory, 'node_modules/image-optimizer/package.json'), 'utf8')).version;
}

/** Writes the site's `qualify.json` and runs `astro build`. */
export async function buildSite(siteDirectory, config) {
  await writeFile(join(siteDirectory, 'qualify.json'), `${JSON.stringify(config, null, 2)}\n`);
  await rm(join(siteDirectory, 'dist'), { recursive: true, force: true });
  // Astro writes the site's real path into the build, so a build wrapper must see the site at the
  // real path it runs from (a symlink does not do).
  build(join(siteDirectory, 'node_modules/.bin/astro'), ['build'], { cwd: siteDirectory, env: { ASTRO_TELEMETRY_DISABLED: '1' } });
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
