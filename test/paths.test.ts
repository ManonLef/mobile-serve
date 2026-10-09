import { test } from 'node:test';
import assert from 'node:assert';
import { isInside } from '../src/paths.ts';

test('isInside compares whole path segments, including under the root', () => {
  assert.ok(isInside('/work/app/src', '/work/app'));
  assert.ok(isInside('/work/app', '/work/app'));
  assert.ok(!isInside('/work/app-2', '/work/app'));
  assert.ok(isInside('/Users/x', '/'));
});
