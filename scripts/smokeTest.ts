// Runs test/smoke/run.ts (bundled to out/smoke/run.js) in real VS Code: the current release, and the
// oldest one package.json's "engines" allows. Each is downloaded once into .vscode-test/ (about 1.2 GB
// for both, safe to delete). It normally runs on GitHub instead, see .github/workflows/smoke.yml.
// Usage: npm run test:vscode [-- <version>…]. On Linux without a display, run it under xvfb-run.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const root = path.resolve();
const { engines } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const oldest = String(engines.vscode).replace(/^\^/, '');
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ['stable', oldest];
// Set in VS Code's own terminal, where it would start the downloaded VS Code as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

// A plain HTML folder to open, outside the repo so nothing gets written into it.
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-serve-smoke-'));
fs.writeFileSync(path.join(folder, 'index.html'), '<!DOCTYPE html><html><body><h1>Smoke test page</h1></body></html>');

try {
  for (const version of versions) {
    console.log(`Smoke test in VS Code ${version}…`);
    await runTests({
      version,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'out', 'smoke', 'run.js'),
      // Only Mobile Serve, and no trust prompt in front of the window.
      launchArgs: [folder, '--disable-extensions', '--disable-workspace-trust'],
    });
  }
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
