'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { resolveToken, writerRunning } = require('./api-token');

const W = '2026-11-13T15:53:03.605Z';
const ms = (iso) => Date.parse(iso);

test('writerRunning: live pid that started just before the file, not a reused or dead pid', () => {
  const at = (iso) => () => ms(iso);
  assert.equal(writerRunning(4144, W, at('2026-11-13T15:53:03.275Z')), true, 'started 0.3 s before writing');
  assert.equal(writerRunning(4144, W, at('2026-11-13T16:20:00.000Z')), false, 'pid reused by a later process');
  assert.equal(writerRunning(4144, W, at('2026-11-12T09:00:00.000Z')), false, 'started long before: not the writer');
  assert.equal(writerRunning(4144, W, () => null), false, 'dead pid');
  assert.equal(writerRunning(NaN, W, at(W)), false, 'no pid');
  assert.equal(writerRunning(4144, undefined, at(W)), false, 'no startedAt');
});

test('resolveToken: the file only while its writer runs, else the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  const rt = path.join(dir, 'runtime.json');
  const env = { SYMPHONEE_TOKEN: 'from-env' };
  fs.writeFileSync(rt, JSON.stringify({ token: 'from-file', pid: 4242, startedAt: W }));
  assert.equal(resolveToken({ runtimePath: rt, env, isWriterRunning: () => true }), 'from-file');
  assert.equal(resolveToken({ runtimePath: rt, env, isWriterRunning: () => false }), 'from-env', 'stale file ignored (the 403 case)');
  assert.equal(resolveToken({ runtimePath: path.join(dir, 'absent.json'), env }), 'from-env');
  assert.equal(resolveToken({ runtimePath: path.join(dir, 'absent.json'), env: {} }), '');
  // Real check against this very process: it is alive and started before "now".
  fs.writeFileSync(rt, JSON.stringify({ token: 'from-file', pid: process.pid, startedAt: new Date().toISOString() }));
  assert.equal(resolveToken({ runtimePath: rt, env }), 'from-file', 'real live writer');
  fs.writeFileSync(rt, JSON.stringify({ token: 'from-file', pid: process.pid, startedAt: '2020-01-01T00:00:00Z' }));
  assert.equal(resolveToken({ runtimePath: rt, env }), 'from-env', 'real process, but it did not write that old file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a writer that dies is noticed by the same long-running process (no stale cache)', async () => {
  const { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-dead-'));
  const rt = path.join(dir, 'runtime.json');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(rt, JSON.stringify({ token: 'from-file', pid: child.pid, startedAt: new Date().toISOString() }));
  const env = { SYMPHONEE_TOKEN: 'from-env' };
  assert.equal(resolveToken({ runtimePath: rt, env }), 'from-file', 'writer alive');
  child.kill();
  await new Promise((r) => child.on('exit', r));
  assert.equal(resolveToken({ runtimePath: rt, env }), 'from-env', 'writer gone: environment token');
  fs.rmSync(dir, { recursive: true, force: true });
});
