// Comparing paths on this machine.
import * as fs from 'node:fs';
import * as path from 'node:path';

// Whether `dir` is `parent` or inside it, comparing whole path segments.
export function isInside(dir: string | undefined, parent: string): boolean {
  if (!dir) return false;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return dir === parent || dir.startsWith(prefix);
}

// Resolves symlinks (and on macOS the letter case), so paths compare equal to the ones lsof reports,
// and files reached through a symlink can be checked against the folder they must stay in.
export function realPath(dir: string): Promise<string> {
  return new Promise(resolve => fs.realpath.native(dir, (err, resolved) => resolve(err ? dir : resolved)));
}
