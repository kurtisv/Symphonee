'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const lib = require('./freellm');

const cfg = { enabled: true, apiKey: 'freellmapi-test', baseUrl: 'http://127.0.0.1:3001/v1', model: 'gemini-3.6-flash' };
const okFetch = (calls) => async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'reponse' } }], usage: { total_tokens: 3 } }) }; };

test('guardPrompt : refuse les secrets et cles', () => {
  const fake = (parts) => parts.join('');
  const bad = [fake(['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789']), fake(['sk-or-', 'v1-', 'a'.repeat(30)]), fake(['nv', 'api-', 'A'.repeat(30)]), fake(['AI', 'za', 'B'.repeat(30)]),
    fake(['-----BEGIN RSA ', 'PRIVATE KEY-----']), 'Authorization: Bearer ' + 'x'.repeat(30), 'a'.repeat(0) + '0123456789abcdef'.repeat(3), 'password: hunter2'];
  for (const t of bad) assert.equal(lib.guardPrompt('voici ' + t).ok, false, t.slice(0, 20));
});

test('guardPrompt : refuse la paie et les donnees personnelles', () => {
  for (const t of ['calcule la paie de Julie', 'talon de paie du 15 mars', 'salaire brut 3200', 'mon NAS est 123 456 789', 'IBAN FR76 3000', 'carte 4111 1111 1111 1111', 'api_key = abc'])
    assert.equal(lib.guardPrompt(t).ok, false, t);
});

test('guardPrompt : laisse passer un texte public ordinaire', () => {
  for (const t of ['Explique la difference entre let et const en JavaScript.', 'Ecris une fonction qui renvoie la moyenne d un tableau.', 'Resume ce paragraphe sur les volcans.'])
    assert.equal(lib.guardPrompt(t).ok, true, t);
});

test('chat : portee obligatoire (public ou fictional-fixture), sinon aucun appel reseau', async () => {
  for (const scope of [undefined, '', 'real-repo', 'payroll', 'Public']) {
    const calls = []; const r = await lib.chat({ config: cfg, prompt: 'bonjour', scope, fetchFn: okFetch(calls) });
    assert.equal(r.ok, false); assert.match(r.error, /^refused/); assert.equal(calls.length, 0, String(scope));
  }
});

test('chat : texte sensible refuse avant tout appel reseau, meme avec une bonne portee', async () => {
  const calls = []; const r = await lib.chat({ config: cfg, prompt: 'calcule la paie de Julie', scope: 'public', fetchFn: okFetch(calls) });
  assert.equal(r.ok, false); assert.match(r.error, /^refused/); assert.equal(calls.length, 0);
});

test('chat : appel nominal vers la boucle locale avec la cle en en-tete, limite de sortie large', async () => {
  const calls = []; const r = await lib.chat({ config: cfg, prompt: 'bonjour', scope: 'public', fetchFn: okFetch(calls) });
  assert.equal(r.ok, true); assert.equal(r.text, 'reponse');
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer freellmapi-test');
  const b = JSON.parse(calls[0].init.body); assert.equal(b.model, 'gemini-3.6-flash'); assert.ok(b.max_tokens >= 4000);
});

test('chat : desactive sans configuration, reponse coupee = echec, erreur sans fuite de cle', async () => {
  assert.equal((await lib.chat({ config: { enabled: false, reason: 'no key configured' }, prompt: 'x', scope: 'public', fetchFn: okFetch([]) })).ok, false);
  const cut = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }) });
  assert.match((await lib.chat({ config: cfg, prompt: 'x', scope: 'public', fetchFn: cut })).error, /cut by the token limit/);
  const down = async () => { throw new Error('ECONNREFUSED freellmapi-test'); };
  const r = await lib.chat({ config: cfg, prompt: 'x', scope: 'public', fetchFn: down });
  assert.equal(r.ok, false); assert.ok(!/freellmapi-test/.test(r.error));
});

test('findInstallDir : variable d environnement, puis dossier voisin, sinon null', () => {
  const exists = (p) => p.replace(/\\/g, '/').endsWith('/A/server/dist/index.js');
  assert.equal(lib.findInstallDir({ env: { SYMPHONEE_FREELLM_DIR: path.join('X', 'A') }, repoRoot: path.join('X', 'S'), exists }), path.join('X', 'A'));
  assert.equal(lib.findInstallDir({ env: {}, repoRoot: path.join('X', 'S'), exists: () => false }), null);
});

function fakeSpawn() {
  const handlers = {}; const proc = { exitCode: null, killed: false, on: (e, f) => { handlers[e] = f; }, kill() { this.killed = true; this.exitCode = 0; } };
  const calls = []; const fn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return proc; };
  return { fn, proc, calls };
}

test('manager : deja en marche -> aucun nouveau processus', async () => {
  const sp = fakeSpawn();
  const m = lib.createManager({ installDir: path.join('X', 'A'), fetchFn: async () => ({ status: 200 }), spawnFn: sp.fn });
  assert.deepEqual(await m.start(), { ok: true, already: true });
  assert.equal(sp.calls.length, 0);
});

test('manager : non installe -> erreur claire, aucun processus', async () => {
  const sp = fakeSpawn();
  const m = lib.createManager({ installDir: null, fetchFn: async () => { throw new Error('x'); }, spawnFn: sp.fn });
  const r = await m.start(); assert.equal(r.ok, false); assert.equal(sp.calls.length, 0);
  assert.equal((await m.status()).installed, false);
});

test('manager : demarre node dist/index.js dans le dossier server, puis detecte la reponse', async () => {
  const sp = fakeSpawn(); let up = false;
  const fetchFn = async () => { if (!up) throw new Error('down'); return { status: 401 }; };
  const m = lib.createManager({ installDir: path.join('X', 'A'), fetchFn, spawnFn: (...a) => { setTimeout(() => { up = true; }, 50); return sp.fn(...a); } });
  const r = await m.start();
  assert.equal(r.ok, true); assert.equal(r.started, true);
  assert.deepEqual(sp.calls[0].args, ['dist/index.js']); assert.equal(sp.calls[0].opts.cwd, path.join('X', 'A', 'server'));
  assert.equal((await m.status()).managed, true);
  assert.equal(m.stop().ok, true); assert.equal(sp.proc.killed, true);
});

test('nodeBinary : sous Electron on utilise node du PATH, jamais electron.exe', () => {
  assert.equal(lib.nodeBinary({ env: {}, versions: { electron: '33.0.0' }, execPath: 'C:/x/electron.exe' }), 'node');
  assert.equal(lib.nodeBinary({ env: {}, versions: {}, execPath: 'C:/x/node.exe' }), 'C:/x/node.exe');
  assert.equal(lib.nodeBinary({ env: { SYMPHONEE_NODE: 'D:/n/node.exe' }, versions: { electron: '33' }, execPath: 'e' }), 'D:/n/node.exe');
});

test('manager : le binaire lance est celui choisi (node), pas l executable courant', async () => {
  const sp = fakeSpawn(); let up = false;
  const m = lib.createManager({ installDir: path.join('X', 'A'), nodeBin: 'node', fetchFn: async () => { if (!up) throw new Error('d'); return { status: 401 }; }, spawnFn: (...a) => { setTimeout(() => { up = true; }, 30); return sp.fn(...a); } });
  await m.start();
  assert.equal(sp.calls[0].cmd, 'node');
});

test('manager : stop ne touche rien si Symphonee n a rien demarre', () => {
  const m = lib.createManager({ installDir: path.join('X', 'A'), fetchFn: async () => ({ status: 200 }), spawnFn: () => { throw new Error('ne doit pas etre appele'); } });
  assert.match(m.stop().note, /nothing started/);
});

test('status : ne renvoie jamais la cle', async () => {
  const m = lib.createManager({ installDir: 'X', fetchFn: async () => ({ status: 401 }), getConfig: () => cfg });
  const s = await m.status();
  assert.equal(s.configured, true); assert.equal(s.running, true);
  assert.ok(!JSON.stringify(s).includes('freellmapi-test'));
});
