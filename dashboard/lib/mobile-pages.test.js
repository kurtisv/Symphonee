'use strict';
// Runs the phone page modules (settings, files) against a minimal fake DOM, to catch runtime errors
// (wrong variable names, missing calls, nodes concatenated as text) without a real browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this._text = ''; this.handlers = {}; this.disabled = false; }
  get textContent() { return this._text + this.children.map(c => (c instanceof El ? c.textContent : String(c))).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  addEventListener(ev, fn) { this.handlers[ev] = fn; }
  click() { return this.handlers.click && this.handlers.click(); }
  all(tag) { const out = []; (function walk(n) { n.children.forEach(c => { if (c instanceof El) { if (!tag || c.tag === tag) out.push(c); walk(c); } }); })(this); return out; }
}

function makeM(responses, calls) {
  const h = (tag, cls, text) => { const e = new El(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const card = (title, body) => { const c = h('section', 'card'); c.appendChild(h('h2', null, title)); if (body) c.appendChild(body); return c; };
  const row = (l, r) => { const d = h('div', 'row'); d.appendChild(h('span', 'l', l)); if (r != null) d.appendChild(h('span', 'r', r)); return d; };
  const getJson = (url) => { calls.push(['GET', url]); return Promise.resolve(responses(url)); };
  return {
    h, card, row, muted: (t) => h('p', 'muted', t), pre: (t) => h('pre', null, t), list: (a) => { const d = h('div'); a.forEach(x => d.appendChild(x)); return d; },
    clip: (s, n) => String(s).slice(0, n), hhmm: () => '', arr: (x) => (Array.isArray(x) ? x : []),
    api: (m, u, b) => { calls.push([m, u, b]); return Promise.resolve({ status: 200, json: { ok: true } }); },
    getJson, quiet: (p) => p.catch(() => null), content: h('main'), status: h('span'),
  };
}

function load(file) {
  const win = { SymMobilePages: {}, location: { replaced: null, replace(u) { this.replaced = u; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), { window: win });
  return win;
}
const tick = () => new Promise(r => setImmediate(r));

test('Reglages : construit trois cartes, le bouton existe et deconnecte vers /remote', async () => {
  const win = load('mobile-settings.js');
  const calls = [];
  const M = makeM(() => ({ authenticated: true }), calls);
  win.SymMobilePages.settings(M);
  await tick();
  const titles = M.content.all('h2').map(e => e.textContent);
  assert.deepEqual(titles, ['Session', 'Application', 'Securite']);
  const btn = M.content.all('button').find(b => b.textContent === 'Se deconnecter');
  assert.ok(btn, 'bouton de deconnexion present');
  assert.ok(!/\[object/.test(M.content.textContent), 'aucun noeud concatene en texte');
  assert.match(M.content.textContent, /active/, 'etat de session affiche');
  btn.click(); await tick(); await tick();
  assert.deepEqual(calls.find(c => c[0] === 'POST').slice(0, 2), ['POST', '/api/remote/logout']);
  assert.equal(win.location.replaced, '/remote');
});

test('Fichiers : liste la racine, ouvre un dossier, lit un fichier, revient en arriere', async () => {
  const win = load('mobile-files.js');
  const calls = [];
  const tree = {
    '': { ok: true, path: '', entries: [{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file' }] },
    'src': { ok: true, path: 'src', entries: [{ name: 'app.js', type: 'file' }] },
  };
  const M = makeM((url) => {
    const q = new URL('http://x' + url);
    const p = q.searchParams.get('path');
    if (url.startsWith('/api/remote/files')) return tree[p] || { ok: false, code: 'NOT_FOUND' };
    return { ok: true, text: 'contenu de ' + p };
  }, calls);
  const box = M.h('div');
  win.SymMobilePages.files(M, 'Mon Projet', box);
  await tick();
  assert.match(calls[0][1], /^\/api\/remote\/files\?repo=Mon%20Projet&path=$/, 'le nom du projet est encode');
  let btns = box.all('button').map(b => b.textContent);
  assert.deepEqual(btns, ['[dossier] src', 'README.md']);
  box.all('button')[0].click(); await tick();
  assert.equal(calls[1][1].includes('path=src'), true);
  btns = box.all('button').map(b => b.textContent);
  assert.deepEqual(btns, ['Dossier parent', 'app.js']);
  box.all('button')[1].click(); await tick();
  assert.ok(calls[2][1].startsWith('/api/remote/file?') && calls[2][1].includes('path=src%2Fapp.js'));
  assert.match(box.textContent, /contenu de src\/app\.js/);
  const back = box.all('button').find(b => b.textContent === 'Retour');
  back.click(); await tick();
  assert.equal(box.all('button')[0].textContent, 'Dossier parent', 'retour dans le dossier du fichier');
  box.all('button')[0].click(); await tick();
  assert.equal(box.all('button')[0].textContent, '[dossier] src', 'retour a la racine');
});

test('Fichiers : acces refuse par le serveur -> message, jamais de contenu', async () => {
  const win = load('mobile-files.js');
  const M = makeM(() => ({ ok: false, code: 'FORBIDDEN' }), []);
  const box = M.h('div');
  win.SymMobilePages.files(M, 'p', box);
  await tick();
  assert.match(box.textContent, /Acces refuse ou introuvable \(FORBIDDEN\)/);
  assert.equal(box.all('pre').length, 0);
});

test('Fichiers : reponse invalide ou reseau en erreur -> pas de plantage', async () => {
  const win = load('mobile-files.js');
  const M = makeM(() => null, []);
  const box = M.h('div');
  win.SymMobilePages.files(M, 'p', box);
  await tick();
  assert.match(box.textContent, /Acces refuse ou introuvable \(erreur\)/);
});

test('Fichiers : un contenu HTML dangereux est affiche comme texte (jamais interprete)', async () => {
  const win = load('mobile-files.js');
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const M = makeM((url) => (url.startsWith('/api/remote/files') ? { ok: true, entries: [{ name: 'a.html', type: 'file' }] } : { ok: true, text: evil }), []);
  const box = M.h('div');
  win.SymMobilePages.files(M, 'p', box);
  await tick();
  box.all('button')[0].click(); await tick();
  const p = box.all('pre')[0];
  assert.equal(p.textContent, evil);
  assert.equal(p.children.length, 0, 'aucun element enfant : seulement du texte');
});
