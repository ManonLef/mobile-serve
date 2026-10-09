import { test } from 'node:test';
import assert from 'node:assert';
import { parsePs, serverJob, unrelatedListeners } from '../src/processes.ts';

test('serverJob stops the job up to the terminal shell, never VS Code', () => {
  const processes = parsePs([
    '    1     0     1 /sbin/launchd',
    '  100     1   100 /Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (Plugin)',
    '  200   100   200 -zsh',
    '  300   200   300 npm run dev',
    '  301   300   300 sh',
    '  302   301   300 node',
    '  400   100   100 node',
  ].join('\n'));
  // 302 and the sh around it run the dev script; npm (300) ran it.
  const script = new Set([302, 301]);
  assert.deepStrictEqual(serverJob(302, processes, new Set(), script), { pids: [302, 301, 300], shellPid: 200 });
  // A server started by an extension shares VS Code's process group: only the server itself is stopped.
  assert.deepStrictEqual(serverJob(400, processes, new Set(), new Set([400])), { pids: [400] });
  assert.deepStrictEqual(serverJob(302, processes, new Set([301]), script), { pids: [302] });
});

test('serverJob leaves a tool running several scripts alone, with the servers it started', () => {
  // A root `npm run dev` runs concurrently, which runs web's dev script (Vite) and the API.
  const processes = parsePs([
    '  100     1   100 /Applications/Visual Studio Code.app/Contents/MacOS/Code Helper',
    '  200   100   200 -zsh',
    '  300   200   300 node',
    '  301   300   300 node',
    '  310   301   300 node',
    '  311   310   300 sh',
    '  312   311   300 node',
    '  320   301   300 node',
    '  322   320   300 node',
  ].join('\n'));
  // Only Vite and its sh run web's dev script: npm (310) ran it, concurrently (301) started npm.
  assert.deepStrictEqual(serverJob(312, processes, new Set(), new Set([312, 311])), { pids: [312, 311, 310] });
});

test('unrelatedListeners allows the server\'s job and its workers, nothing else', () => {
  const processes = parsePs([
    '  300   200   300 npm run dev',
    '  302   300   300 node',
    '  303   302   300 node',
    '  500   400   500 node',
  ].join('\n'));
  assert.deepStrictEqual(unrelatedListeners([302, 303], [302, 300], processes), []);
  assert.deepStrictEqual(unrelatedListeners([302, 500, 999], [302, 300], processes), [500, 999]);
});
