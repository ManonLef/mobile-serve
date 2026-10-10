import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { log } from './log.ts';

const EXEC_TIMEOUT_MS = 5000;
// Where macOS and Linux keep lsof, ps, route and ip. VS Code's PATH can leave them out (on macOS
// lsof is in /usr/sbin), for example when it was opened from the Dock and couldn't read the shell's.
const SYSTEM_DIRS = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'];

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(file: string, args: string[]): Promise<ExecResult | undefined> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code as unknown;
      log.debug(`${[file, ...args].join(' ')}: ${err ? code ?? err.message : 0}${stderr.trim() ? `, stderr: ${stderr.trim()}` : ''}`);
      if (!err || typeof code === 'number') resolve({ stdout, stderr, code: typeof code === 'number' ? code : 0 });
      else if (code === 'ENOENT') resolve(undefined);
      else reject(new Error(err.killed ? `${file} didn't finish within ${EXEC_TIMEOUT_MS / 1000} seconds` : `${file} failed: ${err.message}`));
    });
  });
}

/**
 * Runs a program without a shell and resolves to what it wrote, or undefined if the program isn't installed.
 * A program that isn't on the PATH is looked for in `fallbackDirs` too (not on Windows).
 * Output from a non-zero exit is kept: lsof exits 1 when some of the pids it was asked
 * about have gone away, but still reports the rest. Rejects when the output can't be
 * complete: the program timed out, was killed, or wrote too much.
 */
export async function execOutput(file: string, args: string[], fallbackDirs = SYSTEM_DIRS): Promise<ExecResult | undefined> {
  const result = await run(file, args);
  if (result || process.platform === 'win32' || file.includes('/')) return result;
  for (const dir of fallbackDirs) {
    const found = await run(path.join(dir, file), args);
    if (found) {
      log.info(`${file} isn't on VS Code's PATH, using ${path.join(dir, file)}.`);
      return found;
    }
  }
  log.warn(`${file} isn't installed, or isn't on VS Code's PATH.`);
  return undefined;
}

export async function execQuiet(file: string, args: string[]): Promise<string | undefined> {
  return (await execOutput(file, args))?.stdout;
}
