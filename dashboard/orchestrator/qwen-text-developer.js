'use strict';
// Text-only developer for the fictional Qwen fixture. One direct call to the
// loopback LM Studio server: no tools, no Docker, no file access. The model only
// returns the new content of ONE editable file; the host builds the exact diff
// from the frozen Git snapshot, and the independent checker plus the real
// reviewer judge it exactly as for the Docker worker. Measured 2026-11-15: this
// mode takes about 4 s per attempt versus 2 to 5 minutes for the agent, and the
// 4B models could not drive the agent's read/edit/test tools.
const os = require('node:os');
const { gitSnapshot, assertGitSnapshotUnchanged } = require('./qwen-git-snapshot');
const { validateAssertions } = require('./qwen-assertions');
const { validateProposal } = require('./qwen-snapshot');
const { formatDiff } = require('./qwen-docker-adapter');

const BASE_URL = 'http://127.0.0.1:1234';

// The model's answer is data: only a code fence or the raw text is taken.
function extractCode(text) {
  const fence = /```(?:javascript|js)?[ \t]*\r?\n([\s\S]*?)```/i.exec(String(text || ''));
  const code = (fence ? fence[1] : String(text || '')).replace(/\r\n/g, '\n').trim();
  return code ? code + '\n' : '';
}

async function runQwenText({ root, files, editable, assertions, prompt, signal, model, profile, temperature = 0.2 }, dependencies = {}) {
  if (typeof temperature !== 'number' || !(temperature >= 0.2 && temperature <= 0.9)) throw new Error('Invalid temperature');
  const fetchLocal = dependencies.fetch || fetch;
  const readGitSnapshot = dependencies.gitSnapshot || gitSnapshot;
  const verifyGitSnapshot = dependencies.assertGitSnapshotUnchanged || assertGitSnapshotUnchanged;
  if (!profile || profile.mode !== 'text') throw new Error('Not a text-only developer profile');
  if (signal?.aborted) throw new Error('Cancelled');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 6000) throw new Error('Invalid task');
  if (!Array.isArray(files) || !Array.isArray(editable) || editable.length !== 1 || !files.includes(editable[0])) throw new Error('Text-only mode edits exactly one selected file');
  validateAssertions(assertions, editable);
  const base = readGitSnapshot(root, files);
  const original = base.files.find(f => f.path === editable[0]);
  if (!original) throw new Error('Editable file missing from the snapshot');
  if ((dependencies.freemem || os.freemem)() < 1024 * 1024 * 1024) throw new Error('Insufficient free RAM');
  const status = await fetchLocal(BASE_URL + '/api/v0/models', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  if (!status.ok) throw new Error('LM Studio unavailable');
  const models = await status.json();
  if (!models.data?.some(m => m.id === model && m.state === 'loaded' && m.loaded_context_length >= profile.minContext)) throw new Error(`${model} with ${profile.minContext} context is not loaded`);

  const current = Buffer.from(original.content, 'base64').toString('utf8');
  const full = `${prompt}\n\nCurrent content of ${editable[0]}:\n${current}\nReturn ONLY the complete new content of ${editable[0]}: code only, no explanation, no markdown.`;
  const t0 = Date.now();
  const response = await fetchLocal(BASE_URL + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(profile.wallSeconds * 1000)]),
    body: JSON.stringify({ model, messages: [{ role: 'user', content: full }], temperature, max_tokens: 1200, stream: false, ...(profile.reasoningEffort ? { reasoning_effort: profile.reasoningEffort } : {}) }),
  });
  if (!response.ok) throw new Error('LM Studio HTTP ' + response.status);
  const json = await response.json();
  const text = json.choices?.[0]?.message?.content;
  const code = extractCode(text);
  if (!code) throw new Error('Qwen returned no code');

  const snapshot = base.files;
  const returned = snapshot.map(f => ({ path: f.path, content: f.path === editable[0] ? Buffer.from(code).toString('base64') : f.content }));
  const changes = validateProposal(snapshot, returned, editable);
  if (!changes.length) throw new Error('No permitted changes');
  verifyGitSnapshot(base);
  const u = json.usage || {};
  return { diff: formatDiff(changes, snapshot), changes, test: 'independent verification pending (text-only developer)', baseCommit: base.commit, model,
    tools: [], agentDurationMs: Date.now() - t0, agentUsage: { input_tokens: u.prompt_tokens ?? null, output_tokens: u.completion_tokens ?? null, total_tokens: u.total_tokens ?? null } };
}

module.exports = { runQwenText, extractCode };
