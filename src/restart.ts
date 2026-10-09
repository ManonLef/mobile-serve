// Stops a dev server, as Ctrl+C in its terminal would, and starts it again with another command.
import * as vscode from 'vscode';
import {
  findDevServers, listeningPids, listProcesses, ancestors, serverJob, unrelatedListeners, getWorkingDirs, pickRestartedServer,
  type DetectedServer,
} from './servers.ts';

const POLL_INTERVAL_MS = 500;
const STOP_TIMEOUT_MS = 5000;
// How long the progress notification waits for the restarted server.
const START_TIMEOUT_MS = 30000;
// How long to keep looking for it after that, so a slow or cancelled start is still noticed.
const START_WATCH_MS = 5 * 60000;
const TERMINAL_NAME = 'Dev server (phone)';

// A command and the folder to run it in.
export interface Run {
  command: string;
  dir: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Calls `check` until it returns something truthy, or resolves to undefined after `timeoutMs` or on cancellation.
async function waitFor<T>(check: () => Promise<T>, timeoutMs: number, token?: vscode.CancellationToken): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !token?.isCancellationRequested) {
    const result = await check();
    if (result) return result;
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

// The VS Code terminal whose shell started the server, if it's still in the server's directory.
async function findServerTerminal(shellPid: number | undefined, dir: string): Promise<vscode.Terminal | undefined> {
  if (!shellPid) return;
  for (const terminal of vscode.window.terminals) {
    if ((await terminal.processId) !== shellPid) continue;
    try {
      const cwd = (await getWorkingDirs([shellPid])).get(shellPid);
      return cwd === dir ? terminal : undefined;
    } catch {
      // A new terminal works just as well.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Stops the server on `server.port` and sends `run.command` to its terminal (or a new one).
 * Resolves to that terminal, or undefined after telling the user why it didn't happen.
 */
async function stopAndRun(
  server: { pid: number; port: number }, run: Run, token?: vscode.CancellationToken,
): Promise<vscode.Terminal | undefined> {
  // Check the pid still owns the port, so a pid reused by another process is never killed.
  const listening = await listeningPids(server.port);
  if (!listening.includes(server.pid)) {
    vscode.window.showErrorMessage(`The server on port ${server.port} has already stopped. Start it with “${run.command}”.`);
    return;
  }
  // Stop what started the server too (npm, a watcher…), the processes Ctrl+C would stop, so nothing starts it again.
  // Each gets SIGTERM rather than Ctrl+C's SIGINT, which commands a script starts in the background ignore.
  const processes = await listProcesses();
  const job = serverJob(server.pid, processes, ancestors(process.pid, processes));
  // Another process on the port (another project's server on [::1], say) would keep it busy, and isn't ours to stop.
  const others = unrelatedListeners(listening, job.pids, processes);
  if (others.length) {
    vscode.window.showErrorMessage(`Port ${server.port} is also used by another process (pid ${others.join(', ')}). ` +
      `Stop the server yourself and run “${run.command}”.`);
    return;
  }
  // Last point where cancelling leaves everything as it was.
  if (token?.isCancellationRequested) return;
  // Outermost first, so a watcher can't restart the server in between.
  for (const pid of [...job.pids].reverse()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already stopped.
    }
  }

  // From here the server is stopped, so a failure must say how to start it again.
  try {
    // Not cancellable: once the server has been stopped, it's always started again.
    const stopped = await waitFor(async () => (await listeningPids(server.port)).length === 0, STOP_TIMEOUT_MS);
    if (!stopped) {
      vscode.window.showErrorMessage(`Port ${server.port} is still in use. Something may have restarted the server; ` +
        `stop it yourself and run “${run.command}”.`);
      return;
    }
    const terminal = await findServerTerminal(job.shellPid, run.dir)
      ?? vscode.window.createTerminal({ name: TERMINAL_NAME, cwd: run.dir });
    terminal.show(true);
    terminal.sendText(run.command);
    return terminal;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`The server was stopped, but starting it again failed: ${reason}. Start it with “${run.command}”.`);
    return;
  }
}

/**
 * Restarts the server with `run.command`, which makes it listen on the network. Resolves to the
 * restarted server once it's reachable. `onStarted` is called with it too, even when it only
 * comes up after the progress notification gave up or was cancelled, since it's on the network all the same.
 */
export function restartOnNetwork(
  server: DetectedServer, run: Run, onStarted: (started: DetectedServer) => void,
): Thenable<DetectedServer | undefined> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Restarting the dev server with “${run.command}”…`,
    cancellable: true,
  }, async (_progress, token) => {
    // Servers already running (an API next to the front end, say) mustn't be mistaken for the restarted one.
    const pidsBefore = new Set((await findDevServers()).map(s => s.pid));
    pidsBefore.delete(server.pid);
    const terminal = await stopAndRun(server, run, token);
    if (!terminal) return;

    const watch = waitFor(async () => pickRestartedServer(await findDevServers(),
      { dir: run.dir, oldPort: server.port, pidsBefore }), START_WATCH_MS);
    watch.then(started => started && onStarted(started), () => {
      // Reported below while the notification waits; later failures only end the watch.
    });

    // Cancelling only stops waiting: the server keeps starting in its terminal.
    const cancelled = new Promise<'gave up'>(resolve => token.onCancellationRequested(() => resolve('gave up')));
    const timedOut = sleep(START_TIMEOUT_MS).then(() => 'gave up' as const);
    try {
      const started = await Promise.race([watch, cancelled, timedOut]);
      if (started === 'gave up' && token.isCancellationRequested) return;
      if (!started || started === 'gave up') {
        vscode.window.showErrorMessage(`The dev server didn't become reachable within ${START_TIMEOUT_MS / 1000} seconds. ` +
          `Check the “${terminal.name}” terminal.`);
        return;
      }
      return started;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`The dev server is starting again, but checking on it failed: ${reason}`);
      return;
    }
  });
}

// Restarts the server with `run.command`, which makes it listen on localhost only. Resolves to whether it did.
export function restartLocally(server: { pid: number; port: number }, run: Run): Thenable<boolean> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Restarting the dev server with “${run.command}”, for this computer only…`,
  }, async () => !!(await stopAndRun(server, run)));
}
