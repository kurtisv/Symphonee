'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { LIMITS, clean, normalizeNew, createStore, hintFor, mountDecisions } = require('./decisions');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
const ok = (r) => { assert.equal(r.error, undefined, r.error); return r.decision || r.value; };

test('text is cleaned and bounded', () => {
  assert.equal(clean('a\x00b\x1bc\nd'), 'a b c d');
  assert.equal(clean('a\x00b\nc', 100, true), 'ab\nc');
  assert.equal(clean('x'.repeat(500), 10), 'xxxxxxxxxx');
  assert.equal(clean(null, 10), '');
});

test('a new decision is validated and normalised', () => {
  const v = ok(normalizeNew({ title: '  R2 : accepter ?  ', body: 'Detail\nsur deux lignes', options: ['Oui', { id: 'non', label: 'Non' }], from: 'codex', ref: 'fiche C1 16.8', termId: 'term-2' }));
  assert.equal(v.title, 'R2 : accepter ?');
  assert.deepEqual(v.options, [{ id: 'o1', label: 'Oui' }, { id: 'non', label: 'Non' }]);
  assert.equal(v.allowText, false);
  assert.equal(v.termId, 'term-2');
  assert.equal(ok(normalizeNew({ title: 'Libre' })).allowText, true, 'no options means free text');
  assert.equal(ok(normalizeNew({ title: 'Mixte', options: ['A'], allowText: true })).allowText, true);
});

test('invalid decisions are refused with a reason', () => {
  const bad = (input, re) => assert.match(normalizeNew(input).error, re);
  bad(null, /title/);
  bad({ title: '   ' }, /title/);
  bad({ title: 'x', options: 'oui' }, /list/);
  bad({ title: 'x', options: [''] }, /label/);
  bad({ title: 'x', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, /at most 6/);
  bad({ title: 'x', options: [{ id: 'a b', label: 'A' }] }, /ids/);
  bad({ title: 'x', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /duplicate/);
  bad({ title: 'x', options: ['A'], allowText: false, termId: '../etc' }, /termId/);
  bad({ title: 'x', allowText: false }, /options or allowText/);
});

test('answering: a known choice, free text, and the refusals', () => {
  const s = createStore();
  const d = ok(s.create({ title: 'Choisir', options: ['Oui', 'Non'] }));
  assert.match(d.id, /^dec_[0-9a-f]{8}$/);
  assert.equal(s.answer(d.id, { choice: 'zzz' }).error, 'unknown choice');
  assert.match(s.answer(d.id, {}).error, /choice or some text/);
  assert.match(s.answer(d.id, { choice: 'o1', text: 'et en plus' }).error, /choice only/);
  const a = ok(s.answer(d.id, { choice: 'o2' }));
  assert.equal(a.status, 'answered'); assert.deepEqual(a.answer, { choice: 'o2', text: null });
  assert.equal(s.answer(d.id, { choice: 'o1' }).code, 409, 'only the first answer counts');
  assert.equal(s.answer('dec_00000000', { choice: 'o1' }).code, 404);
  const free = ok(s.create({ title: 'Libre' }));
  assert.equal(ok(s.answer(free.id, { text: '  oui, vas-y\x1b  ' })).answer.text, 'oui, vas-y');
});

test('dismissing closes a decision without an answer', () => {
  const s = createStore();
  const d = ok(s.create({ title: 'x', options: ['A'] }));
  assert.equal(ok(s.dismiss(d.id)).status, 'dismissed');
  assert.equal(s.dismiss(d.id).code, 409);
  assert.equal(s.list().pending.length, 0);
});

test('too many pending decisions are refused', () => {
  const s = createStore();
  for (let i = 0; i < LIMITS.pending; i++) ok(s.create({ title: 'q' + i, options: ['A'] }));
  assert.equal(s.create({ title: 'one more', options: ['A'] }).code, 429);
  ok(s.dismiss(s.list().pending[0].id));
  ok(s.create({ title: 'now there is room', options: ['A'] }));
});

test('decisions survive a restart and old finished ones are trimmed', () => {
  const dir = tmp(), file = path.join(dir, 'd.json');
  const s = createStore({ file });
  const keep = ok(s.create({ title: 'garde', options: ['A'] }));
  const done = ok(s.create({ title: 'fini', options: ['A'] }));
  ok(s.answer(done.id, { choice: 'o1' }));
  const again = createStore({ file });
  assert.equal(again.get(keep.id).status, 'pending');
  assert.equal(again.get(done.id).answer.choice, 'o1');
  const many = createStore({ file: path.join(dir, 'many.json') });
  for (let i = 0; i < LIMITS.keep + 5; i++) { const d = ok(many.create({ title: 'n' + i, options: ['A'] })); ok(many.answer(d.id, { choice: 'o1' })); }
  assert.equal(many._items().length, LIMITS.keep);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  assert.equal(createStore({ file: path.join(dir, 'broken.json') }).list().pending.length, 0, 'a damaged file starts empty, never crashes');
});

test('the hint typed into the agent terminal is one clean short line', () => {
  const d = { id: 'dec_0a1b2c3d', status: 'answered', options: [{ id: 'o1', label: 'Oui' }], answer: { choice: 'o1', text: 'ligne 1\nligne 2\x1b[31m' } };
  const h = hintFor(d);
  assert.match(h, /^\[DECISION ANSWERED dec_0a1b2c3d\] Oui \/ ligne 1 ligne 2 \[31m\. Read it: GET \/api\/decisions\/item\?id=dec_0a1b2c3d$/);
  assert.doesNotMatch(h, /[\x00-\x1f]/);
  assert.ok(hintFor(Object.assign({}, d, { answer: { choice: null, text: 'x'.repeat(2000) } })).length <= 300);
  assert.match(hintFor({ id: 'dec_0a1b2c3d', status: 'dismissed', options: [], answer: null }), /dismissed by the user/);
});

// ---- the real routes over HTTP ------------------------------------------
function serve(deps) {
  const routes = new Map();
  const addRoute = (method, p, handler) => routes.set(method + ' ' + p, handler);
  const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  mountDecisions(addRoute, json, deps);
  const server = http.createServer((req, res) => {
    const h = routes.get(req.method + ' ' + new URL(req.url, 'http://x').pathname);
    return h ? h(req, res) : json(res, { error: 'no route' }, 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port })));
}
const call = async (base, method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  return { status: r.status, body: await r.json() };
};

test('routes: ask, list, answer, read back, and tell the asking terminal', async () => {
  const injected = [], events = [];
  const { server, base } = await serve({ repoRoot: tmp(), broadcast: (m) => events.push(m.type), inject: (t, text) => { injected.push([t, text]); return { ok: true }; } });
  try {
    const made = await call(base, 'POST', '/api/decisions', { title: 'R2 : exception M0 ?', body: 'Baseline seule avant candidat.', options: [{ id: 'oui', label: 'Oui, consigner' }, { id: 'non', label: 'Non' }], from: 'codex', termId: 'term-2' });
    assert.equal(made.status, 201);
    const id = made.body.decision.id;
    const list = await call(base, 'GET', '/api/decisions');
    assert.equal(list.body.pending.length, 1); assert.equal(list.body.pending[0].id, id);
    const bad = await call(base, 'POST', '/api/decisions/answer', { id, choice: 'peut-etre' });
    assert.equal(bad.status, 400);
    const done = await call(base, 'POST', '/api/decisions/answer', { id, choice: 'oui' });
    assert.equal(done.status, 200); assert.equal(done.body.decision.status, 'answered');
    assert.equal(injected.length, 1); assert.equal(injected[0][0], 'term-2'); assert.match(injected[0][1], /\[DECISION ANSWERED .*Oui, consigner/);
    const item = await call(base, 'GET', '/api/decisions/item?id=' + id);
    assert.equal(item.body.decision.answer.choice, 'oui'); assert.equal(item.body.decision.notified, true);
    assert.equal((await call(base, 'POST', '/api/decisions/answer', { id, choice: 'non' })).status, 409);
    assert.equal((await call(base, 'GET', '/api/decisions/item?id=dec_ffffffff')).status, 404);
    assert.equal((await call(base, 'GET', '/api/decisions/item?id=../../etc')).status, 404);
    assert.equal((await call(base, 'POST', '/api/decisions', 'not json')).status, 400);
    assert.deepEqual(events.filter((e) => e === 'decisions-changed').length, 2, 'the Bureau is told after each change');
    const dis = await call(base, 'POST', '/api/decisions', { title: 'a ecarter', options: ['A'] });
    assert.equal((await call(base, 'POST', '/api/decisions/dismiss', { id: dis.body.decision.id })).body.decision.status, 'dismissed');
  } finally { server.close(); }
});

test('routes: no terminal is typed into unless the asker gave one', async () => {
  const injected = [];
  const { server, base } = await serve({ repoRoot: tmp(), broadcast() {}, inject: (t, x) => { injected.push([t, x]); return { ok: true }; } });
  try {
    const made = await call(base, 'POST', '/api/decisions', { title: 'sans terminal', options: ['A'] });
    await call(base, 'POST', '/api/decisions/answer', { id: made.body.decision.id, choice: 'o1' });
    assert.equal(injected.length, 0);
  } finally { server.close(); }
});

test('routes: a terminal that is gone is recorded, not fatal', async () => {
  const { server, base } = await serve({ repoRoot: tmp(), broadcast() {}, inject: () => ({ ok: false, error: 'not found' }) });
  try {
    const made = await call(base, 'POST', '/api/decisions', { title: 'x', options: ['A'], termId: 'term-9' });
    const r = await call(base, 'POST', '/api/decisions/answer', { id: made.body.decision.id, choice: 'o1' });
    assert.equal(r.status, 200);
    assert.equal((await call(base, 'GET', '/api/decisions/item?id=' + made.body.decision.id)).body.decision.notified, false);
  } finally { server.close(); }
});
