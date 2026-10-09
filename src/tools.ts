// The dev server tools Mobile Serve knows how to put on the network.

export interface Tool {
  // Matches the tool's name inside a package.json script.
  inScript: RegExp;
  // Matches the running program's name, without directory or .js extension.
  inProcess: RegExp;
  // Matches a script that starts the tool's dev server, rather than a build or a production server.
  devScript: RegExp;
  // Make the tool listen on all interfaces.
  hostArgs: string[];
  // Make the tool listen on `port`, and fail rather than pick another one when it's taken.
  portArgs: (port: number) => string[];
  // The port the tool uses when none is given, tried first so the address stays the same between runs.
  defaultPort: number;
}

// A name as a whole word in a script, so "vite" doesn't match "vite-app".
const word = (names: string) => `(?<![\\w/.-])(?:${names})(?![\\w/.-])`;
// What follows the name in a dev script: one of these subcommands, or (when `bare` is set) nothing
// but options, for tools that start their dev server when given no subcommand.
const dev = (names: string, subcommands: string, bare = false) =>
  new RegExp(`${word(names)}(?:\\s+(?:${subcommands})(?![\\w-])${bare ? '|(?=\\s*$|\\s+-)' : ''})`);

// `names` is a regex alternation.
const tool = (names: string, rest: Omit<Tool, 'inScript' | 'inProcess'>, processNames = names): Tool => ({
  inScript: new RegExp(word(names)),
  inProcess: new RegExp(`^(?:${processNames})$`),
  ...rest,
});

const portFlag = (port: number) => ['--port', String(port)];

export const TOOLS: Tool[] = [
  // Vite also takes the folder to serve, so anything but its other subcommands starts the dev server.
  tool('vite', {
    devScript: new RegExp(`${word('vite')}(?!\\s+(?:build|preview|optimize)(?![\\w-]))`),
    hostArgs: ['--host'], portArgs: port => [...portFlag(port), '--strictPort'], defaultPort: 5173,
  }),
  tool('astro', { devScript: dev('astro', 'dev'), hostArgs: ['--host'], portArgs: portFlag, defaultPort: 4321 }),
  tool('nuxt|nuxi', { devScript: dev('nuxt|nuxi', 'dev', true), hostArgs: ['--host'], portArgs: portFlag, defaultPort: 3000 }),
  // Next.js renames its server process to "next-server (vX.Y.Z)".
  tool('next', {
    devScript: dev('next', 'dev', true), hostArgs: ['-H', '0.0.0.0'], portArgs: port => ['-p', String(port)], defaultPort: 3000,
  }, 'next|next-server'),
  tool('ng', { devScript: dev('ng', 'serve|s'), hostArgs: ['--host', '0.0.0.0'], portArgs: portFlag, defaultPort: 4200 }),
  // Plain `webpack` only builds; `webpack serve` starts webpack-dev-server.
  tool('webpack|webpack-dev-server|vue-cli-service', {
    devScript: new RegExp(`${dev('webpack', 'serve|server|s').source}|${dev('webpack-dev-server', 'serve', true).source}|${dev('vue-cli-service', 'serve').source}`),
    hostArgs: ['--host', '0.0.0.0'], portArgs: portFlag, defaultPort: 8080,
  }),
];

// Script names end up in a shell command, so anything else is never offered. A leading "-" would be read as an option.
export const SAFE_SCRIPT_NAME = /^\w[\w:.-]*$/;
// Flags are appended to the script, so they only reach the tool when the tool is the script's
// only command. Scripts that chain commands, run several at once, or already set a host are skipped.
export const COMPOUND_SCRIPT = /[;&|`$<>\n]|(?<![\w-])(concurrently|run-p|run-s|npm-run-all2?|nodemon|turbo|nx|lerna)(?![\w-])/;
export const SETS_HOST = /(?<![\w-])(--host|--hostname|-H)(?![\w-])/;
// The host flag and the value it's given, if any ("--host", "--host 0.0.0.0", "-H=::").
const HOST_VALUE = /(?<![\w-])(?:--hostname|--host|-H)(?![\w-])(?:[ =](?!-)(\S+))?/;
// Values that listen on every interface. No value is Vite's, Astro's and Nuxt's bare --host.
const ALL_INTERFACES = new Set([undefined, '0.0.0.0', '::', '[::]']);

// The tool a script runs, when flags appended to it would reach that tool. Hosts aside.
function toolIn(body: unknown): Tool | undefined {
  if (typeof body !== 'string' || COMPOUND_SCRIPT.test(body)) return;
  return TOOLS.find(t => t.inScript.test(body));
}

// The tool a script runs, when flags appended to it would reach that tool and it doesn't set a host yet.
export function scriptTool(body: unknown): Tool | undefined {
  return typeof body === 'string' && !SETS_HOST.test(body) ? toolIn(body) : undefined;
}

/**
 * The tool whose dev server a script starts, when flags appended to it would reach that tool.
 * `setsHost` is set when the script already makes it listen on every interface; a script that keeps
 * it on localhost, or on one address, isn't used.
 */
export function devServerTool(body: unknown): { tool: Tool; setsHost: boolean } | undefined {
  const tool = toolIn(body);
  if (!tool?.devScript.test(body as string)) return;
  const host = HOST_VALUE.exec(body as string);
  if (host && !ALL_INTERFACES.has(host[1])) return;
  return { tool, setsHost: !!host };
}
