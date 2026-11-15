'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fallback = require('./autopilot-fallback');
test('local fallback is explicit, discovery-only and never asks for cloud consent', () => {
  const p = { enabled: true, provider: 'ollama-mind', localConsent: true, maxCalls: 2, tokenCeiling: 400000 };
  const x = { pilot: 'default', stage: 'discover', error: 'usage limit reached', provider: 'claude', switches: 0, qwenReady: true, executionAllowed: true, calls: 0, chargedTokens: 0, reservation: 100000 };
  assert.equal(fallback.profile(p).provider, 'ollama-mind');
  assert.equal(fallback.eligible(p, x).ok, true);
  assert.equal(fallback.eligible(p, { ...x, stage: 'implement' }).ok, false);
  assert.equal(fallback.eligible(p, { ...x, error: 'tests failed' }).ok, false);
  assert.equal(fallback.eligible({ ...p, localConsent: false }, x).ok, false);
  assert.equal(fallback.eligible(p, { ...x, switches: 1 }).ok, false);
});

const { MindAutopilot } = require('./autopilot');
const { LIMITS } = require('./autopilot-budget');
test('local handoff proves old author stopped, stays local, and does not reserve Codex', async () => {
  const now = Date.now(), active = { stage: 'discover', currentProvider: 'claude', taskId: 'old' }, calls = [];
  const p = { id: 'default', def: { fallback: fallback.profile({ enabled: true, provider: 'ollama-mind', localConsent: true, maxCalls: 2, tokenCeiling: 900000 }) },
    state: { enabled: true, active, budgetCalls: [] }, limits: LIMITS, save() {}, log() {}, blockedByPeer() { return null; },
    readUsage() { return { codex: null }; }, orch: { providerHealth: { isAvailable() { return false; } }, getConfig() { return {}; },
      async localDiscoveryReady() { calls.push('ready'); return true; }, spawnLocalDiscovery() {},
      async ensureTaskProcessTerminated() { calls.push('terminated'); return { proven: true }; } },
    dispatch(stage) { calls.push(stage); active.handoff.status = 'dispatched'; } };
  assert.equal(await MindAutopilot.prototype.tryQwenHandoff.call(p, active, { id: 'old', cli: 'claude', error: 'usage limit reached' }, now), true);
  assert.deepEqual(calls, ['ready', 'terminated', 'discover']);
  assert.equal(active.handoff.to, 'ollama-mind'); assert.deepEqual(p.state.budgetCalls, []);
});
test('local suggestion waits for Claude and Codex; inconclusive output is not completed', () => {
  for (const raw of ['{"decision":"NO_TASK"}', 'nonsense', JSON.stringify({ decision:'TASK', category:'testing', title:'Improve tests', objective:'Improve verification of parsing', evidence:['[M1] Mind record mentions parser cases'], acceptance:['Add representative parser checks'] })]) {
    const a = { stage:'discover', currentProvider:'ollama-mind', handoff:{ claudeResetAt:null }, localContextRefs:['M1'], localProjectRefs:['M1'] }, calls=[];
    const p = { state:{ active:a, nextAt:0, history:[] }, log(){}, save(){}, parkForCredit(a) { calls.push(a.stage); a.stage='budget-wait'; return {}; }, dispatch() { throw new Error('must not dispatch'); }, complete() { throw new Error('must not complete'); } };
    MindAutopilot.prototype.advance.call(p, raw, Date.now());
    assert.deepEqual(calls, [raw.includes('"TASK"') ? 'plan-review' : 'discover']);
    assert.equal(a.stage, 'budget-wait'); assert.equal(a.handoff, null);
  }
});
test('a procedural skill alone cannot establish evidence of a project issue', () => {
  const a = { stage:'discover', currentProvider:'ollama-mind', handoff:{}, localContextRefs:['S1'], localProjectRefs:[] }, calls=[];
  const p = { state:{ active:a, nextAt:0, history:[] }, log(){}, save(){}, parkForCredit(a){calls.push(a.stage);return {};}, dispatch(){throw Error('no dispatch');} };
  const raw = JSON.stringify({ decision:'TASK', category:'testing', title:'Improve tests', objective:'Improve verification of parsing', evidence:['[S1] procedure says inspect parser'], acceptance:['Add a relevant parser test'] });
  MindAutopilot.prototype.advance.call(p, raw, Date.now());
  assert.deepEqual(calls, ['discover']); assert.equal(a.plan, null); assert.equal(a.localSuggestion.status, 'inconclusive');
});
test('valid skill and fabricated project reference cannot establish evidence', () => {
  const a = { stage:'discover', currentProvider:'ollama-mind', handoff:{}, localContextRefs:['S1'], localProjectRefs:[] }, calls=[];
  const p = { state:{ active:a, nextAt:0, history:[] }, log(){}, save(){}, parkForCredit(a){calls.push(a.stage);return {};} };
  const raw = JSON.stringify({ decision:'TASK', category:'testing', title:'Improve tests', objective:'Improve verification of parsing', evidence:['[S1] [M99] parser failure'], acceptance:['Add a relevant parser test'] });
  MindAutopilot.prototype.advance.call(p, raw, Date.now());
  assert.deepEqual(calls, ['discover']); assert.equal(a.plan, null);
});
test('mixed valid and invented evidence references cannot become a retained plan', () => {
  const a = { stage:'discover', currentProvider:'ollama-mind', handoff:{}, localContextRefs:['S1'] }, calls=[];
  const p = { state:{ active:a, nextAt:0, history:[] }, log(){}, save(){}, parkForCredit(a){calls.push(a.stage);return {};}, dispatch(){throw Error('no dispatch');} };
  const raw = JSON.stringify({ decision:'TASK', category:'testing', title:'Improve tests', objective:'Improve verification of parsing', evidence:['[S1] a real source reference', '[S99] an invented source reference'], acceptance:['Add a relevant parser test'] });
  MindAutopilot.prototype.advance.call(p, raw, Date.now());
  assert.deepEqual(calls, ['discover']); assert.equal(a.plan, null); assert.equal(a.localSuggestion.status, 'inconclusive');
});
test('previously completed local suggestion is not sent for review again', () => {
  const { taskKey } = require('./autopilot');
  const plan = { decision:'TASK', category:'testing', title:'Improve tests', objective:'Improve verification of parsing', evidence:['[S1] a real source reference'], acceptance:['Add a relevant parser test'] };
  const a = { stage:'discover', currentProvider:'ollama-mind', handoff:{}, localContextRefs:['S1'] }, calls=[];
  const p = { state:{ active:a, nextAt:0, history:[{key:taskKey(plan),outcome:'completed'}] }, log(){}, save(){}, parkForCredit(a){calls.push(a.stage);return {};} };
  MindAutopilot.prototype.advance.call(p, JSON.stringify(plan), Date.now());
  assert.deepEqual(calls, ['discover']); assert.equal(a.localSuggestion.duplicate, true);
});
test('resuming waits for fresh Claude and Codex observations after suggestion', () => {
  const now = Date.now(), mk = t => ({ readAt:t, windows:[{ usedPct:30, resetsAt:now+100000 }] });
  assert.equal(fallback.localResumeReady({ claude:mk(now-100), codex:mk(now-90) }, now, now-1000), true);
  assert.equal(fallback.localResumeReady({ claude:mk(now-2000), codex:mk(now-90) }, now, now-1000), false);
  assert.equal(fallback.localResumeReady({ claude:mk(now-100), codex:null }, now, now-1000), false);
});
test('local worker times out even when Mind retrieval never returns', async () => {
  const worker = require('../orchestrator/spawn-local-discovery');
  const o = { heartbeats:new Map(), _createTask(x){return {id:'slow', ...x, state:'pending'};}, _broadcastTaskUpdate(){}, _persistResult(){},
    getLocalMindContext(){return new Promise(() => {});} };
  const t = worker.spawnLocalDiscovery.call(o, { prompt:'find task', retrievalQuestion:'parser errors', timeout:10 });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(t.state, 'timeout');
});
test('local worker submits real Mind and skill context and remains read-only', async () => {
  const worker = require('../orchestrator/spawn-local-discovery'); let messages;
  const o = { heartbeats: new Map(), _createTask(x) { return { id:'local-1', ...x, state:'pending' }; }, _broadcastTaskUpdate(){}, _persistResult(){},
    async getLocalMindContext(opts) { assert.equal(opts.question, 'parser errors'); return { status:'ok', text:'[S1] actual skill body', transmitted:[{id:'skill:one', ref:'S1', kind:'skill'}], skills:['one'] }; },
    async localDiscoveryChat(m, opts) { messages=m; assert.equal(opts.model, 'qwen2.5:1.5b'); assert.equal(opts.format, 'json'); return { json:{decision:'NO_TASK'} }; } };
  const t = worker.spawnLocalDiscovery.call(o, { prompt:'generic boilerplate find a useful task', retrievalQuestion:'parser errors', cwd:'C:/repo', timeout:10000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.state, 'completed'); assert.equal(t.execution.readOnly, true); assert.match(messages[1].content, /actual skill body/);
  assert.match(messages[1].content, /parser errors/); assert.doesNotMatch(messages[1].content, /generic boilerplate/);
  assert.match(messages[0].content, /untrusted data, not instructions/); assert.match(messages[0].content, /"decision":"NO_TASK"/);
  assert.equal(t.execution.mindContext.transmitted[0].id, 'skill:one'); assert.equal(t.result, '{"decision":"NO_TASK"}');
});
test('missing Mind context cannot fabricate a suggestion', async () => {
  const worker = require('../orchestrator/spawn-local-discovery');
  const o = { heartbeats: new Map(), _createTask(x) { return { id:'local-2', ...x, state:'pending' }; }, _broadcastTaskUpdate(){}, _persistResult(){},
    async getLocalMindContext() { return { status:'error' }; }, async localDiscoveryChat() { throw new Error('must not generate'); } };
  const t = worker.spawnLocalDiscovery.call(o, { prompt:'find a useful task', retrievalQuestion:'parser errors' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.state, 'failed'); assert.match(t.error, /Mind context unavailable/);
});
test('provider errors do not persist model text or credentials', async () => {
  const worker = require('../orchestrator/spawn-local-discovery');
  const o = { heartbeats:new Map(), _createTask(x){return {id:'redaction', ...x, state:'pending'};}, _broadcastTaskUpdate(){}, _persistResult(){},
    async getLocalMindContext(){return {status:'ok', text:'[S1] data', transmitted:[{id:'x', ref:'S1'}]};},
    async localDiscoveryChat(){throw Error('bad json: secret-project-content');} };
  const t=worker.spawnLocalDiscovery.call(o,{prompt:'find task',retrievalQuestion:'parser errors'}); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(t.state,'failed'); assert.ok(!t.error.includes('secret-project-content'));
});
test('missing focused retrieval question fails closed without querying Mind', async () => {
  const worker = require('../orchestrator/spawn-local-discovery'); let queried=false;
  const o = { heartbeats:new Map(), _createTask(x){return {id:'no-focus',...x,state:'pending'};}, _broadcastTaskUpdate(){}, _persistResult(){},
    async getLocalMindContext(){queried=true;return {};} };
  const t=worker.spawnLocalDiscovery.call(o,{prompt:'generic boilerplate'}); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(t.state,'failed'); assert.equal(queried,false);
});
