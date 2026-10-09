// Writes dist/THIRD_PARTY_NOTICES.txt with the license of every package esbuild bundled into
// dist/extension.js. Their licenses (MIT) require the notice to ship with every copy, and
// node_modules isn't part of the .vsix. Fails when a package's license text can't be found.
import * as fs from 'node:fs';
import * as path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

const meta = JSON.parse(fs.readFileSync('dist/meta.json', 'utf8')) as { inputs: Record<string, unknown> };
const packageDirs = new Set<string>();
for (const input of Object.keys(meta.inputs)) {
  // The innermost node_modules, so nested copies of a package are listed too.
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) packageDirs.add(match[1]);
}

const sections = [...packageDirs].sort().map(dir => {
  const { name, version, license } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = fs.readdirSync(dir).find(f => LICENSE_FILE.test(f));
  if (!file) throw new Error(`No license file in ${dir}`);
  const text = fs.readFileSync(path.join(dir, file), 'utf8').trim();
  return `${name} ${version} (${license})\n\n${text}`;
});

const separator = `\n\n${'-'.repeat(72)}\n\n`;
fs.writeFileSync('dist/THIRD_PARTY_NOTICES.txt',
  `Mobile Serve bundles the following packages.${separator}${sections.join(separator)}\n`);
console.log(`Wrote notices for ${sections.length} packages.`);
