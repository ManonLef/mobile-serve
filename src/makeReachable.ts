// Helps when the chosen server only listens on localhost, so a phone can't reach it.
import * as vscode from 'vscode';
import {
  findDevServers, listeningPids, listProcesses, ancestors, serverJob, getWorkingDirs, pickRestartedServer, isDetected,
  type DevServer, type DetectedServer,
} from './servers.ts';
import { findNetworkCommand } from './restartCommand.ts';

const POLL_INTERVAL_MS = 500;
const STOP_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 30000;
const TERMINAL_NAME = 'Dev server (phone)';
const SHOW_ANYWAY = 'Show Anyway';

// Calls `check` until it returns something truthy, or resolves to undefined after `timeoutMs` or on cancellation.
async function waitFor<T>(check: () => Promise<T>, timeoutMs: number, token?: vscode.CancellationToken): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !token?.isCancellationRequested) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return undefined;
}

// The VS Code terminal whose shell started the server, if it's still in the server's directory.
async function findServerTerminal(shellPid: number | undefined, dir: string): Promise<vscode.Terminal | undefined> {
  if (!shellPid) return;
  for (const terminal of vscode.window.terminals) {
    if ((await terminal.processId) !== shellPid) continue;
    const cwd = (await getWorkingDirs([shellPid])).get(shellPid);
    return cwd === dir ? terminal : undefined;
  }
  return undefined;
}

// Stops the server and starts it again in a terminal with `command`. Resolves to the new port.
function restartOnNetwork(server: DetectedServer, restart: { command: string; dir: string }): Thenable<number | undefined> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Restarting the dev server with “${restart.command}”…`,
    cancellable: true,
  }, async (_progress, token) => {
    // Check the pid still owns the port, so a pid reused by another process is never killed.
    if (!(await listeningPids(server.port)).includes(server.pid)) {
      vscode.window.showErrorMessage(`The server on port ${server.port} has already stopped. Start it with “${restart.command}”.`);
      return;
    }
    // Stop what started the server too (npm, a watcher…), as Ctrl+C would, so nothing starts it again.
    const processes = await listProcesses();
    const job = serverJob(server.pid, processes, ancestors(process.pid, processes));
    // Last point where cancelling leaves everything as it was.
    if (token.isCancellationRequested) return;
    // Outermost first, so a watcher can't restart the server in between.
    for (const pid of [...job.pids].reverse()) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already stopped.
      }
    }

    // Not cancellable: once the server has been stopped, it's always started again.
    const stopped = await waitFor(async () => (await listeningPids(server.port)).length === 0, STOP_TIMEOUT_MS);
    if (!stopped) {
      vscode.window.showErrorMessage(`Port ${server.port} is still in use. Something may have restarted the server; ` +
        `stop it yourself and run “${restart.command}”.`);
      return;
    }

    // Servers already running (an API next to the front end, say) mustn't be mistaken for the restarted one.
    const pidsBefore = new Set((await findDevServers()).map(s => s.pid));
    const terminal = await findServerTerminal(job.shellPid, restart.dir)
      ?? vscode.window.createTerminal({ name: TERMINAL_NAME, cwd: restart.dir });
    terminal.show(true);
    terminal.sendText(restart.command);

    // Cancelling only stops waiting: the server keeps starting in its terminal.
    const started = await waitFor(async () => pickRestartedServer(await findDevServers(),
      { dir: restart.dir, oldPort: server.port, pidsBefore }), START_TIMEOUT_MS, token);
    if (token.isCancellationRequested) return;
    if (!started) {
      vscode.window.showErrorMessage(`The dev server didn't become reachable within ${START_TIMEOUT_MS / 1000} seconds. ` +
        `Check the “${terminal.name}” terminal.`);
      return;
    }
    return started.port;
  });
}

async function fixLiveServer(server: DevServer, intro: string): Promise<number | undefined> {
  // Only ever change it for a workspace: a global 0.0.0.0 would expose every Live Server session, on every network.
  if (!vscode.workspace.workspaceFolders) {
    const answer = await vscode.window.showWarningMessage(
      `${intro} Live Server needs its host setting changed to 0.0.0.0.`,
      { modal: true, detail: 'Open the folder you\'re serving and try again, so the setting can be changed for that workspace only.' },
      SHOW_ANYWAY);
    return answer === SHOW_ANYWAY ? server.port : undefined;
  }

  const fix = 'Fix Live Server Setting';
  const answer = await vscode.window.showWarningMessage(
    `${intro} Live Server needs its host setting changed to 0.0.0.0.`,
    { modal: true, detail: 'This makes Live Server reachable from any device on your network for this workspace.' },
    fix, SHOW_ANYWAY);
  if (answer === fix) {
    await vscode.workspace.getConfiguration('liveServer.settings').update('host', '0.0.0.0', vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage('Live Server host set to 0.0.0.0. Stop and restart Go Live, then try again.');
    return;
  }
  return answer === SHOW_ANYWAY ? server.port : undefined;
}

// Explains why the server can't be reached and offers to fix it. Resolves to the port to show, or undefined to stop.
export async function makeReachable(server: DevServer): Promise<number | undefined> {
  const intro = 'This server only listens on localhost, so your phone can\'t reach it.';
  if (server.liveServer) return fixLiveServer(server, intro);
  if (server.label === 'Docker') {
    const answer = await vscode.window.showWarningMessage(
      `${intro} The container's port is published on 127.0.0.1 only. Publish it on all interfaces ` +
      '(for example “-p 3000:3000” instead of “-p 127.0.0.1:3000:3000”) and restart the container.',
      { modal: true }, SHOW_ANYWAY);
    return answer === SHOW_ANYWAY ? server.port : undefined;
  }

  // Restarting runs a script from the project's package.json, so only offer it in trusted workspaces.
  const detected = isDetected(server) ? server : undefined;
  const restart = detected && vscode.workspace.isTrusted ? await findNetworkCommand(detected) : undefined;
  if (detected && restart) {
    const restartServer = 'Restart Server';
    const answer = await vscode.window.showWarningMessage(
      `${intro} Restart it with “${restart.command}” to make it reachable.`,
      { modal: true, detail: 'Restarting stops the current server, as Ctrl+C in its terminal would, and starts it again with that command.' },
      restartServer, SHOW_ANYWAY);
    if (answer === restartServer) return restartOnNetwork(detected, restart);
    return answer === SHOW_ANYWAY ? server.port : undefined;
  }

  const answer = await vscode.window.showWarningMessage(
    `${intro} Restart it bound to all interfaces, e.g. “npm run dev -- --host” (Vite), ` +
    '“ng serve --host 0.0.0.0” or “python3 -m http.server --bind 0.0.0.0”.',
    { modal: true }, SHOW_ANYWAY);
  return answer === SHOW_ANYWAY ? server.port : undefined;
}
