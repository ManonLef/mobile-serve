// Starts a workspace folder's own server for the phone, like Live Server's Go Live: its dev script
// as a VS Code task, or the static server for a plain HTML/CSS/JS folder.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { canConnect } from './network.ts';
import { planStart, portFor, scriptArgs, type StartPlan } from './projectStart.ts';
import { realPath } from './servers.ts';
import { startStaticServer } from './staticServer.ts';
import { sleep } from './wait.ts';
import { TASK_TYPE, addShare, addStaticShare, currentShares, isLocalUri, isOurTask } from './sharing.ts';

const POLL_INTERVAL_MS = 500;
// Some dev servers (Angular's, say) take a while to compile before they listen.
const START_TIMEOUT_MS = 60000;

export interface StartOption {
  folder: vscode.WorkspaceFolder;
  plan: StartPlan;
  // Set when the folder is already started for the phone, on this port.
  sharedPort?: number;
}

// The workspace folders Mobile Serve can start, one option each.
export async function findStartOptions(): Promise<StartOption[]> {
  const options: StartOption[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (!isLocalUri(folder.uri)) continue;
    const plan = await planStart(folder.uri.fsPath);
    // Running a script from package.json needs a trusted workspace; serving files doesn't.
    if (!plan || (plan.kind === 'script' && !vscode.workspace.isTrusted)) continue;
    const shared = currentShares().find(s => (s.kind === 'task' || s.kind === 'static') && s.dir === plan.dir);
    options.push({ folder, plan, sharedPort: shared?.port });
  }
  return options;
}

async function startStatic(folder: vscode.WorkspaceFolder, dir: string, port: number): Promise<number> {
  const server = await startStaticServer(await realPath(dir), port);
  // VS Code's watcher, since Node's can't watch a folder recursively on Linux.
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
  const changed = (uri: vscode.Uri) => server.fileChanged(path.relative(dir, uri.fsPath));
  watcher.onDidChange(changed);
  watcher.onDidCreate(changed);
  watcher.onDidDelete(changed);
  addStaticShare(server.port, dir, async () => {
    watcher.dispose();
    await server.close();
  });
  return server.port;
}

/**
 * Runs the dev script as a task, and waits until it accepts connections on `host`, the address
 * the phone will use. Resolves to the port, or undefined after telling the user why it isn't up.
 */
async function startScript(
  folder: vscode.WorkspaceFolder, plan: Extract<StartPlan, { kind: 'script' }>, port: number, host: string,
): Promise<number | undefined> {
  // Quoted, or PowerShell drops the "--" that tells npm the rest is for the script.
  const args = scriptArgs(plan, port).map(arg => arg === '--' ? { value: arg, quoting: vscode.ShellQuoting.Strong } : arg);
  const task = new vscode.Task({ type: TASK_TYPE, port }, folder, `${plan.script} (phone)`, 'Mobile Serve',
    new vscode.ShellExecution(plan.packageManager, args, { cwd: plan.dir }));
  task.isBackground = true;
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: false, panel: vscode.TaskPanelKind.Dedicated };

  let ended = false;
  const onEnd = vscode.tasks.onDidEndTask(({ execution }) => {
    if (isOurTask(execution.task.definition, port)) ended = true;
  });
  try {
    const execution = await vscode.tasks.executeTask(task);
    // Recorded straight away, so Close Mobile can stop it while it starts.
    addShare({ kind: 'task', port, dir: plan.dir });

    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Starting “${plan.packageManager} run ${plan.script}” for your phone…`,
      cancellable: true,
    }, async (_progress, token) => {
      const end = Date.now() + START_TIMEOUT_MS;
      while (!ended && !token.isCancellationRequested && Date.now() < end) {
        if (await canConnect(host, port)) return port;
        await sleep(POLL_INTERVAL_MS);
      }
      if (token.isCancellationRequested) {
        execution.terminate();
      } else if (ended) {
        vscode.window.showErrorMessage(`The dev server stopped before your phone could reach it. Check the “${task.name}” terminal.`);
      } else {
        vscode.window.showErrorMessage(`The dev server isn't reachable after ${START_TIMEOUT_MS / 1000} seconds. ` +
          `It keeps starting in the “${task.name}” terminal: show the phone URL again once it's up.`);
      }
      return undefined;
    });
  } finally {
    onEnd.dispose();
  }
}

// Starts the folder for the phone (or finds it already started). Resolves to the port, or undefined if it didn't start.
export async function startOption(option: StartOption, host: string): Promise<number | undefined> {
  if (option.sharedPort !== undefined) return option.sharedPort;
  const port = await portFor(option.plan);
  return option.plan.kind === 'static'
    ? startStatic(option.folder, option.plan.dir, port)
    : startScript(option.folder, option.plan, port, host);
}
