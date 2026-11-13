'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { resolveToken } = require('./api-token');

test('runtime.json wins only while the Symphonee that wrote it is running', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  const rt = path.join(dir, 'runtime.json');
  const env = { SYMPHONEE_TOKEN: 'from-env' };
  fs.writeFileSync(rt, JSON.stringify({ token: 'from-file', pid: 4242 }));
  assert.equal(resolveToken({ runtimePath: rt, env, isAlive: () => true }), 'from-file', 'live server: its file is current');
  assert.equal(resolveToken({ runtimePath: rt, env, isAlive: () => false }), 'from-env', 'dead writer: stale file ignored (the 403 case)');
  fs.writeFileSync(rt, JSON.stringify({ token: 'from-file' }));
  assert.equal(resolveToken({ runtimePath: rt, env, isAlive: () => true }), 'from-env', 'no pid: not trusted');
  assert.equal(resolveToken({ runtimePath: path.join(dir, 'absent.json'), env }), 'from-env');
  assert.equal(resolveToken({ runtimePath: path.join(dir, 'absent.json'), env: {} }), '');
  // Real pid check: this process is alive, a huge pid is not.
  fs.writeFileSync(rt, JSON.stringify({ token: 'from-file', pid: process.pid }));
  assert.equal(resolveToken({ runtimePath: rt, env }), 'from-file');
  fs.writeFileSync(rt, JSON.stringify({ token: 'from-file', pid: 999999 }));
  assert.equal(resolveToken({ runtimePath: rt, env }), 'from-env');
  fs.rmSync(dir, { recursive: true, force: true });
});
