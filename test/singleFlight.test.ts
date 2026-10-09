import { test } from 'node:test';
import assert from 'node:assert';
import { singleFlight } from '../src/singleFlight.ts';

test('singleFlight joins a job that is still running for the same key', async () => {
  const once = singleFlight<string, number>();
  let runs = 0;
  const job = () => new Promise<number>(resolve => setTimeout(() => resolve(++runs), 10));
  assert.deepStrictEqual(await Promise.all([once('site', job), once('site', job), once('blog', job)]), [1, 1, 2]);
  // Finished jobs are forgotten, so the next call runs again.
  assert.strictEqual(await once('site', job), 3);
});

test('singleFlight shares a failure, then runs again', async () => {
  const once = singleFlight<string, number>();
  const failing = () => Promise.reject(new Error('port taken'));
  const results = await Promise.allSettled([once('site', failing), once('site', async () => 1)]);
  assert.deepStrictEqual(results.map(r => r.status), ['rejected', 'rejected']);
  assert.strictEqual(await once('site', async () => 1), 1);
});
