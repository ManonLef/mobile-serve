// Works out the command that restarts a dev server listening on all interfaces,
// from the server's command line and the scripts in the project's package.json.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execQuiet } from './exec.ts';
import type { DevServer } from './servers.ts';

interface HostFlag {
  // Matches the tool's name inside a package.json script.
  inScript: RegExp;
  // Matches one word of the running process's command line, without directory or .js extension.
  inProcess: RegExp;
  // Makes the tool listen on all interfaces.
  flag: string;
}

// `names` is a regex alternation. In scripts it must be a whole word, so "vite" doesn't match "vite-app".
// In the process it must be a whole program name, so a folder called "vite" doesn't count.
const tool = (names: string, flag: string, processNames = names): HostFlag => ({
  inScript: new RegExp(`(?<![\\w-])(?:${names})(?![\\w-])`),
  inProcess: new RegExp(`^(?:${processNames})$`),
  flag,
});

const HOST_FLAGS: HostFlag[] = [
  tool('vite', '--host'),
  tool('astro', '--host'),
  tool('nuxt|nuxi', '--host'),
  // Next.js renames its server process to "next-server (vX.Y.Z)".
  tool('next', '-H 0.0.0.0', 'next|next-server'),
  tool('ng', '--host 0.0.0.0'),
  tool('webpack|webpack-dev-server|vue-cli-service', '--host 0.0.0.0'),
];
const PREFERRED_SCRIPTS = ['dev', 'start', 'serve'];
// Script names end up in a shell command, so anything else is never offered.
const SAFE_SCRIPT_NAME = /^[\w:.-]+$/;
// The flag is appended to the script, so it only reaches the tool when the tool is the script's
// only command. Scripts that chain commands, run several at once, or already set a host are skipped.
const COMPOUND_SCRIPT = /[;&|]|(?<![\w-])(concurrently|run-p|run-s|npm-run-all2?|nodemon|turbo|nx|lerna)(?![\w-])/;
const SETS_HOST = /(?<![\w-])(--host|--hostname|-H)(?![\w-])/;
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

// Program names in a command line such as "node /app/node_modules/vite/bin/vite.js --port 3000".
function programNames(commandLine: string): string[] {
  return commandLine.split(/\s+/).map(word => path.basename(word).replace(/\.[cm]?js$/, ''));
}

function scriptRank(name: string): number {
  const i = PREFERRED_SCRIPTS.indexOf(name);
  return i === -1 ? PREFERRED_SCRIPTS.length : i;
}

export function buildNetworkCommand({ scripts, processCommand, packageManager }: {
  scripts: Record<string, unknown>;
  processCommand: string;
  packageManager: string;
}): string | undefined {
  // Only restart with a script that runs the same tool as the server that's running. Otherwise a
  // Laravel or Express server would get replaced by the project's Vite asset server.
  const programs = programNames(processCommand);
  const runningTool = HOST_FLAGS.find(h => programs.some(name => h.inProcess.test(name)));
  if (!runningTool) return;

  const script = Object.keys(scripts)
    .filter(name => SAFE_SCRIPT_NAME.test(name))
    .sort((a, b) => scriptRank(a) - scriptRank(b))
    .find(name => {
      const body = scripts[name];
      return typeof body === 'string' && runningTool.inScript.test(body) && !COMPOUND_SCRIPT.test(body) && !SETS_HOST.test(body);
    });
  if (!script) return;

  return packageManager === 'npm'
    ? `npm run ${script} -- ${runningTool.flag}`
    : `${packageManager} run ${script} ${runningTool.flag}`;
}

async function readPackageManagerField(dir: string): Promise<string | undefined> {
  try {
    const field = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).packageManager;
    const name = typeof field === 'string' ? field.split('@')[0] : undefined;
    return name && PACKAGE_MANAGERS.includes(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

// Looks in `dir` and the folders above it, so packages in a monorepo use the repo's package manager.
export async function detectPackageManager(dir: string): Promise<string> {
  for (let current = dir; ; current = path.dirname(current)) {
    const field = await readPackageManagerField(current);
    if (field) return field;
    for (const [lockfile, manager] of LOCKFILES) {
      try {
        await fs.access(path.join(current, lockfile));
        return manager;
      } catch {
        // Not this one.
      }
    }
    if (path.dirname(current) === current) return 'npm';
  }
}

export async function findNetworkCommand(server: DevServer): Promise<{ command: string; dir: string } | undefined> {
  if (!server.cwd || !server.inProject || !server.pid) return;
  let scripts: unknown;
  try {
    scripts = JSON.parse(await fs.readFile(path.join(server.cwd, 'package.json'), 'utf8')).scripts;
  } catch {
    return;
  }
  if (!scripts || typeof scripts !== 'object') return;

  const processCommand = ((await execQuiet('ps', ['-o', 'command=', '-p', String(server.pid)])) ?? '').trim();
  const command = buildNetworkCommand({
    scripts: scripts as Record<string, unknown>,
    processCommand,
    packageManager: await detectPackageManager(server.cwd),
  });
  return command ? { command, dir: server.cwd } : undefined;
}
