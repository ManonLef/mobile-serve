import { test } from 'node:test';
import assert from 'node:assert';
import { describe, log, setLogger } from '../src/log.ts';

test('log goes to the logger that is set, and nowhere without one', () => {
  const lines: string[] = [];
  setLogger({
    debug: message => lines.push(`debug ${message}`),
    info: message => lines.push(`info ${message}`),
    warn: message => lines.push(`warn ${message}`),
    error: message => lines.push(`error ${describe(message)}`),
  });
  try {
    log.info('started');
    log.error(new Error('port taken'));
  } finally {
    setLogger(undefined);
  }
  log.warn('not recorded');
  assert.deepStrictEqual(lines, ['info started', 'error port taken']);
});

test('describe gives an error\'s message, or the value itself', () => {
  assert.strictEqual(describe(new Error('lsof failed')), 'lsof failed');
  assert.strictEqual(describe('timeout'), 'timeout');
});
