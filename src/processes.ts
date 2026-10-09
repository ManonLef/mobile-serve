// The processes on this machine and how they started each other, to stop a dev server the way
// Ctrl+C in its terminal would (macOS and Linux only).
import * as path from 'node:path';
import { execQuiet } from './exec.ts';

// VS Code and its forks, which stopping a server never climbs into (see serverJob).
const VS_CODE_PROCESS = /^(code|electron|cursor|vscodium|codium|windsurf)\b/i;
const SHELL = /^-?(sh|bash|zsh|fish|dash|ksh|tcsh|csh|nu|pwsh)$/;

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
 * the server plus the ancestors in its process group that run its script (`scriptPids`, see
 * runningSameScript) and the package manager that ran it, up to but not including the shell it was
 * started from, which is returned too when there is one. Never climbs into VS Code, init,
 * `protectedPids`, or a tool running several scripts at once (concurrently, turbo…).
 */
export function serverJob(
  pid: number, processes: Map<number, ProcessInfo>, protectedPids: Set<number>, scriptPids: Set<number>,
): { pids: number[]; shellPid?: number } {
  const pids = [pid];
  for (let current = processes.get(pid); current;) {
    const parent = processes.get(current.ppid);
    if (!parent || parent.pid <= 1 || protectedPids.has(parent.pid) || VS_CODE_PROCESS.test(parent.name)) break;
    // A shell with job control runs each command in its own process group.
    if (parent.pgid !== current.pgid) return { pids, shellPid: SHELL.test(parent.name) ? parent.pid : undefined };
    // `current` is the package manager that ran the script, so `parent` started it as part of something
    // bigger, which may be running other servers too. Stopping the script ends `current` anyway.
    if (!scriptPids.has(current.pid)) break;
    pids.push(parent.pid);
    current = parent;
  }
  return { pids };
}
