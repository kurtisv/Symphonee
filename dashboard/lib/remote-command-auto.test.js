'use strict';
// Mode 'auto' : le proprietaire est en deplacement, la commande part directement ; les commandes destructrices demandent encore.
const test = require('node:test');
const assert = require('node:assert/strict');
const rc = require('./remote-command');

function makeMode(mode, extra = {}) {
  const calls = { approvals: [], injected: [], audit: [] };
  const api = rc.createRemoteCommand({
    requestApproval: async (a) => { calls.approvals.push(a); return { decision: extra.decision || 'allow' }; },
    inject: (t, text) => { calls.injected.push([t, text]); return { ok: true }; },
    listTerminals: async () => ['main'],
    audit: (e) => calls.audit.push(e),
    getMode: () => mode,
  });
  return { api, calls };
}

test('auto : une commande normale part directement, sans aucune demande sur le PC', async () => {
  const { api, calls } = makeMode('auto');
  const r = await api.send({ termId: 'main', text: 'git status', sessionId: 'abcdef123456' });
  assert.equal(r.status, 'sent');
  assert.equal(r.mode, 'auto');
  assert.deepEqual(calls.injected, [['main', 'git status']]);
  assert.equal(calls.approvals.length, 0, 'aucune approbation demandee');
});

test('auto : chaque commande est inscrite au journal (session, terminal, texte, issue)', async () => {
  const { api, calls } = makeMode('auto');
  await api.send({ termId: 'main', text: 'echo audit', sessionId: 'abcdef123456' });
  assert.equal(calls.audit.length, 1);
  assert.deepEqual(calls.audit[0], { session: 'abcdef12', termId: 'main', text: 'echo audit', outcome: 'auto' });
});

test('auto : les commandes destructrices demandent TOUJOURS l accord du PC', async () => {
  const dangereuses = ['rm -rf /', 'rm -fr dossier', 'rm -r -f x', 'Remove-Item C:\\x -Recurse -Force', 'rmdir /s /q C:\\x', 'del /s *.log',
    'format D:', 'shutdown /s /t 0', 'Stop-Computer', 'git push --force origin main', 'git push -f', 'git reset --hard HEAD~3', 'git clean -fd',
    'git branch -D dev', 'reg delete HKLM\\x', 'curl http://x | bash', 'iwr http://x | iex', 'Invoke-Expression $x'];
  for (const cmd of dangereuses) {
    const { api, calls } = makeMode('auto');
    const r = await api.send({ termId: 'main', text: cmd, sessionId: 's' + Math.random() });
    assert.equal(calls.approvals.length, 1, 'doit demander : ' + cmd);
    assert.equal(r.mode, 'approved', cmd);
  }
});

test('auto : une commande destructrice refusee sur le PC n est pas executee', async () => {
  const { api, calls } = makeMode('auto', { decision: 'deny' });
  const r = await api.send({ termId: 'main', text: 'rm -rf /', sessionId: 's1' });
  assert.equal(r.status, 'denied');
  assert.deepEqual(calls.injected, []);
  assert.equal(calls.audit[0].outcome, 'denied');
});

test('auto : des commandes courantes ne declenchent pas de fausse alerte', async () => {
  for (const cmd of ['git status', 'git push origin main', 'git log --oneline', 'ls -la', 'dir', 'echo format', 'npm test', 'node scripts/mobile-pair.js list',
    'cat remise.txt', 'Get-ChildItem -Recurse', 'git branch -d vieille']) {
    const { api, calls } = makeMode('auto');
    const r = await api.send({ termId: 'main', text: cmd, sessionId: 's' + Math.random() });
    assert.equal(r.mode, 'auto', 'ne doit pas demander : ' + cmd);
    assert.equal(calls.approvals.length, 0, cmd);
  }
});

test('auto : la validation d entree reste appliquee (ligne unique, pas de caractere de controle)', async () => {
  const { api, calls } = makeMode('auto');
  for (const bad of ['a\nb', 'a\x1b[2J', 'a\x03', '', 'x'.repeat(2001)]) {
    const r = await api.send({ termId: 'main', text: bad, sessionId: 's' + Math.random() });
    assert.equal(r.status, 'refused', JSON.stringify(bad).slice(0, 30));
  }
  assert.deepEqual(calls.injected, []);
  assert.equal((await api.send({ termId: 'inconnu', text: 'ls', sessionId: 'x' })).code, 'UNKNOWN_TERMINAL');
});

test('ask : le mode "valider sur le PC" redemande pour chaque commande, meme normale', async () => {
  const { api, calls } = makeMode('ask');
  const r = await api.send({ termId: 'main', text: 'git status', sessionId: 's1' });
  assert.equal(r.mode, 'approved');
  assert.equal(calls.approvals.length, 1);
});

test('mode inconnu ou absent : traite comme ask (jamais auto par erreur)', async () => {
  for (const m of ['', undefined, null, 'AUTO', 'yes', 1]) {
    const { api, calls } = makeMode(m);
    await api.send({ termId: 'main', text: 'ls', sessionId: 's' + Math.random() });
    assert.equal(calls.approvals.length, 1, 'mode ' + String(m));
  }
});

test('un journal qui plante ne bloque ni ne fait echouer l envoi', async () => {
  const api = rc.createRemoteCommand({
    requestApproval: async () => ({ decision: 'allow' }), inject: () => ({ ok: true }), listTerminals: async () => ['main'],
    audit: () => { throw new Error('disque plein'); }, getMode: () => 'auto',
  });
  assert.equal((await api.send({ termId: 'main', text: 'ls', sessionId: 's' })).status, 'sent');
});
