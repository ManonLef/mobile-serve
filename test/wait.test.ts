import { test } from 'node:test';
import assert from 'node:assert';
import { waitFor } from '../src/wait.ts';

// A check that gives each of `results` in turn: a value, or an Error to throw.
const sequence = <T>(results: (T | Error)[]) => {
  let i = 0;
  return async () => {
    const result = results[Math.min(i++, results.length - 1)];
    if (result instanceof Error) throw result;
    return result;
  };
};

test('waitFor resolves to the first truthy result', async () => {
  assert.strictEqual(await waitFor(sequence([0, '', 'up']), 1000, 1), 'up');
  assert.strictEqual(await waitFor(sequence([false]), 30, 1), undefined);
});

test('waitFor keeps going after a failed check', async () => {
  assert.strictEqual(await waitFor(sequence<string>([new Error('lsof timed out'), 'up']), 1000, 1), 'up');
  // Failures in between don't count once a later check worked.
  assert.strictEqual(await waitFor(sequence([new Error('lsof timed out'), false]), 30, 1), undefined);
});

test('waitFor reports the error when the checks were still failing at the end', async () => {
  await assert.rejects(waitFor(sequence([false, new Error('lsof timed out')]), 30, 1), /lsof timed out/);
});
