// Runs test/smoke/run.ts (bundled to out/smoke/run.js) in real VS Code: the current release, and the
// oldest one package.json's "engines" allows. Each is downloaded once into .vscode-test/ (about 1.2 GB
// for both, safe to delete). It normally runs on GitHub instead, see .github/workflows/smoke.yml.
// Usage: npm run test:vscode [-- <version>…]. On Linux without a display, run it under xvfb-run.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const root = path.resolve();
const { engines, publisher, name } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const oldest = String(engines.vscode).replace(/^\^/, '');
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ['stable', oldest];
// Set in VS Code's own terminal, where it would start the downloaded VS Code as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

// A stand-in for a dev server, so the smoke test needs no install: it listens on --port once the
// test has made the "ready" file in the monorepo, which is after it has started both apps.
const DEV_SERVER = `const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const ready = path.join(__dirname, '..', '..', 'ready');
const timer = setInterval(() => {
  if (!fs.existsSync(ready)) return;
  clearInterval(timer);
  http.createServer((_req, res) => res.end('<h1>' + path.basename(__dirname) + '</h1>'))
    .listen(port, args.includes('--host') ? '0.0.0.0' : '127.0.0.1');
}, 200);
`;

// What's opened, outside the repo so nothing gets written into it: a workspace with a plain HTML
// folder, and a monorepo with two apps that are started side by side.
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-serve-smoke-'));
fs.mkdirSync(path.join(folder, 'page'));
fs.writeFileSync(path.join(folder, 'page', 'index.html'), '<!DOCTYPE html><html><body><h1>Smoke test page</h1></body></html>');
for (const app of ['admin', 'site']) {
  const dir = path.join(folder, 'monorepo', 'apps', app);
  fs.mkdirSync(dir, { recursive: true });
  // "vite" is what makes Mobile Serve take it for a dev script; server.js ignores it.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, scripts: { dev: 'node server.js vite' } }));
  fs.writeFileSync(path.join(dir, 'server.js'), DEV_SERVER);
}
const workspace = path.join(folder, 'smoke.code-workspace');
fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: 'page' }, { path: 'monorepo' }] }));

// What Mobile Serve logged in the VS Code that ran last, which is what tells why a test failed.
function extensionLog(): string {
  try {
    const logs = path.join(root, '.vscode-test', 'user-data', 'logs');
    // Each run's folder is named after the time it started.
    const last = (fs.readdirSync(logs, { recursive: true }) as string[]).filter(file => path.basename(file) === 'Mobile Serve.log').sort().at(-1);
    return last ? fs.readFileSync(path.join(logs, last), 'utf8') : 'Mobile Serve logged nothing.';
  } catch (err) {
    return `Couldn't read Mobile Serve's log: ${err}`;
  }
}

try {
  for (const version of versions) {
    console.log(`Smoke test in VS Code ${version}…`);
    try {
      await runTests({
        version,
        extensionDevelopmentPath: root,
        extensionTestsPath: path.join(root, 'out', 'smoke', 'run.js'),
        // Only Mobile Serve, logging everything, and no trust prompt in front of the window.
        launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--log', `${publisher}.${name}:debug`],
      });
    } catch (err) {
      console.error(`Mobile Serve's log:\n${extensionLog()}`);
      throw err;
    }
  }
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
