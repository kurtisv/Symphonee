#!/usr/bin/env node
'use strict';
// Integration test of the phone access against a RUNNING Symphonee (default 127.0.0.1:3800).
// It simulates the phone by sending requests with a non-loopback Host header, exactly what
// Tailscale Serve forwards, and simulates Serve by adding forwarding headers to loopback calls.
// Needs the per-boot token from config/runtime.json only for the local PC-side steps.
//   node scripts/test-remote-access.js [port] [tailnetOrigin]
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 3800;
const ORIGIN = process.argv[3] || 'https://pc.test.ts.net';
const TAILHOST = new URL(ORIGIN).host;
const root = path.resolve(__dirname, '..');
const TOKEN = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime.json'), 'utf8')).token;

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra && !cond ? '  -> ' + extra : '')); };

function req({ method = 'GET', path: p, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({}, headers);
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h, timeout: 15000 }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: s, json() { try { return JSON.parse(s); } catch (_) { return null; } } }));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const phone = (extra = {}, cookie) => Object.assign({ Host: TAILHOST, ...(cookie ? { Cookie: cookie } : {}) }, extra);
const LOCAL_TOKEN = { 'x-symphonee-token': TOKEN };

(async () => {
  // 1. Local PC behaviour is unchanged.
  let r = await req({ path: '/api/busy' });
  check('PC: GET /api/busy sans jeton -> 200', r.status === 200, 'status ' + r.status);
  r = await req({ method: 'POST', path: '/api/remote/pairing/start', body: {} });
  check('PC: POST sans jeton -> 403 TOKEN_REQUIRED (inchange)', r.status === 403 && r.json().code === 'TOKEN_REQUIRED', r.text.slice(0, 120));

  // 2. The phone without session.
  r = await req({ path: '/api/busy', headers: phone() });
  check('Telephone sans session : /api/busy -> 401', r.status === 401 && r.json().code === 'REMOTE_LOGIN_REQUIRED', 'status ' + r.status);
  r = await req({ path: '/', headers: phone() });
  check('Telephone sans session : / -> redirection /remote', r.status === 302 && r.headers.location === '/remote', 'status ' + r.status + ' loc ' + r.headers.location);
  r = await req({ path: '/remote', headers: phone() });
  check('Telephone : page de connexion servie', r.status === 200 && /Connexion a Symphonee/.test(r.text));
  check('Page de connexion : aucun jeton injecte', !/x-symphonee-token|__SYMPHONEE_TOKEN__/.test(r.text) && !r.text.includes(TOKEN));
  // Serve simulation: loopback Host + forwarding header, no session.
  r = await req({ path: '/api/busy', headers: { Host: '127.0.0.1:' + PORT, 'X-Forwarded-For': '100.64.0.5' } });
  check('Relais Serve sans session (127.0.0.1 + X-Forwarded-For) -> 401', r.status === 401, 'status ' + r.status);

  // 3. Pairing from the PC, then from the phone.
  r = await req({ method: 'POST', path: '/api/remote/pairing/start', headers: LOCAL_TOKEN, body: {} });
  const code = r.json() && r.json().code;
  check('PC : code d appairage cree', /^\d{6}$/.test(code || ''), r.text.slice(0, 80));
  const wrong = code === '000000' ? '111111' : '000000';
  r = await req({ method: 'POST', path: '/api/remote/pair', headers: phone(), body: { code: wrong } });
  check('Telephone : mauvais code -> 403 bad_code', r.status === 403 && r.json().reason === 'bad_code', r.text.slice(0, 120));
  r = await req({ method: 'POST', path: '/api/remote/pair', headers: phone({ Origin: ORIGIN }), body: { code } });
  const setCookie = [].concat(r.headers['set-cookie'] || []).join(';');
  check('Telephone : bon code -> 200 et cookie de session', r.status === 200 && /sym_remote=/.test(setCookie), r.status + ' ' + setCookie.slice(0, 80));
  check('Cookie : HttpOnly; Secure; SameSite=Strict', /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Strict/.test(setCookie));
  const cookie = (setCookie.match(/sym_remote=([^;]+)/) || [])[1];
  const C = 'sym_remote=' + cookie;

  // 4. Authenticated phone.
  r = await req({ path: '/api/remote/session', headers: phone({}, C) });
  check('Telephone avec session : /api/remote/session authentifie', r.status === 200 && r.json().authenticated === true);
  r = await req({ path: '/api/busy', headers: phone({}, C) });
  check('Telephone avec session : /api/busy -> 200', r.status === 200, 'status ' + r.status);
  r = await req({ path: '/', headers: phone({}, C) });
  check('Telephone avec session : / servi SANS jeton interne', r.status === 200 && !r.text.includes(TOKEN) && !/__SYMPHONEE_TOKEN__/.test(r.text));
  r = await req({ path: '/api/remote/sessions', headers: phone({}, C) });
  check('Telephone : liste des sessions reservee au PC -> 403 LOCAL_ONLY', r.status === 403 && r.json().code === 'LOCAL_ONLY', 'status ' + r.status);
  r = await req({ method: 'POST', path: '/api/remote/pairing/start', headers: phone({}, C), body: {} });
  check('Telephone : demarrer un appairage -> 403 LOCAL_ONLY', r.status === 403 && r.json().code === 'LOCAL_ONLY', 'status ' + r.status);
  r = await req({ method: 'POST', path: '/api/remote/logout', headers: phone({ Origin: 'https://evil.example' }, C), body: {} });
  check('CSRF : ecriture avec Origin etranger -> 403 ORIGIN_NOT_ALLOWED', r.status === 403 && r.json().code === 'ORIGIN_NOT_ALLOWED', 'status ' + r.status);
  r = await req({ method: 'POST', path: '/api/remote/logout', headers: phone({ Origin: ORIGIN }, C), body: {} });
  check('Deconnexion telephone -> 200', r.status === 200);
  r = await req({ path: '/api/busy', headers: phone({}, C) });
  check('Ancienne session revoquee -> 401', r.status === 401, 'status ' + r.status);

  // 5. Session persists after a fresh pairing, cookie checked by the PC side list.
  r = await req({ method: 'POST', path: '/api/remote/pairing/start', headers: LOCAL_TOKEN, body: {} });
  const code2 = r.json().code;
  r = await req({ method: 'POST', path: '/api/remote/pair', headers: phone({ Origin: ORIGIN }), body: { code: code2 } });
  const c2 = (([].concat(r.headers['set-cookie'] || []).join(';')).match(/sym_remote=([^;]+)/) || [])[1];
  r = await req({ path: '/api/remote/sessions', headers: LOCAL_TOKEN });
  check('PC : session visible sans secret dans la liste', r.status === 200 && r.json().length >= 1 && r.json().every(x => !('hash' in x) && !('value' in x)), r.text.slice(0, 120));
  r = await req({ path: '/api/busy', headers: phone({}, 'sym_remote=' + c2) });
  check('Nouvelle session valide apres appairage', r.status === 200);

  // 6. Symphonee Mobile pages: session required, no token injected for a phone, PC unchanged.
  r = await req({ path: '/mobile', headers: phone() });
  check('Mobile sans session -> refuse (401 ou redirection)', r.status === 401 || r.status === 302, 'status ' + r.status);
  r = await req({ path: '/mobile', headers: phone({}, 'sym_remote=' + c2) });
  check('Mobile avec session -> page servie sans jeton', r.status === 200 && /mobile\.js/.test(r.text) && !r.text.includes(TOKEN) && !/__SYMPHONEE_TOKEN__/.test(r.text), 'status ' + r.status);
  r = await req({ path: '/mobile.webmanifest', headers: phone({}, 'sym_remote=' + c2) });
  check('Manifeste PWA servi au telephone', r.status === 200 && r.json() && r.json().display === 'standalone', 'status ' + r.status);
  r = await req({ path: '/mobile', headers: { Host: '127.0.0.1:' + PORT } });
  check('PC : /mobile servi (interface PC inchangee)', r.status === 200, 'status ' + r.status);
  r = await req({ path: '/', headers: { Host: '127.0.0.1:' + PORT } });
  check('PC : interface principale / toujours servie', r.status === 200 && /x-symphonee-token|__SYMPHONEE_TOKEN__|<html/i.test(r.text));

  const pass = results.filter(x => x.ok).length, fail = results.length - pass;
  console.log(`\nRESULTAT HTTP : ${pass}/${results.length} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERREUR', e.message); process.exit(2); });
