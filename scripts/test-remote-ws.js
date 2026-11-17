#!/usr/bin/env node
'use strict';
// WebSocket (terminal) checks for phone access, against a RUNNING Symphonee.
//   node scripts/test-remote-ws.js [port] [tailnetOrigin]
// A phone may watch the terminals (term-list) but must not type: the server answers REMOTE_READ_ONLY.
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const PORT = Number(process.argv[2]) || 3800;
const ORIGIN = process.argv[3] || 'https://pc.test.ts.net';
const TAILHOST = new URL(ORIGIN).host;
const TOKEN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'runtime.json'), 'utf8')).token;
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && extra ? ' -> ' + extra : '')); if (!ok) fails++; };

function postJson(p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: p, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers) }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(s || 'null') }));
    });
    r.on('error', reject); r.write(data); r.end();
  });
}

function open(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers });
    const msgs = [];
    ws.on('message', (d) => { try { msgs.push(JSON.parse(d)); } catch (_) {} });
    ws.on('open', () => resolve({ ok: true, ws, msgs }));
    ws.on('unexpected-response', (req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const code = (await postJson('/api/remote/pairing/start', { 'x-symphonee-token': TOKEN }, {})).json().code;
  const pr = await postJson('/api/remote/pair', { Host: TAILHOST, Origin: ORIGIN }, { code });
  const cookie = 'sym_remote=' + (([].concat(pr.headers['set-cookie'] || []).join(';')).match(/sym_remote=([^;]+)/) || [])[1];

  const noCookie = await open({ Host: TAILHOST, Origin: ORIGIN });
  check('WS telephone sans session refuse', !noCookie.ok, 'connexion acceptee');

  const badOrigin = await open({ Host: TAILHOST, Origin: 'https://evil.example', Cookie: cookie });
  check('WS telephone avec Origin etranger refuse (cross-site WebSocket)', !badOrigin.ok, 'connexion acceptee');

  const phone = await open({ Host: TAILHOST, Origin: ORIGIN, Cookie: cookie });
  check('WS telephone avec session + bonne origine accepte', phone.ok, JSON.stringify(phone));
  if (phone.ok) {
    await wait(800);
    check('Telephone recoit la liste des terminaux (consultation)', phone.msgs.some(m => m.type === 'term-list'));
    phone.ws.send(JSON.stringify({ type: 'input', termId: 'main', data: 'echo SHOULD_NOT_RUN\r' }));
    await wait(1200);
    check('Telephone : saisie refusee par le serveur (REMOTE_READ_ONLY)', phone.msgs.some(m => m.type === 'error' && m.code === 'REMOTE_READ_ONLY'), JSON.stringify(phone.msgs.slice(-2)));
    check('Telephone : la saisie ne parvient pas au shell', !phone.msgs.some(m => JSON.stringify(m).includes('SHOULD_NOT_RUN')));
    phone.ws.close();
  }

  // Live view (ONLY with the 'live' argument, on a TEST server: it creates and closes its own terminal):
  // a command typed on the PC side must appear on the phone connection.
  if (process.argv[4] === 'live') {
    const marker = 'SYM_LIVE_' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const watcher = await open({ Host: TAILHOST, Origin: ORIGIN, Cookie: cookie });
    const pc = await open({ Host: '127.0.0.1:' + PORT, Origin: 'http://127.0.0.1:' + PORT });
    check('Live : telephone et PC connectes', watcher.ok && pc.ok);
    if (watcher.ok && pc.ok) {
      pc.ws.send(JSON.stringify({ type: 'create-term', termId: 'mobile-live-test', cols: 100, rows: 30, label: 'test-live' }));
      await wait(2500);
      pc.ws.send(JSON.stringify({ type: 'input', termId: 'mobile-live-test', data: 'echo ' + marker + '\r' }));
      await wait(3500);
      const seen = watcher.msgs.filter(m => m.type === 'output' && m.termId === 'mobile-live-test').map(m => m.data).join('');
      check('Live : la commande lancee sur le PC apparait sur le telephone', seen.includes(marker), seen.slice(-120));
      pc.ws.send(JSON.stringify({ type: 'kill-term', termId: 'mobile-live-test' }));
      await wait(800);
      watcher.ws.close(); pc.ws.close();
    }
  }

  const local = await open({ Host: '127.0.0.1:' + PORT, Origin: 'http://127.0.0.1:' + PORT });
  check('WS PC (local) toujours accepte', local.ok, JSON.stringify(local));
  if (local.ok) local.ws.close();

  console.log(fails ? `\nRESULTAT WS : ${fails} FAIL` : '\nRESULTAT WS : tous PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERREUR', e.message); process.exit(2); });
