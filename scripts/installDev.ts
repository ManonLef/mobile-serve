// Installs the built extension into VS Code's extensions folder, to try it in everyday VS Code:
// over the copy VS Code has registered (installed from a .vsix, say), or else as mobile-serve-dev.
// Usage: npm run install-dev [-- <extensions folder>], then "Developer: Reload Window".
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// What a .vsix contains (see .vscodeignore).
const FILES = ['package.json', 'README.md', 'LICENSE', 'dist/extension.js', 'dist/THIRD_PARTY_NOTICES.txt'];
const DEV_FOLDER = 'mobile-serve-dev';

const { publisher, name } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const id = `${publisher}.${name}`.toLowerCase();
const extensionsDir = process.argv[2] ?? path.join(os.homedir(), '.vscode', 'extensions');

// The folder VS Code has registered for this extension, if it's installed.
function registeredFolder(): string | undefined {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'extensions.json'), 'utf8')) as
      { identifier?: { id?: string }; relativeLocation?: string }[];
    return installed.find(e => e.identifier?.id?.toLowerCase() === id)?.relativeLocation;
  } catch {
    return undefined;
  }
}

const folder = registeredFolder() ?? DEV_FOLDER;
const target = path.join(extensionsDir, folder);
// Put together next to it and swapped in. That changes the extensions folder's modification time,
// so VS Code reads the new package.json instead of its cached copy. VS Code skips folders starting with ".".
const staging = path.join(extensionsDir, `.${folder}-installing`);

fs.rmSync(staging, { recursive: true, force: true });
for (const file of FILES) {
  fs.mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
  fs.copyFileSync(file, path.join(staging, file));
}
// An installed .vsix keeps its manifest, which VS Code reads the extension's details from.
const manifest = path.join(target, '.vsixmanifest');
if (fs.existsSync(manifest)) fs.copyFileSync(manifest, path.join(staging, '.vsixmanifest'));
fs.rmSync(target, { recursive: true, force: true });
fs.renameSync(staging, target);

console.log(`Installed ${id} into ${target}.`);
console.log('Run “Developer: Reload Window” in each open VS Code window to load it.');
