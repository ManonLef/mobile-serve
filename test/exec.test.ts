import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execOutput, execQuiet } from '../src/exec.ts';

test('execQuiet keeps the output of a non-zero exit', async () => {
  assert.strictEqual(await execQuiet(process.execPath, ['-e', 'console.log("partial"); process.exit(1)']), 'partial\n');
});

test('execQuiet resolves to undefined for a program that isn\'t installed', async () => {
  assert.strictEqual(await execQuiet('mobile-serve-no-such-program', []), undefined);
});

test('execQuiet rejects when the program is killed', async () => {
  await assert.rejects(execQuiet(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")']));
});

test('execOutput reports stderr and the exit code', async () => {
  assert.deepStrictEqual(
    await execOutput(process.execPath, ['-e', 'console.error("lsof: illegal option"); process.exit(1)']),
    { stdout: '', stderr: 'lsof: illegal option\n', code: 1 });
});

test('execOutput finds a program outside the PATH in the system folders', { skip: process.platform === 'win32' && 'uses a shell script' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-serve-bin-'));
  try {
    await fs.writeFile(path.join(dir, 'mobile-serve-fake-lsof'), '#!/bin/sh\necho found "$1"\n', { mode: 0o755 });
    assert.deepStrictEqual(await execOutput('mobile-serve-fake-lsof', ['-n'], ['/no/such/dir', dir]), { stdout: 'found -n\n', stderr: '', code: 0 });
    assert.strictEqual(await execOutput('mobile-serve-no-such-program', [], [dir]), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
