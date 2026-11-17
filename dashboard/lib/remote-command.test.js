'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rc = require('./remote-command');

function make({ decision = 'allow', reason, delay = 0, terminals = ['main', 'term-4'], injectResult = { ok: true } } = {}) {
  const calls = { approvals: [], injected: [], logs: [] };
  const api = rc.createRemoteCommand({
    requestApproval: async (action, ctx, timeout) => {
      calls.approvals.push({ action, ctx, timeout });
      if (delay) await new Promise(r => setTimeout(r, delay));
      return { decision, reason, promote: true }; // the PC modal may say "always allow": it must be ignored
    },
    inject: (t, text) => { calls.injected.push([t, text]); return injectResult; },
    listTerminals: async () => terminals,
    log: (m) => calls.logs.push(m),
  });
  return { api, calls };
}

test('commande approuvee sur le PC : envoyee une fois au bon terminal', async () => {
  const { api, calls } = make();
  const r = await api.send({ termId: 'main', text: 'echo bonjour', sessionId: 'abcdef123456' });
  assert.equal(r.status, 'sent');
  assert.deepEqual(calls.injected, [['main', 'echo bonjour']]);
  assert.equal(calls.approvals.length, 1);
  assert.equal(calls.approvals[0].action.type, 'remote-terminal');
  assert.match(calls.approvals[0].action.value, /\[main\] echo bonjour/);
});

test('une approbation est TOUJOURS demandee, quel que soit le mode (jamais de raccourci BYPASS)', async () => {
  const { api, calls } = make();
  await api.send({ termId: 'main', text: 'ls', sessionId: 's1' });
  await api.send({ termId: 'main', text: 'pwd', sessionId: 's1' });
  assert.equal(calls.approvals.length, 2, 'chaque commande a sa propre demande');
});

test('refusee sur le PC : rien n est envoye au terminal', async () => {
  const { api, calls } = make({ decision: 'deny' });
  const r = await api.send({ termId: 'main', text: 'rm -rf /tmp/x', sessionId: 's1' });
  assert.equal(r.status, 'denied');
  assert.deepEqual(calls.injected, []);
});

test('delai depasse : traite comme un refus, rien n est envoye', async () => {
  const { api, calls } = make({ decision: 'deny', reason: 'approval timeout' });
  const r = await api.send({ termId: 'main', text: 'ls', sessionId: 's1' });
  assert.equal(r.status, 'timeout');
  assert.deepEqual(calls.injected, []);
});

test('le "toujours autoriser" du PC est ignore : la commande suivante redemande', async () => {
  const { api, calls } = make({ decision: 'allow' });
  await api.send({ termId: 'main', text: 'ls', sessionId: 's1' });
  await api.send({ termId: 'main', text: 'ls', sessionId: 's1' });
  assert.equal(calls.approvals.length, 2);
});

test('caracteres de controle, ESC, retour a la ligne et NUL refuses (pas de seconde commande ni de sequence)', async () => {
  const { api, calls } = make();
  for (const bad of ['ls\nrm -rf x', 'ls\r', 'a\x1b[2Jb', 'a\x03b', 'a\x00b', 'a\tb', 'a\x7fb']) {
    const r = await api.send({ termId: 'main', text: bad, sessionId: 's' + Math.random() });
    assert.equal(r.status, 'refused', JSON.stringify(bad));
    assert.equal(r.code, 'CONTROL_CHARS', JSON.stringify(bad));
  }
  assert.equal(calls.approvals.length, 0, 'aucune demande pour une entree invalide');
  assert.deepEqual(calls.injected, []);
});

test('vide, trop long, mauvais type, terminal inconnu ou invalide refuses', async () => {
  const { api } = make();
  assert.equal((await api.send({ termId: 'main', text: '   ', sessionId: 'a' })).code, 'EMPTY');
  assert.equal((await api.send({ termId: 'main', text: 'x'.repeat(2001), sessionId: 'a' })).code, 'TOO_LONG');
  assert.equal((await api.send({ termId: 'main', text: 123, sessionId: 'a' })).code, 'BAD_TEXT');
  assert.equal((await api.send({ termId: 'inconnu', text: 'ls', sessionId: 'a' })).code, 'UNKNOWN_TERMINAL');
  assert.equal((await api.send({ termId: '', text: 'ls', sessionId: 'a' })).code, 'BAD_TERMINAL');
  assert.equal((await api.send({ termId: { a: 1 }, text: 'ls', sessionId: 'a' })).code, 'BAD_TERMINAL');
  assert.equal((await api.send({ termId: 'main', text: 'x'.repeat(2000), sessionId: 'a' })).status, 'sent', 'la limite exacte passe');
});

test('une seule demande en attente par session telephone', async () => {
  const { api, calls } = make({ delay: 80 });
  const first = api.send({ termId: 'main', text: 'ls', sessionId: 'same' });
  const second = await api.send({ termId: 'main', text: 'pwd', sessionId: 'same' });
  assert.equal(second.status, 'refused');
  assert.equal(second.code, 'ALREADY_PENDING');
  assert.equal((await first).status, 'sent');
  assert.equal(calls.injected.length, 1);
  assert.equal((await api.send({ termId: 'main', text: 'pwd', sessionId: 'same' })).status, 'sent', 'libere apres la reponse');
});

test('au plus 3 demandes en attente au total', async () => {
  const { api } = make({ delay: 80 });
  const p = ['a', 'b', 'c'].map(s => api.send({ termId: 'main', text: 'ls', sessionId: s }));
  const extra = await api.send({ termId: 'main', text: 'ls', sessionId: 'd' });
  assert.equal(extra.code, 'TOO_MANY_PENDING');
  const done = await Promise.all(p);
  assert.ok(done.every(r => r.status === 'sent'));
});

test('echec d injection signale, jamais "sent"', async () => {
  const { api } = make({ injectResult: { ok: false } });
  const r = await api.send({ termId: 'main', text: 'ls', sessionId: 's1' });
  assert.equal(r.status, 'failed');
});

test('le delai d approbation est de 90 s', async () => {
  const { api, calls } = make();
  await api.send({ termId: 'main', text: 'ls', sessionId: 's1' });
  assert.equal(calls.approvals[0].timeout, 90000);
});

test('le journal ne contient jamais le texte de la commande (seulement sa longueur)', async () => {
  const { api, calls } = make();
  await api.send({ termId: 'main', text: 'echo SECRET_TOKEN_123', sessionId: 'abcdef123456' });
  assert.ok(calls.logs.length >= 1);
  assert.ok(calls.logs.every(l => !l.includes('SECRET_TOKEN_123')));
});
