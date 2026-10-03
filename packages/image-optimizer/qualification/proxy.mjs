// A throwaway reverse proxy in front of the qualification site: Caddy, listening on 127.0.0.1 only,
// passing every request to the site and serving nothing itself. The run then talks to the proxy's
// origin instead of the site's port. Caddy runs from a `caddy` binary on the PATH, or, with an image
// name, in a container on the host's network that is removed when it stops. Nothing here names a
// host: the ports, the image and the container name come from the caller.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CONFIG_IN_CONTAINER = '/etc/caddy/Caddyfile';

/**
 * The whole configuration: no admin endpoint, no TLS, one plain-HTTP site on loopback whose only
 * directive is `reverse_proxy` to the site. No `root`, no `file_server`: the proxy has no access to
 * the uploads or data directories and no route that would read a file.
 */
export function caddyfile({ proxyPort, sitePort }) {
  return [
    '{',
    '\tadmin off',
    '\tauto_https off',
    '\tpersist_config off',
    '}',
    '',
    `http://127.0.0.1:${proxyPort} {`,
    '\tbind 127.0.0.1',
    `\treverse_proxy 127.0.0.1:${sitePort}`,
    '}',
    '',
  ].join('\n');
}

/** Every object in a JSON value, depth first. */
function* objects(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* objects(item);
  } else if (value && typeof value === 'object') {
    yield value;
    for (const item of Object.values(value)) yield* objects(item);
  }
}

/**
 * What Caddy makes of a configuration, from its adapted JSON: where it listens, every HTTP handler
 * it has, where they send requests, and whether anything names a file-system root.
 */
export function describeConfig(adapted) {
  const servers = Object.values(adapted.apps?.http?.servers ?? {});
  const handlers = [];
  const upstreams = [];
  const roots = [];
  for (const node of objects(servers)) {
    if (typeof node.handler === 'string') handlers.push(node.handler);
    if (node.handler === 'reverse_proxy') for (const upstream of node.upstreams ?? []) upstreams.push(upstream.dial);
    if ('root' in node) roots.push(node.root);
  }
  return {
    listen: servers.flatMap((server) => server.listen ?? []),
    handlers: [...new Set(handlers)].sort(),
    upstreams: [...new Set(upstreams)],
    roots,
    admin: adapted.admin?.disabled === true ? 'off' : 'on',
  };
}

/**
 * Fails unless the configuration only passes requests on: it listens on loopback alone, every
 * terminal handler is a reverse proxy to the site and nothing else, and no file server or root
 * exists.
 */
export function assertPassThrough(description, { proxyPort, sitePort }) {
  const problems = [];
  if (description.listen.length === 0 || description.listen.some((address) => address !== `127.0.0.1:${proxyPort}`)) {
    problems.push(`listens on ${JSON.stringify(description.listen)}, not on loopback alone`);
  }
  const other = description.handlers.filter((handler) => !['reverse_proxy', 'subroute'].includes(handler));
  if (other.length > 0) problems.push(`has handlers besides the reverse proxy: ${other.join(', ')}`);
  if (!description.handlers.includes('reverse_proxy')) problems.push('has no reverse proxy');
  if (description.upstreams.length !== 1 || description.upstreams[0] !== `127.0.0.1:${sitePort}`) {
    problems.push(`sends requests to ${JSON.stringify(description.upstreams)}, not to the site alone`);
  }
  if (description.roots.length > 0) problems.push(`names a file-system root: ${JSON.stringify(description.roots)}`);
  if (description.admin !== 'off') problems.push('has its admin endpoint on');
  if (problems.length > 0) throw new Error(`The proxy configuration ${problems.join('; ')}`);
}

/**
 * Starts Caddy with the pass-through configuration and waits until it listens. `image` selects the
 * container form; `name` is the container's name. Returns the proxy's origin, Caddy's version, what
 * its configuration adapts to, and `stop()`.
 */
export async function startCaddy({ proxyPort, sitePort, directory, image = null, name = 'qualification-proxy', logFile }) {
  await mkdir(directory, { recursive: true });
  const configFile = join(directory, 'Caddyfile');
  await writeFile(configFile, caddyfile({ proxyPort, sitePort }));
  const origin = `http://127.0.0.1:${proxyPort}`;

  const mounts = ['-v', `${configFile}:${CONFIG_IN_CONTAINER}:ro`];
  const caddy = (args, options = {}) =>
    image
      ? execFileSync('docker', ['run', '--rm', ...mounts, image, 'caddy', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
      : execFileSync('caddy', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const configPath = image ? CONFIG_IN_CONTAINER : configFile;

  const version = caddy(['version']).trim().split(/\s+/)[0];
  const adapted = describeConfig(JSON.parse(caddy(['adapt', '--config', configPath, '--adapter', 'caddyfile'])));

  // Nothing may answer on the proxy's port before the proxy starts: afterwards, whatever answers
  // there is the proxy.
  const answers = async () => {
    try {
      await fetch(origin, { signal: AbortSignal.timeout(2_000), redirect: 'manual' });
      return true;
    } catch {
      return false;
    }
  };
  if (await answers()) throw new Error(`Something already answers on the proxy's port`);

  await mkdir(join(logFile, '..'), { recursive: true });
  const log = createWriteStream(logFile, { flags: 'a' });
  const run = ['run', '--config', configPath, '--adapter', 'caddyfile'];
  const child = image
    ? spawn('docker', ['run', '--rm', '--name', name, '--network', 'host', ...mounts, image, 'caddy', ...run], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('caddy', run, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  for (let attempt = 0; !(await answers()); attempt += 1) {
    if (exited) throw new Error(`The proxy exited during startup (${JSON.stringify(exited)}); see ${logFile}`);
    if (attempt === 120) throw new Error(`The proxy did not listen within 60 s; see ${logFile}`);
    await sleep(500);
  }

  return {
    name: 'caddy',
    version,
    origin,
    config: adapted,
    exited: () => exited,
    async stop() {
      if (exited) return;
      const done = new Promise((resolve) => child.once('exit', resolve));
      if (image) spawnSync('docker', ['stop', name], { stdio: 'ignore' });
      else child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      await done;
      clearTimeout(timer);
      log.end();
    },
  };
}
