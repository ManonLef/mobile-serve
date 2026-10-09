// The dev server tools Mobile Serve knows how to put on the network.

export interface Tool {
  // Matches the tool's name inside a package.json script.
  inScript: RegExp;
  // Matches the running program's name, without directory or .js extension.
  inProcess: RegExp;
  // Make the tool listen on all interfaces.
  hostArgs: string[];
  // Make the tool listen on `port`, and fail rather than pick another one when it's taken.
  portArgs: (port: number) => string[];
  // The port the tool uses when none is given, tried first so the address stays the same between runs.
  defaultPort: number;
}

// `names` is a regex alternation. In scripts it must be a whole word, so "vite" doesn't match "vite-app".
const tool = (names: string, rest: Omit<Tool, 'inScript' | 'inProcess'>, processNames = names): Tool => ({
  inScript: new RegExp(`(?<![\\w/.-])(?:${names})(?![\\w/.-])`),
  inProcess: new RegExp(`^(?:${processNames})$`),
  ...rest,
});

const portFlag = (port: number) => ['--port', String(port)];

export const TOOLS: Tool[] = [
  tool('vite', { hostArgs: ['--host'], portArgs: port => [...portFlag(port), '--strictPort'], defaultPort: 5173 }),
  tool('astro', { hostArgs: ['--host'], portArgs: portFlag, defaultPort: 4321 }),
  tool('nuxt|nuxi', { hostArgs: ['--host'], portArgs: portFlag, defaultPort: 3000 }),
  // Next.js renames its server process to "next-server (vX.Y.Z)".
  tool('next', { hostArgs: ['-H', '0.0.0.0'], portArgs: port => ['-p', String(port)], defaultPort: 3000 }, 'next|next-server'),
  tool('ng', { hostArgs: ['--host', '0.0.0.0'], portArgs: portFlag, defaultPort: 4200 }),
  tool('webpack|webpack-dev-server|vue-cli-service', { hostArgs: ['--host', '0.0.0.0'], portArgs: portFlag, defaultPort: 8080 }),
];

// Script names end up in a shell command, so anything else is never offered. A leading "-" would be read as an option.
export const SAFE_SCRIPT_NAME = /^\w[\w:.-]*$/;
// Flags are appended to the script, so they only reach the tool when the tool is the script's
// only command. Scripts that chain commands, run several at once, or already set a host are skipped.
export const COMPOUND_SCRIPT = /[;&|`$<>\n]|(?<![\w-])(concurrently|run-p|run-s|npm-run-all2?|nodemon|turbo|nx|lerna)(?![\w-])/;
export const SETS_HOST = /(?<![\w-])(--host|--hostname|-H)(?![\w-])/;

// The tool a script runs, when flags appended to it would reach that tool.
export function scriptTool(body: unknown): Tool | undefined {
  if (typeof body !== 'string' || COMPOUND_SCRIPT.test(body) || SETS_HOST.test(body)) return;
  return TOOLS.find(t => t.inScript.test(body));
}

// The arguments that run `script` with `extra` passed on to it. npm needs "--" in between.
export function runScriptArgs(packageManager: string, script: string, extra: string[]): string[] {
  return packageManager === 'npm' ? ['run', script, '--', ...extra] : ['run', script, ...extra];
}
