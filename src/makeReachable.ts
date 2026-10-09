// Helps when the chosen server only listens on localhost, so a phone can't reach it.
import * as vscode from 'vscode';
import { isDetected, type DevServer } from './servers.ts';
import { findNetworkCommand } from './restartCommand.ts';
import { restartOnNetwork } from './restart.ts';

const SHOW_ANYWAY = 'Show Anyway';

async function fixLiveServer(server: DevServer, intro: string): Promise<number | undefined> {
  const message = `${intro} Live Server needs its host setting changed to 0.0.0.0.`;
  // Only ever change it for a workspace: a global 0.0.0.0 would expose every Live Server session, on every network.
  if (!vscode.workspace.workspaceFolders) {
    const answer = await vscode.window.showWarningMessage(message,
      { modal: true, detail: 'Open the folder you\'re serving and try again, so the setting can be changed for that workspace only.' },
      SHOW_ANYWAY);
    return answer === SHOW_ANYWAY ? server.port : undefined;
  }

  const fix = 'Fix Live Server Setting';
  const answer = await vscode.window.showWarningMessage(message,
    {
      modal: true,
      detail: 'This makes Live Server reachable from any device on your network for this workspace. ' +
        'The setting is saved in the workspace settings (usually .vscode/settings.json), so take care not to commit it.',
    },
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
  if (server.kind === 'liveServer') return fixLiveServer(server, intro);
  if (server.kind === 'docker') {
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
    if (answer === restartServer) return (await restartOnNetwork(detected, restart))?.port;
    return answer === SHOW_ANYWAY ? server.port : undefined;
  }

  const answer = await vscode.window.showWarningMessage(
    `${intro} Restart it bound to all interfaces, e.g. “npm run dev -- --host” (Vite), ` +
    '“ng serve --host 0.0.0.0” or “python3 -m http.server --bind 0.0.0.0”.',
    { modal: true }, SHOW_ANYWAY);
  return answer === SHOW_ANYWAY ? server.port : undefined;
}
