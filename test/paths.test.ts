import { test } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import { isInside } from '../src/paths.ts';

test('isInside compares whole path segments, including under the root', () => {
  // Built with path, so the separators are this platform's (\ on Windows).
  const app = path.resolve('/work/app');
  assert.ok(isInside(path.join(app, 'src'), app));
  assert.ok(isInside(app, app));
  assert.ok(!isInside(`${app}-2`, app));
  const root = path.parse(app).root;
  assert.ok(isInside(path.join(root, 'Users', 'x'), root));
});
