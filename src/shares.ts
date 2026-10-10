// What Mobile Serve has made reachable from the network, and the decisions about it that don't need
// VS Code: what to pick up after a window reload, and how Close Mobile goes through it all.
// sharing.ts does the closing and checking itself.
import { describe } from './log.ts';

export type Share =
  // A dev server Mobile Serve restarted with its host flag. Closing restarts it with `localCommand`.
  | { kind: 'restarted'; port: number; pid: number; dir: string; localCommand: string }
  // Live Server's host setting, which Mobile Serve changed to 0.0.0.0 from `previousHost`
  // (the workspace value, undefined when it wasn't set). Closing puts it back.
  | { kind: 'liveServer'; port: number; previousHost: unknown }
  // A project's own server, which Mobile Serve started for the phone: its dev script as a VS Code
  // task, or the static server. Closing stops it.
  | { kind: 'task'; port: number; dir: string }
  | { kind: 'static'; port: number; dir: string };

// What the decisions need to know about this machine and this window.
export interface ShareChecks {
  // Pids listening on `port`. Rejects when that can't be found out (lsof failing, say).
  listeningPids(port: number): Promise<number[]>;
  // Live Server's host setting in this workspace.
  liveServerHost(): unknown;
  // Whether Live Server, in this window, still serves `port` to the network.
  liveServerOnNetwork(port: number): Promise<boolean>;
  // Whether VS Code knows the task Mobile Serve started for `port`.
  taskKnown(port: number): boolean;
  // Whether the task's server still runs from its folder, for when VS Code hasn't reconnected the task (yet).
  taskStillRunning(share: Extract<Share, { kind: 'task' }>): Promise<boolean>;
  // Whether this window runs a static server on `port`.
  staticRunning(port: number): boolean;
}

// Whether a value read back from storage is a Share.
export function isShare(value: unknown): value is Share {
  const share = value as Share | undefined;
  return typeof share?.port === 'number' && (share.kind === 'liveServer' ||
    ((share.kind === 'task' || share.kind === 'static') && typeof share.dir === 'string') ||
    (share.kind === 'restarted' && typeof share.pid === 'number' && typeof share.dir === 'string' && typeof share.localCommand === 'string'));
}

/**
 * What to do with a share from the last session, after a reload or VS Code closing without undoing
 * it: keep offering to close it, forget it, or put Live Server's host setting back straight away.
 */
export async function restoreDecision(share: Share, checks: ShareChecks): Promise<'keep' | 'forget' | 'restoreLiveServerHost'> {
  switch (share.kind) {
    case 'restarted':
      // Terminals outlive a window reload, so the server may still be running.
      try {
        return (await checks.listeningPids(share.port)).includes(share.pid) ? 'keep' : 'forget';
      } catch {
        // Can't tell, so it's forgotten rather than offered for closing.
        return 'forget';
      }
    case 'task':
      // VS Code reconnects tasks after a window reload, possibly after this runs, so the port is checked too.
      // Something else may have taken it since, which isn't Mobile Serve's to close.
      return checks.taskKnown(share.port) || await checks.taskStillRunning(share) ? 'keep' : 'forget';
    case 'static':
      // Stopped with the last window's extension host.
      return 'forget';
    case 'liveServer':
      // Mobile Serve was turned off (disabled, or updated) while Live Server kept running on the
      // network, with the setting it started with. Close Mobile stops it.
      if (await checks.liveServerOnNetwork(share.port)) return 'keep';
      // Normally undone when VS Code closes (see undoOnShutdown), so VS Code was force quit or crashed.
      // Live Server stopped with it, so the setting can go back straight away.
      return checks.liveServerHost() === '0.0.0.0' ? 'restoreLiveServerHost' : 'forget';
  }
}

// The restored shares added to the current ones, which win: something may have been shared while restoring.
export function mergeRestored(restored: Share[], current: readonly Share[]): Share[] {
  return [...restored.filter(r => !current.some(s => s.port === r.port)), ...current];
}

// Whether the share is still in place after closing it, so a close that failed early keeps offering to close it.
export async function stillShared(share: Share, checks: ShareChecks): Promise<boolean> {
  switch (share.kind) {
    case 'liveServer':
      return checks.liveServerHost() === '0.0.0.0';
    case 'task':
      // Terminating ends the task, and one VS Code no longer knows of can't be stopped from here.
      return false;
    case 'static':
      return checks.staticRunning(share.port);
    case 'restarted':
      try {
        return (await checks.listeningPids(share.port)).includes(share.pid);
      } catch {
        return true;
      }
  }
}

/**
 * Closes every share, even when one fails, removing each that's no longer in place. Then rejects
 * with what couldn't be closed, if anything.
 */
export async function closeShares(shares: readonly Share[], { close, stillShared, remove }: {
  close(share: Share): Promise<void>;
  stillShared(share: Share): Promise<boolean>;
  remove(share: Share): void;
}): Promise<void> {
  const failures: string[] = [];
  for (const share of [...shares]) {
    try {
      await close(share);
    } catch (err) {
      failures.push(`port ${share.port} (${describe(err)})`);
    } finally {
      if (!(await stillShared(share))) remove(share);
    }
  }
  if (failures.length) {
    throw new Error(`Couldn't stop sharing ${failures.join(', ')}. Click Close Mobile to try again.`);
  }
}
