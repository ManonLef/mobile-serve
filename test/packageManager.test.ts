import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectPackageManager, runScriptArgs } from '../src/packageManager.ts';

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

test('runScriptArgs passes flags to the script, with "--" for npm', () => {
  assert.deepStrictEqual(runScriptArgs('npm', 'dev', ['--host']), ['run', 'dev', '--', '--host']);
  assert.deepStrictEqual(runScriptArgs('pnpm', 'dev', ['--host']), ['run', 'dev', '--host']);
  assert.deepStrictEqual(runScriptArgs('npm', 'dev', []), ['run', 'dev']);
});
