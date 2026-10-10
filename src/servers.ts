// Finds dev servers listening on this machine, using lsof (macOS and Linux only).
import { execOutput, type ExecResult } from './exec.ts';
import { isInside } from './paths.ts';

// Process names that are likely to be a dev server. Compared after dropping a trailing
// version number, so python3.12 and php8.2 match too.
const DEV_PROCESS_NAMES = new Set([
  'node', 'nodejs', 'python', 'ruby', 'php', 'php-fpm', 'deno', 'bun',
  'java', 'dotnet', 'hugo', 'caddy', 'nginx', 'httpd',
]);
// A listening address the phone can use: a wildcard, or a specific IPv4 address that isn't
// loopback or link-local. The URLs shown are IPv4, so a server bound to one IPv6 address doesn't count.
const WILDCARD_HOST = /^(\*|0\.0\.0\.0|\[::\])$/;
const IPV4_HOST = /^\d+\.\d+\.\d+\.\d+$/;
const UNREACHABLE_IPV4 = /^(127\.|169\.254\.)/;
// Ports below this are system services, not dev servers.
const MIN_DEV_PORT = 1024;

export const LSOF_MISSING = process.platform === 'linux'
  ? 'lsof isn\'t installed, so running servers can\'t be detected. Install it, for example with `sudo apt install lsof`.'
  : 'lsof isn\'t available, so running servers can\'t be detected.';

export interface DevServer {
  port: number;
  // Missing for a port typed in by hand.
  pid?: number;
  // Process name, "Live Server" or "Manual".
  label: string;
  kind: 'process' | 'liveServer' | 'manual';
  // Listens on an address the phone can use. Unknown for a port typed in by hand.
  lanReachable?: boolean;
  // The one IPv4 address it listens on, when it doesn't listen on all of them.
  boundAddress?: string;
  cwd?: string;
  // Started from one of the open workspace folders.
  inProject?: boolean;
}

// A server found by lsof, so its pid is always known.
export type DetectedServer = DevServer & { pid: number };

export function isDetected(server: DevServer): server is DetectedServer {
  return server.pid !== undefined;
}

export interface LsofProcess {
  pid: number;
  command: string;
  names: string[];
}

/**
 * lsof's output, or an error. lsof exits 1 both when nothing matches and when it fails, so a failure
 * is told apart by the explanation it writes to stderr. Warnings (on Linux, about file systems it
 * can't look into) can come with every run and don't count.
 */
export function lsofOutput({ stdout, stderr, code }: ExecResult): string {
  // Indented lines continue the message before them.
  const problem = stderr.split('\n').find(line => /^\S/.test(line) && !/\bWARNING\b/.test(line));
  if (code !== 0 && !stdout.trim() && problem) throw new Error(`lsof failed: ${problem.trim()}`);
  return stdout;
}

async function lsof(args: string[]): Promise<string> {
  const result = await execOutput('lsof', args);
  if (!result) throw new Error(LSOF_MISSING);
  return lsofOutput(result);
}

// Parses `lsof -F` output into one record per process.
export function parseLsof(stdout: string): LsofProcess[] {
  const processes: LsofProcess[] = [];
  let current: LsofProcess | undefined;
  for (const line of stdout.split('\n')) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      current = { pid: Number(value), command: '', names: [] };
      processes.push(current);
    } else if (current && field === 'c') {
      current.command = value;
    } else if (current && field === 'n') {
      current.names.push(value);
    }
  }
  return processes;
}

// Splits a listening address such as "*:3000", "127.0.0.1:5173" or "[::1]:8080".
export function parseListenAddress(name: string): { host: string; port: number } | undefined {
  const colon = name.lastIndexOf(':');
  const port = Number(name.slice(colon + 1));
  if (colon === -1 || !Number.isInteger(port) || port <= 0) return;
  return { host: name.slice(0, colon), port };
}

export function isLanHost(host: string): boolean {
  return WILDCARD_HOST.test(host) || (IPV4_HOST.test(host) && !UNREACHABLE_IPV4.test(host));
}

export function isDevProcess(command: string): boolean {
  const name = command.toLowerCase().replace(/[\d.]+$/, '');
  // Next.js renames its process to "next-server (vX.Y.Z)".
  return DEV_PROCESS_NAMES.has(name) || name.startsWith('next-server');
}

/**
 * Groups listening sockets into one server per port, keeping only likely dev servers.
 * When several processes listen on a port, the server is the one the phone would reach.
 * Live Server runs inside this window's extension host, `extensionHostPid`, which over Remote SSH, WSL
 * or in a container is a plain node process. A Live Server in another window serves another project,
 * and its setting can't be changed from here, so it isn't listed.
 */
export function collectServers(processes: LsofProcess[], liveServerPort?: number, extensionHostPid?: number): DetectedServer[] {
  const byPort = new Map<number, { pid: number; label: string; kind: DevServer['kind']; host: string }[]>();
  for (const { pid, command, names } of processes) {
    for (const name of names) {
      const address = parseListenAddress(name);
      if (!address || address.port < MIN_DEV_PORT) continue;

      const kind = pid === extensionHostPid && address.port === liveServerPort ? 'liveServer'
        : isDevProcess(command) ? 'process'
        : undefined;
      if (!kind) continue;

      const label = kind === 'liveServer' ? 'Live Server' : command;
      const listeners = byPort.get(address.port) ?? [];
      listeners.push({ pid, label, kind, host: address.host });
      byPort.set(address.port, listeners);
    }
  }
  return [...byPort].map(([port, listeners]) => {
    const reachable = listeners.find(l => WILDCARD_HOST.test(l.host)) ?? listeners.find(l => isLanHost(l.host));
    const { pid, label, kind } = reachable ?? listeners[0];
    const server: DetectedServer = { port, pid, label, kind, lanReachable: !!reachable };
    if (reachable && !WILDCARD_HOST.test(reachable.host)) server.boundAddress = reachable.host;
    return server;
  });
}

// Working directory per pid, so servers started from the open project can be told apart.
export async function getWorkingDirs(pids: number[]): Promise<Map<number, string>> {
  if (!pids.length) return new Map();
  const stdout = await lsof(['-a', '-d', 'cwd', '-nP', '-Fn', '-p', pids.join(',')]);
  return new Map(parseLsof(stdout).map(p => [p.pid, p.names[0]]));
}

// `workspaceFolders` should already be real paths (see realPath).
export async function findDevServers(
  { liveServerPort, extensionHostPid, workspaceFolders = [] }:
  { liveServerPort?: number; extensionHostPid?: number; workspaceFolders?: string[] } = {},
): Promise<DetectedServer[]> {
  const stdout = await lsof(['-iTCP', '-sTCP:LISTEN', '-nP', '-F', 'pcn']);
  const servers = collectServers(parseLsof(stdout), liveServerPort, extensionHostPid);
  const dirs = await getWorkingDirs([...new Set(servers.map(s => s.pid))]);

  return servers
    .map(server => ({ ...server, cwd: dirs.get(server.pid) }))
    // Apps opened from the Dock or Finder (pgAdmin, Spotify…) run from "/"; dev servers never do.
    .filter(server => server.kind !== 'process' || server.cwd !== '/')
    .map(server => ({
      ...server,
      inProject: server.kind === 'liveServer' || workspaceFolders.some(folder => isInside(server.cwd, folder)),
    }))
    .sort((a, b) => a.port - b.port);
}

export async function listeningPids(port: number): Promise<number[]> {
  const stdout = await lsof([`-iTCP:${port}`, '-sTCP:LISTEN', '-nP', '-t']);
  return stdout.split('\n').filter(Boolean).map(Number);
}

// Whether a process running from `dir` (a real path, see realPath) listens on `port`.
export async function listensFrom(port: number, dir: string): Promise<boolean> {
  const dirs = await getWorkingDirs(await listeningPids(port));
  return [...dirs.values()].some(cwd => isInside(cwd, dir));
}

// After a restart, picks the server that the restart started: one that wasn't running before,
// runs from `dir` and is reachable, preferring the port the old server had.
export function pickRestartedServer(
  servers: DetectedServer[], { dir, oldPort, pidsBefore }: { dir: string; oldPort: number; pidsBefore: Set<number> },
): DetectedServer | undefined {
  const started = servers.filter(s => s.lanReachable && !pidsBefore.has(s.pid) && isInside(s.cwd, dir));
  return started.find(s => s.port === oldPort) ?? started[0];
}
