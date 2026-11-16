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
test('installed Qwen Mind retains idle desk with actual health and no duplicate during activity', () => {
  const health = { providers: { 'symphonee-qwen-mind': { ok: true, model: 'qwen2.5:1.5b' } } };
  const idle = office.buildAgents([], [], [], {}, {}, now, null, {activeCount: 0}, health);
  assert.equal(idle.length, 1); assert.equal(idle[0].id, 'provider:symphonee-qwen-mind'); assert.equal(idle[0].state, 'idle');
  const direct = office.buildAgents([], [], [], {}, {}, now, null, {activeCount: 1, startedAt: now}, health);
  assert.equal(direct.length, 1); assert.equal(direct[0].id, 'brain:direct-local-ask');
  const worker = office.buildAgents([{id:'q1', cli:'symphonee-qwen-mind', state:'running', startedAt:now}], [], [], {}, {}, now, null, null, health);
  assert.equal(worker.length, 1); assert.equal(worker[0].id, 'task:q1');
  const unavailable = office.buildAgents([], [], [], {}, {}, now, null, null, {providers:{'symphonee-qwen-mind':{ok:false}}});
  assert.equal(unavailable[0].state, 'unknown');
  assert.equal(office.buildAgents([], [], [], {}, {}, now, null, null, null).length, 0);
});
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

// ---- Animated office (canvas) ------------------------------------------
const scene = office.scene;
function resetScene() { Object.keys(scene.actors).forEach(k => delete scene.actors[k]); scene.deskOwner.length = 0; scene.particles.length = 0; office.setCalm(false); }
function walk(seconds) { for (let i = 0; i < seconds * 10; i++) scene.step(0.1); }
const agent = (id, state, extra) => Object.assign({ id, kind: 'task', cli: 'claude', model: '', title: 'Type: simple', state, since: now }, extra);

test('short label comes from structured fields only', () => {
  assert.equal(office.shortLabel({ title: 'Type: simple | Role: reviewer | Tache: ab' }), 'reviewer');
  assert.equal(office.shortLabel({ title: 'Type: simple' }), 'simple');
  assert.equal(office.shortLabel({ kind: 'terminal', title: 'Terminal principal' }), 'terminal');
  assert.equal(office.shortLabel({ kind: 'loop', name: 'Principale', title: 'decouverte' }), 'Principale');
  assert.equal(office.shortLabel(null), '');
  assert.doesNotMatch(office.shortLabel({ title: office.taskTitle({ id: 'a', prompt: 'secret injected prompt', selectedRole: 'coder' }) }), /secret/);
});

test('a new agent enters by the door, walks to its desk and sits down', () => {
  resetScene();
  scene.syncActors([agent('task:1', 'working')]);
  const a = scene.actors['task:1'];
  assert.equal(a.x, scene.DOOR.x); assert.equal(a.y, scene.DOOR.y); assert.equal(a.seated, false);
  assert.equal(scene.deskOwner[0], 'task:1');
  walk(20);
  assert.equal(a.seated, true); assert.equal(a.path.length, 0);
});

test('finished work goes to the lounge and frees the desk', () => {
  resetScene();
  scene.syncActors([agent('task:2', 'working')]); walk(20);
  scene.syncActors([agent('task:2', 'done')]);
  assert.equal(scene.deskOwner[0] || null, null);
  assert.equal(scene.actors['task:2'].seated, false);
  walk(30);
  assert.ok(scene.actors['task:2'].x > 380, 'ended up in the lounge');
  scene.syncActors([agent('task:3', 'working')]);
  assert.equal(scene.deskOwner[0], 'task:3', 'the freed desk is reused');
});

test('an agent that disappears from the data walks out and is removed', () => {
  resetScene();
  scene.syncActors([agent('task:4', 'working')]); walk(20);
  scene.syncActors([]);
  assert.equal(scene.actors['task:4'].leaving, true);
  walk(30);
  assert.equal(scene.actors['task:4'], undefined);
});

test('more agents than desks are counted, not lost', () => {
  resetScene();
  const many = []; for (let i = 0; i < 11; i++) many.push(agent('task:m' + i, 'working'));
  scene.syncActors(many);
  assert.equal(Object.keys(scene.actors).length, 8);
  assert.equal(scene.overflow(), 3);
});

test('clicking a seated character finds it, empty floor finds nothing', () => {
  resetScene();
  scene.syncActors([agent('task:5', 'waiting')]); walk(20);
  const a = scene.actors['task:5'];
  assert.equal(office.actorAt(a.x, a.y - 10), 'task:5');
  assert.equal(office.actorAt(2, 2), null);
});

test('agent sheet shows the agent, escapes text, and has a legend when nothing is selected', () => {
  assert.match(office.sheetHtml(null, now), /Clique sur un personnage/);
  const html = office.sheetHtml(agent('task:6', 'working', { title: '<img src=x onerror=alert(1)>' }), now);
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
});

test('the loop pauses when hidden and honours reduced motion', () => {
  assert.match(script, /if \(document\.hidden\) return;/);
  assert.match(script, /visibilitychange/);
  assert.match(script, /prefers-reduced-motion: reduce/);
});

test('a state change gets a reaction: smoke on failure, sparks when done, nothing in calm mode', () => {
  resetScene();
  scene.syncActors([agent('task:7', 'working')]); walk(20);
  scene.particles.length = 0;
  scene.syncActors([agent('task:7', 'failed')]);
  assert.ok(scene.particles.length > 0, 'smoke on failure');
  scene.particles.length = 0;
  scene.syncActors([agent('task:7', 'done')]);
  assert.ok(scene.particles.length > 0, 'sparks when done');
  resetScene();
  office.setCalm(true);
  scene.syncActors([agent('task:8', 'working')]); scene.step(0.1);
  scene.syncActors([agent('task:8', 'failed')]);
  assert.equal(scene.particles.length, 0);
});

test('calm mode skips the walk and goes straight to the desk', () => {
  resetScene();
  office.setCalm(true);
  scene.syncActors([agent('task:9', 'working')]);
  scene.step(0.1);
  assert.equal(scene.actors['task:9'].seated, true);
  assert.equal(scene.actors['task:9'].path.length, 0);
});

test('the scene only counts as busy while something moves or works', () => {
  resetScene();
  assert.equal(office.isBusy(), false);
  scene.syncActors([agent('task:10', 'idle')]);
  assert.equal(office.isBusy(), true, 'walking in');
  walk(20);
  assert.equal(office.isBusy(), false, 'seated and idle');
  scene.syncActors([agent('task:10', 'working')]);
  assert.equal(office.isBusy(), true, 'typing');
});

test('hair, accessories and the unknown bubble never need the removed shift operator', () => {
  assert.doesNotMatch(script, /ph >> 3/);
  assert.doesNotMatch(script, /reduceMotion/);
});

// ---- Answering a waiting terminal ---------------------------------------
test('the question is cleaned: no colour codes, no control characters, last lines only', () => {
  const raw = '\x1b[32mline one\x1b[0m\r\n\x1b[1mDo you want to proceed?\x1b[0m\r\n 1. Yes\r\n 2. No\x07\r\n';
  assert.equal(office.cleanAsk(raw), 'line one\nDo you want to proceed?\n 1. Yes\n 2. No');
  const many = Array.from({ length: 30 }, (_, i) => 'row ' + i).join('\n');
  assert.equal(office.cleanAsk(many).split('\n').length, 8);
  assert.equal(office.cleanAsk(''), '');
});

test('choices follow the prompt: numbered menu, yes/no, and always Enter', () => {
  const menu = office.replyChoices('Do you want to proceed?\n \u276f 1. Yes\n   2. Yes, and do not ask again\n   3. No');
  assert.deepEqual(Array.from(menu.map(c => c.act)), ['opt:1', 'opt:2', 'opt:3', 'enter']);
  assert.match(menu[1].label, /do not ask again/);
  assert.deepEqual(Array.from(office.replyChoices('Continue? (y/n)').map(c => c.act)), ['yes', 'no', 'enter']);
  assert.deepEqual(Array.from(office.replyChoices('press enter to continue').map(c => c.act)), ['enter']);
});

test('keystrokes are exact: digit alone, y/n with Enter, text sanitised', () => {
  assert.equal(office.payloadFor('enter'), '\r');
  assert.equal(office.payloadFor('yes'), 'y\r');
  assert.equal(office.payloadFor('no'), 'n\r');
  assert.equal(office.payloadFor('opt:2'), '2');
  assert.equal(office.payloadFor('text', '  oui, vas-y  '), 'oui, vas-y\r');
  assert.equal(office.payloadFor('text', 'a\x1b[31mb\nc'), 'a [31mb c\r');      // escape and newline never reach the terminal
  assert.equal(office.payloadFor('text', '   '), null);
  assert.equal(office.payloadFor('opt:10'), null);
  assert.equal(office.payloadFor('rm -rf'), null);
});

test('only a waiting terminal can be answered', () => {
  assert.equal(office.canReply({ kind: 'terminal', state: 'waiting', termId: 'term-2' }), true);
  assert.equal(office.canReply({ kind: 'terminal', state: 'working', termId: 'term-2' }), false);
  assert.equal(office.canReply({ kind: 'task', state: 'waiting', termId: 'x' }), false);
  assert.equal(office.canReply({ kind: 'loop', state: 'waiting' }), false);
  assert.equal(office.canReply(null), false);
});

test('a waiting terminal exposes its question and signature to the office', () => {
  const tail = 'Do you want to proceed?\n 1. Yes\n 2. No';
  const rows = office.buildAgents([], [], [{ id: 'term-2' }], { 'term-2': 'claude' }, { 'term-2': { lastChange: now, tail, sig: '3:40:123' } }, now, null, null);
  assert.equal(rows[0].state, 'waiting');
  assert.equal(rows[0].termId, 'term-2');
  assert.match(rows[0].ask, /Do you want to proceed/);
  assert.equal(rows[0].askSig, '3:40:123');
  const busy = office.buildAgents([], [], [{ id: 'term-3' }], { 'term-3': 'codex' }, { 'term-3': { lastChange: now, tail: 'compiling...', sig: 'x' } }, now, null, null);
  assert.equal(busy[0].ask, ''); assert.equal(busy[0].askSig, '');
});

// ---- One list of requests for the user ---------------------------------
const waitingTerm = { id: 'term:t2', kind: 'terminal', cli: 'claude', state: 'waiting', title: 'Terminal t2', termId: 't2', ask: 'Do you want to proceed?\n 1. Yes\n 2. No', askSig: 'sig1' };
const approval = { runId: 'gr_1', runName: 'Boucle PleinSens', nodeId: 'review', title: 'Valider le plan ?' };
const decision = { id: 'dec_0a1b2c3d', from: 'codex', title: 'R2 : consigner ?', body: 'Detail', ref: 'fiche C1', options: [{ id: 'oui', label: 'Oui' }, { id: 'non', label: 'Non' }], allowText: true };

test('requests from the three sources are merged into one list', () => {
  const asks = office.buildAsks([waitingTerm, { id: 'term:t3', kind: 'terminal', state: 'working', termId: 't3' }], { approvals: [approval, { runId: 'x' }], decisions: { pending: [decision, {}] } });
  assert.deepEqual(Array.from(asks.map(a => a.kind)), ['terminal', 'approval', 'decision']);
  assert.deepEqual(Array.from(asks.map(a => a.key)), ['t|t2|sig1', 'a|gr_1|review', 'd|dec_0a1b2c3d']);
  assert.deepEqual(Array.from(asks[2].choices.map(c => c.act)), ['opt:oui', 'opt:non']);
  assert.deepEqual(Array.from(office.buildAsks([], null)), []);
  assert.equal(office.buildAsks([], { approvals: [], decisions: { pending: [] } }).length, 0);
});

test('a request card escapes everything and offers the right controls', () => {
  const evil = { id: 'dec_0a1b2c3d', from: '<b>x</b>', title: '<img src=x onerror=alert(1)>', body: '<script>1</script>', ref: '"><i>', options: [{ id: 'a', label: '<u>A</u>' }], allowText: true };
  const html = office.askCardHtml(office.buildAsks([], { approvals: [], decisions: { pending: [evil] } })[0], 'brouillon "x"', null);
  assert.doesNotMatch(html, /<img|<script|<b>x|<u>A|<i>/);
  assert.match(html, /data-act="opt:a"/);
  assert.match(html, /value="brouillon &quot;x&quot;"/, 'the draft is restored, escaped');
  assert.doesNotMatch(html, /data-act="text"/, 'choices plus a note: the text is attached to a choice, no separate Send');
  const term = office.askCardHtml(office.buildAsks([waitingTerm], null)[0], '', null);
  assert.match(term, /data-act="opt:1"/); assert.match(term, /data-act="enter"/); assert.match(term, /data-act="text"/);
  const gate = office.askCardHtml(office.buildAsks([], { approvals: [approval], decisions: null })[0], '', null);
  assert.match(gate, /data-act="approve"/); assert.match(gate, /data-act="reject"/);
  const freeOnly = office.askCardHtml(office.buildAsks([], { approvals: [], decisions: { pending: [{ id: 'dec_00000001', title: 'Libre', options: [], allowText: true }] } })[0], '', null);
  assert.match(freeOnly, /data-act="text"/);
});

test('answering routes each request to its own source', async () => {
  const calls = [];
  const plain = (x) => JSON.parse(JSON.stringify(x));      // objects made inside the page are from another realm
  const deps = { postJson: (url, body) => { calls.push(plain([url, body])); return Promise.resolve({ ok: true }); }, sendReply: (t, p, sig) => { calls.push(['term', t, p, sig]); return Promise.resolve(true); } };
  const [t, a, d] = office.buildAsks([waitingTerm], { approvals: [approval], decisions: { pending: [decision] } });
  await office.answerAsk(t, 'opt:1', '', deps);
  assert.deepEqual(calls.pop(), ['term', 't2', '1', 'sig1']);
  await office.answerAsk(a, 'approve', '  ok pour moi \n', deps);
  assert.deepEqual(calls.pop(), ['/api/graph-runs/gr_1/approve/review', { approved: true, note: 'ok pour moi' }]);
  await office.answerAsk(a, 'reject', '', deps);
  assert.deepEqual(calls.pop(), ['/api/graph-runs/gr_1/approve/review', { approved: false, note: '' }]);
  await office.answerAsk(d, 'opt:oui', 'mais surveille', deps);
  assert.deepEqual(calls.pop(), ['/api/decisions/answer', { id: 'dec_0a1b2c3d', choice: 'oui', text: 'mais surveille' }]);
  await office.answerAsk(d, 'opt:non', '', deps);
  assert.deepEqual(calls.pop(), ['/api/decisions/answer', { id: 'dec_0a1b2c3d', choice: 'non' }]);
  await assert.rejects(office.answerAsk(d, 'text', '   ', deps), /Ecris/);
  await assert.rejects(office.answerAsk(a, 'peut-etre', '', deps), /inconnu/);
  await assert.rejects(office.answerAsk(t, 'text', '', deps), /Ecris/);
  assert.equal(calls.length, 0, 'nothing was sent for an empty or unknown answer');
});

test('a choice-only question never carries free text to the server', async () => {
  const calls = [];
  const [d] = office.buildAsks([], { approvals: [], decisions: { pending: [{ id: 'dec_0a1b2c3d', title: 'Choisir', options: [{ id: 'a', label: 'A' }], allowText: false }] } });
  await office.answerAsk(d, 'opt:a', 'du texte', { postJson: (u, b) => { calls.push(JSON.parse(JSON.stringify(b))); return Promise.resolve({}); } });
  assert.deepEqual(calls, [{ id: 'dec_0a1b2c3d', choice: 'a' }]);
});

test('the request section is rebuilt only when the set of requests changes', () => {
  assert.match(script, /if \(sig === asksSig\) return;/);
  assert.match(script, /drafts\[it\.key\]/);
  assert.doesNotMatch(script, /sheetReply|replyHtml/);
});

test('sending re-reads the terminal and refuses when it changed', async () => {
  const sent = [];
  const sock = () => Promise.resolve({ send: d => sent.push(d), close() {} });
  const same = { termId: 't', output: 'Do you want to proceed?', totalLines: 3 };
  // the signature is built exactly like the poller does
  const sigOf = (o) => { const t = String(o.output); let hh = 2166136261; for (let i = 0; i < t.length; i++) { hh ^= t.charCodeAt(i); hh = Math.imul(hh, 16777619); } return o.totalLines + ':' + t.length + ':' + (hh >>> 0); };
  await office.sendReply('t', 'y\r', sigOf(same), { getJson: () => Promise.resolve(same), openSocket: sock });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]), { type: 'input', termId: 't', data: 'y\r' });
  await assert.rejects(office.sendReply('t', 'y\r', sigOf(same), { getJson: () => Promise.resolve({ termId: 't', output: 'something else now', totalLines: 4 }), openSocket: sock }), e => e.code === 'CHANGED');
  assert.equal(sent.length, 1, 'nothing was sent after the terminal changed');
  await assert.rejects(office.sendReply('t', 'y\r', sigOf(same), { getJson: () => Promise.reject(new Error('down')), openSocket: sock }), /down/);
  assert.equal(sent.length, 1);
  // the read route answers for ANOTHER terminal when the id is unknown: never answer that one
  await assert.rejects(office.sendReply('t', 'y\r', sigOf(same), { getJson: () => Promise.resolve({ termId: 'main', output: same.output, totalLines: 3 }), openSocket: sock }), e => e.code === 'GONE');
  assert.equal(sent.length, 1, 'nothing was sent to a different terminal');
});
