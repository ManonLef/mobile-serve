// Finds dev servers listening on this machine, using lsof (macOS and Linux only).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execQuiet } from './exec.ts';

// Process names that are likely to be a dev server. Compared after dropping a trailing
// version number, so python3.12 and php8.2 match too.
const DEV_PROCESS_NAMES = new Set([
  'node', 'nodejs', 'python', 'ruby', 'php', 'php-fpm', 'deno', 'bun',
  'java', 'dotnet', 'hugo', 'caddy', 'nginx', 'httpd',
]);
// VS Code and its forks. Only Live Server's port is worth showing from these.
export const VS_CODE_PROCESS = /^(code|electron|cursor|vscodium|codium|windsurf)\b/i;
// Docker's port forwarders. macOS cuts process names at 16 characters, hence the prefixes.
const DOCKER_PROCESS = /^(com\.docker|docker-proxy|vpnkit)/i;
// A listening address the phone can use: a wildcard, or a specific IPv4 address that isn't
// loopback or link-local. The URLs shown are IPv4, so a server bound to one IPv6 address doesn't count.
const WILDCARD_HOST = /^(\*|0\.0\.0\.0|\[::\])$/;
const IPV4_HOST = /^\d+\.\d+\.\d+\.\d+$/;
const UNREACHABLE_IPV4 = /^(127\.|169\.254\.)/;
// Ports below this are system services, not dev servers.
const MIN_DEV_PORT = 1024;
const SHELL = /^-?(sh|bash|zsh|fish|dash|ksh|tcsh|csh|nu|pwsh)$/;

export const LSOF_MISSING = process.platform === 'linux'
  ? 'lsof isn\'t installed, so running servers can\'t be detected. Install it (for example `sudo apt install lsof`) or enter a port.'
  : 'lsof isn\'t available, so running servers can\'t be detected. Enter a port instead.';

export interface DevServer {
  port: number;
  // Missing for a port typed in by hand.
  pid?: number;
  // Process name, "Live Server" or "Docker".
  label: string;
  // Served by the Live Server extension inside VS Code.
  liveServer: boolean;
  // Listens on an address the phone can use. Unknown for a port typed in by hand.
  lanReachable?: boolean;
  // Working directory of the server process.
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

// Runs lsof, throwing LSOF_MISSING if it isn't installed.
async function lsof(args: string[]): Promise<string> {
  const stdout = await execQuiet('lsof', args);
  if (stdout === undefined) throw new Error(LSOF_MISSING);
  return stdout;
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

export function isInside(dir: string | undefined, parent: string): boolean {
  if (!dir) return false;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return dir === parent || dir.startsWith(prefix);
}

// Resolves symlinks (and on macOS the letter case), so paths compare equal to the ones lsof reports.
export function realPath(dir: string): Promise<string> {
  return new Promise(resolve => fs.realpath.native(dir, (err, resolved) => resolve(err ? dir : resolved)));
}

// Groups listening sockets into one server per port, keeping only likely dev servers.
// When several processes listen on a port, the server is the one the phone would reach.
export function collectServers(processes: LsofProcess[], liveServerPort?: number): DetectedServer[] {
  const byPort = new Map<number, { pid: number; label: string; liveServer: boolean; host: string }[]>();
  for (const { pid, command, names } of processes) {
    for (const name of names) {
      const address = parseListenAddress(name);
      if (!address || address.port < MIN_DEV_PORT) continue;

      const liveServer = VS_CODE_PROCESS.test(command) && address.port === liveServerPort;
      const docker = DOCKER_PROCESS.test(command);
      if (!liveServer && !docker && !isDevProcess(command)) continue;

      const label = liveServer ? 'Live Server' : docker ? 'Docker' : command;
      const listeners = byPort.get(address.port) ?? [];
      listeners.push({ pid, label, liveServer, host: address.host });
      byPort.set(address.port, listeners);
    }
  }
  return [...byPort].map(([port, listeners]) => {
    const reachable = listeners.find(l => isLanHost(l.host));
    const { pid, label, liveServer } = reachable ?? listeners[0];
    return { port, pid, label, liveServer, lanReachable: !!reachable };
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
  { liveServerPort, workspaceFolders = [] }: { liveServerPort?: number; workspaceFolders?: string[] } = {},
): Promise<DetectedServer[]> {
  const stdout = await lsof(['-iTCP', '-sTCP:LISTEN', '-nP', '-F', 'pcn']);
  const servers = collectServers(parseLsof(stdout), liveServerPort);
  const dirs = await getWorkingDirs([...new Set(servers.map(s => s.pid))]);

  return servers
    .map(server => ({ ...server, cwd: dirs.get(server.pid) }))
    // Apps opened from the Dock or Finder (pgAdmin, Spotify…) run from "/"; dev servers never do.
    // Docker Desktop does too, but forwards the ports of containers, which often are dev servers.
    .filter(server => server.liveServer || server.label === 'Docker' || server.cwd !== '/')
    .map(server => ({
      ...server,
      inProject: server.liveServer || workspaceFolders.some(folder => isInside(server.cwd, folder)),
    }))
    .sort((a, b) => a.port - b.port);
}

// Pids currently listening on a TCP port.
export async function listeningPids(port: number): Promise<number[]> {
  const stdout = await lsof([`-iTCP:${port}`, '-sTCP:LISTEN', '-nP', '-t']);
  return stdout.split('\n').filter(Boolean).map(Number);
}

// After a restart, picks the server that the restart started: one that wasn't running before,
// runs from `dir` and is reachable, preferring the port the old server had.
export function pickRestartedServer(
  servers: DetectedServer[], { dir, oldPort, pidsBefore }: { dir: string; oldPort: number; pidsBefore: Set<number> },
): DetectedServer | undefined {
  const started = servers.filter(s => s.lanReachable && !pidsBefore.has(s.pid) && isInside(s.cwd, dir));
  return started.find(s => s.port === oldPort) ?? started[0];
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  // Executable name, without its directory.
  name: string;
}

// Parses `ps -A -o pid=,ppid=,pgid=,comm=`. On macOS comm is the executable's full path.
export function parsePs(stdout: string): Map<number, ProcessInfo> {
  const processes = new Map<number, ProcessInfo>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, comm] = match;
    processes.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), name: path.basename(comm.trim()) });
  }
  return processes;
}

export async function listProcesses(): Promise<Map<number, ProcessInfo>> {
  return parsePs((await execQuiet('ps', ['-A', '-o', 'pid=,ppid=,pgid=,comm='])) ?? '');
}

// Pid and its ancestors.
export function ancestors(pid: number, processes: Map<number, ProcessInfo>): Set<number> {
  const found = new Set<number>();
  for (let p = processes.get(pid); p && !found.has(p.pid); p = processes.get(p.ppid)) found.add(p.pid);
  return found;
}

// Listening pids that are neither in the server's job nor started by it (its workers).
export function unrelatedListeners(listening: number[], jobPids: number[], processes: Map<number, ProcessInfo>): number[] {
  const job = new Set(jobPids);
  return listening.filter(pid => ![...ancestors(pid, processes)].some(p => job.has(p)));
}

/**
 * The processes to stop so the server on `pid` stays stopped, as Ctrl+C in its terminal would:
 * the server plus the ancestors in its process group (npm, a watcher like nodemon, `next dev`…),
 * up to but not including the shell it was started from, which is returned too when there is one.
 * Never climbs into VS Code, init, or `protectedPids`.
 */
export function serverJob(pid: number, processes: Map<number, ProcessInfo>, protectedPids: Set<number>): { pids: number[]; shellPid?: number } {
  const pids = [pid];
  for (let current = processes.get(pid); current;) {
    const parent = processes.get(current.ppid);
    if (!parent || parent.pid <= 1 || protectedPids.has(parent.pid) || VS_CODE_PROCESS.test(parent.name)) break;
    // A shell with job control runs each command in its own process group.
    if (parent.pgid !== current.pgid) return { pids, shellPid: SHELL.test(parent.name) ? parent.pid : undefined };
    pids.push(parent.pid);
    current = parent;
  }
  return { pids };
}
