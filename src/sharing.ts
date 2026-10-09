// What Mobile Serve has made reachable from the network, so "Close Mobile" can undo it.
import * as vscode from 'vscode';
import { listeningPids } from './servers.ts';
import { restartLocally } from './restart.ts';

const LIVE_SERVER_SETTINGS = 'liveServer.settings';
const LIVE_SERVER_GO_OFFLINE = 'extension.liveServer.goOffline';
// How often to check that restarted servers are still running, so the status bar doesn't offer to close what's gone.
const CHECK_INTERVAL_MS = 10000;

export type Share =
  // A dev server Mobile Serve restarted with its host flag. Closing restarts it with `localCommand`.
  | { kind: 'restarted'; port: number; pid: number; dir: string; localCommand: string }
  // Live Server's host setting, which Mobile Serve changed to 0.0.0.0 from `previousHost`
  // (the workspace value, undefined when it wasn't set). Closing puts it back.
  | { kind: 'liveServer'; port: number; previousHost: unknown };

let shares: Share[] = [];
let checkTimer: ReturnType<typeof setInterval> | undefined;
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
  changed.fire();
}

export function addShare(share: Share): void {
  // One share per port: a newer one replaces what was recorded for it.
  setShares([...shares.filter(s => s.port !== share.port), share]);
}

function liveServerHost(): unknown {
  return vscode.workspace.getConfiguration(LIVE_SERVER_SETTINGS).inspect('host')?.workspaceValue;
}

// Forgets restarted servers that have stopped, or been restarted by hand.
async function dropStoppedServers(): Promise<void> {
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
  if (liveServerHost() !== '0.0.0.0') return;
  await vscode.workspace.getConfiguration(LIVE_SERVER_SETTINGS)
    .update('host', share.previousHost, vscode.ConfigurationTarget.Workspace);
  // The setting only applies when Live Server starts, so a running one has to stop.
  if (!(await listeningPids(share.port)).length) return;
  if ((await vscode.commands.getCommands(true)).includes(LIVE_SERVER_GO_OFFLINE)) {
    await vscode.commands.executeCommand(LIVE_SERVER_GO_OFFLINE);
    vscode.window.showInformationMessage('Live Server is stopped and set back to this computer only. Click Go Live to start it again.');
  } else {
    vscode.window.showWarningMessage('Live Server is set back to this computer only, but is still running on your network. Stop it and click Go Live again.');
  }
}

// Whether the share is still in place, so a close that failed early keeps offering to close it.
async function stillShared(share: Share): Promise<boolean> {
  if (share.kind === 'liveServer') return liveServerHost() === '0.0.0.0';
  try {
    return (await listeningPids(share.port)).includes(share.pid);
  } catch {
    return true;
  }
}

// Undoes everything Mobile Serve made reachable.
export async function closeAll(): Promise<void> {
  for (const share of [...shares]) {
    try {
      if (share.kind === 'restarted') await closeRestarted(share);
      else await closeLiveServer(share);
    } finally {
      if (!(await stillShared(share))) setShares(shares.filter(s => s !== share));
    }
  }
}

export function registerSharing(context: vscode.ExtensionContext): void {
  context.subscriptions.push(changed, vscode.workspace.onDidChangeConfiguration(onConfigurationChanged), {
    dispose: () => clearInterval(checkTimer),
  });
}
