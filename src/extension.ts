import * as vscode from 'vscode';
import { toDataURL } from 'qrcode';
import { SHOW_COMMAND, SHOW_LOG_COMMAND, STOP_COMMAND } from './commands.ts';
import { describe, log, setLogger } from './log.ts';
import { realPath } from './paths.ts';
import { findDevServers, LSOF_MISSING, type DevServer } from './servers.ts';
import { getLanAddresses, probe } from './network.ts';
import { makeReachable } from './makeReachable.ts';
import { showPanel, disposePanel } from './panel.ts';
import { registerSharing, onDidChangeShares, currentShares, closeAll, dropStoppedServers, undoOnShutdown } from './sharing.ts';
import { findStartOptions, startOption, type StartOption } from './start.ts';
import { describePlan } from './projectStart.ts';
import type { PageUrl } from './page.ts';
import { strings } from './strings.ts';

const DEFAULT_LIVE_SERVER_PORT = 5500;
// Server detection relies on lsof, which Windows doesn't have.
const CAN_DETECT_SERVERS = process.platform !== 'win32';

type ServerItem = vscode.QuickPickItem & { server?: DevServer; start?: StartOption; manual?: boolean };
type Target = { start: StartOption } | { server: DevServer };

// The port the panel offers to stop sharing, if it does.
let panelSharedPort: number | undefined;

// Servers running from the open project, or a message saying why there are none. The message is
// shown with "Enter a port", which still works.
async function findWorkspaceServers(): Promise<{ servers: DevServer[]; problem?: string }> {
  if (!CAN_DETECT_SERVERS) return { servers: [], problem: strings.picker.noDetectionOnWindows };
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
    log.debug(`Servers found: ${servers.map(s => `${s.port} ${s.label} (pid ${s.pid}, ${s.lanReachable ? 'on the network' : 'localhost only'}, ` +
      `${s.inProject ? 'in this project' : `from ${s.cwd ?? 'an unknown folder'}`})`).join('; ') || 'none'}.`);
    // Servers Mobile Serve started are offered through their folder instead.
    const started = new Set(currentShares().filter(s => s.kind === 'task' || s.kind === 'static').map(s => s.port));
    const inProject = servers.filter(s => s.inProject && !started.has(s.port));
    return { servers: inProject, problem: inProject.length ? undefined : strings.picker.noServers };
  } catch (err) {
    // Starting the project or entering a port still works, so the list stays open.
    const message = describe(err);
    log.warn(`Couldn't look for running servers: ${message}`);
    return { servers: [], problem: message === LSOF_MISSING ? message : strings.picker.detectionFailed(message) };
  }
}

function startItem(option: StartOption): ServerItem {
  const { name, plan, sharedPort } = option;
  if (sharedPort !== undefined) {
    return { label: `$(device-mobile) ${name}`, description: strings.picker.shared(sharedPort), detail: strings.picker.showAgain, start: option };
  }
  return {
    label: `$(play) ${strings.picker.start(name)}`,
    description: describePlan(plan),
    detail: plan.kind === 'static'
      ? strings.picker.staticDetail
      : strings.picker.scriptDetail,
    start: option,
  };
}

function serverItems(starts: StartOption[], servers: DevServer[], problem?: string): ServerItem[] {
  const separator = (label: string): ServerItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const toItem = (server: DevServer): ServerItem => ({
    label: `$(radio-tower) ${server.port}`,
    description: server.label,
    detail: server.lanReachable ? strings.picker.reachable : `$(warning) ${strings.picker.localhostOnly}`,
    server,
  });

  const items = starts.map(startItem);
  if (servers.length) items.push(separator(strings.picker.running), ...servers.map(toItem));
  items.push(separator(''), { label: `$(edit) ${strings.picker.enterPort}`, detail: problem, manual: true });
  return items;
}

// Shows the list straight away and fills it in once lsof has answered.
async function chooseItem(): Promise<ServerItem | undefined> {
  // Only reads package.json and index.html, in the folder or just below it, so it's quick enough to wait for.
  const starts = await findStartOptions();
  const quickPick = vscode.window.createQuickPick<ServerItem>();
  quickPick.title = strings.picker.title;
  quickPick.placeholder = strings.picker.looking;
  quickPick.busy = true;
  quickPick.items = serverItems(starts, []);

  let open = true;
  const choice = new Promise<ServerItem | undefined>(resolve => {
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
    quickPick.onDidHide(() => {
      if (open) log.debug('The list was closed with nothing picked.');
      resolve(undefined);
    });
  });
  quickPick.show();

  const filled = findWorkspaceServers().then(({ servers, problem }) => {
    if (!open) return;
    // Replacing the items moves the highlight back to the top, away from what was about to be picked.
    const active = quickPick.activeItems[0];
    quickPick.items = serverItems(starts, servers, problem);
    const same = active && quickPick.items.find(item => active.start ? item.start === active.start : !!active.manual && item.manual);
    if (same) quickPick.activeItems = [same];
    quickPick.placeholder = starts.length ? strings.picker.startOrPick
      : servers.length ? strings.picker.pickOrEnterPort
      : strings.picker.enterRunningPort;
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
    prompt: strings.picker.portPrompt,
    validateInput: text => {
      const port = Number(text);
      return /^\d+$/.test(text) && port >= 1 && port <= 65535 ? null : strings.picker.portInvalid;
    },
  });
  // Nothing is known about a port typed in by hand, so lanReachable stays undefined.
  return value ? { server: { port: Number(value), label: strings.picker.manual, kind: 'manual' } } : undefined;
}

async function show(): Promise<void> {
  const addresses = await getLanAddresses();
  if (!addresses.length) {
    log.warn('No network address found.');
    vscode.window.showErrorMessage(strings.errors.noNetwork);
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
  log.info(`Showing ${first.url}${listening ? '' : ', which doesn\'t answer from this computer'}.`);
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
    item.text = `$(device-mobile) ${strings.statusBar.show}`;
    item.tooltip = strings.statusBar.showTooltip;
    item.command = SHOW_COMMAND;
    item.backgroundColor = undefined;
    return;
  }
  item.text = `$(device-mobile) ${strings.statusBar.close(ports)}`;
  item.tooltip = strings.statusBar.closeTooltip(ports);
  item.command = STOP_COMMAND;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
}

function reportingErrors(run: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await run();
    } catch (err) {
      log.error(err instanceof Error ? err : describe(err));
      const showLog = strings.errors.showLog;
      if (await vscode.window.showErrorMessage(strings.errors.failed(describe(err)), showLog) === showLog) {
        await vscode.commands.executeCommand(SHOW_LOG_COMMAND);
      }
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  // First, so picking up shares from the last session is logged too.
  const output = vscode.window.createOutputChannel('Mobile Serve', { log: true });
  setLogger(output);
  log.info(`Mobile Serve ${context.extension.packageJSON.version} in VS Code ${vscode.version} on ${process.platform}` +
    `${vscode.env.remoteName ? `, connected to ${vscode.env.remoteName}` : ''}.`);
  context.subscriptions.push(output, { dispose: () => setLogger(undefined) });
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
    vscode.commands.registerCommand(SHOW_COMMAND, reportingErrors(show)),
    vscode.commands.registerCommand(STOP_COMMAND, reportingErrors(async () => {
      if (!currentShares().length) {
        vscode.window.showInformationMessage(strings.errors.notSharing);
        return;
      }
      // The URLs stop working, so the panel goes too.
      panelSharedPort = undefined;
      disposePanel();
      await closeAll();
    })),
    vscode.commands.registerCommand(SHOW_LOG_COMMAND, () => output.show()),
    { dispose: disposePanel },
  );
}

export function deactivate(): void {
  undoOnShutdown();
}
