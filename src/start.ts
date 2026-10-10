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
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => isLocalUri(folder.uri));
  const roots = new Set(folders.map(folder => folder.uri.fsPath));
  const offered = new Set<string>();
  for (const folder of folders) {
    const plans = await planStarts(folder.uri.fsPath);
    if (!plans.length) log.debug(`${folder.name}: no dev script Mobile Serve knows, nor a plain HTML page.`);
    for (const plan of plans) {
      const inside = path.relative(folder.uri.fsPath, plan.dir).split(path.sep).join('/');
      // Offered once when workspace folders overlap, and under its own name when it's one of them.
      if (offered.has(plan.dir) || (inside && roots.has(plan.dir))) continue;
      offered.add(plan.dir);
      // With several workspace folders, the path alone doesn't tell which one it's in.
      const name = !inside ? folder.name : folders.length > 1 ? `${folder.name}/${inside}` : inside;
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
  { folder, name }: StartOption, plan: Extract<StartPlan, { kind: 'script' }>, port: number, host: string,
): Promise<number | undefined> {
  // Quoted, or PowerShell drops the "--" that tells npm the rest is for the script.
  const args = scriptArgs(plan, port).map(arg => arg === '--' ? { value: arg, quoting: vscode.ShellQuoting.Strong } : arg);
  // Projects below the folder are named, as several of them may run the same script.
  const taskName = strings.start.taskName(plan.script, plan.dir === folder.uri.fsPath ? undefined : name);
  const task = new vscode.Task({ type: TASK_TYPE, port }, folder, taskName, 'Mobile Serve',
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
// The ports of starts that haven't recorded their share yet.
const startingPorts = new Set<number>();
// Ports are chosen one start at a time, or two projects started together would both take the same one.
let portChoice: Promise<unknown> = Promise.resolve();

// Whether a dev script was started on `port`. Nothing may listen there yet, so the port can look free.
function givenToStart(port: number): boolean {
  return startingPorts.has(port) || currentShares().some(s => s.kind === 'task' && s.port === port);
}

// The port to start the plan on, kept from other starts until startOption is done with it.
function reservePort(plan: StartPlan): Promise<number> {
  const choice = portChoice.then(async () => {
    const port = await portFor(plan, givenToStart);
    startingPorts.add(port);
    return port;
  });
  portChoice = choice.catch(() => undefined);
  return choice;
}

// Starts the folder for the phone (or finds it already started). Resolves to the port, or undefined if it didn't start.
export async function startOption(option: StartOption, host: string): Promise<number | undefined> {
  // Joins a start that's still waiting for the server, rather than showing a URL that doesn't work yet.
  return startOnce(option.plan.dir, async () => {
    if (option.sharedPort !== undefined) return option.sharedPort;
    const port = await reservePort(option.plan);
    try {
      return await (option.plan.kind === 'static'
        ? startStatic(option.folder, option.plan.dir, port)
        : startScript(option, option.plan, port, host));
    } finally {
      startingPorts.delete(port);
    }
  });
}
