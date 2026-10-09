import { execFile } from 'node:child_process';

const EXEC_TIMEOUT_MS = 5000;

/**
 * Runs a program without a shell and resolves to its stdout, or undefined if the program isn't installed.
 * Output from a non-zero exit is kept: lsof exits 1 when some of the pids it was asked
 * about have gone away, but still reports the rest. Rejects when the output can't be
 * complete: the program timed out, was killed, or wrote too much.
 */
export function execQuiet(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      const code = (err as NodeJS.ErrnoException | null)?.code as unknown;
      if (!err || typeof code === 'number') resolve(stdout);
      else if (code === 'ENOENT') resolve(undefined);
      else reject(new Error(err.killed ? `${file} didn't finish within ${EXEC_TIMEOUT_MS / 1000} seconds` : `${file} failed: ${err.message}`));
    });
  });
}
