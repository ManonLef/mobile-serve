// Runs inside a real VS Code, with Mobile Serve loaded and a plain HTML folder open (see
// scripts/smokeTest.ts): the extension activates, its commands exist, and Go Live's equivalent works
// end to end: pick the folder, its page is served with live reload, Stop Sharing stops it.
import * as assert from 'node:assert';
import * as http from 'node:http';
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

// What clicking Mobile and then "Start ‹folder› for your phone" does.
async function servesThePlainHtmlFolder(): Promise<void> {
  let shown = false;
  const show = Promise.resolve(vscode.commands.executeCommand('mobileServe.show')).finally(() => shown = true);
  // The picker opens once the folder has been looked at; the start option is its first item.
  for (const end = Date.now() + TIMEOUT_MS; !shown && Date.now() < end;) {
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await sleep(250);
  }
  await show;

  const page = await findServedPage();
  assert.ok(page, 'The folder isn\'t served on any port from 5600. Does this computer have a network address?');
  assert.match(page.body, /\/__mobile-serve\/reload/, 'The page has no live reload script');

  await vscode.commands.executeCommand('mobileServe.stop');
  assert.strictEqual(await getPage(page.port), undefined, `Port ${page.port} still answers after Stop Sharing`);
}

export async function run(): Promise<void> {
  const extension = await activates();
  await registersItsCommands(extension);
  await servesThePlainHtmlFolder();
  console.log('Smoke test passed.');
}
