#!/usr/bin/env node
'use strict';
// End-to-end test of "phone sends a command, the PC approves it, the result comes back".
// Run ONLY against a TEST server (it creates and closes its own terminal 'mobile-cmd-test'):
//   node scripts/test-remote-command.js <port> <tailnetOrigin>
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const PORT = Number(process.argv[2]);
const ORIGIN = process.argv[3] || 'https://pc.test.ts.net';
if (!PORT || PORT === 3800) { console.error('Refus : lancer ce test sur un serveur de TEST (port different de 3800).'); process.exit(2); }
const TAILHOST = new URL(ORIGIN).host;
const TOKEN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'runtime.json'), 'utf8')).token;
let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && extra ? ' -> ' + extra : '')); if (!ok) fails++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function req(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = Object.assign({}, headers);
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (res) => {
      let s = ''; res.on('data', c => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => { try { return JSON.parse(s); } catch (_) { return null; } } }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const LOCAL = { 'x-symphonee-token': TOKEN };
function open(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers }); const msgs = [];
    ws.on('message', (d) => { try { msgs.push(JSON.parse(d)); } catch (_) {} });
    ws.on('open', () => resolve({ ok: true, ws, msgs })); ws.on('error', (e) => resolve({ ok: false, error: e.message }));
    ws.on('unexpected-response', (q, r) => resolve({ ok: false, status: r.statusCode }));
  });
}
async function pendingRemote() {
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', '/api/permissions/pending', {});
    const p = (r.json() || []).find(x => x.action && x.action.type === 'remote-terminal');
    if (p) return p;
    await wait(250);
  }
  return null;
}

(async () => {
  const code = (await req('POST', '/api/remote/pairing/start', LOCAL, {})).json().code;
  const pr = await req('POST', '/api/remote/pair', { Host: TAILHOST, Origin: ORIGIN }, { code });
  const cookie = 'sym_remote=' + (([].concat(pr.headers['set-cookie'] || []).join(';')).match(/sym_remote=([^;]+)/) || [])[1];
  const PH = (extra) => Object.assign({ Host: TAILHOST, Origin: ORIGIN, Cookie: cookie }, extra);

  const phone = await open({ Host: TAILHOST, Origin: ORIGIN, Cookie: cookie });
  const pc = await open({ Host: '127.0.0.1:' + PORT, Origin: 'http://127.0.0.1:' + PORT });
  check('Telephone et PC connectes', phone.ok && pc.ok);
  pc.ws.send(JSON.stringify({ type: 'create-term', termId: 'mobile-cmd-test', cols: 100, rows: 30, label: 'test-cmd' }));
  await wait(2500);

  // 0. Default mode is auto; the approval scenarios below need 'ask'.
  const m0 = await req('GET', '/api/remote/command-mode', LOCAL);
  check('Mode par defaut : auto', (m0.json() || {}).mode === 'auto', JSON.stringify(m0.json()));
  const phoneSet = await req('POST', '/api/remote/command-mode', PH(), { mode: 'ask' });
  check('Le telephone ne peut PAS changer le mode', phoneSet.status === 403, 'status ' + phoneSet.status);
  const m1 = await req('POST', '/api/remote/command-mode', LOCAL, { mode: 'ask' });
  check('Le PC passe en mode ask', (m1.json() || {}).mode === 'ask');

  // 1. Approved command.
  const mark = 'SYMCMD_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const sent = req('POST', '/api/remote/terminal/command', PH(), { termId: 'mobile-cmd-test', text: 'echo ' + mark });
  const p1 = await pendingRemote();
  check('La demande apparait dans la file d approbation du PC', !!p1 && /echo/.test(p1.action.value) && p1.action.value.includes(mark), JSON.stringify(p1));
  check('Rien ne s est execute avant l accord (pas de sortie)', !phone.msgs.some(m => m.type === 'output' && JSON.stringify(m).includes(mark)));
  // The phone must NOT be able to approve itself.
  const self = await req('POST', '/api/permissions/resolve', PH(), { id: p1 && p1.id, decision: 'allow', promote: true });
  check('Le telephone ne peut PAS approuver sa propre commande', self.status === 403 && (self.json() || {}).code === 'REMOTE_NOT_ALLOWED', 'status ' + self.status);
  await wait(1500);
  check('Toujours aucune execution apres la tentative d auto-approbation', !phone.msgs.some(m => m.type === 'output' && JSON.stringify(m).includes(mark)));
  const ok = await req('POST', '/api/permissions/resolve', LOCAL, { id: p1.id, decision: 'allow', promote: true });
  check('Le PC approuve', ok.status === 200);
  const r1 = await sent;
  check('Reponse au telephone : sent', r1.status === 200 && (r1.json() || {}).status === 'sent', JSON.stringify(r1.json()));
  await wait(3000);
  const out = phone.msgs.filter(m => m.type === 'output' && m.termId === 'mobile-cmd-test').map(m => m.data).join('');
  check('La commande s est executee sur le PC et la reponse arrive sur le telephone', out.includes(mark), out.slice(-120));

  // 2. Same command again: must ask again ("always allow" is ignored).
  const again = req('POST', '/api/remote/terminal/command', PH(), { termId: 'mobile-cmd-test', text: 'echo ' + mark });
  const p2 = await pendingRemote();
  check('"Toujours autoriser" ignore : nouvelle demande pour la meme commande', !!p2);
  // 3. Denied.
  if (p2) await req('POST', '/api/permissions/resolve', LOCAL, { id: p2.id, decision: 'deny' });
  const r2 = await again;
  check('Refus sur le PC : status denied et rien execute', r2.status === 403 && (r2.json() || {}).status === 'denied', JSON.stringify(r2.json()));

  // 4. Invalid input never reaches the approval queue.
  const bad = await req('POST', '/api/remote/terminal/command', PH(), { termId: 'mobile-cmd-test', text: 'echo a\nrm -rf x' });
  check('Deux lignes / caracteres speciaux refuses', bad.status === 400 && (bad.json() || {}).code === 'CONTROL_CHARS', JSON.stringify(bad.json()));
  const unk = await req('POST', '/api/remote/terminal/command', PH(), { termId: 'nexiste-pas', text: 'ls' });
  check('Terminal inconnu refuse', unk.status === 400 && (unk.json() || {}).code === 'UNKNOWN_TERMINAL', JSON.stringify(unk.json()));
  // 5. Without a session nothing works.
  const anon = await req('POST', '/api/remote/terminal/command', { Host: TAILHOST, Origin: ORIGIN }, { termId: 'mobile-cmd-test', text: 'ls' });
  check('Sans session : refuse (401)', anon.status === 401, 'status ' + anon.status);

  // 6. Auto mode: straight through, destructive still asks, everything is logged.
  await req('POST', '/api/remote/command-mode', LOCAL, { mode: 'auto' });
  const mk = 'SYMAUTO_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const a1 = await req('POST', '/api/remote/terminal/command', PH(), { termId: 'mobile-cmd-test', text: 'echo ' + mk });
  check('Auto : envoi direct sans approbation (sent / auto)', a1.status === 200 && (a1.json() || {}).status === 'sent' && (a1.json() || {}).mode === 'auto', JSON.stringify(a1.json()));
  const pend = await req('GET', '/api/permissions/pending', {});
  check('Auto : aucune demande dans la file du PC', !(pend.json() || []).some(x => x.action && x.action.type === 'remote-terminal'));
  await wait(3000);
  const out2 = phone.msgs.filter(m => m.type === 'output' && m.termId === 'mobile-cmd-test').map(m => m.data).join('');
  check('Auto : la commande s est executee et la reponse arrive sur le telephone', out2.includes(mk), out2.slice(-120));
  const danger = req('POST', '/api/remote/terminal/command', PH(), { termId: 'mobile-cmd-test', text: 'echo ' + mk + ' ; Remove-Item C:\ne-pas-executer -Recurse' });
  const pd = await pendingRemote();
  check('Auto : une commande destructrice demande quand meme l accord du PC', !!pd);
  if (pd) await req('POST', '/api/permissions/resolve', LOCAL, { id: pd.id, decision: 'deny' });
  const rd = await danger;
  check('Auto : destructrice refusee sur le PC = non executee', rd.status === 403 && (rd.json() || {}).status === 'denied', JSON.stringify(rd.json()));
  const logf = path.join(__dirname, '..', '.symphonee', 'remote-commands.log');
  const lg = fs.existsSync(logf) ? fs.readFileSync(logf, 'utf8') : '';
  check('Journal : la commande auto y est inscrite', lg.includes(mk) && /"outcome":"auto"/.test(lg), lg.slice(-200));

  pc.ws.send(JSON.stringify({ type: 'kill-term', termId: 'mobile-cmd-test' }));
  await wait(800);
  phone.ws.close(); pc.ws.close();
  console.log(fails ? `\nRESULTAT COMMANDE : ${fails} FAIL` : '\nRESULTAT COMMANDE : tous PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERREUR', e.message); process.exit(2); });
