import * as vscode from 'vscode';
import { toDataURL } from 'qrcode';
import { findDevServers, realPath, LSOF_MISSING, type DevServer } from './servers.ts';
import { getLanAddresses, probe } from './network.ts';
import { makeReachable } from './makeReachable.ts';
import { showPanel, disposePanel } from './panel.ts';
import { registerSharing, onDidChangeShares, currentShares, closeAll, dropStoppedServers, undoOnShutdown } from './sharing.ts';
import { findStartOptions, startOption, type StartOption } from './start.ts';
import { describePlan } from './projectStart.ts';
import type { PageUrl } from './page.ts';

const COMMAND = 'mobileServe.show';
const STOP_COMMAND = 'mobileServe.stop';
const DEFAULT_LIVE_SERVER_PORT = 5500;
// Server detection relies on lsof, which Windows doesn't have.
const CAN_DETECT_SERVERS = process.platform !== 'win32';

type ServerItem = vscode.QuickPickItem & { server?: DevServer; start?: StartOption; manual?: boolean };
// What to show on the phone: a folder to start, or a server that's running.
type Target = { start: StartOption } | { server: DevServer };

// The port the panel offers to stop sharing, if it does.
let panelSharedPort: number | undefined;

// Servers running from the open project, or a message saying why there are none. The message is
// shown with "Enter a port", which still works.
async function findWorkspaceServers(): Promise<{ servers: DevServer[]; problem?: string }> {
  if (!CAN_DETECT_SERVERS) return { servers: [], problem: 'Detecting servers isn\'t supported on Windows' };
  // 0 means Live Server picks a random port, which can't be told apart from VS Code's other ports.
  const liveServerPort = vscode.workspace.getConfiguration('liveServer.settings').get<number>('port') ?? DEFAULT_LIVE_SERVER_PORT;
  try {
    const servers = await findDevServers({
      liveServerPort,
      // Live Server runs in this extension host, like Mobile Serve.
      extensionHostPid: process.pid,
      // lsof reports real paths, so symlinked workspace folders have to be resolved to match.
      workspaceFolders: await Promise.all((vscode.workspace.workspaceFolders || []).map(folder => realPath(folder.uri.fsPath))),
    });
    // Servers Mobile Serve started are offered through their folder instead.
    const started = new Set(currentShares().filter(s => s.kind === 'task' || s.kind === 'static').map(s => s.port));
    const inProject = servers.filter(s => s.inProject && !started.has(s.port));
    return { servers: inProject, problem: inProject.length ? undefined : 'No servers running in this project' };
  } catch (err) {
    // Starting the project or entering a port still works, so the list stays open.
    const message = err instanceof Error ? err.message : String(err);
    return { servers: [], problem: message === LSOF_MISSING ? message : `Couldn't look for running servers (${message})` };
  }
}

function startItem(option: StartOption): ServerItem {
  const { folder, plan, sharedPort } = option;
  if (sharedPort !== undefined) {
    return { label: `$(device-mobile) ${folder.name}`, description: `Shared on port ${sharedPort}`, detail: 'Show the QR code again', start: option };
  }
  return {
    label: `$(play) Start ${folder.name} for your phone`,
    description: describePlan(plan),
    detail: plan.kind === 'static'
      ? 'Reloads your phone when you save, like Go Live'
      : 'Runs in a terminal, reachable from your network',
    start: option,
  };
}

function serverItems(starts: StartOption[], servers: DevServer[], problem?: string): ServerItem[] {
  const separator = (label: string): ServerItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const toItem = (server: DevServer): ServerItem => ({
    label: `$(radio-tower) ${server.port}`,
    description: server.label,
    detail: server.lanReachable ? 'Reachable from your network' : '$(warning) Listening on localhost only',
    server,
  });

  const items = starts.map(startItem);
  if (servers.length) items.push(separator('Running in this project'), ...servers.map(toItem));
  items.push(separator(''), { label: '$(edit) Enter a port…', detail: problem, manual: true });
  return items;
}

// Shows the list straight away and fills it in once lsof has answered.
async function chooseItem(): Promise<ServerItem | undefined> {
  // Only reads package.json and index.html, so it's quick enough to wait for.
  const starts = await findStartOptions();
  const quickPick = vscode.window.createQuickPick<ServerItem>();
  quickPick.title = 'What do you want on your phone?';
  quickPick.placeholder = 'Looking for running servers…';
  quickPick.busy = true;
  quickPick.items = serverItems(starts, []);

  let open = true;
  const choice = new Promise<ServerItem | undefined>(resolve => {
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
    quickPick.onDidHide(() => resolve(undefined));
  });
  quickPick.show();

  const filled = findWorkspaceServers().then(({ servers, problem }) => {
    if (!open) return;
    quickPick.items = serverItems(starts, servers, problem);
    quickPick.placeholder = starts.length ? 'Start this project for your phone, or pick a running server'
      : servers.length ? 'Pick a running server, or enter a port'
      : 'Enter the port of a running server';
    quickPick.busy = false;
  });
  try {
    // findWorkspaceServers reports its own failures, so `filled` only rejects on a bug, which ends the command with an error.
    return await Promise.race([choice, filled.then(() => choice)]);
  } finally {
    open = false;
    quickPick.dispose();
  }
}

async function pickTarget(): Promise<Target | undefined> {
  const choice = await chooseItem();
  if (!choice) return;
  if (choice.start) return { start: choice.start };
  if (!choice.manual) return choice.server && { server: choice.server };

  const value = await vscode.window.showInputBox({
    prompt: 'Port number',
    validateInput: text => {
      const port = Number(text);
      return /^\d+$/.test(text) && port >= 1 && port <= 65535 ? null : 'Enter a port between 1 and 65535, like 4200';
    },
  });
  // Nothing is known about a port typed in by hand, so lanReachable stays undefined.
  return value ? { server: { port: Number(value), label: 'Manual', kind: 'manual' } } : undefined;
}

async function show(): Promise<void> {
  const addresses = await getLanAddresses();
  if (!addresses.length) {
    vscode.window.showErrorMessage('No network connection found. Connect to Wi-Fi and try again.');
    return;
  }

  const target = await pickTarget();
  if (!target) return;
  const port = 'start' in target ? await startOption(target.start, addresses[0].address)
    : target.server.lanReachable === false ? await makeReachable(target.server)
    : target.server.port;
  if (!port) return;

  // A server listening on one address can only be reached on that one.
  const bound = 'server' in target ? target.server.boundAddress : undefined;
  const usable = bound ? [addresses.find(a => a.address === bound) ?? { name: 'the server\'s address', address: bound }] : addresses;
  const { listening, https } = await probe(usable[0].address, port);
  const scheme = https ? 'https' : 'http';
  const [first, ...rest] = usable.map((a): PageUrl => ({ name: a.name, url: `${scheme}://${a.address}:${port}` }));
  const qr = await toDataURL(first.url, { margin: 1, width: 320 });
  // A server restarted by hand since isn't Mobile Serve's to stop, which the regular check may not have noticed yet.
  await dropStoppedServers();
  const ours = currentShares().some(s => s.port === port);
  showPanel({
    urls: [first, ...rest], qr, listening, remoteName: vscode.env.remoteName,
    sharedBy: listening ? (ours ? 'mobileServe' : 'other') : undefined,
  });
  panelSharedPort = ours ? port : undefined;
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
  const [noun, verb, pronoun] = ports.length > 1 ? ['Ports', 'are', 'them'] : ['Port', 'is', 'it'];
  item.tooltip = `${noun} ${list} ${verb} reachable from every device on your network. Click to stop sharing ${pronoun}.\n\n` +
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
    onDidChangeShares(() => {
      updateStatusBar(item);
      // Sharing ended (closed, or the server stopped), so the panel's URLs and Stop Sharing button are out of date.
      if (panelSharedPort !== undefined && !currentShares().some(s => s.port === panelSharedPort)) {
        panelSharedPort = undefined;
        disposePanel();
      }
    }),
    vscode.commands.registerCommand(COMMAND, reportingErrors(show)),
    vscode.commands.registerCommand(STOP_COMMAND, reportingErrors(async () => {
      if (!currentShares().length) {
        vscode.window.showInformationMessage('Mobile Serve isn\'t sharing anything on your network.');
        return;
      }
      // The URLs stop working, so the panel goes too.
      panelSharedPort = undefined;
      disposePanel();
      await closeAll();
    })),
    { dispose: disposePanel },
  );
}

export function deactivate(): void {
  undoOnShutdown();
}
