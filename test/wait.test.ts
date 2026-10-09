import { test } from 'node:test';
import assert from 'node:assert';
import { waitFor, waitForStart } from '../src/wait.ts';

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

test('waitFor tells the interval how long it has been waiting', async () => {
  const intervals: number[] = [];
  await waitFor(sequence([false]), 40, elapsed => {
    intervals.push(elapsed);
    return 15;
  });
  assert.ok(intervals.length >= 2, String(intervals));
  assert.ok(intervals.every((elapsed, i) => i === 0 || elapsed > intervals[i - 1]), String(intervals));
});

test('waitForStart resolves once the server listens', async () => {
  const state = { closed: false, cancelled: false, ended: false };
  assert.strictEqual(await waitForStart(sequence([false, false, true]), () => state, 1000, 10), 'listening');
  assert.strictEqual(await waitForStart(async () => false, () => state, 50, 10), 'timedOut');
});

test('waitForStart stops when the server ends, the wait is cancelled, or Close Mobile stopped it', async () => {
  for (const reason of ['closed', 'cancelled', 'ended'] as const) {
    const state = { closed: false, cancelled: false, ended: false };
    const listening = async () => {
      state[reason] = true;
      return false;
    };
    assert.strictEqual(await waitForStart(listening, () => state, 1000, 10), reason);
  }
  // Close Mobile stopping the server ends its task too, which mustn't be reported as a failure.
  const stopped = { closed: true, cancelled: false, ended: true };
  assert.strictEqual(await waitForStart(async () => false, () => stopped, 1000, 10), 'closed');
});
