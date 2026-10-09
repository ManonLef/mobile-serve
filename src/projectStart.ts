// Works out how to start a workspace folder's own server on the network, the way Live Server's
// Go Live does: its package.json dev script with the tool's host flag, or else, for a plain
// HTML/CSS/JS folder, Mobile Serve's static server.
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { canConnect } from './network.ts';
import { detectPackageManager, runScriptArgs } from './packageManager.ts';
import { SAFE_SCRIPT_NAME, devServerTool, type Tool } from './tools.ts';

// Tried in this order. "start" is often a production server, so a dev script wins.
const SCRIPT_NAMES = ['dev', 'start', 'serve'];
// A script that builds (`vite build --watch`, say) never starts a server.
const BUILDS = /(?<![\w-])build(?![\w-])/;
// Static file servers, which Mobile Serve's own server replaces (it reloads the phone and hides dotfiles).
const STATIC_SERVER_SCRIPT = /^(?:npx\s+)?(?:live-server|five-server|http-server|serve|lite-server|browser-sync)(?![\w-])/;
// A port the script sets itself, which has to be used as it is.
const SETS_PORT = /(?<![\w-])(?:--port|-p)(?:[ =](\d+))?(?![\w-])/;
// Live Server uses 5500, so the static server keeps clear of it.
export const STATIC_PORT = 5600;
// How many ports after the preferred one to try before taking any free one.
const PORT_ATTEMPTS = 20;

export type StartPlan =
  // Runs the package.json script in `dir` (see scriptArgs).
  // `setsHost` when the script already listens on every interface.
  | { kind: 'script'; dir: string; script: string; packageManager: string; tool: Tool; fixedPort?: number; setsHost?: boolean }
  // Serves `dir` with the static server.
  | { kind: 'static'; dir: string };

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

/**
 * How to start `dir` for the phone, or undefined when Mobile Serve can't tell: a script it doesn't
 * know, or nothing to serve. A folder only counts as plain HTML when package.json has no script to
 * start a server other than a static file server, so a project that needs building is never served raw.
 */
export async function planStart(dir: string): Promise<StartPlan | undefined> {
  const scripts = (await readJson(path.join(dir, 'package.json')) as { scripts?: unknown } | undefined)?.scripts;
  const names = scripts && typeof scripts === 'object'
    ? SCRIPT_NAMES.filter(name => Object.hasOwn(scripts, name))
    : [];
  for (const script of names) {
    const body = (scripts as Record<string, unknown>)[script];
    const found = devServerTool(body);
    if (!found || !SAFE_SCRIPT_NAME.test(script) || BUILDS.test(body as string)) continue;
    const port = SETS_PORT.exec(body as string);
    // A port set some other way (from a variable, say) can't be known in advance.
    if (port && !port[1]) continue;
    return {
      kind: 'script', dir, script, packageManager: await detectPackageManager(dir), tool: found.tool,
      fixedPort: port ? Number(port[1]) : undefined, setsHost: found.setsHost || undefined,
    };
  }
  const bodies = names.map(name => (scripts as Record<string, unknown>)[name]);
  if (!bodies.every(body => typeof body === 'string' && STATIC_SERVER_SCRIPT.test(body.trim()))) return undefined;
  return await exists(path.join(dir, 'index.html')) ? { kind: 'static', dir } : undefined;
}

// The arguments to give the package manager so the script listens on the network, on `port`.
export function scriptArgs(plan: Extract<StartPlan, { kind: 'script' }>, port: number): string[] {
  const extra = [...(plan.setsHost ? [] : plan.tool.hostArgs), ...(plan.fixedPort === undefined ? plan.tool.portArgs(port) : [])];
  return runScriptArgs(plan.packageManager, plan.script, extra);
}

// What the phone's server runs, for showing to the user.
export function describePlan(plan: StartPlan): string {
  return plan.kind === 'static' ? 'Serves the folder\'s HTML, CSS and JavaScript' : `${plan.packageManager} run ${plan.script}`;
}

// Whether nothing listens on `port`, on localhost or on the network.
export async function isPortFree(port: number): Promise<boolean> {
  // Node binds with SO_REUSEADDR, so binding alone misses a server on 127.0.0.1 or ::1.
  if (await canConnect('127.0.0.1', port) || await canConnect('::1', port)) return false;
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

// `preferred` when it's free, else one of the ports after it, else any free port.
export async function choosePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + PORT_ATTEMPTS && port <= 65535; port++) {
    if (await isPortFree(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

// The port to start the plan on. Rejects when the port the script sets itself is taken.
export async function portFor(plan: StartPlan): Promise<number> {
  if (plan.kind === 'static') return choosePort(STATIC_PORT);
  if (plan.fixedPort === undefined) return choosePort(plan.tool.defaultPort);
  if (await isPortFree(plan.fixedPort)) return plan.fixedPort;
  throw new Error(`Port ${plan.fixedPort}, which the “${plan.script}” script uses, is already taken. Stop what's using it and try again.`);
}
