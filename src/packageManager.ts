// npm, pnpm, yarn and bun: which one a project uses, and how to pass flags to a script it runs.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

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

// The arguments that run `script` with `extra` passed on to it. npm needs "--" in between.
export function runScriptArgs(packageManager: string, script: string, extra: string[]): string[] {
  return packageManager === 'npm' ? ['run', script, '--', ...extra] : ['run', script, ...extra];
}
