import { test } from 'node:test';
import assert from 'node:assert';
import { execQuiet } from '../src/exec.ts';

test('execQuiet keeps the output of a non-zero exit', async () => {
  assert.strictEqual(await execQuiet(process.execPath, ['-e', 'console.log("partial"); process.exit(1)']), 'partial\n');
});

test('execQuiet resolves to undefined for a program that isn\'t installed', async () => {
  assert.strictEqual(await execQuiet('mobile-serve-no-such-program', []), undefined);
});

test('execQuiet rejects when the program is killed', async () => {
  await assert.rejects(execQuiet(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")']));
});
