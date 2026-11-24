'use strict';
// Saving a pilot definition from a form that does not know the behaviour gate must not erase it (it did: the route rebuilds the definition from a fixed field list).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mountMindAutopilot } = require('./autopilot');

const BEHAVIOR = { required: true, sourceDirs: ['src/'], testCmd: [process.execPath, '--test', '{files}'], timeoutMs: 60000 };

function mount() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-'));
  fs.mkdirSync(path.join(root, '.symphonee'));
  fs.writeFileSync(path.join(root, '.symphonee', 'mind-autopilots.json'), JSON.stringify({ pilots: { demo: { label: 'Demo', verify: [], behavior: BEHAVIOR } } }));
  const routes = {}; const addRoute = (m, p, h) => { routes[m + ' ' + p] = h; };
  const json = (res, body, status) => { res.body = body; res.status = status || 200; };
  mountMindAutopilot(addRoute, json, { repoRoot: root, orchestrator: {}, orch: {}, spawn: () => {}, log: () => {} });
  return { root, routes, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const post = async (routes, body) => {
  const req = { method: 'POST', on(ev, cb) { if (ev === 'data') setImmediate(() => cb(JSON.stringify(body))); if (ev === 'end') setImmediate(() => setImmediate(() => cb())); return this; } };
  const res = {}; await routes['POST /api/mind/autopilots'](req, res); return res;
};
const saved = (root) => JSON.parse(fs.readFileSync(path.join(root, '.symphonee', 'mind-autopilots.json'), 'utf8')).pilots.demo;

test('a form that does not know "behavior" keeps the gate, and one that sends it replaces it', async () => {
  const m = mount();
  try {
    assert.equal(saved(m.root).behavior.required, true);
    const keep = await post(m.routes, { id: 'demo', label: 'Demo renamed', verify: [] });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.equal(saved(m.root).behavior.required, true, 'not erased by a save that did not mention it');
    assert.equal(saved(m.root).label, 'Demo renamed');
    const off = await post(m.routes, { id: 'demo', verify: [], behavior: { required: false } });
    assert.equal(off.status, 200); assert.equal(saved(m.root).behavior.required, false, 'an explicit value wins');
  } finally { m.clean(); }
});

test('a save keeps the gate that is on DISK (changed by an activation script after this process started), and the list shows what the pilot runs with', async () => {
  const m = mount();
  try {
    // the file now holds a different gate than the one loaded in memory
    const file = path.join(m.root, '.symphonee', 'mind-autopilots.json');
    const defs = JSON.parse(fs.readFileSync(file, 'utf8')); defs.pilots.demo.behavior = { ...BEHAVIOR, sourceDirs: ['lib/'] }; fs.writeFileSync(file, JSON.stringify(defs));
    const r = await post(m.routes, { id: 'demo', label: 'Saved from a form', verify: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(saved(m.root).behavior.sourceDirs, ['lib/'], 'the on-disk gate survives the save');
  } finally { m.clean(); }
});

test('GET /api/mind/autopilots exposes whether each pilot runs with the gate', async () => {
  const m = mount();
  try {
    const res = {}; await m.routes['GET /api/mind/autopilots']({}, res);
    const demo = res.body.pilots.find((p) => p.pilot === 'demo');
    const gate = require('./behavior-gate');
    assert.deepEqual(demo.behavior, { required: true, invalid: [], fingerprint: gate.fingerprint(BEHAVIOR) });
    assert.equal(res.body.pilots.find((p) => p.pilot === 'default').behavior.required, false);
  } finally { m.clean(); }
});

test('a gate REMOVED on disk stays removed when a form saves before the restart (the in-memory gate is not put back)', async () => {
  const m = mount();
  try {
    const file = path.join(m.root, '.symphonee', 'mind-autopilots.json');
    const defs = JSON.parse(fs.readFileSync(file, 'utf8')); delete defs.pilots.demo.behavior; fs.writeFileSync(file, JSON.stringify(defs));
    const r = await post(m.routes, { id: 'demo', label: 'Saved', verify: [] });
    assert.equal(r.status, 200); assert.notEqual((saved(m.root).behavior || {}).required, true, 'still off: the in-memory gate was not put back');
  } finally { m.clean(); }
});

test('fingerprint: same configuration, same value, whatever the key order; another configuration, another value', () => {
  const gate = require('./behavior-gate');
  assert.equal(gate.fingerprint(BEHAVIOR), gate.fingerprint({ timeoutMs: 60000, testCmd: BEHAVIOR.testCmd, sourceDirs: ['src/'], required: true }));
  assert.notEqual(gate.fingerprint(BEHAVIOR), gate.fingerprint({ ...BEHAVIOR, sourceDirs: ['lib/'] }));
  assert.equal(gate.fingerprint({ required: false }), gate.fingerprint(undefined), 'off is off');
});

test('the fallback-permissions route also keeps the gate that is on disk (it used to write the in-memory definition over it)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'autopilot.js'), 'utf8');
  assert.match(src, /all\[p\.id\] = \{ \.\.\.\(all\[p\.id\] \|\| p\.def\), fallback: settings \}/);
  assert.doesNotMatch(src, /all\[p\.id\] = \{ \.\.\.p\.def, fallback: settings \}/);
});
