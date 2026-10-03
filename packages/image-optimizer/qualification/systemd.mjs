// The hosted runner of the site qualification: the built site runs as a transient systemd service
// under its own Unix user, with cgroup caps and sandboxing, bound to 127.0.0.1, one process per site.
// The script calling this runs as root on the host. Nothing here names a host: the unit, the user,
// the Node binary and the caps come from the command line.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** The unprivileged account used to show that another user cannot read the site's data. */
const OTHER_USER = { name: 'nobody', uid: 65534, gid: 65534 };

/**
 * Sandboxing that the site runs under besides the caps. Each was tried on the qualification host;
 * `MemoryDenyWriteExecute` is left out because V8's JIT needs writable executable memory.
 */
export const HARDENING = [
  'NoNewPrivileges=yes',
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'PrivateTmp=yes',
  'PrivateDevices=yes',
  'ProtectKernelTunables=yes',
  'ProtectKernelModules=yes',
  'ProtectKernelLogs=yes',
  'ProtectControlGroups=yes',
  'ProtectClock=yes',
  'ProtectHostname=yes',
  'ProtectProc=invisible',
  'RestrictSUIDSGID=yes',
  'RestrictRealtime=yes',
  'RestrictNamespaces=yes',
  'LockPersonality=yes',
  'SystemCallArchitectures=native',
  'CapabilityBoundingSet=',
  // AF_NETLINK: `os.networkInterfaces()`, which the site calls while rendering, lists interfaces
  // over netlink and fails without it.
  'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
  'IPAddressDeny=any',
  'IPAddressAllow=localhost',
  'UMask=0077',
];

function exec(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

/** `3G` and the like, as systemd reads them (powers of 1024), in bytes. */
export function parseBytes(text) {
  const match = /^(\d+)([KMGT]?)$/.exec(text);
  if (!match) throw new Error(`Not a byte size: ${text}`);
  return Number(match[1]) * 1024 ** ' KMGT'.indexOf(match[2] || ' ');
}

function show(unit, ...properties) {
  const text = exec('systemctl', ['show', unit, ...properties.flatMap((property) => ['-p', property])]);
  return Object.fromEntries(text.trim().split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/** `memory.events` as numbers: `{ low, high, max, oom, oom_kill, ... }`. */
function parseEvents(text) {
  return Object.fromEntries((text ?? '').split('\n').filter(Boolean).map((line) => line.split(' ')).map(([key, value]) => [key, Number(value)]));
}

/** Every process on the host: its parent, cgroup and arguments, read from `/proc`. */
function processTable() {
  const table = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      table.set(Number(name), { pid: Number(name), ppid });
    } catch {
      // Exited while listing.
    }
  }
  return table;
}

function describeProcess(pid) {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((line) => line.startsWith('0::'))?.slice(3) ?? null;
    let cwd = null;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // A process of another user that has exited, or a kernel thread.
    }
    return { pid, argv, cgroup, cwd };
  } catch {
    return null;
  }
}

export function createSystemdRunner({ unit, user, node, siteDirectory, dataDirectory, port, logFile, memoryMax = '3G', cpuQuota = '200%' }) {
  const uid = Number(exec('id', ['-u', user]).trim());
  const gid = Number(exec('id', ['-g', user]).trim());
  const origin = `http://127.0.0.1:${port}`;
  const caps = [`MemoryMax=${memoryMax}`, 'MemorySwapMax=0', `CPUQuota=${cpuQuota}`];
  // OOMPolicy=continue: when the kernel kills a processor worker for memory, the site keeps serving
  // and the processor retries the image as crashed. The default, stop, takes the whole site down.
  const properties = [...caps, 'OOMPolicy=continue', ...HARDENING, `ReadWritePaths=${dataDirectory}`, 'TimeoutStopSec=30'];
  const expected = {
    memoryMax: String(parseBytes(memoryMax)),
    swapMax: '0',
    cpuMax: `${Number.parseInt(cpuQuota, 10) * 1000} 100000`,
  };

  function state() {
    const values = show(unit, 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'InvocationID');
    return { ...values, MainPID: Number(values.MainPID) };
  }

  function running() {
    const { ActiveState } = state();
    return ['active', 'activating', 'reloading', 'deactivating', 'refreshing'].includes(ActiveState);
  }

  async function answers() {
    try {
      await fetch(`${origin}/_emdash/api/health`, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      return false;
    }
  }

  async function journal(sinceMs) {
    const text = exec('journalctl', ['-u', unit, '--since', `@${Math.floor(sinceMs / 1000) - 1}`, '-o', 'short-iso', '--no-pager']);
    await mkdir(join(logFile, '..'), { recursive: true });
    await appendFile(logFile, text);
    return text;
  }

  /** The unit's cgroup directory, or null when the unit is not running. */
  function cgroupDirectory() {
    const { ControlGroup } = state();
    return ControlGroup ? join('/sys/fs/cgroup', ControlGroup) : null;
  }

  return {
    kind: 'systemd',
    unit,
    properties,
    expected,
    uid,
    gid,
    otherUser: OTHER_USER.name,

    /** Creates a data directory owned by the site user, mode 0700. */
    prepareDirectory(path) {
      mkdirSync(path, { recursive: true });
      chmodSync(path, 0o700);
      chownSync(path, uid, gid);
    },

    /**
     * Starts the site, refusing when the unit or anything on the site's port is already running: a
     * site has exactly one process. Waits until it answers.
     */
    async start() {
      if (running()) throw new Error(`${unit} is already running; a site has exactly one process, so no second one is started`);
      if (await answers()) throw new Error(`Something already answers on ${origin}; a site has exactly one process, so no second one is started`);
      const since = Date.now();
      exec('systemd-run', [
        '--unit', unit, '--uid', String(uid), '--gid', String(gid), '--collect', '--quiet',
        `--working-directory=${siteDirectory}`,
        '--setenv=HOST=127.0.0.1', `--setenv=PORT=${port}`, '--setenv=NODE_ENV=production',
        ...properties.flatMap((property) => ['-p', property]),
        '--', node, 'dist/server/entry.mjs',
      ]);
      for (let attempt = 0; ; attempt += 1) {
        const current = state();
        if (!['active', 'activating'].includes(current.ActiveState)) {
          const log = await journal(since);
          throw new Error(`${unit} stopped during startup (${current.ActiveState}/${current.SubState}):\n${log.split('\n').slice(-30).join('\n')}`);
        }
        try {
          const response = await fetch(`${origin}/_emdash/api/health`);
          if (response.status < 500) break;
        } catch {
          // Not listening yet.
        }
        if (attempt === 119) {
          await journal(since);
          throw new Error(`${unit} did not answer within 60 s; see ${logFile}`);
        }
        await sleep(500);
      }
      const { MainPID, InvocationID } = state();
      let stopped = null;
      return {
        origin,
        pid: MainPID,
        invocation: InvocationID,
        exited: () => stopped,
        /** Stops the unit, keeps its journal, and returns the memory events of its cgroup. */
        async stop() {
          if (stopped) return stopped;
          const directory = cgroupDirectory();
          const memory = directory
            ? { events: parseEvents(readOrNull(join(directory, 'memory.events'))), peakBytes: Number(readOrNull(join(directory, 'memory.peak'))) || null }
            : null;
          // The unit may have stopped already, or been collected after failing; its journal is kept anyway.
          spawnSync('systemctl', ['stop', unit], { stdio: 'ignore' });
          for (let attempt = 0; running(); attempt += 1) {
            if (attempt === 60) throw new Error(`${unit} did not stop`);
            await sleep(500);
          }
          await journal(since);
          stopped = { memory };
          return stopped;
        },
      };
    },

    running,
    state,

    /** The caps as the kernel applies them to the running unit, and its memory accounting. */
    cgroup() {
      const directory = cgroupDirectory();
      if (!directory) throw new Error(`${unit} has no cgroup: it is not running`);
      return {
        path: state().ControlGroup,
        memoryMax: readOrNull(join(directory, 'memory.max')),
        swapMax: readOrNull(join(directory, 'memory.swap.max')),
        cpuMax: readOrNull(join(directory, 'cpu.max')),
        memoryEvents: parseEvents(readOrNull(join(directory, 'memory.events'))),
        memoryPeakBytes: Number(readOrNull(join(directory, 'memory.peak'))) || null,
      };
    },

    /**
     * The site's processes, found from `/proc` rather than from the unit: every process running the
     * site's server entry from the site directory, and all of their descendants (the processor's
     * workers among them), each with its cgroup.
     */
    siteProcesses() {
      const table = processTable();
      const children = new Map();
      for (const { pid, ppid } of table.values()) {
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(pid);
      }
      const found = [];
      for (const pid of table.keys()) {
        const entry = describeProcess(pid);
        if (entry?.cwd === siteDirectory && entry.argv.includes('dist/server/entry.mjs')) found.push({ ...entry, role: 'server' });
      }
      const queue = found.map((entry) => entry.pid);
      while (queue.length > 0) {
        for (const child of children.get(queue.shift()) ?? []) {
          const entry = describeProcess(child);
          if (!entry) continue;
          const worker = entry.argv.includes('--eval') && entry.argv.includes('--input-type=module');
          found.push({ ...entry, role: worker ? 'worker' : 'other' });
          queue.push(child);
        }
      }
      return found;
    },

    /**
     * Samples the site's processes every few milliseconds until stopped, to catch the short-lived
     * processor workers. Returns every distinct process seen, with the cgroup it was in when first seen.
     */
    sampleProcesses(intervalMs = 25) {
      const seen = new Map();
      const sample = () => {
        for (const entry of this.siteProcesses()) if (!seen.has(entry.pid)) seen.set(entry.pid, entry);
      };
      sample();
      const timer = setInterval(sample, intervalMs);
      timer.unref();
      return {
        stop() {
          clearInterval(timer);
          sample();
          return [...seen.values()];
        },
      };
    },

    /**
     * Every entry under the data directory with its owner and mode, and what is wrong: not owned by
     * the site user, a directory other than 0700, a file readable or writable by group or others.
     */
    inspectData() {
      const entries = [];
      const walk = (path) => {
        const stat = lstatSync(path);
        entries.push({ path: relative(dataDirectory, path) || '.', directory: stat.isDirectory(), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 });
        if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
      };
      walk(dataDirectory);
      const problems = entries.filter((entry) => entry.uid !== uid || entry.gid !== gid || (entry.directory ? entry.mode !== 0o700 : (entry.mode & 0o077) !== 0));
      return { entries, problems };
    },

    /** Tries to read each path as another unprivileged user; returns the error code of each attempt. */
    readAsOtherUser(paths) {
      const script = `
        const { readFileSync, readdirSync, statSync } = require('node:fs');
        const out = {};
        for (const path of JSON.parse(process.argv[1])) {
          try {
            if (statSync(path).isDirectory()) readdirSync(path); else readFileSync(path);
            out[path] = 'read';
          } catch (error) {
            out[path] = error.code;
          }
        }
        console.log(JSON.stringify(out));`;
      const result = spawnSync(node, ['-e', script, JSON.stringify(paths)], { uid: OTHER_USER.uid, gid: OTHER_USER.gid, encoding: 'utf8', cwd: '/' });
      if (result.status !== 0) throw new Error(`Reading as ${OTHER_USER.name} failed to run: ${result.stderr}`);
      return JSON.parse(result.stdout.trim());
    },

    /**
     * Runs a module script with Node from the site directory, as the site user, under the same caps
     * and sandbox in a unit of its own, and returns its output. Only while the site is stopped.
     */
    recover(script) {
      if (running()) throw new Error(`${unit} is running; recovery works on a stopped site`);
      return exec('systemd-run', [
        '--unit', `${unit}-recovery`, '--uid', String(uid), '--gid', String(gid), '--wait', '--pipe', '--collect', '--quiet',
        `--working-directory=${siteDirectory}`,
        ...properties.flatMap((property) => ['-p', property]),
        '--', node, '--input-type=module', '-e', script,
      ]);
    },

    /** Tries to start a second transient unit under the site's unit name; returns systemd's answer. */
    secondUnit() {
      const result = spawnSync('systemd-run', ['--unit', unit, '--uid', String(uid), '--gid', String(gid), '--collect', '--quiet', '--', node, '-e', ''], { encoding: 'utf8' });
      return { status: result.status, stderr: result.stderr.trim() };
    },
  };
}
