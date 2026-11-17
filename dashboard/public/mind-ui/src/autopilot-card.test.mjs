import test from 'node:test';
import assert from 'node:assert/strict';
import { cardModel, cardHtml, CARD_STAGES } from './autopilot-card.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NOW = 1000000;
const base = (o = {}) => ({ label: 'Principale', status: 'active', enabled: true, today: { completed: 1 }, limits: { dailyCompletions: 3 }, active: null, history: [], ...o });
const stepStates = (m) => m.steps.map((x) => x.state).join(',');
const btn = (m, k) => m.buttons.find((b) => b.key === k);

test('pas de snapshot : pas de carte', () => {
  assert.equal(cardModel(null), null);
  assert.equal(cardModel(undefined), null);
  assert.equal(cardHtml(null, esc), '');
});

test('en cours : phrase avec le titre du plan, etape active, agent, boutons Verifier et Arreter actifs', () => {
  const m = cardModel(base({ status: 'running', active: { stage: 'implement', plan: { title: 'Corriger le calcul' }, currentProvider: 'claude', worktree: { path: 'W' } } }), NOW);
  assert.equal(m.tone, 'green'); assert.equal(m.word, 'En train de travailler');
  assert.match(m.text, /Corriger le calcul/); assert.match(m.sub, /Etape : Ecriture/); assert.match(m.sub, /claude/);
  assert.equal(stepStates(m), 'done,done,active,todo,todo,todo');
  assert.equal(btn(m, 'enable').enabled, false); assert.equal(btn(m, 'tick').enabled, true); assert.equal(btn(m, 'stop').enabled, true);
  assert.equal(m.safe, true);
});

test('en cours sans plan : decouverte, jamais un titre invente', () => {
  const m = cardModel(base({ status: 'running', active: { stage: 'discover' } }), NOW);
  assert.match(m.text, /cherche quoi ameliorer/); assert.equal(stepStates(m), 'active,todo,todo,todo,todo,todo');
});

test('la reparation compte comme l ecriture', () => {
  const m = cardModel(base({ status: 'running', active: { stage: 'repair', plan: { title: 'x' } } }), NOW);
  assert.equal(m.steps[2].state, 'active');
});

test('en attente : phrase d attente, prochaine verification, bouton principal Verifier maintenant', () => {
  const m = cardModel(base({ nextAt: NOW + 60000 }), NOW);
  assert.equal(m.tone, 'blue'); assert.match(m.text, /J'attends la prochaine verification/); assert.match(m.sub, /Prochaine verification possible/);
  assert.equal(btn(m, 'tick').primary, true); assert.equal(stepStates(m), 'todo,todo,todo,todo,todo,todo');
});

test('hors fenetre horaire : le dit avec les heures reelles', () => {
  const m = cardModel(base({ schedule: { start: '14:00', end: '19:00' }, inWindow: false }), NOW);
  assert.match(m.text, /hors de ma fenetre horaire/); assert.match(m.text, /14:00 a 19:00/);
  assert.ok(m.facts.some((f) => /hors plage/.test(f)));
});

test('sans fenetre : "non limitee", jamais une plage inventee', () => {
  const m = cardModel(base(), NOW);
  assert.ok(m.facts.some((f) => /non limitee/.test(f))); assert.ok(!m.facts.some((f) => /\d\d:\d\d/.test(f)));
});

test('budget du jour atteint sans tache : repos', () => {
  const m = cardModel(base({ today: { completed: 3 }, status: 'waiting', nextAt: NOW + 5000 }), NOW);
  assert.equal(m.tone, 'amber'); assert.match(m.word, /Repos/); assert.match(m.text, /3 taches du jour/);
  assert.equal(stepStates(cardModel(base({ today: { completed: 3 }, history: [{ outcome: 'completed' }] }), NOW)), 'done,done,done,done,done,done');
});

test('pause quota : le motif est explique selon parkReason', () => {
  const cases = { credit: /limite de credit/, quota: /budget interne/, window: /fenetre horaire/, restart: /redemarrage/, autre: /etape est en attente/ };
  for (const [reason, re] of Object.entries(cases)) {
    const m = cardModel(base({ status: 'quota', active: { stage: 'implement', parkReason: reason, plan: { title: 't' } } }), NOW);
    assert.equal(m.tone, 'amber'); assert.match(m.text, re, reason); assert.equal(m.steps[2].state, 'paused');
  }
});

test('erreur : phrase rouge, motif coupe, etape en echec', () => {
  const m = cardModel(base({ status: 'error', error: 'x'.repeat(400), active: { stage: 'verify' } }), NOW);
  assert.equal(m.tone, 'red'); assert.equal(m.word, 'Erreur'); assert.ok(m.sub.length <= 160); assert.equal(m.steps[3].state, 'error');
});

test('interrompu : reprise proposee seulement si resumable, sinon archivage', () => {
  const r = cardModel(base({ status: 'interrupted', active: { stage: 'implement', resumable: true } }), NOW);
  assert.equal(btn(r, 'resume').enabled, true); assert.equal(btn(r, 'resume').primary, true); assert.equal(btn(r, 'enable'), undefined);
  const n = cardModel(base({ status: 'interrupted', active: { stage: 'implement', resumable: false } }), NOW);
  assert.equal(btn(n, 'acknowledge').enabled, true); assert.equal(btn(n, 'resume'), undefined);
});

test('releve bloquee : rouge, motif cite', () => {
  const m = cardModel(base({ status: 'running', active: { stage: 'plan-review', handoff: { status: 'blocked', reason: 'limite Claude atteinte' } } }), NOW);
  assert.equal(m.tone, 'red'); assert.match(m.text, /limite Claude atteinte/); assert.match(m.word, /Bloque/);
});

test('desactive : Activer est le bouton principal, Verifier et Arreter sont inactifs avec la raison', () => {
  const m = cardModel(base({ status: 'disabled', enabled: false }), NOW);
  assert.equal(m.tone, 'gray'); assert.equal(btn(m, 'enable').primary, true); assert.equal(btn(m, 'tick').enabled, false); assert.equal(btn(m, 'stop').enabled, false);
  assert.match(btn(m, 'tick').hint, /desactive/);
});

test('aucun bouton Pause : l autopilote n en a pas', () => {
  const labels = cardModel(base({ status: 'running', active: { stage: 'verify' } }), NOW).buttons.map((b) => b.label.toLowerCase()).join('|');
  assert.ok(!/pause/.test(labels));
});

test('valeurs manquantes : dit "non fourni", n invente ni zero ni limite', () => {
  const m = cardModel({ status: 'active', enabled: true }, NOW);
  assert.equal(m.used, null); assert.equal(m.max, null);
  assert.match(cardHtml(m, esc), /information non fournie/);
  assert.ok(!m.safe, 'aucune promesse d isolation sans preuve');
});

test('chip "worktree isole" seulement avec une preuve (worktree actif ou consentement)', () => {
  assert.equal(cardModel(base(), NOW).safe, false);
  assert.equal(cardModel(base({ consent: { worktreeWrites: true } }), NOW).safe, true);
  assert.equal(cardModel(base({ active: { stage: 'verify', worktree: { path: 'p' } } }), NOW).safe, true);
});

test('markup : echappe le texte venant des donnees, 6 etapes, 4 boutons, actions reelles', () => {
  const m = cardModel(base({ label: '<b>P</b>', status: 'running', active: { stage: 'verify', plan: { title: '<img src=x onerror=alert(1)>' } } }), NOW);
  const html = cardHtml(m, esc, false);
  assert.ok(!html.includes('<img') && !html.includes('<b>P</b>'));
  assert.equal((html.match(/class="apc-step"/g) || []).length, CARD_STAGES.length);
  assert.equal((html.match(/apc-btn/g) || []).length, 4);
  for (const a of ['MindAutopilot.enable()', 'MindAutopilot.tick()', 'MindAutopilot.stop()', 'MindAutopilot.detail()']) assert.ok(html.includes(a), a);
  assert.match(html, /role="status"/); assert.match(html, /aria-label="Tests : en cours"/);
});

test('occupe : tout est desactive sauf Voir le detail', () => {
  const html = cardHtml(cardModel(base({ status: 'running', active: { stage: 'verify' } }), NOW), esc, true);
  const buttons = html.match(/<button[^>]*>/g);
  assert.equal(buttons.filter((b) => /disabled/.test(b)).length, 3);
  assert.ok(!/disabled/.test(buttons[3]));
});

test('tout le texte affiche est en ASCII (regle du projet)', () => {
  for (const o of [{ status: 'running', active: { stage: 'verify', plan: { title: 'ok' } } }, { status: 'error', error: 'e' }, { status: 'disabled', enabled: false }, { status: 'quota', active: { parkReason: 'credit' } }, { today: { completed: 3 } }]) {
    const html = cardHtml(cardModel(base(o), NOW), esc);
    assert.ok(/^[\x20-\x7E\n]*$/.test(html.replace(/\n/g, '')), JSON.stringify(o));
  }
});
