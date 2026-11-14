'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMindContext, retrieveSkills } = require('./mind-context');

test('a long relevant skill cannot consume the whole budget and hide retrieved project evidence', async () => {
  const skill = { id: 'inspect-silents', valid: true, runnable: true, name: 'Inspect silent failures', description: 'inspect silent failures', body: 'procedure '.repeat(2000) };
  const graph = { nodes: [{ id: 'specific-memory', kind: 'memory', label: 'silent failures', body: 'Silent failures in the scheduler were caused by missing timeout handling. '.repeat(4) }] };
  const r = await buildMindContext({ repoRoot: '.', question: 'inspect silent failures', budgetTokens: 500,
    loadGraph: () => graph, loadSkills: () => [skill], vectors: () => null });
  assert.ok(r.transmitted.some(x => x.kind === 'skill'));
  assert.ok(r.transmitted.some(x => x.id === 'specific-memory'), 'the retrieved evidence must also reach the model');
  assert.ok(r.contextTokens <= 500);
});

test('explicitly non-runnable skills do not take priority over runnable ones', () => {
  const skills = [
    { id: 'fix-migration', valid: true, runnable: false, name: 'broken', description: 'fix migration', body: 'broken' },
    { id: 'safe-migration', valid: true, runnable: true, name: 'safe', description: 'fix migration safely', body: 'safe' },
  ];
  assert.equal(retrieveSkills(skills, { question: 'fix migration' })[0].id, 'safe-migration');
});

test('distinctive renderer term beats generic change and unrelated project terms', () => {
  const skills = [
    { id: 'review-security-change', valid: true, runnable: true, name: 'security', description: 'Checklist for authentication and security', tags: ['security'], body: 'security steps' },
    { id: 'verify-frontend-edit', valid: true, runnable: true, name: 'frontend', description: 'Validate dashboard renderer and rebuild outputs', tags: ['frontend'], body: 'frontend steps' },
    { id: 'examiner-systeme-pleinsens-avant-modif', valid: true, runnable: true, name: 'PleinSens', description: 'Examiner PleinSens avant modification', tags: [], body: 'PleinSens steps' },
  ];
  assert.equal(retrieveSkills(skills, { question: 'verifier un changement interface et reconstruire renderer' })[0].id, 'verify-frontend-edit');
  assert.deepEqual(retrieveSkills(skills, { question: 'corrige un bug et cherche sa cause avant de modifier le code' }), []);
});
