// Starts a workspace folder's own server for the phone, like Live Server's Go Live: its dev script
// as a VS Code task, or the static server for a plain HTML/CSS/JS folder.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from './log.ts';
import { canConnect } from './network.ts';
import { describePlan, planStarts, portFor, scriptArgs, type StartPlan } from './projectStart.ts';
import { realPath } from './paths.ts';
import { singleFlight } from './singleFlight.ts';
import { startStaticServer } from './staticServer.ts';
import { waitForStart } from './wait.ts';
import { TASK_TYPE, addStaticShare, addTaskShare, currentShares, isLocalUri, isOurTask } from './sharing.ts';
import { strings } from './strings.ts';

const POLL_INTERVAL_MS = 500;
// Some dev servers (Angular's, say) take a while to compile before they listen.
const START_TIMEOUT_MS = 60000;

export interface StartOption {
  folder: vscode.WorkspaceFolder;
  // What to call it: the workspace folder's name, or the path inside it of the project that's started.
  name: string;
  plan: StartPlan;
  // Set when the folder is already started for the phone, on this port.
  sharedPort?: number;
}

export async function findStartOptions(): Promise<StartOption[]> {
  const options: StartOption[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (!isLocalUri(folder.uri)) continue;
    const plans = await planStarts(folder.uri.fsPath);
    if (!plans.length) log.debug(`${folder.name}: no dev script Mobile Serve knows, nor a plain HTML page.`);
    for (const plan of plans) {
      const name = path.relative(folder.uri.fsPath, plan.dir).split(path.sep).join('/') || folder.name;
      log.debug(`${name}: ${describePlan(plan)}.`);
      // Running a script from package.json needs a trusted workspace; serving files doesn't.
      if (plan.kind === 'script' && !vscode.workspace.isTrusted) continue;
      const shared = currentShares().find(s => (s.kind === 'task' || s.kind === 'static') && s.dir === plan.dir);
      options.push({ folder, name, plan, sharedPort: shared?.port });
    }
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
  log.info(`Serving ${dir} on port ${server.port}.`);
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
  const task = new vscode.Task({ type: TASK_TYPE, port }, folder, strings.start.taskName(plan.script), 'Mobile Serve',
    new vscode.ShellExecution(plan.packageManager, args, { cwd: plan.dir }));
  task.isBackground = true;
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: false, panel: vscode.TaskPanelKind.Dedicated };

  let ended = false;
  // Stopped with Close Mobile, which isn't a failure to report.
  let closed = false;
  const onEnd = vscode.tasks.onDidEndTask(({ execution }) => {
    if (isOurTask(execution.task.definition, port)) ended = true;
  });
  try {
    log.info(`Starting “${plan.packageManager} ${scriptArgs(plan, port).join(' ')}” in ${plan.dir}.`);
    const execution = await vscode.tasks.executeTask(task);
    // Recorded straight away, so Close Mobile can stop it while it starts.
    addTaskShare(port, plan.dir, () => closed = true);

    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: strings.start.starting(`${plan.packageManager} run ${plan.script}`),
      cancellable: true,
    }, async (_progress, token) => {
      const outcome = await waitForStart(() => canConnect(host, port),
        () => ({ closed, cancelled: token.isCancellationRequested, ended }), START_TIMEOUT_MS, POLL_INTERVAL_MS);
      log.info(`The dev server on port ${port}: ${outcome}.`);
      if (outcome === 'listening') return port;
      if (outcome === 'cancelled') {
        execution.terminate();
      } else if (outcome === 'ended') {
        vscode.window.showErrorMessage(strings.start.stoppedEarly(task.name));
      } else if (outcome === 'timedOut') {
        vscode.window.showErrorMessage(strings.start.notReachableYet(START_TIMEOUT_MS / 1000, task.name));
      }
      return undefined;
    });
  } finally {
    onEnd.dispose();
  }
}

// A folder being started, per folder: starting it again meanwhile would pick the same free port twice.
const startOnce = singleFlight<string, number | undefined>();

// Starts the folder for the phone (or finds it already started). Resolves to the port, or undefined if it didn't start.
export async function startOption(option: StartOption, host: string): Promise<number | undefined> {
  // Joins a start that's still waiting for the server, rather than showing a URL that doesn't work yet.
  return startOnce(option.plan.dir, async () => {
    if (option.sharedPort !== undefined) return option.sharedPort;
    const port = await portFor(option.plan);
    return option.plan.kind === 'static'
      ? startStatic(option.folder, option.plan.dir, port)
      : startScript(option.folder, option.plan, port, host);
  });
}
