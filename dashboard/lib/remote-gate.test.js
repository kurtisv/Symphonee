'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('./remote-gate');

const check = (c) => (c === 'valid.session' ? { id: 'valid' } : null);
const req = (host, extra = {}) => ({ headers: Object.assign({ host }, extra) });
const ORIGIN = 'https://pc.tail1234.ts.net';

test('classement : loopback sans en-tete de relais = local', () => {
  assert.equal(g.classify(req('127.0.0.1:3800')), 'local');
  assert.equal(g.classify(req('localhost:3800')), 'local');
  assert.equal(g.classify(req('[::1]:3800')), 'local');
});

test('classement : nom tailnet = distant', () => {
  assert.equal(g.classify(req('pc.tail1234.ts.net')), 'remote');
  assert.equal(g.classify(req('attacker.example')), 'remote');
});

test('classement : Serve se connecte depuis 127.0.0.1 mais ajoute un en-tete de relais = distant', () => {
  assert.equal(g.classify(req('127.0.0.1:3800', { 'x-forwarded-for': '100.64.0.5' })), 'remote');
  assert.equal(g.classify(req('127.0.0.1:3800', { 'tailscale-user-login': 'x@y' })), 'remote');
  assert.equal(g.classify(req('localhost:3800', { forwarded: 'for=100.64.0.5' })), 'remote');
});

test('classement : pas d en-tete Host = local (le pare-feu local le rejette, comportement inchange)', () => {
  assert.equal(g.classify({ headers: {} }), 'local');
});

test('distant sans session : refuse 401, sauf page et appairage', () => {
  const a = g.decide(req('pc.tail1234.ts.net'), { method: 'GET', pathname: '/api/busy', cookieValue: null, check, allowedOrigin: ORIGIN });
  assert.equal(a.allow, false);
  assert.equal(a.status, 401);
  assert.equal(a.code, 'REMOTE_LOGIN_REQUIRED');
  assert.equal(g.decide(req('pc.tail1234.ts.net'), { method: 'GET', pathname: '/', cookieValue: null, check, allowedOrigin: ORIGIN }).redirect, '/remote', 'page racine -> login');
  for (const p of ['/remote', '/api/remote/pair', '/api/remote/session']) {
    assert.equal(g.decide(req('pc.tail1234.ts.net'), { method: 'POST', pathname: p, cookieValue: null, check, allowedOrigin: ORIGIN }).allow, true, p);
  }
});

test('distant avec session valide : acces, sans token interne', () => {
  const d = g.decide(req('pc.tail1234.ts.net'), { method: 'GET', pathname: '/api/busy', cookieValue: 'valid.session', check, allowedOrigin: ORIGIN });
  assert.equal(d.allow, true);
  assert.equal(d.authed, true);
  assert.equal(d.sessionId, 'valid');
});

test('cookie invalide ou falsifie = aucune session', () => {
  for (const c of ['invalid.session', 'valid', '', null]) {
    assert.equal(g.decide(req('pc.tail1234.ts.net'), { method: 'GET', pathname: '/api/busy', cookieValue: c, check, allowedOrigin: ORIGIN }).allow, false, String(c));
  }
});

test('distant : demarrage d appairage et liste des sessions interdits meme avec session', () => {
  for (const p of ['/api/remote/pairing/start', '/api/remote/sessions']) {
    const d = g.decide(req('pc.tail1234.ts.net'), { method: 'POST', pathname: p, cookieValue: 'valid.session', check, allowedOrigin: ORIGIN });
    assert.equal(d.allow, false, p);
    assert.equal(d.code, 'LOCAL_ONLY');
  }
});

test('distant : ecriture avec Origin etranger refusee (CSRF)', () => {
  const d = g.decide(req('pc.tail1234.ts.net', { origin: 'https://evil.example' }), { method: 'POST', pathname: '/api/x', cookieValue: 'valid.session', check, allowedOrigin: ORIGIN });
  assert.equal(d.allow, false);
  assert.equal(d.code, 'ORIGIN_NOT_ALLOWED');
});

test('distant : ecriture avec notre propre Origin acceptee ; sans Origin aussi (cookie SameSite=Strict protege)', () => {
  assert.equal(g.decide(req('pc.tail1234.ts.net', { origin: ORIGIN }), { method: 'POST', pathname: '/api/x', cookieValue: 'valid.session', check, allowedOrigin: ORIGIN }).allow, true);
  assert.equal(g.decide(req('pc.tail1234.ts.net'), { method: 'POST', pathname: '/api/x', cookieValue: 'valid.session', check, allowedOrigin: ORIGIN }).allow, true);
});

test('distant : Origin present mais aucune origine configuree = refuse', () => {
  const d = g.decide(req('pc.tail1234.ts.net', { origin: ORIGIN }), { method: 'POST', pathname: '/api/x', cookieValue: 'valid.session', check, allowedOrigin: null });
  assert.equal(d.allow, false);
});

test('local : aucune restriction ajoutee (le chemin local reste celui d avant)', () => {
  const d = g.decide(req('127.0.0.1:3800'), { method: 'POST', pathname: '/api/remote/sessions', cookieValue: null, check, allowedOrigin: ORIGIN });
  assert.deepEqual(d, { mode: 'local', allow: true });
});

test('une requete proxifiee sans session ne passe jamais pour locale', () => {
  const d = g.decide(req('127.0.0.1:3800', { 'x-forwarded-for': '1.2.3.4' }), { method: 'GET', pathname: '/api/busy', cookieValue: null, check, allowedOrigin: ORIGIN });
  assert.equal(d.mode, 'remote');
  assert.equal(d.allow, false);
});
