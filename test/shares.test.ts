import { test } from 'node:test';
import assert from 'node:assert';
import { closeShares, isShare, mergeRestored, restoreDecision, stillShared, type Share, type ShareChecks } from '../src/shares.ts';

const restarted: Share = { kind: 'restarted', port: 5173, pid: 42, dir: '/app', localCommand: 'npm run dev' };
const liveServer: Share = { kind: 'liveServer', port: 5500, previousHost: undefined };
const task: Share = { kind: 'task', port: 4200, dir: '/app' };
const staticShare: Share = { kind: 'static', port: 5600, dir: '/site' };

// A machine where nothing runs any more, with `overrides` saying what does.
const checks = (overrides: Partial<ShareChecks> = {}): ShareChecks => ({
  listeningPids: async () => [],
  liveServerHost: () => undefined,
  liveServerOnNetwork: async () => false,
  taskKnown: () => false,
  taskStillRunning: async () => false,
  staticRunning: () => false,
  ...overrides,
});
const lsofFails = async (): Promise<number[]> => {
  throw new Error('lsof failed');
};

test('isShare accepts what Mobile Serve saves, and nothing else', () => {
  for (const share of [restarted, liveServer, task, staticShare]) assert.ok(isShare(share), share.kind);
  for (const value of [
    undefined, null, 'share', {}, { kind: 'task', port: '4200', dir: '/app' }, { kind: 'task', port: 4200 },
    { kind: 'restarted', port: 5173, pid: 42, dir: '/app' }, { kind: 'unknown', port: 1 },
  ]) {
    assert.ok(!isShare(value), JSON.stringify(value));
  }
});

test('restoreDecision keeps a restarted server only while the same process still listens', async () => {
  assert.strictEqual(await restoreDecision(restarted, checks({ listeningPids: async () => [42] })), 'keep');
  // Restarted by hand since: another pid on the port isn't Mobile Serve's to close.
  assert.strictEqual(await restoreDecision(restarted, checks({ listeningPids: async () => [43] })), 'forget');
  assert.strictEqual(await restoreDecision(restarted, checks({ listeningPids: lsofFails })), 'forget');
});

test('restoreDecision keeps a task VS Code reconnected, or whose server still runs from its folder', async () => {
  assert.strictEqual(await restoreDecision(task, checks({ taskKnown: () => true })), 'keep');
  assert.strictEqual(await restoreDecision(task, checks({ taskStillRunning: async () => true })), 'keep');
  assert.strictEqual(await restoreDecision(task, checks()), 'forget');
});

test('restoreDecision forgets static servers, which stopped with the last window', async () => {
  assert.strictEqual(await restoreDecision(staticShare, checks({ staticRunning: () => true })), 'forget');
});

test('restoreDecision keeps Live Server on the network, and puts the setting back after a crash', async () => {
  assert.strictEqual(await restoreDecision(liveServer, checks({ liveServerOnNetwork: async () => true })), 'keep');
  // VS Code crashed: Live Server stopped, but the setting is still the one Mobile Serve wrote.
  assert.strictEqual(await restoreDecision(liveServer, checks({ liveServerHost: () => '0.0.0.0' })), 'restoreLiveServerHost');
  // Already put back, by VS Code closing normally or by hand.
  assert.strictEqual(await restoreDecision(liveServer, checks({ liveServerHost: () => '127.0.0.1' })), 'forget');
});

test('mergeRestored keeps what was shared while restoring', () => {
  const sharedMeanwhile: Share = { kind: 'static', port: 5173, dir: '/other' };
  assert.deepStrictEqual(mergeRestored([restarted, task], [sharedMeanwhile]), [task, sharedMeanwhile]);
});

test('stillShared tells what a close left in place', async () => {
  assert.strictEqual(await stillShared(liveServer, checks({ liveServerHost: () => '0.0.0.0' })), true);
  assert.strictEqual(await stillShared(liveServer, checks()), false);
  assert.strictEqual(await stillShared(task, checks({ taskKnown: () => true })), false);
  assert.strictEqual(await stillShared(staticShare, checks({ staticRunning: () => true })), true);
  assert.strictEqual(await stillShared(restarted, checks({ listeningPids: async () => [42] })), true);
  assert.strictEqual(await stillShared(restarted, checks()), false);
  // When lsof can't tell, Close Mobile keeps offering to close it.
  assert.strictEqual(await stillShared(restarted, checks({ listeningPids: lsofFails })), true);
});

test('closeShares closes everything, removes what is gone, and reports what failed', async () => {
  const closed: number[] = [];
  const removed: number[] = [];
  const closing = closeShares([restarted, liveServer, task], {
    close: async share => {
      closed.push(share.port);
      if (share.kind === 'liveServer') throw new Error('settings are read-only');
    },
    // The failed Live Server close left its setting in place.
    stillShared: async share => share.kind === 'liveServer',
    remove: share => removed.push(share.port),
  });
  await assert.rejects(closing, { message: 'Couldn\'t stop sharing port 5500 (settings are read-only). Click Close Mobile to try again.' });
  assert.deepStrictEqual(closed, [5173, 5500, 4200]);
  assert.deepStrictEqual(removed, [5173, 4200]);
});

test('closeShares removes a share that failed to close but is gone all the same', async () => {
  const removed: number[] = [];
  await assert.rejects(closeShares([restarted], {
    close: async () => {
      throw new Error('restart failed');
    },
    stillShared: async () => false,
    remove: share => removed.push(share.port),
  }));
  assert.deepStrictEqual(removed, [5173]);
});
