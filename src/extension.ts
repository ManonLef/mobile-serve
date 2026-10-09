import * as vscode from 'vscode';
import { toDataURL } from 'qrcode';
import { findDevServers, realPath, LSOF_MISSING, type DevServer } from './servers.ts';
import { getLanAddresses, probe } from './network.ts';
import { makeReachable } from './makeReachable.ts';
import { showPanel, disposePanel } from './panel.ts';
import { registerSharing, onDidChangeShares, currentShares, closeAll } from './sharing.ts';
import type { PageUrl } from './page.ts';

const COMMAND = 'mobileServe.show';
const STOP_COMMAND = 'mobileServe.stop';
const DEFAULT_LIVE_SERVER_PORT = 5500;
// Server detection relies on lsof, which Windows doesn't have.
const CAN_DETECT_SERVERS = process.platform !== 'win32';

type ServerItem = vscode.QuickPickItem & { server?: DevServer; manual?: boolean };

// Running servers, or a message saying why they couldn't be looked for.
async function findWorkspaceServers(): Promise<{ servers: DevServer[]; problem?: string }> {
  if (!CAN_DETECT_SERVERS) return { servers: [], problem: 'Detecting servers isn\'t supported on Windows — enter a port' };
  // 0 means Live Server picks a random port, which can't be told apart from VS Code's other ports.
  const liveServerPort = vscode.workspace.getConfiguration('liveServer.settings').get<number>('port') ?? DEFAULT_LIVE_SERVER_PORT;
  try {
    const servers = await findDevServers({
      liveServerPort,
      // lsof reports real paths, so symlinked workspace folders have to be resolved to match.
      workspaceFolders: await Promise.all((vscode.workspace.workspaceFolders || []).map(folder => realPath(folder.uri.fsPath))),
    });
    return { servers, problem: servers.length ? undefined : 'No dev servers detected — enter a port' };
  } catch (err) {
    if (err instanceof Error && err.message === LSOF_MISSING) return { servers: [], problem: LSOF_MISSING };
    throw err;
  }
}

function serverItems(servers: DevServer[]): ServerItem[] {
  const inProject = servers.filter(s => s.inProject);
  const elsewhere = servers.filter(s => !s.inProject);
  const separator = (label: string): ServerItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const toItem = (server: DevServer): ServerItem => ({
    label: `$(radio-tower) ${server.port}`,
    description: server.label,
    detail: server.lanReachable ? 'Reachable from your network' : '$(warning) Listening on localhost only',
    server,
  });

  const items: ServerItem[] = [];
  if (inProject.length) items.push(separator('This project'), ...inProject.map(toItem));
  if (elsewhere.length) items.push(separator(inProject.length ? 'Other servers' : 'Running servers'), ...elsewhere.map(toItem));
  items.push(separator(''), { label: '$(edit) Enter a port…', manual: true });
  return items;
}

// Shows the list straight away and fills it in once lsof has answered.
async function chooseItem(): Promise<ServerItem | undefined> {
  const quickPick = vscode.window.createQuickPick<ServerItem>();
  quickPick.title = 'Which dev server do you want on your phone?';
  quickPick.placeholder = 'Looking for running servers…';
  quickPick.busy = true;
  quickPick.items = serverItems([]);

  let open = true;
  const choice = new Promise<ServerItem | undefined>(resolve => {
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
    quickPick.onDidHide(() => resolve(undefined));
  });
  quickPick.show();

  const filled = findWorkspaceServers().then(({ servers, problem }) => {
    if (!open) return;
    quickPick.items = serverItems(servers);
    quickPick.placeholder = problem ?? 'Running servers';
    quickPick.busy = false;
  });
  try {
    // A failed scan rejects `filled`, which ends the command with an error.
    return await Promise.race([choice, filled.then(() => choice)]);
  } finally {
    open = false;
    quickPick.dispose();
  }
}

async function pickServer(): Promise<DevServer | undefined> {
  const choice = await chooseItem();
  if (!choice) return;
  if (!choice.manual) return choice.server;

  const value = await vscode.window.showInputBox({
    prompt: 'Port number',
    validateInput: text => {
      const port = Number(text);
      return /^\d+$/.test(text) && port >= 1 && port <= 65535 ? null : 'Enter a port between 1 and 65535, like 4200';
    },
  });
  // Nothing is known about a port typed in by hand, so lanReachable stays undefined.
  return value ? { port: Number(value), label: 'Manual', kind: 'manual' } : undefined;
}

async function show(): Promise<void> {
  const addresses = await getLanAddresses();
  if (!addresses.length) {
    vscode.window.showErrorMessage('No network connection found. Connect to Wi-Fi and try again.');
    return;
  }

  const server = await pickServer();
  if (!server) return;
  const port = server.lanReachable === false ? await makeReachable(server) : server.port;
  if (!port) return;

  const { listening, https } = await probe(addresses[0].address, port);
  const scheme = https ? 'https' : 'http';
  const [first, ...rest] = addresses.map((a): PageUrl => ({ name: a.name, url: `${scheme}://${a.address}:${port}` }));
  const qr = await toDataURL(first.url, { margin: 1, width: 320 });
  showPanel({ urls: [first, ...rest], qr, listening, remoteName: vscode.env.remoteName });
}

// "Mobile" opens a server up for the phone; while Mobile Serve has opened one up, it becomes "Close Mobile".
function updateStatusBar(item: vscode.StatusBarItem): void {
  const ports = [...new Set(currentShares().map(s => s.port))];
  // Hides "Stop Sharing" from the Command Palette when there's nothing to stop.
  void vscode.commands.executeCommand('setContext', 'mobileServe.sharing', ports.length > 0);
  if (!ports.length) {
    item.text = '$(device-mobile) Mobile';
    item.tooltip = 'Show a QR code to open a local dev server on your phone';
    item.command = COMMAND;
    item.backgroundColor = undefined;
    return;
  }
  const list = ports.join(', ');
  item.text = `$(device-mobile) Close Mobile: ${list}`;
  item.tooltip = `Port ${list} is reachable from every device on your network. Click to stop sharing it.\n\n` +
    'To show the QR code again, run “Mobile Serve: Show Phone URL”.';
  item.command = STOP_COMMAND;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
}

// Runs a command, showing any error it ends with.
function reportingErrors(run: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await run();
    } catch (err) {
      vscode.window.showErrorMessage(`Mobile Serve: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  registerSharing(context);
  const item = vscode.window.createStatusBarItem('mobileServe.status', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Mobile Serve';
  updateStatusBar(item);
  item.show();

  context.subscriptions.push(
    item,
    onDidChangeShares(() => updateStatusBar(item)),
    vscode.commands.registerCommand(COMMAND, reportingErrors(show)),
    vscode.commands.registerCommand(STOP_COMMAND, reportingErrors(async () => {
      if (!currentShares().length) {
        vscode.window.showInformationMessage('Mobile Serve isn\'t sharing anything on your network.');
        return;
      }
      // The URLs stop working, so the panel goes too.
      disposePanel();
      await closeAll();
    })),
    { dispose: disposePanel },
  );
}

export function deactivate(): void {}
