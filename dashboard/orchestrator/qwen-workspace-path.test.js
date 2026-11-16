'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWorkspacePath } = require('./qwen-workspace-path');

const root = 'C:\\Users\\Test User\\workspace';
test('maps model-rooted and relative paths into the Windows workspace', () => {
  assert.equal(resolveWorkspacePath(root, '/average.js'), root + '\\average.js');
  assert.equal(resolveWorkspacePath(root, 'src/file.js'), root + '\\src\\file.js');
  assert.equal(resolveWorkspacePath(root, root + '\\test.js'), root + '\\test.js');
});
test('rejects traversal, other volumes, UNC, devices, ADS and drive-relative paths', () => {
  for (const value of ['../outside.js', '/../../outside.js', 'D:\\outside.js',
    'C:\\Users\\Test User\\workspace-other\\x', '\\\\server\\share\\x',
    '\\\\?\\C:\\outside', 'x.js:stream', 'C:outside', 'x\0y']) {
    assert.throws(() => resolveWorkspacePath(root, value), value);
  }
});

test('refuses confined Qwen runs when no OS sandbox adapter is available', () => {
  const { spawnHeadless } = require('./spawn-headless');
  for (const flags of [{ readOnly: true }, { confineWrites: true }]) {
    assert.throws(() => spawnHeadless.call({}, { cli: 'qwen', ...flags }),
      /Qwen confinement is unavailable/);
  }
});
