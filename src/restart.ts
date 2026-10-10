// Stops a dev server, as Ctrl+C in its terminal would, and starts it again with another command.
import * as vscode from 'vscode';
import { describe, log } from './log.ts';
import { listProcesses, ancestors, serverJob, unrelatedListeners } from './processes.ts';
import { findDevServers, listeningPids, getWorkingDirs, pickRestartedServer, type DetectedServer } from './servers.ts';
import { runningSameScript } from './restartCommand.ts';
import { waitFor } from './wait.ts';

const STOP_TIMEOUT_MS = 5000;
// How long the progress notification waits for the restarted server.
const START_TIMEOUT_MS = 30000;
// How long to keep looking for it after that, so a slow or cancelled start is still noticed.
const START_WATCH_MS = 5 * 60000;
// How often to look while the notification waits, and after it gave up.
const START_POLL_MS = 500;
const SLOW_POLL_MS = 5000;
const TERMINAL_NAME = 'Dev server (phone)';

export interface Run {
  command: string;
  dir: string;
}

// Ports whose server is being stopped and started again, so it isn't done twice at once.
const restarting = new Set<number>();

// The VS Code terminal whose shell started the server, if it's still in the server's directory.
async function findServerTerminal(shellPid: number | undefined, dir: string): Promise<vscode.Terminal | undefined> {
  if (!shellPid) return;
  for (const terminal of vscode.window.terminals) {
    if ((await terminal.processId) !== shellPid) continue;
    try {
      const cwd = (await getWorkingDirs([shellPid])).get(shellPid);
      return cwd === dir ? terminal : undefined;
    } catch (err) {
      // A new terminal works just as well.
      log.debug(`Couldn't read the terminal shell's folder: ${describe(err)}`);
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
  if (restarting.has(server.port)) {
    vscode.window.showInformationMessage(`The server on port ${server.port} is already restarting.`);
    return;
  }
  restarting.add(server.port);
  try {
    return await stopAndRunOnce(server, run, token);
  } finally {
    restarting.delete(server.port);
  }
}

// stopAndRun, for a port no other restart is busy with.
async function stopAndRunOnce(
  server: { pid: number; port: number }, run: Run, token?: vscode.CancellationToken,
): Promise<vscode.Terminal | undefined> {
  // Check the pid still owns the port, so a pid reused by another process is never killed.
  const listening = await listeningPids(server.port);
  if (!listening.includes(server.pid)) {
    log.warn(`Not restarting port ${server.port}: pid ${server.pid} no longer listens on it (${listening.join(', ') || 'nothing'} does).`);
    vscode.window.showErrorMessage(`The server on port ${server.port} has already stopped. Start it with “${run.command}”.`);
    return;
  }
  // Stop what started the server too (npm, a watcher…), the processes Ctrl+C would stop, so nothing starts it again.
  // Each gets SIGTERM rather than Ctrl+C's SIGINT, which commands a script starts in the background ignore.
  const processes = await listProcesses();
  const job = serverJob(server.pid, processes, ancestors(process.pid, processes), await runningSameScript(server.pid, processes));
  // Another process on the port (another project's server on [::1], say) would keep it busy, and isn't ours to stop.
  const others = unrelatedListeners(listening, job.pids, processes);
  log.info(`Port ${server.port}: stopping pids ${job.pids.join(', ')}, started from ${job.shellPid ? `shell ${job.shellPid}` : 'no shell found'}.`);
  if (others.length) {
    log.warn(`Not restarting port ${server.port}: pids ${others.join(', ')} listen on it too.`);
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
    } catch (err) {
      // Already stopped.
      log.debug(`Couldn't stop pid ${pid}: ${describe(err)}`);
    }
  }

  // From here the server is stopped, so a failure must say how to start it again.
  try {
    // Not cancellable: once the server has been stopped, it's always started again.
    const stopped = await waitFor(async () => (await listeningPids(server.port)).length === 0, STOP_TIMEOUT_MS);
    if (!stopped) {
      log.warn(`Port ${server.port} is still in use ${STOP_TIMEOUT_MS / 1000} seconds after stopping the server.`);
      vscode.window.showErrorMessage(`Port ${server.port} is still in use. Something may have restarted the server; ` +
        `stop it yourself and run “${run.command}”.`);
      return;
    }
    const terminal = await findServerTerminal(job.shellPid, run.dir)
      ?? vscode.window.createTerminal({ name: TERMINAL_NAME, cwd: run.dir });
    log.info(`Running “${run.command}” in ${terminal.name === TERMINAL_NAME ? 'a new terminal' : `the terminal “${terminal.name}”`}.`);
    terminal.show(true);
    terminal.sendText(run.command);
    return terminal;
  } catch (err) {
    const reason = describe(err);
    log.error(`Port ${server.port} was stopped, but starting it again failed: ${reason}`);
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
      { dir: run.dir, oldPort: server.port, pidsBefore }), START_WATCH_MS,
    elapsed => elapsed < START_TIMEOUT_MS ? START_POLL_MS : SLOW_POLL_MS);
    watch.then(started => {
      log.info(started ? `The restarted server is on port ${started.port}, pid ${started.pid}.` : `The restarted server on port ${server.port} didn't show up.`);
      if (started) onStarted(started);
    }, err => {
      // Checks only fail for good after the notification is gone (see waitFor), which ends the watch.
      log.warn(`Stopped looking for the restarted server: ${describe(err)}`);
    });

    // Cancelling only stops waiting: the server keeps starting in its terminal.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onCancel: vscode.Disposable | undefined;
    const gaveUp = new Promise<'gave up'>(resolve => {
      timer = setTimeout(() => resolve('gave up'), START_TIMEOUT_MS);
      onCancel = token.onCancellationRequested(() => resolve('gave up'));
    });
    try {
      const started = await Promise.race([watch, gaveUp]);
      if (started === 'gave up' && token.isCancellationRequested) return;
      if (!started || started === 'gave up') {
        vscode.window.showErrorMessage(`The dev server didn't become reachable within ${START_TIMEOUT_MS / 1000} seconds. ` +
          `Check the “${terminal.name}” terminal.`);
        return;
      }
      return started;
    } finally {
      clearTimeout(timer);
      onCancel?.dispose();
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
