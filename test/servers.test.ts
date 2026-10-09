import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseLsof, parseListenAddress, isDevProcess, isInside, isLanHost, collectServers, pickRestartedServer, parsePs, serverJob, unrelatedListeners,
  type DetectedServer,
} from '../src/servers.ts';

test('parseLsof groups fields by process', () => {
  const stdout = 'p101\ncnode\nf23\nn*:5173\nf24\nn[::1]:5174\np202\ncSpotify\nf9\nn127.0.0.1:4370\n';
  assert.deepStrictEqual(parseLsof(stdout), [
    { pid: 101, command: 'node', names: ['*:5173', '[::1]:5174'] },
    { pid: 202, command: 'Spotify', names: ['127.0.0.1:4370'] },
  ]);
});

test('parseListenAddress handles IPv4, IPv6 and wildcard hosts', () => {
  assert.deepStrictEqual(parseListenAddress('*:3000'), { host: '*', port: 3000 });
  assert.deepStrictEqual(parseListenAddress('[::1]:8080'), { host: '[::1]', port: 8080 });
  assert.deepStrictEqual(parseListenAddress('127.0.0.1:5173'), { host: '127.0.0.1', port: 5173 });
  assert.strictEqual(parseListenAddress('garbage'), undefined);
});

test('isLanHost only accepts addresses an IPv4 URL can reach', () => {
  for (const host of ['*', '0.0.0.0', '[::]', '192.168.1.5']) assert.ok(isLanHost(host), host);
  for (const host of ['127.0.0.1', '[::1]', 'localhost', '[fe80::1%lo0]', '169.254.1.1', '[2001:db8::1]']) {
    assert.ok(!isLanHost(host), host);
  }
});

test('isDevProcess matches whole names, not prefixes', () => {
  for (const name of ['node', 'Python', 'python3.12', 'php8.2', 'next-server (v14.2.0)', 'bun']) {
    assert.ok(isDevProcess(name), name);
  }
  for (const name of ['Google', 'GoogleSoftwareUpdateDaemon', 'goland', 'javaw', 'nodemon-ui', 'Spotify']) {
    assert.ok(!isDevProcess(name), name);
  }
});

test('isInside compares whole path segments, including under the root', () => {
  assert.ok(isInside('/work/app/src', '/work/app'));
  assert.ok(isInside('/work/app', '/work/app'));
  assert.ok(!isInside('/work/app-2', '/work/app'));
  assert.ok(isInside('/Users/x', '/'));
});

test('collectServers keeps dev servers, Live Server and Docker, and works out reachability', () => {
  const servers = collectServers([
    { pid: 1, command: 'node', names: ['127.0.0.1:5173', '[::1]:5173'] },
    { pid: 2, command: 'python3', names: ['*:8000'] },
    { pid: 3, command: 'Code Helper (Plugin)', names: ['127.0.0.1:5500', '127.0.0.1:9229'] },
    { pid: 4, command: 'node', names: ['*:80'] },
    { pid: 5, command: 'Google Chrome', names: ['127.0.0.1:9222'] },
    { pid: 6, command: 'com.docker.backe', names: ['*:3306'] },
  ], 5500);
  assert.deepStrictEqual(servers, [
    { port: 5173, pid: 1, label: 'node', kind: 'process', lanReachable: false },
    { port: 8000, pid: 2, label: 'python3', kind: 'process', lanReachable: true },
    { port: 5500, pid: 3, label: 'Live Server', kind: 'liveServer', lanReachable: false },
    { port: 3306, pid: 6, label: 'Docker', kind: 'docker', lanReachable: true },
  ]);
});

test('collectServers merges IPv4 and IPv6 listeners on one port, keeping the first pid', () => {
  const servers = collectServers([
    { pid: 1, command: 'node', names: ['127.0.0.1:3000', '[::]:3000'] },
    { pid: 2, command: 'node', names: ['[::1]:3000'] },
  ]);
  assert.deepStrictEqual(servers, [{ port: 3000, pid: 1, label: 'node', kind: 'process', lanReachable: true }]);
});

test('collectServers describes the process the phone would reach when several share a port', () => {
  const servers = collectServers([
    { pid: 1, command: 'node', names: ['[::1]:5173'] },
    { pid: 2, command: 'python3', names: ['*:5173'] },
  ]);
  assert.deepStrictEqual(servers, [{ port: 5173, pid: 2, label: 'python3', kind: 'process', lanReachable: true }]);
});

test('pickRestartedServer ignores servers that were already running', () => {
  const server = (pid: number, port: number, cwd = '/app'): DetectedServer =>
    ({ pid, port, cwd, label: 'node', kind: 'process', lanReachable: true });
  const pidsBefore = new Set([10]);
  const options = { dir: '/app', oldPort: 5173, pidsBefore };
  // The API that was already running from the same folder is not the restarted server.
  assert.strictEqual(pickRestartedServer([server(10, 3001)], options), undefined);
  assert.strictEqual(pickRestartedServer([server(10, 3001), server(20, 5174), server(21, 5173)], options)?.pid, 21);
  assert.strictEqual(pickRestartedServer([server(10, 3001), server(20, 5174)], options)?.pid, 20);
  assert.strictEqual(pickRestartedServer([server(20, 5173, '/elsewhere')], options), undefined);
});

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
  assert.deepStrictEqual(serverJob(302, processes, new Set()), { pids: [302, 301, 300], shellPid: 200 });
  // A server started by an extension shares VS Code's process group: only the server itself is stopped.
  assert.deepStrictEqual(serverJob(400, processes, new Set()), { pids: [400] });
  assert.deepStrictEqual(serverJob(302, processes, new Set([301])), { pids: [302] });
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
