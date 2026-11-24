// node --test dashboard/public/mind-ui/src/autopilot-decisions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionsHtml, decisionCard } from './autopilot-decisions.js';

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const item = (over = {}) => ({ pilot: 'gas-saver', pilotLabel: 'Gas Saver', suspendedId: 'sus_0123456789', decisionId: 'dec_0a1b2c3d', kind: 'request', task: 'Task A', stage: 'implement',
  category: 'dependency', categoryLabel: 'Ajouter une dependance', question: 'Add <left-pad>?', consequences: 'Allowed: added.', options: [{ id: 'allow', label: 'Autoriser' }, { id: 'refuse', label: 'Refuser' }],
  allowText: true, status: 'waiting', at: '2026-11-24T16:00:00Z', worktree: 'C:/w', branch: 'b', ...over });
const view = (items) => ({ items, history: [{ pilot: 'default', pilotLabel: 'Principale', task: 'T', status: 'resumed', by: 'phone', at: '2026-11-24T15:00:00Z' }],
  categories: { dependency: 'Dependance', secrets: 'Secret' }, alwaysAsk: ['secrets'], policies: { 'gas-saver': { dependency: 'auto' } } });

test('a waiting request shows its pilot, task, question, consequences and choices; every button carries pilot + task + decision ids', () => {
  const h = decisionCard(item(), esc, false);
  for (const x of ['Gas Saver', 'Task A', 'Add &lt;left-pad&gt;?', 'Allowed: added.', 'Autoriser', 'Refuser', 'Reponse personnalisee']) assert.ok(h.includes(x), x);
  assert.ok(!h.includes('<left-pad>'), 'escaped');
  const buttons = h.match(/<button[^>]*>/g);
  assert.equal(buttons.length, 3);
  for (const b of buttons) { assert.match(b, /data-pilot="gas-saver"/); assert.match(b, /data-sus="sus_0123456789"/); assert.match(b, /data-dec="dec_0a1b2c3d"/); }
});

test('an answered request has no buttons (no second answer from the page); busy disables them', () => {
  assert.ok(!/<button/.test(decisionCard(item({ status: 'answered-resume-pending', answer: { choice: 'allow', by: 'ui' } }), esc, false)));
  assert.ok(/disabled/.test(decisionCard(item(), esc, true)));
  assert.ok(!/textarea/.test(decisionCard(item({ allowText: false }), esc, false)), 'no free text when the question takes a choice only');
});

test('section: count of open requests, history, and a policy where sensitive categories are locked', () => {
  const h = decisionsHtml(view([item(), item({ suspendedId: 'sus_2', status: 'answered-resume-pending' })]), 'gas-saver', esc, false, '');
  assert.match(h, /Mes decisions \(1 a repondre\)/);
  assert.match(h, /Reprise apres ta reponse/);
  assert.match(h, /data-cat="dependency"/); assert.match(h, /value="auto" selected/);
  assert.ok(!/data-cat="secrets"/.test(h), 'secrets cannot be made automatic'); assert.match(h, /Toujours me demander/);
  assert.match(decisionsHtml(view([]), 'default', esc, false, ''), /Aucune tache n attend ta decision/);
});
