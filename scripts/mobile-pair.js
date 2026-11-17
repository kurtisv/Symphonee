#!/usr/bin/env node
'use strict';
// PC-side control of phone access (Symphonee Mobile). Talks to the local server with the per-boot token.
//   node scripts/mobile-pair.js            -> shows a 6-digit pairing code (valid 5 minutes)
//   node scripts/mobile-pair.js list       -> lists paired phones (id, created, expires)
//   node scripts/mobile-pair.js revoke <id>|all
const http = require('http');
const fs = require('fs');
const path = require('path');
const rt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'runtime.json'), 'utf8'));
function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: rt.port || 3800, method, path: p, headers: Object.assign({ 'x-symphonee-token': rt.token }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let s = ''; res.on('data', c => { s += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, json: null }); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd) {
    const r = await call('POST', '/api/remote/pairing/start', {});
    if (!r.json || !r.json.code) { console.error('Echec : ' + JSON.stringify(r)); process.exit(1); }
    console.log('Code d appairage : ' + r.json.code + '  (valable jusqu a ' + new Date(r.json.expiresAt).toLocaleTimeString() + ')');
  } else if (cmd === 'list') {
    const r = await call('GET', '/api/remote/sessions');
    const l = Array.isArray(r.json) ? r.json : [];
    if (!l.length) console.log('Aucun telephone appaire.');
    l.forEach(s => console.log(s.id + '  cree ' + new Date(s.created).toLocaleString() + '  expire ' + new Date(s.expires).toLocaleDateString()));
  } else if (cmd === 'revoke' && arg) {
    const r = await call('POST', '/api/remote/sessions/revoke', arg === 'all' ? { all: true } : { id: arg });
    console.log(r.json && r.json.ok ? 'Revoque : ' + r.json.revoked : 'Echec : ' + JSON.stringify(r.json));
    if (!(r.json && r.json.ok)) process.exit(1);
  } else { console.error('Usage : node scripts/mobile-pair.js [list | revoke <id>|all]'); process.exit(2); }
})().catch(e => { console.error('Serveur injoignable : ' + e.message); process.exit(1); });
