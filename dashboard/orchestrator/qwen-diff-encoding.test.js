'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDiff } = require('./qwen-docker-adapter');

test('rejects malformed UTF-8 instead of producing a lossy diff', () => {
  const snapshot = [{ path:'a.js', content:Buffer.from('before\n').toString('base64') }];
  assert.throws(() => formatDiff([{ path:'a.js', content:Buffer.from([0xff]).toString('base64') }], snapshot), /valid UTF-8/);
  assert.throws(() => formatDiff([{ path:'a.js', content:Buffer.from('after\n').toString('base64') }], [{ path:'a.js', content:Buffer.from([0xc3]).toString('base64') }]), /valid UTF-8/);
  assert.match(formatDiff([{ path:'a.js', content:Buffer.from('after\n').toString('base64') }], snapshot), /after/);
});
