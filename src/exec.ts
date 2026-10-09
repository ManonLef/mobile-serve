import { execFile } from 'node:child_process';

const EXEC_TIMEOUT_MS = 5000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  // 0, or the non-zero exit code.
  code: number;
}

/**
 * Runs a program without a shell and resolves to what it wrote, or undefined if the program isn't installed.
 * Output from a non-zero exit is kept: lsof exits 1 when some of the pids it was asked
 * about have gone away, but still reports the rest. Rejects when the output can't be
 * complete: the program timed out, was killed, or wrote too much.
 */
export function execOutput(file: string, args: string[]): Promise<ExecResult | undefined> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code as unknown;
      if (!err || typeof code === 'number') resolve({ stdout, stderr, code: typeof code === 'number' ? code : 0 });
      else if (code === 'ENOENT') resolve(undefined);
      else reject(new Error(err.killed ? `${file} didn't finish within ${EXEC_TIMEOUT_MS / 1000} seconds` : `${file} failed: ${err.message}`));
    });
  });
}

// execOutput's stdout.
export async function execQuiet(file: string, args: string[]): Promise<string | undefined> {
  return (await execOutput(file, args))?.stdout;
}
