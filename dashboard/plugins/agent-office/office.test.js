'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'office.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function load() {
  const elements = new Map();
  const ctx = {};
  function element(id) {
    if (!elements.has(id)) elements.set(id, { id, style: {}, clientWidth: 480, clientHeight: 270, innerHTML: '', textContent: '',
      addEventListener() {}, getContext() { return ctx; } });
    return elements.get(id);
  }
  const window = { addEventListener() {}, console };
  const sandbox = { window, document: { getElementById: element }, location: { protocol: 'file:', search: '' },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, requestAnimationFrame() {}, performance: { now: () => 0 },
    console, AbortController, Promise, Date, Math };
  vm.runInNewContext(script, sandbox);
  return window.__agentOffice;
}
const office = load();
const now = Date.now();
test('active loop uses actual task provider and is not duplicated', () => {
  const tasks = [{ id: 'abc', state: 'running', cli: 'ollama-mind', model: 'qwen', createdAt: now }];
  const loops = { loops: [{ id: 'autopilote:default', label: 'Principale', status: 'working', cli: 'claude', taskId: 'abc', detail: 'decouverte' }] };
  const rows = office.buildAgents(tasks, [], [], {}, {}, now, loops, null);
  assert.equal(rows.length, 1); assert.equal(rows[0].cli, 'ollama-mind'); assert.equal(rows[0].state, 'working');
});
test('loop with missing or conflicting task does not claim active work', () => {
  const loops = { loops: [{ id: 'default', status: 'working', taskId: 'x', cli: 'claude' }] };
  assert.equal(office.buildAgents([], [], [], {}, {}, now, loops, null)[0].state, 'unknown');
  assert.equal(office.buildAgents([{ id: 'x', state: 'unknown' }], [], [], {}, {}, now, loops, null)[0].state, 'unknown');
});
test('loop with a pending task shows waiting, not working', () => {
  const loops = { loops: [{ id: 'default', status: 'working', statusLabel: 'travaille', taskId: 'x' }] };
  const row = office.buildAgents([{ id: 'x', cli: 'codex', state: 'pending' }], [], [], {}, {}, now, loops, null)[0];
  assert.equal(row.state, 'waiting'); assert.equal(row.statusLabel, '');
});
test('local direct requests and orchestrator tasks use independent actual evidence', () => {
  const task = { id: 'def', state: 'running', cli: 'ollama-mind', createdAt: now };
  const rows = office.buildAgents([task], [], [], {}, {}, now, null, { activeCount: 2, startedAt: now });
  assert.equal(rows.length, 2); assert.equal(rows[0].id, 'brain:direct-local-ask'); assert.match(rows[0].title, /2 demande/);
  assert.equal(office.buildAgents([], [], [], {}, {}, now, null, { activeCount: 0 }).length, 0);
});
test('pending or unknown work is never reported as working', () => {
  assert.equal(office.taskState({ state: 'pending' }, null, now), 'waiting');
  assert.equal(office.taskState({ state: 'unrecognised' }, null, now), 'unknown');
});
test('terminal with unavailable activity is unknown rather than working', () => {
  const rows = office.buildAgents([], [], [{ id: 'term-1' }], { 'term-1': 'codex' }, {}, now, null, null);
  assert.equal(rows[0].state, 'unknown');
  const failed = office.buildAgents([], [], [{ id: 'term-1' }], { 'term-1': 'codex' }, { 'term-1': { lastChange: now, failed: true } }, now, null, null);
  assert.equal(failed[0].state, 'unknown');
});
test('active snapshot includes older tasks and conflicting terminal snapshots remain unknown', () => {
  const rows = office.mergeTasks([{ id: 'recent', state: 'completed' }, { id: 'both', state: 'completed' }],
    { tasks: [{ id: 'old-active', state: 'running' }, { id: 'both', state: 'running' }] });
  assert.equal(rows.length, 3);
  assert.equal(rows.find(t => t.id === 'old-active').state, 'running');
  assert.equal(rows.find(t => t.id === 'both').state, 'unknown');
});
test('task titles never expose prompts or model output', () => {
  const title = office.taskTitle({ id: 'abc', prompt: 'secret injected prompt', result: 'private output', taskClass: 'simple' });
  assert.match(title, /simple/); assert.doesNotMatch(title, /secret|private/);
});
test('provider list includes unknown future ids without claiming verified availability', () => {
  const rows = office.providerRows({ future: { enabled: true, available: true, locality: 'cloud' }, qwen: { enabled: false } }, null);
  assert.equal(rows.find(r => r.id === 'future').state, 'configure - disponibilite a verifier');
  assert.equal(rows.find(r => r.id === 'qwen').state, 'desactive');
  assert.equal(rows.find(r => r.id === 'ollama-mind').state, 'etat indisponible');
});
test('network loss never switches the live office to simulated agents', () => {
  assert.doesNotMatch(script, /setMode\('demo', 'serveur injoignable'\)/);
  assert.match(script, /setMode\(lastSuccessAt \? 'stale' : 'error'/);
  assert.doesNotMatch(html, /@media\s*\(max-width:\s*720px\)\s*\{\s*#side\s*\{\s*display:\s*none/);
});
