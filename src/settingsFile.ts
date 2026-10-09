// Edits a VS Code settings file (JSON with comments) directly, for when the settings API can't be
// relied on: while VS Code is shutting down.
import * as fs from 'node:fs';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree } from 'jsonc-parser';

/**
 * Sets the value at `jsonPath` back to `previous` (removing it when undefined), but only while it
 * still is `expected`, so a change made by hand is never overwritten. Undefined when there's nothing to do.
 */
export function restoreSetting(text: string, jsonPath: string[], expected: unknown, previous: unknown): string | undefined {
  const tree = parseTree(text);
  const node = tree && findNodeAtLocation(tree, jsonPath);
  if (!node || getNodeValue(node) !== expected) return undefined;
  // No formatting options: with them, removing a setting re-indents the lines around it.
  return applyEdits(text, modify(text, jsonPath, previous, {}));
}

// restoreSetting on a file, synchronously. Resolves to whether the file was changed.
export function restoreSettingInFile(file: string, jsonPath: string[], expected: unknown, previous: unknown): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const restored = restoreSetting(text, jsonPath, expected, previous);
  if (restored === undefined) return false;
  fs.writeFileSync(file, restored);
  return true;
}
