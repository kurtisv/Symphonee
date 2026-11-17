'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ft = require('./freellm-teacher');

const okFetch = (calls) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ model: 'gemini-x', choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
};
const cfg = { enabled: true, apiKey: 'freellmapi-test', baseUrl: 'http://127.0.0.1:3001/v1', model: 'auto' };

test('sans cle : desactive, aucun appel', async () => {
  assert.equal(ft.loadConfig({ env: {} }).enabled, false);
  const calls = [];
  const r = await ft.callTeacher({ config: ft.loadConfig({ env: {} }), prompt: 'x', scope: ft.FIXTURE_SCOPE, fetchFn: okFetch(calls) });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test('la cle vient de l environnement ou de .symphonee/freellm.json', () => {
  assert.equal(ft.loadConfig({ env: { SYMPHONEE_FREELLM_KEY: 'k1' } }).apiKey, 'k1');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-fl-'));
  fs.writeFileSync(path.join(d, 'freellm.json'), JSON.stringify({ apiKey: 'k2', model: 'auto:coding' }));
  const c = ft.loadConfig({ env: {}, dataDir: d });
  assert.equal(c.enabled, true); assert.equal(c.apiKey, 'k2'); assert.equal(c.model, 'auto:coding'); assert.equal(c.baseUrl, ft.DEFAULT_URL);
  assert.equal(ft.loadConfig({ env: { SYMPHONEE_FREELLM_KEY: 'k3' }, dataDir: d }).apiKey, 'k3', 'l environnement prime');
});

test('adresse non locale refusee : la cle ne part jamais ailleurs', () => {
  for (const u of ['https://api.openai.com/v1', 'http://192.168.1.5:3001/v1', 'http://evil.example/v1', 'http://127.0.0.1.evil.com/v1', 'ftp://127.0.0.1/v1', 'pas une url'])
    assert.equal(ft.loadConfig({ env: { SYMPHONEE_FREELLM_KEY: 'k', SYMPHONEE_FREELLM_URL: u } }).enabled, false, u);
  for (const u of ['http://127.0.0.1:3001/v1', 'http://localhost:3001/v1', 'http://[::1]:3001/v1'])
    assert.equal(ft.loadConfig({ env: { SYMPHONEE_FREELLM_KEY: 'k', SYMPHONEE_FREELLM_URL: u } }).enabled, true, u);
});

test('jamais hors des exercices fictifs : tout autre scope est refuse sans appel reseau', async () => {
  for (const scope of ['real-repo', 'payroll', '', undefined, null, 'Fictional-Fixture'])
    {
      const calls = [];
      const r = await ft.callTeacher({ config: cfg, prompt: 'x', scope, fetchFn: okFetch(calls) });
      assert.equal(r.ok, false, String(scope));
      assert.equal(calls.length, 0, String(scope));
    }
});

test('appel nominal : adresse, en-tete, corps, jetons', async () => {
  const calls = [];
  const r = await ft.callTeacher({ config: cfg, prompt: 'explique', scope: ft.FIXTURE_SCOPE, fetchFn: okFetch(calls) });
  assert.equal(r.ok, true); assert.equal(r.text, '{"a":1}'); assert.equal(r.model, 'gemini-x');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 });
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer freellmapi-test');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'auto'); assert.equal(body.messages[0].content, 'explique');
});

test('erreurs : HTTP, reponse vide, injoignable, delai : jamais d exception, jamais la cle dans le message', async () => {
  const bad = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const empty = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '  ' } }] }) });
  const down = async () => { throw new Error('connect ECONNREFUSED freellmapi-test'); };
  const slow = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; rej(e); }));
  for (const [f, re, ms] of [[bad, /HTTP 429/, 1000], [empty, /no text/, 1000], [down, /unreachable/, 1000], [slow, /timeout/, 30]]) {
    const r = await ft.callTeacher({ config: cfg, prompt: 'x', scope: ft.FIXTURE_SCOPE, fetchFn: f, timeoutMs: ms });
    assert.equal(r.ok, false); assert.match(r.error, re); assert.ok(!/freellmapi-test/.test(r.error));
  }
});

test('le prompt est borne', async () => {
  const calls = [];
  await ft.callTeacher({ config: cfg, prompt: 'a'.repeat(50000), scope: ft.FIXTURE_SCOPE, fetchFn: okFetch(calls) });
  assert.ok(JSON.parse(calls[0].init.body).messages[0].content.length <= 9000);
});

// ---- Pont autopilote <-> FreeLLM -----------------------------------------------------------------------------
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('pont : une tache FreeLLM passe de running a completed avec resultat et jetons', async () => {
  const calls = [];
  const br = ft.createTaskBridge({ getConfig: () => cfg, fetchFn: okFetch(calls) });
  assert.equal(br.ready(), true);
  const orch = { getTask: () => 'REEL', cancelTask: () => 'REEL-CANCEL', other: (x) => 'autre:' + x };
  const w = br.wrap(orch);
  const { id } = br.spawn({ prompt: 'p', scope: ft.FIXTURE_SCOPE });
  assert.ok(id.startsWith(ft.PREFIX));
  assert.equal(w.getTask(id).state, 'running');
  await tick(20);
  const t = w.getTask(id);
  assert.equal(t.state, 'completed'); assert.equal(t.result, '{"a":1}'); assert.equal(t.freellm, true);
  assert.deepEqual(t.usage, { inputTokens: 10, outputTokens: 5 });
});

test('pont : les identifiants normaux et les autres methodes vont a l orchestrateur reel', () => {
  const br = ft.createTaskBridge({ getConfig: () => cfg, fetchFn: okFetch([]) });
  const orch = { getTask: (i) => 'REEL:' + i, cancelTask: (i) => 'CANCEL:' + i, other(x) { return this.tag + x; }, tag: 'T-' };
  const w = br.wrap(orch);
  assert.equal(w.getTask('abc'), 'REEL:abc');
  assert.equal(w.cancelTask('abc'), 'CANCEL:abc');
  assert.equal(w.other('z'), 'T-z');
  assert.equal(br.wrap(undefined), undefined);
});

test('pont : echec FreeLLM = tache failed (l autopilote retombe sur la reparation standard)', async () => {
  const br = ft.createTaskBridge({ getConfig: () => cfg, fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const w = br.wrap({});
  const { id } = br.spawn({ prompt: 'p', scope: ft.FIXTURE_SCOPE });
  await tick(20);
  assert.equal(w.getTask(id).state, 'failed');
  assert.match(w.getTask(id).error, /HTTP 500/);
});

test('pont : hors exercices fictifs la tache echoue sans appel reseau', async () => {
  const calls = [];
  const br = ft.createTaskBridge({ getConfig: () => cfg, fetchFn: okFetch(calls) });
  const { id } = br.spawn({ prompt: 'p', scope: 'real-repo' });
  await tick(20);
  assert.equal(br.wrap({}).getTask(id).state, 'failed');
  assert.equal(calls.length, 0);
});

test('pont : annulation, et sans cle ready() est faux', async () => {
  const br = ft.createTaskBridge({ getConfig: () => cfg, fetchFn: (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; rej(e); })) });
  const w = br.wrap({});
  const { id } = br.spawn({ prompt: 'p', scope: ft.FIXTURE_SCOPE });
  w.cancelTask(id);
  assert.equal(w.getTask(id).state, 'cancelled');
  assert.equal(ft.createTaskBridge({ getConfig: () => ({ enabled: false }) }).ready(), false);
});
