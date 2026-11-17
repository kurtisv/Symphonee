'use strict';
// Runs dashboard/public/mobile.js (home, terminal, Mind, autopilots, projects) against a fake DOM, fake fetch and fake WebSocket.
// Responses use the shapes the real server returns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this._text = ''; this.handlers = {}; this.attrs = {}; this.style = {}; this.value = ''; this.disabled = false; this.parentNode = null; this.scrollTop = 0; this.scrollHeight = 0; }
  get textContent() { return this._text + this.children.map(c => (c instanceof El ? c.textContent : String(c))).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { if (c instanceof El) c.parentNode = this; this.children.push(c); return c; }
  replaceChildren(...n) { this.children = n; n.forEach(c => { if (c instanceof El) c.parentNode = this; }); this._text = ''; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  fire(ev, arg) { (this.handlers[ev] || []).forEach(fn => fn(arg || { preventDefault() {} })); }
  all(tag) { const out = []; (function walk(n) { n.children.forEach(c => { if (c instanceof El) { if (!tag || c.tag === tag) out.push(c); walk(c); } }); })(this); return out; }
  get type() { return this.attrs.type; } set type(v) { this.attrs.type = v; }
}

const REAL = {
  '/api/orchestrator/agents': [{ termId: 'term-4', cols: 120, rows: 30, alive: true }, { termId: 'main', cols: 145, rows: 37, alive: true }],
  '/api/orchestrator/tasks': [{ id: 't1', cli: 'qwen', state: 'running' }],
  '/api/mind/autopilots': { pilots: [{ pilot: 'default', label: 'Principale', profileLabel: 'Standard', status: 'waiting', repoName: 'Symphonee', today: { completed: 1, discoveries: 2 }, limits: { dailyCompletions: 2, dailyDiscoveries: 8 } }] },
  '/api/jobs': [{ id: 'j1', name: 'Porte de fusion', schedule: 'every 30m', enabled: true, lastRun: { status: 'ok' } }],
  '/api/ledger?limit=40': { entries: [{ ts: '2026-11-17T16:19:25Z', action: 'codex:spawn', outcome: 'ok' }, { ts: '2026-11-17T16:20:00Z', action: 'git:push', outcome: 'blocked' }] },
  '/api/permissions/pending': [{ id: 'ap1', action: { type: 'remote-terminal', value: '[main] ls' } }],
  '/api/mind/stats': { stats: { nodes: 95368, edges: 756640, communities: 2136, lastBuildAt: '2026-11-17T18:01:29Z' } },
  '/api/learnings': [{ id: 'a', category: 'gotcha', summary: 'Android gele Chrome en arriere-plan' }],
  '/api/mind/wakeup': { text: '## L0 - IDENTITY\nintent: test' },
  '/api/repos': { 'Gas Saver': 'C:/x', Symphonee: 'C:/y' },
};

function build() {
  const content = new El('main'), status = new El('span'), gear = new El('button');
  const navs = ['home', 'terminal', 'mind', 'autopilotes', 'projets'].map(p => { const b = new El('button'); b.setAttribute('data-page', p); return b; });
  const calls = []; const sockets = []; const timers = [];
  class WS { constructor(u) { this.url = u; this.sent = []; sockets.push(this); } close() { this.closed = true; } send(d) { this.sent.push(d); } }
  const ctx = {
    document: { getElementById: (id) => ({ content, status, gear }[id] || null), querySelectorAll: () => navs, createElement: (t) => new El(t) },
    window: { location: { replaced: null, replace(u) { this.replaced = u; }, protocol: 'https:', host: 'pc.test' }, SymMobilePages: {}, Terminal: undefined },
    location: { protocol: 'https:', host: 'pc.test' },
    fetch: (url, opt) => {
      calls.push([(opt && opt.method) || 'GET', url, opt && opt.body]);
      const u = String(url);
      let body = REAL[u];
      if (u.startsWith('/api/git/status')) body = { branch: 'main', files: [{ path: 'a.js', status: 'M' }], clean: false };
      else if (u.startsWith('/api/git/branches')) body = { branches: [{ name: 'main', current: true }, { name: 'dev' }] };
      else if (u.startsWith('/api/git/log')) body = { commits: [{ message: 'Premier commit', hash: 'abcdef123456' }] };
      else if (u.startsWith('/api/github/pulls')) body = { pulls: [{ number: 7, title: 'Ajoute le mobile', author: 'kurtis' }] };
      else if (u === '/api/mind/recall') body = { hits: [{ id: 'm1', label: 'Qwen utilise le 4B', kindOfMemory: 'decision', snippet: 'Qwen utilise le 4B pour le local' }] };
      else if (u === '/api/remote/terminal/command') body = ctx.__cmdResponse || { status: 'sent' };
      return Promise.resolve({ status: ctx.__status || 200, json: () => Promise.resolve(body === undefined ? null : body) });
    },
    WebSocket: WS, setInterval: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, console, Promise, JSON, Math, Object, Array, String, Date, Error,
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  return { ctx, content, status, navs, gear, calls, sockets, timers, run() { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile.js'), 'utf8'), ctx); } };
}
const tick = (n = 6) => new Promise(r => { let i = 0; (function f() { i++; setImmediate(i >= n ? r : f); })(); });

test('Accueil : toutes les cartes avec les vraies formes, avec validation en attente et erreur', async () => {
  const t = build(); t.run(); await tick();
  const txt = t.content.textContent;
  for (const s of ['A valider sur le PC', '[main] ls', 'Le PC', '95368 noeuds', 'Terminaux et agents (2)', 'term-4', 'Taches (1)', 'qwen', 'Autopilotes', 'Principale', 'Boucles planifiees', 'Porte de fusion', 'Erreurs recentes', 'git:push']) assert.ok(txt.includes(s), 'manque : ' + s);
  assert.match(t.status.textContent, /en ligne - 1 a valider sur le PC/);
  assert.ok(!txt.includes('[object'), 'pas de noeud concatene en texte');
});

test('Accueil : une session expiree (401) renvoie vers /remote', async () => {
  const t = build(); t.ctx.__status = 401; t.run(); await tick();
  assert.equal(t.ctx.window.location.replaced, '/remote');
});

test('Terminal : liste les terminaux, affiche la sortie en direct, ouvre un WebSocket securise', async () => {
  const t = build(); t.run(); await tick();
  t.navs[1].fire('click'); await tick();
  assert.equal(t.sockets.length, 1);
  assert.equal(t.sockets[0].url, 'wss://pc.test/', 'wss en https, jamais ws');
  t.sockets[0].onopen();
  t.sockets[0].onmessage({ data: JSON.stringify({ type: 'term-list', terminals: [{ id: 'main' }, { id: 'term-4' }] }) });
  t.sockets[0].onmessage({ data: JSON.stringify({ type: 'output', termId: 'main', data: 'bonjour du PC\r\n' }) });
  await tick();
  const chips = t.content.all('button').map(b => b.textContent);
  assert.ok(chips.includes('main') && chips.includes('term-4'), chips.join());
  assert.ok(t.content.textContent.includes('bonjour du PC'), 'sortie du terminal affichee');
  t.navs[0].fire('click'); await tick();
  assert.equal(t.sockets[0].closed, true, 'WebSocket ferme en quittant l onglet');
});

test('Terminal : envoi de commande -> demande, attente de l accord PC, resultat affiche', async () => {
  const cases = [['sent', 'Envoye au terminal.'], ['denied', 'Refuse sur le PC.'], ['timeout', 'Delai de 90 s']];
  for (const [status, msg] of cases) {
    const t = build(); t.ctx.__cmdResponse = { status }; t.run(); await tick();
    t.navs[1].fire('click'); await tick();
    t.sockets[0].onmessage({ data: JSON.stringify({ type: 'term-list', terminals: [{ id: 'main' }] }) });
    await tick();
    const form = t.content.all('form')[0]; const input = form.all('input')[0];
    input.value = 'echo bonjour';
    form.fire('submit');
    assert.match(form.textContent, /En attente de votre accord sur le PC/);
    await tick(10);
    const post = t.calls.find(c => c[0] === 'POST' && c[1] === '/api/remote/terminal/command');
    assert.deepEqual(JSON.parse(post[2]), { termId: 'main', text: 'echo bonjour' });
    assert.ok(form.textContent.includes(msg), status + ' -> ' + form.textContent);
    if (status === 'sent') assert.equal(input.value, '', 'champ vide apres envoi');
  }
});

test('Terminal : refus du serveur (caractere special) traduit en message clair', async () => {
  const t = build(); t.ctx.__cmdResponse = { status: 'refused', code: 'CONTROL_CHARS' }; t.run(); await tick();
  t.navs[1].fire('click'); await tick();
  t.sockets[0].onmessage({ data: JSON.stringify({ type: 'term-list', terminals: [{ id: 'main' }] }) }); await tick();
  const form = t.content.all('form')[0]; form.all('input')[0].value = 'a'; form.fire('submit'); await tick(10);
  assert.match(form.textContent, /Une seule ligne de texte/);
});

test('Mind : stats, apprentissages, souvenirs, et recherche (POST /api/mind/recall)', async () => {
  const t = build(); t.run(); await tick();
  t.navs[2].fire('click'); await tick(10);
  let txt = t.content.textContent;
  for (const s of ['Rechercher dans Mind', '95368', 'gotcha', 'Android gele Chrome', 'L0 - IDENTITY']) assert.ok(txt.includes(s), 'manque : ' + s);
  const form = t.content.all('form')[0]; form.all('input')[0].value = 'qwen'; form.fire('submit'); await tick(10);
  assert.ok(t.content.textContent.includes('[decision] Qwen utilise le 4B'));
  const post = t.calls.find(c => c[1] === '/api/mind/recall');
  assert.deepEqual(JSON.parse(post[2]), { question: 'qwen', limit: 8 });
});

test('Autopilotes : etat, limites du jour, boucles ; controles renvoyes au PC', async () => {
  const t = build(); t.run(); await tick();
  t.navs[3].fire('click'); await tick(10);
  const txt = t.content.textContent;
  for (const s of ['Principale - waiting', 'Aujourd hui : 1/2 fait(s), 2/8 decouverte(s)', 'Porte de fusion', 'every 30m', 'depuis le PC']) assert.ok(txt.includes(s), 'manque : ' + s);
});

test('Projets : depots, branche, modifications, branches, commits, pull requests, bouton fichiers', async () => {
  const t = build(); t.run(); await tick();
  t.navs[4].fire('click'); await tick(12);
  const txt = t.content.textContent;
  for (const s of ['Gas Saver', 'Symphonee', 'main', '1 fichier(s)', 'a.js', 'Branches (2)', 'actuelle', 'Premier commit', 'abcdef1', 'Pull requests ouvertes (1)', '#7 Ajoute le mobile', 'Parcourir les fichiers (lecture seule)']) assert.ok(txt.includes(s), 'manque : ' + s);
  assert.ok(t.calls.some(c => c[1].startsWith('/api/git/status?repo=Gas%20Saver')), 'le premier projet est ouvert, nom encode');
});

test('Reglages : bouton en-tete -> page chargee depuis le module', async () => {
  const t = build();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile-settings.js'), 'utf8'), t.ctx);
  t.run(); await tick();
  t.gear.fire('click'); await tick();
  assert.ok(t.content.textContent.includes('Se deconnecter'));
});

test('Module absent ou en erreur : repli propre, jamais de page blanche', async () => {
  const t = build(); t.run(); await tick();
  t.gear.fire('click'); await tick();
  assert.ok(t.content.textContent.includes('Indisponible'));
  t.ctx.window.SymMobilePages.settings = () => { throw new Error('boum'); };
  t.gear.fire('click'); await tick();
  assert.ok(t.content.textContent.includes('rencontre une erreur'));
});

test('Aucune donnee du serveur n est injectee comme HTML (pas de innerHTML dans le code)', () => {
  for (const f of ['mobile.js', 'mobile-settings.js', 'mobile-files.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), f);
    assert.ok(!/x-symphonee-token|__SYMPHONEE_TOKEN__|localStorage|sessionStorage/.test(src), f + ' : jeton ou stockage');
  }
});

test('Accueil : actualisation automatique toutes les 10 s, arretee en quittant l accueil', async () => {
  const t = build(); t.run(); await tick();
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0][1], 10000);
});
