'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { helperSource } = require('./hard-restart');

const waitFor = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

for (const [label, hangs] of [['an old process that exits', false], ['an old process that hangs (force-stopped)', true]]) {
  test('helper starts the new instance after ' + label, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-restart-'));
    const marker = path.join(dir, 'started');
    const old = spawn(process.execPath, ['-e', hangs ? 'setInterval(() => {}, 1000)' : 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
    const src = helperSource({ pid: old.pid, execPath: process.execPath, args: ['-e', "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'ok')"], cwd: dir, waitMs: 1500 });
    const h = spawn(process.execPath, ['-e', src], { stdio: 'ignore' });
    assert.equal(await waitFor(() => fs.existsSync(marker), 10000), true, 'new instance started');
    let oldAlive = true; try { process.kill(old.pid, 0); } catch (_) { oldAlive = false; }
    assert.equal(oldAlive, false, 'old process gone');
    try { h.kill(); } catch (_) {}
  });
}
