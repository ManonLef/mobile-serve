// Helps when the chosen server only listens on localhost, so a phone can't reach it.
import * as vscode from 'vscode';
import { isDetected, type DevServer } from './servers.ts';
import { findNetworkCommand } from './restartCommand.ts';
import { restartOnNetwork } from './restart.ts';
import { addShare } from './sharing.ts';
import { strings } from './strings.ts';

const SHOW_ANYWAY = strings.makeReachable.showAnyway;

async function fixLiveServer(server: DevServer): Promise<number | undefined> {
  const message = strings.makeReachable.liveServer;
  // Only ever change it for a workspace: a global 0.0.0.0 would expose every Live Server session, on every network.
  if (!vscode.workspace.workspaceFolders) {
    const answer = await vscode.window.showWarningMessage(message,
      { modal: true, detail: strings.makeReachable.openFolderDetail },
      SHOW_ANYWAY);
    return answer === SHOW_ANYWAY ? server.port : undefined;
  }

  const fix = strings.makeReachable.fixLiveServer;
  const answer = await vscode.window.showWarningMessage(message,
    { modal: true, detail: strings.makeReachable.fixLiveServerDetail },
    fix, SHOW_ANYWAY);
  if (answer === fix) {
    const config = vscode.workspace.getConfiguration('liveServer.settings');
    const previousHost = config.inspect('host')?.workspaceValue;
    await config.update('host', '0.0.0.0', vscode.ConfigurationTarget.Workspace);
    // Remembered so "Close Mobile" can put it back, unless it already was 0.0.0.0 by the user's choice.
    if (previousHost !== '0.0.0.0') addShare({ kind: 'liveServer', port: server.port, previousHost });
    vscode.window.showInformationMessage(strings.makeReachable.liveServerFixed);
    return;
  }
  return answer === SHOW_ANYWAY ? server.port : undefined;
}

// Explains why the server can't be reached and offers to fix it. Resolves to the port to show, or undefined to stop.
export async function makeReachable(server: DevServer): Promise<number | undefined> {
  if (server.kind === 'liveServer') return fixLiveServer(server);

  // Restarting runs a script from the project's package.json, so only offer it in trusted workspaces.
  const detected = isDetected(server) ? server : undefined;
  const restart = detected && vscode.workspace.isTrusted ? await findNetworkCommand(detected) : undefined;
  if (detected && restart) {
    const restartServer = strings.makeReachable.restartServer;
    const answer = await vscode.window.showWarningMessage(
      strings.makeReachable.restartWith(restart.command),
      { modal: true, detail: strings.makeReachable.restartDetail },
      restartServer, SHOW_ANYWAY);
    if (answer === restartServer) {
      // Remembered so "Close Mobile" can restart it for this computer only.
      const started = await restartOnNetwork(detected, { command: restart.command, dir: restart.dir }, ({ port, pid }) =>
        addShare({ kind: 'restarted', port, pid, dir: restart.dir, localCommand: restart.localCommand }));
      return started?.port;
    }
    return answer === SHOW_ANYWAY ? server.port : undefined;
  }

  const answer = await vscode.window.showWarningMessage(strings.makeReachable.restartByHand, { modal: true }, SHOW_ANYWAY);
  return answer === SHOW_ANYWAY ? server.port : undefined;
}
