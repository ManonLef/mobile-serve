// What Mobile Serve has made reachable from the network, so "Close Mobile" can undo it.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { canConnect, getLanAddresses } from './network.ts';
import { realPath } from './paths.ts';
import { listeningPids, listensFrom } from './servers.ts';
import { restartLocally } from './restart.ts';
import { restoreSettingInFile } from './settingsFile.ts';
import { closeShares, isShare, mergeRestored, restoreDecision, stillShared, type Share, type ShareChecks } from './shares.ts';

// Where shares are kept, so a window reload or a force quit doesn't lose track of them.
const STATE_KEY = 'mobileServe.shares';
const LIVE_SERVER_SETTINGS = 'liveServer.settings';
const LIVE_SERVER_GO_OFFLINE = 'extension.liveServer.goOffline';
// How often to check that restarted servers are still running, so the status bar doesn't offer to close what's gone.
const CHECK_INTERVAL_MS = 10000;
// The type of the tasks that run a project's dev script for the phone (see package.json).
export const TASK_TYPE = 'mobileServe';

let shares: Share[] = [];
let state: vscode.Memento | undefined;
let checkTimer: ReturnType<typeof setInterval> | undefined;
// Stops each static server. They run inside the extension host, so they end with this window.
const staticServers = new Map<number, () => Promise<void>>();
// Told when Close Mobile stops a task, so a start still waiting for it doesn't report a failure.
const taskClosers = new Map<number, () => void>();
const changed = new vscode.EventEmitter<void>();
export const onDidChangeShares = changed.event;

export function currentShares(): readonly Share[] {
  return shares;
}

function setShares(next: Share[]): void {
  shares = next;
  const restarted = shares.some(s => s.kind === 'restarted');
  if (restarted && !checkTimer) checkTimer = setInterval(() => void dropStoppedServers(), CHECK_INTERVAL_MS);
  if (!restarted && checkTimer) {
    clearInterval(checkTimer);
    checkTimer = undefined;
  }
  void state?.update(STATE_KEY, shares);
  changed.fire();
}

export function addShare(share: Share): void {
  // One share per port: a newer one replaces what was recorded for it.
  setShares([...shares.filter(s => s.port !== share.port), share]);
}

export function addStaticShare(port: number, dir: string, stop: () => Promise<void>): void {
  staticServers.set(port, stop);
  addShare({ kind: 'static', port, dir });
}

export function addTaskShare(port: number, dir: string, onClose: () => void): void {
  taskClosers.set(port, onClose);
  addShare({ kind: 'task', port, dir });
}

// Whether a task is the one Mobile Serve started for `port`.
export function isOurTask(definition: vscode.TaskDefinition, port: number): boolean {
  return definition.type === TASK_TYPE && definition.port === port;
}

function findTask(port: number): vscode.TaskExecution | undefined {
  return vscode.tasks.taskExecutions.find(execution => isOurTask(execution.task.definition, port));
}

// Whether the extension can read the files at `uri`. Over Remote SSH, WSL or in a container it runs
// on that machine, where the files are.
export function isLocalUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || (uri.scheme === 'vscode-remote' && !!vscode.env.remoteName);
}

function liveServerHost(): unknown {
  return vscode.workspace.getConfiguration(LIVE_SERVER_SETTINGS).inspect('host')?.workspaceValue;
}

function setLiveServerHost(host: unknown): Thenable<void> {
  return vscode.workspace.getConfiguration(LIVE_SERVER_SETTINGS).update('host', host, vscode.ConfigurationTarget.Workspace);
}

/**
 * The file workspace settings are saved in, and the path of Live Server's host setting inside it.
 * Undefined for an untitled multi-root workspace, which has no file yet.
 */
function liveServerHostLocation(): { file: string; jsonPath: string[] } | undefined {
  const key = `${LIVE_SERVER_SETTINGS}.host`;
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile) return isLocalUri(workspaceFile) ? { file: workspaceFile.fsPath, jsonPath: ['settings', key] } : undefined;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && isLocalUri(folder.uri) ? { file: path.join(folder.uri.fsPath, '.vscode', 'settings.json'), jsonPath: [key] } : undefined;
}

// Forgets restarted servers that have stopped, or been restarted by hand.
export async function dropStoppedServers(): Promise<void> {
  const stopped: Share[] = [];
  for (const share of shares) {
    if (share.kind !== 'restarted') continue;
    try {
      if (!(await listeningPids(share.port)).includes(share.pid)) stopped.push(share);
    } catch {
      // Checked again next time.
    }
  }
  // Only removes what was found stopped: shares may have been added while lsof ran.
  if (stopped.length) setShares(shares.filter(s => !stopped.includes(s)));
}

// Forgets the Live Server share when its setting is no longer the one Mobile Serve wrote.
function onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
  if (!event.affectsConfiguration(`${LIVE_SERVER_SETTINGS}.host`) || liveServerHost() === '0.0.0.0') return;
  if (shares.some(s => s.kind === 'liveServer')) setShares(shares.filter(s => s.kind !== 'liveServer'));
}

async function closeRestarted(share: Extract<Share, { kind: 'restarted' }>): Promise<void> {
  // Already stopped, or restarted by hand: nothing of ours is left to close.
  if (!(await listeningPids(share.port)).includes(share.pid)) return;
  if (await restartLocally(share, { command: share.localCommand, dir: share.dir })) {
    vscode.window.showInformationMessage(`The dev server is starting again for this computer only (“${share.localCommand}”).`);
  }
}

async function closeLiveServer(share: Extract<Share, { kind: 'liveServer' }>): Promise<void> {
  // Already back when Live Server kept running after Mobile Serve was turned off (see restoreShares).
  if (liveServerHost() === '0.0.0.0') await setLiveServerHost(share.previousHost);
  // The setting only applies when Live Server starts, so a running one has to stop.
  if (!(await listeningPids(share.port)).length) return;
  if ((await vscode.commands.getCommands(true)).includes(LIVE_SERVER_GO_OFFLINE)) {
    await vscode.commands.executeCommand(LIVE_SERVER_GO_OFFLINE);
    vscode.window.showInformationMessage('Live Server is stopped and set back to this computer only. Click Go Live to start it again.');
  } else {
    vscode.window.showWarningMessage('Live Server is set back to this computer only, but is still running on your network. Stop it and click Go Live again.');
  }
}

function closeTask(share: Extract<Share, { kind: 'task' }>): void {
  const execution = findTask(share.port);
  taskClosers.get(share.port)?.();
  taskClosers.delete(share.port);
  if (execution) {
    execution.terminate();
  } else {
    // Started before a window reload that VS Code didn't reconnect the task after.
    vscode.window.showWarningMessage(`Mobile Serve can't stop the server on port ${share.port}. Stop it in its terminal with Ctrl+C.`);
  }
}

async function closeStatic(share: Extract<Share, { kind: 'static' }>): Promise<void> {
  const stop = staticServers.get(share.port);
  staticServers.delete(share.port);
  await stop?.();
}

// The close in progress. Clicking Close Mobile again while it runs would close (and restart) servers twice.
let closing: Promise<void> | undefined;

// Undoes everything Mobile Serve made reachable. Joins the close in progress, if there is one.
export function closeAll(): Promise<void> {
  closing ??= closeShares(shares, {
    close: closeShare,
    stillShared: share => stillShared(share, checks),
    remove: share => setShares(shares.filter(s => s !== share)),
  }).finally(() => closing = undefined);
  return closing;
}

async function closeShare(share: Share): Promise<void> {
  if (share.kind === 'restarted') await closeRestarted(share);
  else if (share.kind === 'liveServer') await closeLiveServer(share);
  else if (share.kind === 'task') closeTask(share);
  else await closeStatic(share);
}

// Whether Live Server, which runs in this extension host, still serves `port` to the network.
async function liveServerOnNetwork(port: number): Promise<boolean> {
  try {
    if (!(await listeningPids(port)).includes(process.pid)) return false;
  } catch {
    return false;
  }
  const [address] = await getLanAddresses();
  return !!address && await canConnect(address.address, port);
}

// Whether the task's server still runs from its folder, for when VS Code hasn't reconnected the task (yet).
// Without lsof (on Windows), any server on the port counts.
async function taskStillRunning(share: Extract<Share, { kind: 'task' }>): Promise<boolean> {
  try {
    return await listensFrom(share.port, await realPath(share.dir));
  } catch {
    return canConnect('127.0.0.1', share.port);
  }
}

const checks: ShareChecks = {
  listeningPids,
  liveServerHost,
  liveServerOnNetwork,
  taskKnown: port => !!findTask(port),
  taskStillRunning,
  staticRunning: port => staticServers.has(port),
};

// Picks up shares from the last session: after a reload, or VS Code closing without undoing them.
async function restoreShares(saved: Share[]): Promise<void> {
  const kept: Share[] = [];
  for (const share of saved) {
    const decision = await restoreDecision(share, checks);
    if (decision === 'keep') {
      kept.push(share);
    } else if (decision === 'restoreLiveServerHost' && share.kind === 'liveServer') {
      try {
        await setLiveServerHost(share.previousHost);
        vscode.window.showInformationMessage('Mobile Serve set Live Server back to this computer only: VS Code closed while it was shared on your network.');
      } catch {
        // Kept, so Close Mobile still offers to undo it.
        kept.push(share);
      }
    }
  }
  setShares(mergeRestored(kept, shares));
}

/**
 * Called from deactivate(). Live Server stops when VS Code closes, so its setting goes back too.
 * The settings API can't be relied on during shutdown, so the file is edited directly; if that
 * isn't possible, restoreShares undoes it on the next start. When only Mobile Serve stops (it was
 * disabled or updated), Live Server keeps running: restoreShares then has Close Mobile offer to stop it.
 */
export function undoOnShutdown(): void {
  const share = shares.find(s => s.kind === 'liveServer');
  const location = liveServerHostLocation();
  if (!share || !location) return;
  try {
    restoreSettingInFile(location.file, location.jsonPath, '0.0.0.0', share.previousHost);
  } catch {
    // Undone on the next start instead.
  }
}

export function registerSharing(context: vscode.ExtensionContext): void {
  state = context.workspaceState;
  const saved = state.get<unknown>(STATE_KEY);
  if (Array.isArray(saved)) void restoreShares(saved.filter(isShare));
  context.subscriptions.push(
    changed,
    vscode.workspace.onDidChangeConfiguration(onConfigurationChanged),
    // The task ended: stopped from here, with Ctrl+C or by closing its terminal, or the server failed.
    vscode.tasks.onDidEndTask(({ execution }) => {
      const ended = shares.filter(s => s.kind === 'task' && isOurTask(execution.task.definition, s.port));
      for (const share of ended) taskClosers.delete(share.port);
      if (ended.length) setShares(shares.filter(s => !ended.includes(s)));
    }),
    {
      dispose: () => {
        clearInterval(checkTimer);
        for (const stop of staticServers.values()) void stop();
      },
    },
  );
}
