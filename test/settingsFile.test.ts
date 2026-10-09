import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { restoreSetting, restoreSettingInFile } from '../src/settingsFile.ts';

const KEY = 'liveServer.settings.host';

test('restoreSetting removes a setting that wasn\'t there before, keeping comments', () => {
  const text = '{\n    // Mine.\n    "editor.tabSize": 2,\n    "liveServer.settings.host": "0.0.0.0"\n}\n';
  const restored = restoreSetting(text, [KEY], '0.0.0.0', undefined);
  assert.strictEqual(restored, '{\n    // Mine.\n    "editor.tabSize": 2\n}\n');
});

test('restoreSetting puts back the previous value, also inside a .code-workspace file', () => {
  const text = '{ "folders": [], "settings": { "liveServer.settings.host": "0.0.0.0" } }';
  const restored = restoreSetting(text, ['settings', KEY], '0.0.0.0', '127.0.0.1');
  assert.deepStrictEqual(JSON.parse(restored!), { folders: [], settings: { [KEY]: '127.0.0.1' } });
});

test('restoreSetting keeps the file\'s own indentation and line endings', () => {
  assert.strictEqual(restoreSetting('{\n\t"a": 1,\n\t"liveServer.settings.host": "0.0.0.0"\n}\n', [KEY], '0.0.0.0', undefined),
    '{\n\t"a": 1\n}\n');
  assert.strictEqual(restoreSetting('{\r\n  "a": 1,\r\n  "liveServer.settings.host": "0.0.0.0"\r\n}\r\n', [KEY], '0.0.0.0', undefined),
    '{\r\n  "a": 1\r\n}\r\n');
  const workspace = '{\n  "folders": [],\n  "settings": {\n    "x": 1,\n    "liveServer.settings.host": "0.0.0.0",\n    "y": 2\n  }\n}\n';
  assert.strictEqual(restoreSetting(workspace, ['settings', KEY], '0.0.0.0', undefined),
    '{\n  "folders": [],\n  "settings": {\n    "x": 1,\n    "y": 2\n  }\n}\n');
});

test('restoreSetting leaves a value changed by hand, or missing, alone', () => {
  assert.strictEqual(restoreSetting('{ "liveServer.settings.host": "192.168.1.5" }', [KEY], '0.0.0.0', undefined), undefined);
  assert.strictEqual(restoreSetting('{}', [KEY], '0.0.0.0', undefined), undefined);
  assert.strictEqual(restoreSetting('', [KEY], '0.0.0.0', undefined), undefined);
});

test('restoreSettingInFile edits the file only when there is something to restore', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-serve-'));
  try {
    const file = path.join(dir, 'settings.json');
    assert.strictEqual(restoreSettingInFile(file, [KEY], '0.0.0.0', undefined), false);
    await fs.writeFile(file, '{ "liveServer.settings.host": "0.0.0.0" }');
    assert.strictEqual(restoreSettingInFile(file, [KEY], '0.0.0.0', undefined), true);
    assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
    assert.strictEqual(restoreSettingInFile(file, [KEY], '0.0.0.0', undefined), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
