'use strict';
// Synthetic, read-only benchmark: no live Mind, files, accounts or cloud calls.
// Run: node scripts/benchmark-local-mind.js [--inference] [--repeat]
// The same cases are used for both retrieved-context and oracle-context arms.
const { buildMindContext, retrieveSkills } = require('../dashboard/brain/mind-context');
const http = require('http');

const records = [
  { id: 'memory:rate', kind: 'memory', label: 'autopilot quota reset', body: 'For this synthetic project, the autopilot quota resets every five hours. Unknown quota must remain unknown and must not be treated as unlimited.' },
  { id: 'memory:review', kind: 'memory', label: 'independent code review', body: 'For this synthetic project, Codex independently reviews every implementation before a task may be marked complete. An absent reviewer means wait.' },
  { id: 'memory:git', kind: 'memory', label: 'git worktree safety', body: 'For this synthetic project, never push, merge or deploy from an autopilot. A failed verification leaves the task unfinished and stops the workflow.' },
  { id: 'memory:javascript', kind: 'memory', label: 'javascript empty average', body: 'In JavaScript, the synthetic mean function reduce with initial zero divided by an empty array length returns NaN. It does not throw an exception.' },
];
const skills = [
  { id: 'review-code', name: 'Review code', valid: true, description: 'independent code review', when: 'review implementation', tags: ['review'], body: 'Check independent code review before completion.' },
  { id: 'investigate-quota', name: 'Investigate quota', valid: true, description: 'autopilot quota reset', when: 'check quota reset', tags: ['quota'], body: 'Distinguish a real quota measurement from an estimate.' },
];
const cases = [
  { id: 'quota', question: 'autopilot quota reset: how many hours?', expectedId: 'memory:rate', skillId: 'investigate-quota', check: s => /\b5\b|five|cinq/i.test(s) },
  { id: 'review', question: 'independent code review: who reviews an implementation?', expectedId: 'memory:review', skillId: 'review-code', check: s => /codex/i.test(s) },
  { id: 'git', question: 'git worktree safety: can an autopilot push or merge?', expectedId: 'memory:git', check: s => /^(?:no\b|non\b|never\b|(?:an? |the )?autopilot (?:must not|cannot|can.t|should not|is not allowed|never)\b)/i.test(s.trim()) && !/\b(?:but|however|mais|cependant)\b/i.test(s) },
  { id: 'javascript', question: 'javascript empty average: what does division by zero return?', expectedId: 'memory:javascript', check: s => /\bnan\b/i.test(s) && !/throws?\b|exception/i.test(s.replace(/does not throw|doesn.t throw|ne (?:lance|provoque) pas (?:une? )?exception/ig, '')) },
];
function requestChat(model, prompt, { seed = 42, improved = false, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const system = improved ? 'Read the record carefully. Answer the question directly using only the record. Pay attention to words such as never, no, and must not. Do not add requirements. If the answer is absent say UNKNOWN. One short sentence.' : 'Answer the question only from the provided record. If the record does not answer, say UNKNOWN. Give one short sentence.';
    const data = JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], options: { temperature: 0, seed, num_predict: 100 } });
    const req = http.request({ hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: timeoutMs }, res => {
      let s = ''; res.on('data', b => { s += b; }); res.on('end', () => { try { if (res.statusCode !== 200) return reject(new Error('Ollama HTTP ' + res.statusCode)); resolve(JSON.parse(s).message.content); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Ollama timeout'))); req.end(data);
  });
}
async function evaluate({ inference = true, chat = requestChat, model = 'qwen2.5:1.5b', trials = 1 } = {}) {
  const graph = { nodes: records, edges: [] }, results = [];
  for (const c of cases) {
    const ctx = await buildMindContext({ repoRoot: '.', space: '_benchmark', question: c.question, budgetTokens: 1600, loadGraph: () => graph, loadSkills: () => skills, vectors: () => null });
    const hit = ctx.transmitted.some(x => x.id === c.expectedId);
    const selected = retrieveSkills(skills, { question: c.question }).map(s => s.id);
    const row = { id: c.id, retrievalHit: hit, expectedSkill: c.skillId || null, skillHit: c.skillId ? selected.includes(c.skillId) : null, transmittedIds: ctx.transmitted.map(x => x.id), retrievedContextTokens: ctx.contextTokens };
    if (inference) {
      const expected = records.find(r => r.id === c.expectedId);
      const arms = [['oracle', expected.body, false], ['retrieved', ctx.text, false], ['promptCandidate', ctx.text, true]];
      for (let trial = 0; trial < trials; trial++) for (const [arm, context, improved] of [...arms.slice(trial % arms.length), ...arms.slice(0, trial % arms.length)]) {
        const t = Date.now();
        row[arm] = row[arm] || [];
        try { const answer = await chat(model, 'RECORD:\n' + context + '\nQUESTION: ' + c.question, { seed: 41 + trial, improved }); row[arm].push({ seed: 41 + trial, answer, pass: c.check(answer), elapsedMs: Date.now() - t }); }
        catch (e) { row[arm].push({ seed: 41 + trial, error: String(e.message), pass: false, elapsedMs: Date.now() - t }); }
      }
    }
    results.push(row);
  }
  const total = results.length, skillRows = results.filter(r => r.expectedSkill);
  return { protocol: 'synthetic-four-cases-v2', model, inference, trials, privacy: 'synthetic data only; loopback Ollama; no live Mind or cloud', results,
    summary: { cases: total, retrieval: results.filter(r => r.retrievalHit).length + '/' + total,
      skill: skillRows.filter(r => r.skillHit).length + '/' + skillRows.length,
      oracle: inference ? results.flatMap(r => r.oracle).filter(v => v.pass).length + '/' + total * trials : null,
      endToEnd: inference ? results.flatMap(r => r.retrieved.map(v => r.retrievalHit && v.pass)).filter(Boolean).length + '/' + total * trials : null,
      promptCandidate: inference ? results.flatMap(r => r.promptCandidate.map(v => r.retrievalHit && v.pass)).filter(Boolean).length + '/' + total * trials : null } };
}
if (require.main === module) evaluate({ inference: process.argv.includes('--inference'), trials: process.argv.includes('--repeat') ? 3 : 1 }).then(x => process.stdout.write(JSON.stringify(x, null, 2) + '\n')).catch(e => { process.stderr.write(String(e.stack || e) + '\n'); process.exitCode = 1; });
module.exports = { evaluate, cases, records, skills };
