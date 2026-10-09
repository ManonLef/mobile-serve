// Works out the command that restarts a dev server listening on all interfaces,
// from the package.json script the server was started with.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execQuiet } from './exec.ts';
import { isInside, type DetectedServer } from './servers.ts';

interface HostFlag {
  // Matches the tool's name inside a package.json script.
  inScript: RegExp;
  // Matches the running program's name, without directory or .js extension.
  inProcess: RegExp;
  // Makes the tool listen on all interfaces.
  flag: string;
}

// `names` is a regex alternation. In scripts it must be a whole word, so "vite" doesn't match "vite-app".
const tool = (names: string, flag: string, processNames = names): HostFlag => ({
  inScript: new RegExp(`(?<![\\w/.-])(?:${names})(?![\\w/.-])`),
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
// Script names end up in a shell command, so anything else is never offered. A leading "-" would be read as an option.
const SAFE_SCRIPT_NAME = /^\w[\w:.-]*$/;
// The flag is appended to the script, so it only reaches the tool when the tool is the script's
// only command. Scripts that chain commands, run several at once, or already set a host are skipped.
const COMPOUND_SCRIPT = /[;&|`$<>\n]|(?<![\w-])(concurrently|run-p|run-s|npm-run-all2?|nodemon|turbo|nx|lerna)(?![\w-])/;
const SETS_HOST = /(?<![\w-])(--host|--hostname|-H)(?![\w-])/;
// Runtimes that run a tool's script file; the tool is the first argument after their options.
const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno']);
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

// The program arguments run, such as "vite" for ["node", "/app/node_modules/vite/bin/vite.js", "--port", "3000"].
// Only the first word of a name counts, so a process title like "next-server (v14.2.0)" gives "next-server".
export function runningProgram(args: string[]): string | undefined {
  const name = (arg: string) => path.basename(arg).split(' ')[0].replace(/\.[cm]?js$/, '');
  let i = 0;
  if (args[0] && RUNTIMES.has(name(args[0]))) {
    i = 1;
    while (args[i]?.startsWith('-')) i++;
  }
  return args[i] ? name(args[i]) || undefined : undefined;
}

// Splits a command line from ps into arguments. ps joins them with spaces, so a word that isn't an
// existing path is joined with the words after it when that makes one ("/Users/me/My Projects/…").
export async function splitCommandLine(commandLine: string, exists: (file: string) => Promise<boolean>): Promise<string[]> {
  // Split on single spaces, so joining the words back restores runs of spaces too.
  const words = commandLine.trim().split(' ');
  const args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    let arg = words[i];
    if (!arg) continue;
    if (arg.includes('/') && !await exists(arg)) {
      for (let j = i + 1; j < words.length; j++) {
        const joined = words.slice(i, j + 1).join(' ');
        if (await exists(joined)) {
          arg = joined;
          i = j;
          break;
        }
      }
    }
    args.push(arg);
  }
  return args;
}

// The arguments of a process owned by this user. Relative paths are looked up from `cwd`.
async function readArguments(pid: number, cwd: string): Promise<string[]> {
  if (process.platform === 'linux') {
    try {
      return (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    } catch {
      return [];
    }
  }
  const commandLine = (await execQuiet('ps', ['-o', 'command=', '-p', String(pid)])) ?? '';
  return splitCommandLine(commandLine, file => fs.access(path.resolve(cwd, file)).then(() => true, () => false));
}

// What npm, pnpm, yarn and bun put in the environment of everything a package.json script starts.
export interface ScriptEnv {
  // The script's name.
  event: string;
  // The package.json the script comes from.
  packageJson?: string;
  // Package manager that ran it.
  packageManager?: string;
}

// Reads ScriptEnv from `NAME=value` entries. Later entries win, as in a real environment.
export function parseScriptEnv(entries: string[]): ScriptEnv | undefined {
  const env = new Map<string, string>();
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  const event = env.get('npm_lifecycle_event');
  if (!event) return;
  // e.g. "pnpm/9.1.0 npm/? node/v20.11.0 darwin arm64".
  const agent = env.get('npm_config_user_agent')?.split('/')[0];
  return {
    event,
    packageJson: env.get('npm_package_json') || undefined,
    packageManager: agent && PACKAGE_MANAGERS.includes(agent) ? agent : undefined,
  };
}

// Splits `ps -E` output (the command line, then the environment) into NAME=value entries.
// An entry runs until the next NAME=, so values with spaces (a project path, say) stay whole.
export function splitPsEnvironment(output: string): string[] {
  return output.trim().split(/\s+(?=[A-Za-z_]\w*=)/).slice(1);
}

// The environment of a process owned by this user, as NAME=value entries.
async function readEnvironment(pid: number): Promise<string[]> {
  if (process.platform === 'linux') {
    try {
      return (await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
    } catch {
      return [];
    }
  }
  // macOS: -E appends the environment to the command line.
  return splitPsEnvironment((await execQuiet('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)])) ?? '');
}

export function buildNetworkCommand({ script, body, program, packageManager }: {
  script: string;
  body: unknown;
  // The running server's program (see runningProgram).
  program: string | undefined;
  packageManager: string;
}): string | undefined {
  // Only restart when the script runs the same tool as the server that's running. Otherwise a
  // Laravel or Express server would get replaced by the project's Vite asset server.
  const runningTool = program && HOST_FLAGS.find(h => h.inProcess.test(program));
  if (!runningTool || !SAFE_SCRIPT_NAME.test(script) || typeof body !== 'string') return;
  if (!runningTool.inScript.test(body) || COMPOUND_SCRIPT.test(body) || SETS_HOST.test(body)) return;

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

/**
 * The command that runs the server's own package.json script again with the tool's host flag, the
 * command that runs it without (to go back to localhost), and the folder to run them in.
 * Undefined unless the server was started by a script.
 */
export async function findNetworkCommand(
  server: DetectedServer,
): Promise<{ command: string; localCommand: string; dir: string } | undefined> {
  if (!server.cwd || !server.inProject) return;
  const env = parseScriptEnv(await readEnvironment(server.pid));
  if (!env) return;
  const dir = env.packageJson ? path.dirname(env.packageJson) : server.cwd;
  // A variable inherited from elsewhere (VS Code itself started by a script, say) points away from the server.
  if (!isInside(server.cwd, dir)) return;

  let scripts: unknown;
  try {
    scripts = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).scripts;
  } catch {
    return;
  }
  if (!scripts || typeof scripts !== 'object' || !Object.hasOwn(scripts, env.event)) return;

  const packageManager = env.packageManager ?? await detectPackageManager(dir);
  const command = buildNetworkCommand({
    script: env.event,
    body: (scripts as Record<string, unknown>)[env.event],
    program: runningProgram(await readArguments(server.pid, server.cwd)),
    packageManager,
  });
  // buildNetworkCommand has checked the script name is safe in a shell command.
  return command ? { command, localCommand: `${packageManager} run ${env.event}`, dir } : undefined;
}
