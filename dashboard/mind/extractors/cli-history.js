/**
 * CLI history extractor.
 *
 * Pulls each AI CLI's local conversation/session history from disk and
 * ingests it as `conversation` nodes in the shared brain. This is THE
 * mechanism for "what Claude figured out at 2pm is available to Codex at
 * 4pm" - their per-CLI session logs become first-class graph nodes.
 *
 * Detected sources (skipped silently if the dir does not exist):
 *
 *   Claude Code      ~/.claude/projects/<slug>/<sessionId>.jsonl
 *                    ~/.claude/history.jsonl                    (lightweight, prompts only)
 *   Codex (OpenAI)   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*-<id>.jsonl
 *                    ~/.codex/history.jsonl                     (lightweight, prompts only)
 *   Gemini CLI       ~/.gemini/history/<project>/                (often empty)
 *   Grok CLI         ~/.grok/sessions/<id>.jsonl
 *   Qwen Code        ~/.qwen/projects/<slug>/chats/<id>.jsonl
 *   GitHub Copilot   ~/.copilot/session-state/<uuid>/events.jsonl
 *
 * Each *session* becomes one node (not each message - that would explode
 * the graph). Edges: session --tagged_with--> cli_<name>, and
 * session --tagged_with--> cwd_<repo-slug> when the session declared a cwd.
 *
 * Filter by activeRepoPath by default so the brain stays scoped; pass
 * `allRepos: true` to ingest every session across every project.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeLabel } = require('../security');
const { makeIdFromLabel, normalizeId } = require('../ids');

const DEFAULT_MAX_PER_CLI = 200;
const DEFAULT_LABEL_CHARS = 140;
const SCAN_BYTES_PER_FILE = 256 * 1024;       // read at most 256K when scanning a session jsonl
const PREVIEW_CHARS = 4000;

// ---- per-CLI parsers -------------------------------------------------------

function readHead(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch (_) { return ''; }
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* corrupt line - skip */ }
  }
  return out;
}

// Extract the first user message text from any of the supported jsonl shapes
function firstUserText(records) {
  for (const r of records) {
    if (!r) continue;
    // Claude / Qwen
    if (r.type === 'user' && r.message?.content) {
      const c = r.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        const txt = c.find(x => x?.type === 'text')?.text;
        if (txt) return txt;
      }
    }
    // Qwen alt: parts[].text
    if (r.type === 'user' && r.message?.parts) {
      const t = r.message.parts.find(p => p?.text)?.text;
      if (t) return t;
    }
    // Codex rollout: payload.input or payload.user_message.text
    if (r.payload?.input) return typeof r.payload.input === 'string' ? r.payload.input : '';
    if (r.payload?.user_message?.text) return r.payload.user_message.text;
    // Codex/Claude flat history
    if (r.text) return r.text;
    if (r.display) return r.display;
    // Copilot events: data.prompt or data.message
    if (r.data?.prompt) return r.data.prompt;
    if (r.data?.message?.content) return r.data.message.content;
  }
  return '';
}

function extractCwd(records) {
  for (const r of records) {
    if (!r) continue;
    if (r.cwd) return r.cwd;
    if (r.payload?.cwd) return r.payload.cwd;
    if (r.data?.context?.cwd) return r.data.context.cwd;
  }
  return null;
}

function extractStartTime(records, fallbackMtime) {
  for (const r of records) {
    if (!r) continue;
    if (r.timestamp) return new Date(r.timestamp).toISOString();
    if (r.startTime) return new Date(r.startTime).toISOString();
    if (typeof r.ts === 'number') return new Date(r.ts * (r.ts < 1e12 ? 1000 : 1)).toISOString();
    if (r.data?.startTime) return new Date(r.data.startTime).toISOString();
  }
  return fallbackMtime ? new Date(fallbackMtime).toISOString() : new Date().toISOString();
}

// ---- per-CLI session collectors --------------------------------------------

function collectClaude(opts) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const slug of fs.readdirSync(root)) {
    const projDir = path.join(root, slug);
    if (!safeIsDir(projDir)) continue;
    let entries;
    try { entries = fs.readdirSync(projDir); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      sessions.push({ cli: 'claude', file: path.join(projDir, entry), projectSlug: slug });
    }
  }
  return sessions;
}

function collectCodex(opts) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  walkDirs(root, (file) => {
    if (file.endsWith('.jsonl')) sessions.push({ cli: 'codex', file });
  }, 4);
  return sessions;
}

function collectGemini(opts) {
  const sessions = [];
  const root = path.join(os.homedir(), '.gemini', 'history');
  walkDirs(root, (file) => {
    if (file.endsWith('.json') || file.endsWith('.jsonl')) sessions.push({ cli: 'gemini', file });
  }, 3);
  const tmp = path.join(os.homedir(), '.gemini', 'tmp');
  for (const project of safeReaddir(tmp)) {
    const projectDir = path.join(tmp, project);
    let cwd = null;
    try { cwd = fs.readFileSync(path.join(projectDir, '.project_root'), 'utf8').trim(); } catch (_) {}
    for (const file of safeReaddir(path.join(projectDir, 'chats'))) {
      if (/^session.*\.json$/.test(file)) sessions.push({ cli: 'gemini', file: path.join(projectDir, 'chats', file), cwd });
    }
  }
  return sessions;
}

function collectGrok(opts) {
  const root = path.join(os.homedir(), '.grok', 'sessions');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const f of safeReaddir(root)) {
    if (f.endsWith('.jsonl')) sessions.push({ cli: 'grok', file: path.join(root, f) });
  }
  return sessions;
}

function collectQwen(opts) {
  const root = path.join(os.homedir(), '.qwen', 'projects');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const slug of safeReaddir(root)) {
    const chats = path.join(root, slug, 'chats');
    if (!fs.existsSync(chats)) continue;
    for (const f of safeReaddir(chats)) {
      if (f.endsWith('.jsonl')) sessions.push({ cli: 'qwen', file: path.join(chats, f), projectSlug: slug });
    }
  }
  return sessions;
}

function collectCopilot(opts) {
  const root = path.join(os.homedir(), '.copilot', 'session-state');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const sid of safeReaddir(root)) {
    const events = path.join(root, sid, 'events.jsonl');
    if (fs.existsSync(events)) sessions.push({ cli: 'copilot', file: events, sessionId: sid });
  }
  return sessions;
}

// Lightweight roll-up files: just user prompts grouped by sessionId.
function collectClaudeHistory() {
  const f = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (!fs.existsSync(f)) return [];
  return [{ cli: 'claude', file: f, kind: 'rollup' }];
}
function collectCodexHistory() {
  const f = path.join(os.homedir(), '.codex', 'history.jsonl');
  if (!fs.existsSync(f)) return [];
  return [{ cli: 'codex', file: f, kind: 'rollup' }];
}

// ---- dir helpers -----------------------------------------------------------

function safeIsDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }
function safeReaddir(p) { try { return fs.readdirSync(p); } catch (_) { return []; } }
function walkDirs(root, cb, maxDepth) {
  const stack = [{ p: root, d: 0 }];
  while (stack.length) {
    const { p, d } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) {
        if (d < maxDepth) stack.push({ p: full, d: d + 1 });
      } else {
        try { cb(full); } catch (_) {}
      }
    }
  }
}

// Slug for the session's working dir, used as a tag node so all sessions in
// the same repo cluster.
function repoSlug(cwd) {
  if (!cwd) return null;
  return normalizeId(path.basename(cwd.replace(/[\\/]+$/, ''))).slice(0, 40);
}

// Compare a session's cwd to the active repo path - tolerate trailing slashes
// and slash flavor.
function cwdMatchesRepo(cwd, activeRepoPath) {
  if (!cwd || !activeRepoPath) return false;
  const norm = (s) => s.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(cwd) === norm(activeRepoPath) || norm(cwd).startsWith(norm(activeRepoPath) + '/');
}

// ---- main extractor --------------------------------------------------------

function extractCliHistory({ activeRepoPath, allRepos = false, maxPerCli = DEFAULT_MAX_PER_CLI, createdBy = 'mind/cli-history', manifest = null, incremental = false }) {
  const collectors = [
    collectClaude, collectCodex, collectGemini, collectGrok, collectQwen, collectCopilot,
  ];
  const rolling = [...collectClaudeHistory(), ...collectCodexHistory()];

  let allSessions = [];
  for (const c of collectors) {
    try { allSessions = allSessions.concat(c({})); } catch (_) {}
  }

  // Newest first (by mtime), cap per CLI.
  for (const s of allSessions) {
    try { s.mtime = fs.statSync(s.file).mtimeMs; } catch (_) { s.mtime = 0; }
  }
  allSessions.sort((a, b) => b.mtime - a.mtime);

  const perCliCount = new Map();
  const kept = [];
  for (const s of allSessions) {
    const n = perCliCount.get(s.cli) || 0;
    if (n >= maxPerCli) continue;
    perCliCount.set(s.cli, n + 1);
    kept.push(s);
  }

  const nodes = [];
  const edges = [];
  const seenCli = new Set();
  const seenRepo = new Set();
  let scanned = 0;
  let skippedOtherRepo = 0;
  let skippedUnchanged = 0;

  // Idempotent-sweeper pattern: skip session files whose mtime hasn't advanced
  // since the last extract. Session jsonls are append-only, so an unchanged
  // mtime means none of our deterministic IDs (clisess_<cli>_<sessionId>)
  // would change. The Manifest already tracks lastExtractedAt for repo-code;
  // we reuse it here keyed by the session file path.
  const manifestKey = (s) => `cli-history:${s.file}`;

  for (const s of kept) {
    // Mtime skip is ONLY safe on incremental builds, where the existing
    // graph still carries the nodes for this session. On a full rebuild,
    // skipping means losing those nodes -- so we always re-extract.
    if (incremental && manifest) {
      const prev = manifest.get(manifestKey(s));
      if (prev && prev.mtimeMs === s.mtime) {
        skippedUnchanged++;
        continue;
      }
    }
    const text = readHead(s.file, SCAN_BYTES_PER_FILE);
    if (!text) continue;
    const records = parseJsonl(text);
    if (!records.length) continue;
    const cwd = extractCwd(records);
    if (!allRepos && activeRepoPath && cwd && !cwdMatchesRepo(cwd, activeRepoPath)) {
      skippedOtherRepo++;
      continue;
    }
    const startTime = extractStartTime(records, s.mtime);
    const userText = firstUserText(records);
    const labelBase = userText || `${s.cli} session ${path.basename(s.file)}`;
    const label = sanitizeLabel(labelBase.slice(0, DEFAULT_LABEL_CHARS));
    const sessionId = path.basename(s.file).replace(/\.jsonl$/i, '').slice(0, 80);
    const id = `clisess_${s.cli}_${normalizeId(sessionId)}`.slice(0, 120);

    nodes.push({
      id, label,
      kind: 'conversation',
      source: { type: 'cli-history', cli: s.cli, file: s.file, sessionId, cwd },
      sourceLocation: { file: s.file },
      createdBy: s.cli,
      createdAt: startTime,
      tags: ['cli-session', s.cli, repoSlug(cwd)].filter(Boolean),
      preview: sanitizeLabel(userText.slice(0, PREVIEW_CHARS)),
      messageCount: records.length,
    });

    // CLI tag node + edge
    const cliId = `cli_${s.cli}`;
    if (!seenCli.has(cliId)) {
      seenCli.add(cliId);
      nodes.push({
        id: cliId, label: sanitizeLabel(s.cli), kind: 'tag',
        source: { type: 'cli', ref: s.cli }, sourceLocation: null,
        createdBy, createdAt: new Date().toISOString(), tags: [],
      });
    }
    edges.push({
      source: id, target: cliId, relation: 'tagged_with',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy: s.cli, createdAt: new Date().toISOString(),
    });

    // Repo tag node + edge (so all sessions in the same repo cluster)
    if (cwd) {
      const slug = repoSlug(cwd);
      const repoTagId = `cwd_${slug}`;
      if (!seenRepo.has(repoTagId)) {
        seenRepo.add(repoTagId);
        nodes.push({
          id: repoTagId, label: sanitizeLabel(`@${slug}`), kind: 'tag',
          source: { type: 'cwd', ref: cwd }, sourceLocation: null,
          createdBy, createdAt: new Date().toISOString(), tags: [],
        });
      }
      edges.push({
        source: id, target: repoTagId, relation: 'tagged_with',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
    }

    scanned++;
    if (manifest) {
      manifest.set(manifestKey(s), { sha256: '', lastExtractedAt: Date.now(), contributors: [], mtimeMs: s.mtime });
    }
  }

  return { nodes, edges, scanned, skippedOtherRepo, skippedUnchanged, perCli: Object.fromEntries(perCliCount) };
}

// Reflection consumes bounded procedural records, never a whole transcript.
function parseProceduralRecords(records, { cli, sessionId, createdAt, state = {}, finalize = true }) {
  const evidences = [], calls = state.calls ||= new Map(), successes = state.successes ||= [], failures = state.failures ||= new Set();
  state.counter ||= 0;
  const add = (sourceType, text, extra = {}) => {
    if (!text || /AGENTS\.md instructions|<environment_context>|# Workflow Rules|api\/bootstrap|<INSTRUCTIONS>/i.test(text)) return;
    evidences.push({ id: `history:${cli}:${sessionId}:${state.counter++}`, sessionId, sourceType, cli, createdAt, text: text.slice(0, 3000), ...extra });
  };
  const command = (name, args) => {
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { return ''; } }
    if (!/bash|shell|exec_command|run_shell_command|powershell/i.test(name || '')) return '';
    const cmd = args?.cmd || args?.command || '';
    return typeof cmd === 'string' && cmd.length <= 8000 ? cmd : '';
  };
  const setCall = (id, cmd) => { if (typeof id === 'string' && id.length > 0 && id.length <= 256) calls.set(id, cmd); };
  const result = (id, output, error = false, successHint = false) => {
    const cmd = calls.get(id);
    if (!cmd) return;
    if (Array.isArray(output)) {
      const texts = output.filter(x => x.type === 'text' || x.type === 'input_text').map(x => x.text);
      const structured = texts.flatMap(text => { try { return [JSON.parse(text)]; } catch (_) { return []; } });
      output = structured.find(x => typeof x?.exit_code === 'number' || typeof x?.exitCode === 'number') || texts.join('\n');
    }
    const str = typeof output === 'string' ? output : JSON.stringify(output);
    let decoded = output;
    if (typeof output === 'string') { try { decoded = JSON.parse(output); } catch (_) {} }
    const exit = decoded?.exit_code ?? decoded?.exitCode ?? decoded?.output?.exit_code;
    const zero = typeof exit === 'number' ? exit === 0 : /(?:Process exited with code|exit_code["']?\s*:)\s*0\b/i.test(str);
    const failed = error || (typeof exit === 'number' && exit !== 0) || /Process exited with code [1-9]/i.test(str);
    if (failed) { failures.add(cmd); if (failures.size > 200) failures.delete(failures.values().next().value); if (state.captureErrors) add('error', cmd + '\n' + str.slice(0, 700), { verified: false, toolCallId: id }); return; }
    if (!zero && !successHint) return;
    if (/api\/bootstrap|AGENTS\.md instructions|<INSTRUCTIONS>/i.test(cmd)) return;
    // A final zero exit from a shell batch does not prove every preceding
    // command/test passed. Keep the observation without granting confirmation.
    if (/[;\r\n|&]/.test(cmd)) { add('command', cmd, { verified: false, toolCallId: id }); return; }
    successes.push(cmd); if (successes.length > 200) successes.shift();
    if (state.captureErrors) { (state.successRecords ||= []).push({ cmd, toolCallId: id, createdAt }); if (state.successRecords.length > 200) state.successRecords.shift(); }
    add(/\btest\b|node --test|npm (?:test|run (?:build|check))|--check|verify/i.test(cmd) ? 'verification' : 'command', cmd, { verified: true, toolCallId: id });
    if (failures.has(cmd)) add('retry', cmd, { verified: true, toolCallId: id });
  };
  for (const record of records) {
    const p = record.payload || record;
    const role = p.role || record.type;
    if (role === 'system' || role === 'developer') continue;
    if (role === 'user' || p.type === 'user_message') {
      const content = record.message?.content || p.content || p.message || p.text;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x.type === 'text' || x.type === 'input_text').map(x => x.text).join('\n') : '';
      if (/\b(?:instead|don't|do not|always|never|correction|retry|prefer)\b|ne .+ pas|plutot|toujours/i.test(text)) add('correction', text);
    }
    if (calls.size > 500) calls.delete(calls.keys().next().value);
    if (p.type === 'function_call') setCall(p.call_id, command(p.name, p.arguments));
    if (p.type === 'function_call_output') result(p.call_id, p.output);
    // Codex code-mode logs literal JS orchestration. Never execute history.
    // Only a single literal command can safely be paired with one output.
    if (p.type === 'custom_tool_call' && p.name === 'exec') {
      const source = p.input || '';
      const matches = [...source.matchAll(/(?:tools\.)?exec_command\(\s*\{\s*["']?cmd["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)];
      if (matches.length === 1 && matches[0][1].startsWith('"')) {
        try { const cmd = JSON.parse(matches[0][1]); if (cmd.length <= 8000) setCall(p.call_id, cmd); } catch (_) {}
      }
    }
    if (p.type === 'custom_tool_call_output') result(p.call_id, p.output);
    for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
      if (block.type === 'tool_use') setCall(block.id, command(block.name, block.input));
      if (block.type === 'tool_result') result(block.tool_use_id, block.content, block.is_error, block.is_error === false);
    }
    for (const call of record.toolCalls || []) {
      const cmd = command(call.name, call.args || call.arguments);
      setCall(call.id, cmd);
      if (call.result !== undefined) result(call.id, call.result, call.error === true);
    }
    // Copilot session events keep tool execution metadata separate.
    if (/tool\.execution_start/.test(record.type || '')) setCall(record.data?.toolCallId, command(record.data?.toolName, record.data?.arguments));
    if (/tool\.execution_complete/.test(record.type || '')) result(record.data?.toolCallId, record.data?.result, record.data?.success === false);
  }
  if (finalize && successes.length >= 2) add('cli-session', successes.slice(0, 20).join('\n'), { steps: successes.slice(0, 20), verified: true });
  return evidences;
}

function collectProceduralHistory({ activeRepoPath, maxPerCli = DEFAULT_MAX_PER_CLI, maxBytesPerFile = 4 * 1024 * 1024 } = {}) {
  const collectors = [collectClaude, collectCodex, collectGemini, collectGrok, collectQwen, collectCopilot];
  const sessions = collectors.flatMap(c => c({})).map(s => ({ ...s, mtime: fs.statSync(s.file).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  const evidences = [], perCli = {}, coverage = {}, truncatedFiles = [];
  let sessionsScanned = 0, skippedOtherRepo = 0;
  for (const cli of ['claude', 'codex', 'gemini', 'grok', 'qwen', 'copilot']) coverage[cli] = { available: sessions.filter(s => s.cli === cli).length, scanned: 0, truncated: 0, skippedUnscoped: 0 };
  for (const s of sessions) {
    if ((perCli[s.cli] || 0) >= maxPerCli) continue;
    const size = fs.statSync(s.file).size;
    let text = readHead(s.file, maxBytesPerFile), records;
    if (size > maxBytesPerFile) {
      truncatedFiles.push({ cli: s.cli, sessionId: path.basename(s.file), bytes: size, bytesRead: maxBytesPerFile });
      coverage[s.cli].truncated++;
      if (s.file.endsWith('.jsonl')) text = text.slice(0, text.lastIndexOf('\n') + 1);
    }
    if (s.file.endsWith('.jsonl')) records = parseJsonl(text);
    else { try { const parsed = JSON.parse(text); records = Array.isArray(parsed) ? parsed : [{ cwd: parsed.cwd, startTime: parsed.startTime }, ...(parsed.messages || [])]; } catch (_) { continue; } }
    const cwd = extractCwd(records) || s.cwd;
    if (!cwd || !activeRepoPath || !cwdMatchesRepo(cwd, activeRepoPath)) {
      skippedOtherRepo++;
      if (!cwd) coverage[s.cli].skippedUnscoped++;
      continue;
    }
    perCli[s.cli] = (perCli[s.cli] || 0) + 1;
    coverage[s.cli].scanned++;
    sessionsScanned++;
    const sessionId = path.basename(s.file).replace(/\.jsonl?$/, '');
    evidences.push(...parseProceduralRecords(records, { cli: s.cli, sessionId, createdAt: extractStartTime(records, s.mtime) }));
  }
  return { evidences, sessionsScanned, perCli, coverage, truncatedFiles, skippedOtherRepo };
}

async function backfillProceduralHistory(opts) {
  return require('./cli-history-backfill').backfillProceduralHistory(opts);
}
module.exports = { extractCliHistory, collectProceduralHistory, parseProceduralRecords, cwdMatchesRepo, backfillProceduralHistory };
