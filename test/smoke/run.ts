// Runs inside a real VS Code, with Mobile Serve loaded and a workspace open that has a plain HTML
// folder and a monorepo (see scripts/smokeTest.ts): the extension activates, its commands exist, and
// Go Live's equivalent works end to end: pick the folder, its page is served with live reload, Stop
// Sharing stops it. Then the monorepo's two apps are started at once, each on its own port.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vscode from 'vscode';

// Mobile Serve's static server starts on 5600, or one of the ports after it (see projectStart.ts).
const STATIC_PORTS = Array.from({ length: 20 }, (_, i) => 5600 + i);
const TIMEOUT_MS = 20000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The page on `port`, or undefined when nothing answers there.
function getPage(port: number): Promise<string | undefined> {
  return new Promise(resolve => {
    http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', chunk => body += chunk).on('end', () => resolve(body));
    }).on('error', () => resolve(undefined)).on('timeout', function (this: http.ClientRequest) {
      this.destroy();
    });
  });
}

async function findServedPage(): Promise<{ port: number; body: string } | undefined> {
  for (const port of STATIC_PORTS) {
    const body = await getPage(port);
    if (body?.includes('Smoke test page')) return { port, body };
  }
  return undefined;
}

async function activates(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'mobile-serve');
  assert.ok(extension, 'Mobile Serve isn\'t loaded');
  await extension.activate();
  assert.ok(extension.isActive);
  return extension;
}

// Every command package.json contributes is registered, so none fails with "command not found".
async function registersItsCommands(extension: vscode.Extension<unknown>): Promise<void> {
  const contributed: string[] = extension.packageJSON.contributes.commands.map((c: { command: string }) => c.command);
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const command of contributed) assert.ok(registered.has(command), `${command} isn't registered`);
}

// What clicking Mobile and then "Start ‹folder› on your network" does.
async function servesThePlainHtmlFolder(): Promise<void> {
  let open = false;
  let show: Promise<unknown> | undefined;
  let page: Awaited<ReturnType<typeof findServedPage>>;
  // The picker opens once the folders have been looked at; the start option is its first item.
  for (const end = Date.now() + TIMEOUT_MS; !(page = await findServedPage()) && Date.now() < end;) {
    if (!open) {
      // Clicked again when the picker closed with nothing picked, as a person would. It closes when
      // the window loses the focus, as it does when someone uses the computer while this runs.
      if (show) console.log('The picker closed with nothing picked, so Mobile is clicked again.');
      open = true;
      show = Promise.resolve(vscode.commands.executeCommand('mobileServe.show')).finally(() => open = false);
    }
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await sleep(250);
  }
  await show;

  assert.ok(page, 'The folder isn\'t served on any port from 5600. Does this computer have a network address?');
  assert.match(page.body, /\/__mobile-serve\/reload/, 'The page has no live reload script');

  await vscode.commands.executeCommand('mobileServe.stop');
  assert.strictEqual(await getPage(page.port), undefined, `Port ${page.port} still answers after Stop Sharing`);
}

// The tasks Mobile Serve runs dev scripts in.
const devTasks = () => vscode.tasks.taskExecutions.filter(execution => execution.task.definition.type === 'mobileServe');

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (const end = Date.now() + TIMEOUT_MS; !await done() && Date.now() < end;) await sleep(250);
}

// Clicks Mobile and picks the item `below` places under the first one, again until `picked`: the
// picker opens a moment after the command, and a test can't see when.
async function pickItem(below: number, picked: () => boolean): Promise<void> {
  for (const end = Date.now() + TIMEOUT_MS; !picked() && Date.now() < end;) {
    void vscode.commands.executeCommand('mobileServe.show');
    await sleep(2000);
    for (let i = 0; i < below; i++) await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await sleep(500);
  }
}

// The monorepo's apps come after the plain HTML folder in the picker. The second is started while
// the first isn't listening yet, when its port still looks free.
async function startsTheMonoreposAppsSideBySide(): Promise<void> {
  const monorepo = vscode.workspace.workspaceFolders?.find(folder => folder.name === 'monorepo');
  assert.ok(monorepo, 'The monorepo isn\'t a workspace folder');
  // What the stand-in dev servers wait for before they listen (see scripts/smokeTest.ts). Left
  // behind by the VS Code version tested before this one.
  const ready = path.join(monorepo.uri.fsPath, 'ready');
  fs.rmSync(ready, { force: true });
  await pickItem(1, () => devTasks().length === 1);
  await pickItem(2, () => devTasks().length === 2);

  const tasks = devTasks().map(({ task }) => ({ name: task.name, port: task.definition.port as number }));
  assert.deepStrictEqual(tasks.map(task => task.name).sort(),
    ['monorepo/apps/admin: dev (network)', 'monorepo/apps/site: dev (network)'], 'The two apps aren\'t both started');
  assert.notStrictEqual(tasks[0].port, tasks[1].port, 'Both apps were given the same port');

  fs.writeFileSync(ready, '');
  for (const { name, port } of tasks) {
    const app = name.includes('admin') ? 'admin' : 'site';
    let body: string | undefined;
    await until(async () => !!(body = await getPage(port)));
    assert.strictEqual(body, `<h1>${app}</h1>`, `Port ${port} doesn't serve ${app}`);
  }

  await vscode.commands.executeCommand('mobileServe.stop');
  await until(() => !devTasks().length);
  assert.strictEqual(devTasks().length, 0, 'The dev scripts still run after Stop Sharing');
}

export async function run(): Promise<void> {
  const extension = await activates();
  await registersItsCommands(extension);
  await servesThePlainHtmlFolder();
  await startsTheMonoreposAppsSideBySide();
  console.log('Smoke test passed.');
}
