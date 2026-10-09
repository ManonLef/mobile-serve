// Loads dist/extension.js the way VS Code does: from a folder without node_modules, so anything
// esbuild left as a runtime require (and the .vsix doesn't ship) fails here instead of on activation.
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-serve-bundle-'));
try {
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.copyFileSync('dist/extension.js', path.join(dir, 'dist', 'extension.js'));
  // VS Code provides the vscode module. This stand-in has the API's top-level names (esbuild copies
  // them when importing), each accepting any use while the bundle loads.
  const types = fs.readFileSync('node_modules/@types/vscode/index.d.ts', 'utf8');
  const names = [...new Set([...types.matchAll(/^\s*export (?:class|function|const|let|enum|namespace) (\w+)/gm)].map(m => m[1]))];
  const stub = path.join(dir, 'node_modules', 'vscode');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'index.js'),
    'const any = new Proxy(function () {}, { get: () => any, set: () => true, apply: () => any, construct: () => any });\n' +
    `for (const name of ${JSON.stringify(names)}) exports[name] = any;\n`);

  const load = createRequire(path.join(dir, 'dist', 'extension.js'));
  const extension = load('./extension.js');
  if (typeof extension.activate !== 'function' || typeof extension.deactivate !== 'function') {
    throw new Error('dist/extension.js doesn\'t export activate and deactivate');
  }
  // Any stand-in value works as the extension context too.
  extension.activate(load('vscode').Uri);
  extension.deactivate();
  console.log('dist/extension.js loads and activates without node_modules.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
