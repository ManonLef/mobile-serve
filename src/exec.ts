import { execFile } from 'node:child_process';

const EXEC_TIMEOUT_MS = 5000;

/**
 * Runs a program without a shell and resolves to its stdout: '' if it failed without output,
 * or undefined if the program isn't installed.
 * Output from a non-zero exit is kept: lsof exits 1 when some of the pids it was asked
 * about have gone away, but still reports the rest.
 */
export function execQuiet(file: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      resolve((err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? undefined : stdout || '');
    });
  });
}
