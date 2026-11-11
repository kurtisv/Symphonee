'use strict';
// Deep/incremental mode of the existing CLI-history extractor, not a new brain.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parse } = require('@babel/parser');
const corpus = require('../../skill-corpus');
const { parseProceduralRecords, cwdMatchesRepo } = require('./cli-history');
const VERSION = 5;
const LIMITS = Object.freeze({ maxBytes: 128 * 1024 * 1024, maxEvents: 50000, maxLineBytes: 1024 * 1024, timeoutMs: 10000, maxFiles: 10000, maxSummaryItems: 200 });
const CLIS = ['codex', 'claude', 'gemini', 'qwen', 'copilot', 'grok'];
const KNOWN_FILES = ['dashboard/server.js', 'dashboard/skill-corpus.js', 'dashboard/skill-reflection.js', 'dashboard/skill-reflection.test.js', 'dashboard/skill-corpus.test.js', 'dashboard/electron-main.js', 'dashboard/mind/', 'dashboard/public/mind-ui/', 'scripts/build-renderer.js', 'skills/author-a-skill/'];
const digest = x => crypto.createHash('sha256').update(String(x)).digest('hex');
const normalize = x => String(x || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase();
const symName = x => /(?:^|[/\\])symphonee(?:-master|-main)?(?:[-_ ]*\(?\d+\)?)?(?:[/\\]|$)/i.test(x || '');
function safeText(text, cwd) {
  let s = String(text || '');
  const issue = corpus.safetyIssue(s);
  if (issue && issue !== 'personal-path') return null;
  if (cwd) s = s.split(cwd).join('<repo>').split(cwd.replace(/\\/g, '/')).join('<repo>');
  s = s.replace(/[a-z]:[\\/]+users[\\/]+[^"'`\r\n]+|\/(?:home|Users)\/[^"'`\r\n]+/gi, '<repo>');
  return s.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ' ').slice(0, 1500).trim();
}
function discoverFiles(home = os.homedir(), limits = LIMITS) {
  const files = [], diagnostics = {};
  for (const cli of CLIS) {
    const root = path.join(home, '.' + cli); let unreadableDirectories = 0;
    function walk(dir, depth) {
      if (depth > 12 || files.length >= limits.maxFiles) return;
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { if (fs.existsSync(dir)) unreadableDirectories++; return; }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const file = path.join(dir, e.name), relative = normalize(path.relative(root, file));
        if (e.isDirectory()) { if (!/^(?:node_modules|cache|plugins|skills|debug|telemetry|vendor)$/.test(e.name)) walk(file, depth + 1); }
        else if (/\.jsonl$/i.test(e.name) && /(?:sessions?\/|archived_sessions\/|projects\/|chats\/|history\.jsonl$|events\.jsonl$)/.test(relative) || /\.json$/i.test(e.name) && /(?:session[^/]*\.json$|(?:chats|history)\/[^/]+\.json$)/.test(relative)) {
          try { const st = fs.statSync(file); files.push({ cli, file, size: st.size, mtimeMs: st.mtimeMs, rollup: /(?:^|\/)history\.jsonl$/.test(relative) }); } catch (_) { unreadableDirectories++; }
        }
      }
    }
    walk(root, 0); diagnostics[cli] = { rootExists: fs.existsSync(root), unreadableDirectories };
  }
  return { files: files.sort((a, b) => Number(a.rollup) - Number(b.rollup) || a.file.localeCompare(b.file)), diagnostics, discoveryLimited: files.length >= limits.maxFiles };
}
async function streamRecords(file, onRecord, limits = LIMITS) {
  const stats = { bytesRead: 0, events: 0, corruptLines: 0, oversizedLines: 0, limited: false, unreadable: false };
  const start = Date.now(), stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  const jsonl = /\.jsonl$/i.test(file); let buffer = '', dropping = false, header = '', depth = 0, quoted = false, escaped = false, capture = '', captureDepth = 0, captureOversized = false, rootArray = null;
  function emit(s) { try { onRecord(JSON.parse(s)); stats.events++; } catch (_) { stats.corruptLines++; } }
  try {
    for await (const chunk of stream) {
      const remaining = limits.maxBytes - stats.bytesRead;
      const taken = chunk.subarray(0, Math.max(0, remaining)), text = taken.toString('utf8'); stats.bytesRead += taken.length;
      if (jsonl) {
        for (const part of text.split(/(?<=\n)/)) {
          if (!dropping) buffer += part;
          if (Buffer.byteLength(buffer) > limits.maxLineBytes) { buffer = ''; dropping = true; stats.oversizedLines++; }
          if (part.endsWith('\n')) { if (!dropping && buffer.trim()) emit(buffer); buffer = ''; dropping = false; }
          if (stats.events >= limits.maxEvents) break;
        }
      } else {
        // Stream message objects from a JSON messages array, keeping only a
        // bounded object. Nested tool structures stay inside their message.
        if (header.length < 65536) header += text.slice(0, 65536 - header.length);
        for (const ch of text) {
          if (rootArray === null && /\S/.test(ch)) rootArray = ch === '[';
          if (captureDepth && !captureOversized) { capture += ch; if (capture.length > limits.maxLineBytes) { capture = ''; captureOversized = true; stats.oversizedLines++; } }
          if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
          if (ch === '"') { quoted = true; continue; }
          if (ch === '{') { depth++; if (!captureDepth && depth === (rootArray ? 1 : 2)) { captureDepth = depth; capture = '{'; captureOversized = false; } }
          if (ch === '}') { if (depth === captureDepth) { if (!captureOversized) emit(capture); capture = ''; captureDepth = 0; } depth--; }
          if (stats.events >= limits.maxEvents) break;
        }
      }
      if (stats.bytesRead >= limits.maxBytes || stats.events >= limits.maxEvents || Date.now() - start >= limits.timeoutMs) { stats.limited = true; stream.destroy(); break; }
    }
    if (jsonl && buffer.trim() && !dropping && !stats.limited) emit(buffer);
    if (!jsonl) {
      const meta = {}; for (const key of ['cwd', 'startTime', 'sessionId', 'projectHash']) { const m = header.match(new RegExp('"' + key + '"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")')); if (m) { try { meta[key] = JSON.parse(m[1]); } catch (_) {} } }
      onRecord(meta); if (depth !== 0 && !stats.limited) stats.corruptLines++;
    }
  } catch (_) { stats.unreadable = true; }
  return stats;
}
function classifyRepo(signals, activeRepoPath) {
  const cwds = [...signals.cwds], matching = cwds.filter(c => cwdMatchesRepo(c, activeRepoPath)), named = cwds.filter(symName);
  const known = signals.knownFiles.size, commandMatch = [...signals.commandDirs].some(symName), refs = signals.references;
  const foreign = cwds.filter(c => !symName(c) && !cwdMatchesRepo(c, activeRepoPath) && !normalize(activeRepoPath).startsWith(normalize(c) + '/'));
  const reasons = [];
  if (matching.length) reasons.push('cwd-exact'); if (named.length) reasons.push('repo-basename');
  if (known >= 2) reasons.push('multiple-known-files'); if (commandMatch) reasons.push('command-working-directory'); if (refs) reasons.push('conversation-reference');
  if (cwds.some(c => /gas.?saver|gasmobile/i.test(c))) return { status: 'other-project', confidence: .01, reasons: ['explicit-other-project-cwd'], cwdMismatch: true, noCwd: false };
  if ([...signals.commandDirs].some(c => !symName(c) && !cwdMatchesRepo(c, activeRepoPath) && path.isAbsolute(c) && !normalize(activeRepoPath).startsWith(normalize(c) + '/') || /gas.?saver|gasmobile/i.test(c))) return { status: 'uncertain', confidence: .5, reasons: [...reasons, 'other-project-tool-directory'], cwdMismatch: true, noCwd: !cwds.length };
  if (foreign.length && !matching.length && !named.length) return { status: known >= 2 || commandMatch ? 'uncertain' : 'other-project', confidence: known >= 2 ? .5 : .05, reasons: [...reasons, 'foreign-cwd'], cwdMismatch: true, noCwd: !cwds.length };
  if (foreign.length && matching.length) return { status: 'uncertain', confidence: .5, reasons: [...reasons, 'mixed-project-cwds'], cwdMismatch: true, noCwd: false };
  const confidence = matching.length ? .99 : named.length ? .92 : commandMatch && known ? .9 : known >= 2 ? .88 : refs ? .35 : 0;
  return { status: confidence >= .85 ? 'accepted' : 'uncertain', confidence, reasons, cwdMismatch: !!cwds.length && !matching.length, noCwd: !cwds.length };
}
function literalToolInputs(source) {
  // Parse syntax only. History is never evaluated. Dynamic values are ignored.
  if (typeof source !== 'string' || source.length > LIMITS.maxLineBytes) return [];
  const result = [];
  try {
    const ast = parse(source, { sourceType: 'module', allowAwaitOutsideFunction: true, errorRecovery: true });
    const stack = [ast]; let visited = 0;
    while (stack.length && visited++ < 20000) {
      const node = stack.pop(); if (!node || typeof node !== 'object') continue;
      if (node.type === 'CallExpression' && /exec_command|run_shell_command|apply_patch/.test(node.callee?.property?.name || node.callee?.name || '')) {
        const arg = node.arguments?.[0];
        if (arg?.type === 'ObjectExpression') {
          const input = {}; for (const prop of arg.properties) if (prop.type === 'ObjectProperty' && prop.value.type === 'StringLiteral') input[prop.key.name || prop.key.value] = prop.value.value;
          result.push(input);
        } else if (arg?.type === 'StringLiteral') result.push({ patch: arg.value });
      }
      for (const [key, value] of Object.entries(node)) { if (['loc', 'start', 'end', 'extra', 'errors', 'comments'].includes(key)) continue; if (Array.isArray(value)) stack.push(...value); else if (value && typeof value === 'object') stack.push(value); }
    }
  } catch (_) {}
  return result;
}
function createAccumulator(cli, fileKey, activeRepoPath, fallbackDate) {
  const signals = { cwds: new Set(), knownFiles: new Set(), commandDirs: new Set(), references: false };
  const parserState = { captureErrors: true }, eventHashes = new Set(), contentHash = crypto.createHash('sha256');
  const summary = { sessionId: fileKey, cli, timestamp: fallbackDate, corrections: [], conclusions: [], errors: [], errorSignatures: [], commands: [], filesTouched: [], tests: [], testResults: [], procedures: [], outcomes: [], lessons: [], gitOperations: [], reverts: [], reviewVerdicts: [], unsafeItemsRejected: 0 };
  let declaredId = null, duplicateEvents = 0, firstTimestamp = null, lastTimestamp = null;
  const evidence = [];
  const queueEvidence = e => { evidence.push(e); if (evidence.length > 600) evidence.shift(); };
  const scopedCommands = new Set(), scopedCallIds = new Set(), scopedKnownFiles = new Set(), successfulDates = new Map(); let symphoneeOperations = 0;
  const push = (field, text) => { const cleaned = safeText(text, [...signals.cwds][0]); if (!cleaned) { summary.unsafeItemsRejected++; return; } if (!summary[field].includes(cleaned)) { summary[field].push(cleaned); if (summary[field].length > LIMITS.maxSummaryItems) summary[field].shift(); } };
  function consume(r) {
    if (!r || typeof r !== 'object') return;
    const p = r.payload || r, role = p.role || r.type;
    const sid = r.sessionId || r.session_id || (r.type === 'session_meta' && p.id);
    if (sid && /^[a-z0-9-]{8,100}$/i.test(sid) && !corpus.safetyIssue(sid)) declaredId ||= sid;
    const cwd = r.cwd || p.cwd || r.data?.context?.cwd; if (typeof cwd === 'string' && cwd.length < 2048 && signals.cwds.size < 200) signals.cwds.add(cwd);
    const ts = r.timestamp || r.startTime || p.timestamp || (r.ts && new Date(r.ts < 1e12 ? r.ts * 1000 : r.ts).toISOString());
    if (ts && Number.isFinite(Date.parse(ts))) { firstTimestamp ||= new Date(ts).toISOString(); lastTimestamp = new Date(ts).toISOString(); summary.timestamp = firstTimestamp; }
    if (role === 'system' || role === 'developer') return;
    const raw = JSON.stringify(r), eh = digest(raw); if (eventHashes.has(eh)) { duplicateEvents++; return; } if (eventHashes.size < LIMITS.maxEvents) eventHashes.add(eh);
    contentHash.update(eh);
    // Only actual tool inputs count touched-file signals; references in user
    // instructions cannot manufacture repository attribution.
    const inputs = [];
    if (p.type === 'function_call') { try { inputs.push(typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments); } catch (_) {} }
    if (p.type === 'custom_tool_call') inputs.push(...literalToolInputs(p.input));
    for (const b of r.message?.content || []) if (typeof b === 'object' && b.type === 'tool_use') inputs.push(b.input);
    for (const c of r.toolCalls || []) inputs.push(c.args || c.arguments);
    if (/tool\.execution_start/.test(r.type || '')) inputs.push(r.data?.arguments);
    for (const input of inputs) {
      const str = typeof input === 'string' ? input : JSON.stringify(input || {}), lower = normalize(str);
      for (const f of KNOWN_FILES) if (lower.includes(f)) { signals.knownFiles.add(f); push('filesTouched', f); }
      for (const m of lower.matchAll(/(?:dashboard|scripts|skills|app)\/[a-z0-9_./-]+\.(?:[cm]?js|ts|json|md|css|html|ps1)/g)) push('filesTouched', m[0]);
      const dir = typeof input === 'object' && (input?.workdir || input?.cwd); if (typeof dir === 'string' && dir.length < 2048 && signals.commandDirs.size < 200) signals.commandDirs.add(dir);
      for (const m of str.matchAll(/(?:workdir|cwd)["']?\s*:\s*"([^"\n]+)"/g)) if (m[1].length < 2048 && signals.commandDirs.size < 200) signals.commandDirs.add(m[1].replace(/\\\\/g, '\\'));
      const explicitSym = dir && !/gas.?saver|gasmobile/i.test(dir) && (symName(dir) || cwdMatchesRepo(dir, activeRepoPath));
      if (explicitSym) {
        symphoneeOperations++;
        for (const f of KNOWN_FILES) if (lower.includes(f)) scopedKnownFiles.add(f);
        const addScopedId = id => { if (typeof id === 'string' && id.length > 0 && id.length <= 256 && scopedCallIds.size < 500) scopedCallIds.add(id); };
        if (inputs.length === 1) addScopedId(p.call_id);
        for (const block of Array.isArray(r.message?.content) ? r.message.content : []) if (block.type === 'tool_use' && block.input === input) addScopedId(block.id);
        for (const c of r.toolCalls || []) if ((c.args || c.arguments) === input) addScopedId(c.id);
        if (scopedCommands.size < 200 && (input.cmd || input.command)) scopedCommands.add(safeText(input.cmd || input.command, dir));
      }
      if (typeof input === 'object' && (input?.cmd || input?.command)) push('commands', input.cmd || input.command);
      if (typeof input === 'string') { try { const decoded = JSON.parse(input); if (decoded.cmd || decoded.command) push('commands', decoded.cmd || decoded.command); } catch (_) {} }
    }
    if (/\bsymphonee\b/i.test(raw)) signals.references = true;
    let text = r.message?.content || p.content || p.message || p.text || r.display || r.data?.prompt;
    if (Array.isArray(text)) text = text.filter(b => ['text', 'input_text', 'output_text'].includes(b.type)).map(b => b.text).join('\n');
    if (typeof text === 'string' && !/AGENTS\.md instructions|<environment_context>|<INSTRUCTIONS>|api\/bootstrap/i.test(text)) {
      if (role === 'assistant' || p.type === 'agent_message') {
        if (/verified|passed|fixed|root cause|confirmed|corrig|tests? .*(?:vert|pass)|conclusion/i.test(text)) push('conclusions', text);
        if (/review|verdict|approve|blocking|LGTM/i.test(text)) push('reviewVerdicts', text);
      }
      if (/lesson|gotcha|remember|from now on|always|never|toujours|jamais|reten/i.test(text)) push('lessons', text);
      const steps = text.split(/\r?\n/).filter(s => /^\s*\d+[.)]\s+/.test(s)).slice(0, 12);
      if (steps.length >= 2 && /run|check|verify|inspect|rebuild|trace|measure|execut|verif|reprodu/i.test(steps.join(' '))) {
        const cleaned = safeText(steps.join('\n'), [...signals.cwds][0]); if (cleaned) queueEvidence({ sourceType: role === 'user' ? 'correction' : 'procedure', text: cleaned, verified: false });
      }
    }
    const eventDate = ts && Number.isFinite(Date.parse(ts)) ? new Date(ts).toISOString() : summary.timestamp;
    const parsed = parseProceduralRecords([r], { cli, sessionId: fileKey, createdAt: eventDate, state: parserState, finalize: false });
    for (const e of parsed) {
      const cleaned = safeText(e.text, [...signals.cwds][0]); if (!cleaned) { summary.unsafeItemsRejected++; continue; }
      const field = e.sourceType === 'correction' ? 'corrections' : e.sourceType === 'error' ? 'errors' : e.sourceType === 'verification' ? 'tests' : 'commands'; push(field, cleaned);
      if (e.sourceType === 'error') { const signature = cleaned.match(/(?:\w*(?:Error|Exception)|ERR_[A-Z_]+|not ok\s+\d+|FAIL)[^\r\n]{0,180}/)?.[0]; if (signature) push('errorSignatures', signature.replace(/:\d+(?::\d+)?/g, ':<line>')); }
      if ((e.sourceType === 'error' && /test|--check|build|verify/i.test(cleaned.split('\n')[0]) || e.sourceType === 'verification') && summary.testResults.length < 200) summary.testResults.push({ command: cleaned.split('\n')[0], status: e.verified ? 'passed' : 'failed', timestamp: e.createdAt });
      if (e.verified && successfulDates.size < 200) successfulDates.set(cleaned, e.createdAt);
      if (e.sourceType === 'retry') push('outcomes', 'Successful retry: ' + cleaned);
      if (/\bgit\s+(?:status|log|show|diff|commit|revert|reset|checkout|switch|push|fetch|pull)/i.test(cleaned)) push('gitOperations', cleaned);
      if (/\bgit\s+(?:revert|reset|restore)/i.test(cleaned)) push('reverts', cleaned);
      queueEvidence({ ...e, text: cleaned, timestampInferred: !firstTimestamp });
    }
  }
  function finish() {
    let attribution = classifyRepo(signals, activeRepoPath);
    const operationalOnly = attribution.status === 'uncertain' && attribution.reasons.includes('other-project-tool-directory') && symphoneeOperations >= 2 && scopedKnownFiles.size >= 2 && ![...signals.cwds].some(c => /gas.?saver|gasmobile/i.test(c));
    if (operationalOnly) attribution = { ...attribution, status: 'accepted', confidence: .9, reasons: ['explicit-symphonee-operations-only', 'mixed-session-text-excluded'] };
    const id = declaredId ? 'session-' + digest(declaredId).slice(0, 24) : 'content-' + contentHash.copy().digest('hex').slice(0, 24);
    summary.sessionId = id; summary.repoConfidence = attribution.confidence; summary.attribution = attribution; summary.lastTimestamp = lastTimestamp || summary.timestamp;
    summary.sourceSessionId = declaredId;
    const successRecords = (parserState.successRecords || []).filter(record => !operationalOnly || scopedCallIds.has(record.toolCallId)), successes = successRecords.map(record => record.cmd);
    // Local consecutive validation windows preserve useful late-session paths
    // instead of only the first twenty commands of a whole session.
    for (let i = 0; i + 1 < successes.length; i++) {
      const steps = successes.slice(i, i + 3).map(s => safeText(s, [...signals.cwds][0])).filter(Boolean);
      if (steps.length < 2 || !steps.some(s => /test|--check|build:renderer|verify/i.test(s))) continue;
      const text = steps.join('\n'); evidence.push({ sourceType: 'cli-session', text, steps, verified: true, scoped: operationalOnly, createdAt: successRecords[Math.min(i + 2, successRecords.length - 1)]?.createdAt || successfulDates.get(steps.at(-1)) || summary.timestamp }); if (summary.procedures.length < 80) summary.procedures.push(steps);
    }
    // Repeated diagnostics/review commands are evidence even when no trustworthy
    // completion was logged. They cannot grant successful-outcome confirmation.
    const observed = (operationalOnly ? [...scopedCommands] : summary.commands).filter(s => s && s.length >= 18 && s.length <= 300 && !/[;\r\n|&]/.test(s) && !/api\/bootstrap|bootstrap-|AGENTS\.md|\.ai-workspace|<INSTRUCTIONS>/i.test(s));
    for (let i = 0; i + 1 < observed.length && i < 80; i++) {
      const steps = observed.slice(i, i + 3); evidence.push({ sourceType: 'cli-session', text: steps.join('\n'), steps, verified: false, scoped: operationalOnly, createdAt: lastTimestamp || summary.timestamp });
    }
    const scopedFailures = new Set(evidence.filter(e => e.sourceType === 'error' && scopedCallIds.has(e.toolCallId)).map(e => e.text.split('\n')[0]));
    const seen = new Set(), evidences = evidence.flatMap(e => {
      if (operationalOnly && (e.steps ? !e.scoped : !scopedCallIds.has(e.toolCallId))) return [];
      if (operationalOnly && e.sourceType === 'retry' && !scopedFailures.has(e.text)) return [];
      const fingerprint = digest(id + ':' + e.sourceType + ':' + e.text); if (seen.has(fingerprint)) return []; seen.add(fingerprint);
      const { toolCallId, ...compact } = e;
      if (compact.steps) {
        compact.successfulRetryCount = new Set(evidence.filter(other => other.sourceType === 'retry' && compact.steps.includes(other.text) && (!operationalOnly || scopedCallIds.has(other.toolCallId) && scopedFailures.has(other.text))).map(other => other.text)).size;
        compact.relatedErrorSignatures = [...new Set(evidence.filter(other => other.sourceType === 'error' && compact.steps.includes(other.text.split('\n')[0]) && (!operationalOnly || scopedCallIds.has(other.toolCallId))).map(other => other.text.match(/(?:\w*(?:Error|Exception)|ERR_[A-Z_]+)[^\r\n]{0,100}/)?.[0]).filter(Boolean))].slice(0, 5);
      }
      return [{ ...compact, id: 'procedural:' + fingerprint.slice(0, 32), fingerprint, sessionId: id, sourceSessionId: declaredId, cli, createdAt: e.createdAt || summary.timestamp, timestampInferred: compact.timestampInferred ?? !firstTimestamp, repoConfidence: attribution.confidence, attribution: attribution.reasons }];
    });
    if (operationalOnly) {
      summary.corrections = []; summary.conclusions = []; summary.lessons = []; summary.reviewVerdicts = []; summary.errors = []; summary.errorSignatures = []; summary.outcomes = []; summary.reverts = [];
      summary.commands = [...scopedCommands].filter(Boolean); summary.tests = evidences.filter(e => e.sourceType === 'verification').map(e => e.text); summary.gitOperations = summary.commands.filter(s => /\bgit\s/.test(s));
      summary.testResults = evidences.filter(e => e.sourceType === 'verification' || e.sourceType === 'error' && /test|--check|build|verify/i.test(e.text.split('\n')[0])).map(e => ({ command: e.text.split('\n')[0], status: e.verified ? 'passed' : 'failed', timestamp: e.createdAt }));
      summary.errors = evidences.filter(e => e.sourceType === 'error').map(e => e.text);
      summary.outcomes = evidences.filter(e => e.sourceType === 'retry').map(e => 'Successful retry: ' + e.text);
      summary.filesTouched = [...scopedKnownFiles]; summary.procedures = evidences.filter(e => e.steps).map(e => e.steps);
    }
    return { summary, evidences: attribution.status === 'accepted' ? evidences : [], attribution, duplicateEvents, declaredId: declaredId ? digest(declaredId) : null, contentFingerprint: contentHash.digest('hex') };
  }
  return { consume, finish };
}
async function backfillProceduralHistory({ activeRepoPath, repoRoot = activeRepoPath, home = os.homedir(), limits: overrides = {}, force = false, dryRun = false, files: suppliedFiles } = {}) {
  const startedAt = Date.now();
  if (!activeRepoPath) throw new Error('activeRepoPath required');
  const limits = { ...LIMITS, ...overrides };
  for (const key of Object.keys(LIMITS)) { if (!Number.isFinite(limits[key]) || limits[key] <= 0) throw new Error('Invalid backfill limit: ' + key); limits[key] = Math.min(limits[key], LIMITS[key]); }
  const indexFile = path.join(repoRoot, 'skills', '.reflection', 'history-index.json'); let index = { version: VERSION, repoFingerprint: digest(normalize(activeRepoPath)), limitsFingerprint: digest(JSON.stringify(limits)), files: {} };
  if (!force) { try { const cached = JSON.parse(fs.readFileSync(indexFile, 'utf8')); if (cached.version === VERSION && cached.repoFingerprint === index.repoFingerprint && cached.limitsFingerprint === index.limitsFingerprint) index = cached; } catch (_) {} }
  const found = suppliedFiles ? { files: suppliedFiles, diagnostics: {}, discoveryLimited: false } : discoverFiles(home, limits);
  const perCli = {}, coverage = {}, sessions = [], seenSessions = new Set(), seenContents = new Set(), evidences = [], seenEvidence = new Set(), nextFiles = {};
  for (const cli of CLIS) coverage[cli] = { filesDiscovered: 0, filesParsed: 0, filesCached: 0, sessionRecordsDiscovered: 0, sessionsAccepted: 0, sessionsRejected: 0, rejectedCwdMismatch: 0, cwdMismatch: 0, noCwd: 0, unreadable: 0, unparseable: 0, duplicates: 0, outsideActiveRepo: 0, uncertain: 0, totalBytesAvailable: 0, bytesRead: 0, corruptLines: 0, oversizedLines: 0, limitedFiles: 0, oldest: null, newest: null, oldestAccepted: null, newestAccepted: null, ...found.diagnostics[cli] };
  for (const file of found.files) {
    const c = coverage[file.cli]; if (!c) continue; c.filesDiscovered++; c.totalBytesAvailable += file.size;
    const key = digest(file.cli + ':' + file.file), cached = index.files[key]; let result, reused = false;
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) { result = cached.result; c.filesCached++; reused = true; }
    else {
      const accs = new Map(), fallbackDate = new Date(file.mtimeMs).toISOString();
      const stats = await streamRecords(file.file, record => {
        const group = file.rollup ? record.sessionId || record.session_id || digest(JSON.stringify(record)) : key;
        if (!accs.has(group) && accs.size < 500) accs.set(group, createAccumulator(file.cli, String(group), activeRepoPath, fallbackDate));
        accs.get(group)?.consume(record);
      }, limits);
      if (file.cli === 'gemini' && /[\\/]chats[\\/]/.test(file.file)) {
        try {
          const metadataFile = path.join(path.dirname(path.dirname(file.file)), '.project_root');
          if (fs.statSync(metadataFile).size <= 2048) {
            const cwd = fs.readFileSync(metadataFile, 'utf8').trim(); for (const acc of accs.values()) acc.consume({ cwd, type: 'project-root-metadata' });
          }
        } catch (_) {}
      }
      result = { items: [...accs.values()].map(acc => acc.finish()), stats }; c.filesParsed++;
    }
    nextFiles[key] = { size: file.size, mtimeMs: file.mtimeMs, result };
    const st = result.stats; c.bytesRead += reused ? 0 : st.bytesRead; c.corruptLines += st.corruptLines; c.oversizedLines += st.oversizedLines; c.limitedFiles += Number(st.limited);
    if (st.unreadable || st.events === 0) { if (st.unreadable) c.unreadable++; else c.unparseable++; c.sessionsRejected++; continue; }
    for (const item of result.items) {
      c.sessionRecordsDiscovered++;
      if (seenSessions.has(item.summary.sessionId) || seenContents.has(item.contentFingerprint)) { c.duplicates++; continue; }
      seenSessions.add(item.summary.sessionId); seenContents.add(item.contentFingerprint);
      const a = item.attribution; c.cwdMismatch += Number(a.cwdMismatch); c.noCwd += Number(a.noCwd);
      const first = item.summary.timestamp, last = item.summary.lastTimestamp; if (!c.oldest || first < c.oldest) c.oldest = first; if (!c.newest || last > c.newest) c.newest = last;
      sessions.push({ ...item.summary, rollup: !!file.rollup, limited: !!st.limited });
      if (a.status === 'accepted') { c.sessionsAccepted++; perCli[file.cli] = (perCli[file.cli] || 0) + 1; if (!c.oldestAccepted || first < c.oldestAccepted) c.oldestAccepted = first; if (!c.newestAccepted || last > c.newestAccepted) c.newestAccepted = last; }
      else { c.sessionsRejected++; c.rejectedCwdMismatch += Number(a.cwdMismatch); if (a.status === 'other-project') c.outsideActiveRepo++; else c.uncertain++; }
      for (const e of item.evidences) if (!seenEvidence.has(e.fingerprint)) { seenEvidence.add(e.fingerprint); evidences.push(e); }
    }
  }
  if (!dryRun) corpus.atomicWrite(indexFile, JSON.stringify({ ...index, files: nextFiles, updatedAt: new Date().toISOString() }));
  return { evidences, sessions, durationMs: Date.now() - startedAt, sessionsScanned: sessions.filter(s => s.attribution.status === 'accepted').length, perCli, coverage,
    filesDiscovered: found.files.length, sessionsDiscovered: sessions.length, uncertainSessions: sessions.filter(s => s.attribution.status === 'uncertain').length,
    skippedOtherRepo: sessions.filter(s => s.attribution.status === 'other-project').length, discoveryLimited: found.discoveryLimited,
    truncatedFiles: sessions.filter(s => s.limited).map(s => ({ cli: s.cli, sessionId: s.sessionId })), indexFile: 'skills/.reflection/history-index.json' };
}
module.exports = { backfillProceduralHistory, discoverFiles, streamRecords, classifyRepo, createAccumulator, literalToolInputs, LIMITS, KNOWN_FILES, VERSION };
