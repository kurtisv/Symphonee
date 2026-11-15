'use strict';
// Experimental fixture reviewer settings for Codex CLI 0.169.0 (ChatGPT login).
// These are official CLI switches. The proof is local and version-specific:
// before launch, `codex debug prompt-input` with the SAME configuration must
// declare no tool other than request_user_input; after the run, the --json
// event stream must contain only agent messages and reasoning, and the
// launched process tree must have no surviving descendant. None of this is a
// kernel boundary, and it does not authorize a real project.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SUPPORTED_VERSION = 'codex-cli 0.169.0';
const ALLOWED_TOOLS = Object.freeze(['functions.request_user_input']);
const ALLOWED_ITEMS = new Set(['agent_message', 'reasoning']);
const DISABLED_FEATURES = Object.freeze(['shell_tool', 'unified_exec', 'code_mode_host', 'multi_agent', 'multi_agent_v2', 'sleep_tool',
  'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'hooks', 'skill_search', 'tool_suggest', 'goals',
  'in_app_browser', 'shell_snapshot', 'view_image', 'daemon_auto_start']);

function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }

// A catalog entry with no patch, image, search, sub-agent or code-mode tool.
function writeRestrictedCatalog(dir, model) {
  if (!/^[a-z0-9.-]{3,40}$/.test(String(model || ''))) throw Error('Invalid reviewer model');
  const cache = JSON.parse(fs.readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8'));
  const entry = structuredClone((cache.models || []).find(m => m && m.slug === model) || null);
  if (!entry) throw Error('Reviewer model missing from the local Codex catalog');
  for (const k of ['apply_patch_tool_type', 'multi_agent_version', 'web_search_tool_type', 'web_search_provider']) delete entry[k];
  Object.assign(entry, { input_modalities: ['text'], experimental_supported_tools: [], supports_search_tool: false, tool_mode: 'direct' });
  const file = path.join(dir, 'codex-catalog-' + crypto.randomBytes(6).toString('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify({ models: [entry] }), { flag: 'wx' });
  return file;
}

function configArgs(catalogFile, model) {
  const args = [];
  for (const f of DISABLED_FEATURES) args.push('--disable', f);
  args.push('-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
    '-c', 'model_catalog_json=' + JSON.stringify(catalogFile.split(path.sep).join('/')), '-c', 'model=' + JSON.stringify(model));
  return args;
}

function declaredTools(items) {
  if (!Array.isArray(items)) throw Error('Unreadable Codex prompt input');
  const names = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') throw Error('Unreadable Codex prompt input');
    if (item.type === 'message') continue;
    if (item.type !== 'additional_tools' || !Array.isArray(item.tools)) throw Error('Unexpected Codex prompt item: ' + item.type);
    for (const ns of item.tools) for (const t of (Array.isArray(ns.tools) ? ns.tools : [ns])) names.push(ns.name + '.' + t.name);
  }
  return names.sort();
}

// Synchronous: spawnHeadless is synchronous and must refuse before launch.
function verifyNoTools({ cwd, catalogFile, model, run = execFileSync }) {
  // No shell: the executable is resolved directly, arguments are not reparsed.
  const opts = { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: false };
  const version = String(run('codex', ['--version'], opts)).trim();
  if (version !== SUPPORTED_VERSION) throw Error('Unverified Codex version: ' + version.slice(0, 60));
  const raw = run('codex', ['debug', 'prompt-input', ...configArgs(catalogFile, model), 'probe'], opts);
  const tools = declaredTools(JSON.parse(raw));
  if (tools.some(t => !ALLOWED_TOOLS.includes(t))) throw Error('Codex still declares tools: ' + tools.join(', ').slice(0, 300));
  return { version, tools, promptInputHash: crypto.createHash('sha256').update(String(raw)).digest('hex') };
}

function reviewerArgs(catalogFile, model) {
  return [...configArgs(catalogFile, model), '--sandbox', 'read-only', '--json', '--ephemeral', '--skip-git-repo-check', '-'];
}

// Any item other than a message or reasoning (command, file change, MCP,
// search, collaboration, plan, error...) voids the review.
function auditEvents(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter(x => x.trim());
  let text = null, usage = null; const items = [];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { throw Error('Non-JSON reviewer output'); }
    if (!e || typeof e.type !== 'string') throw Error('Invalid reviewer event');
    if (['thread.started', 'turn.started'].includes(e.type)) continue;
    if (e.type === 'turn.completed') { usage = e.usage || null; continue; }
    if (!/^item\.(started|updated|completed)$/.test(e.type) || !e.item || !ALLOWED_ITEMS.has(e.item.type)) throw Error('Reviewer event not allowed: ' + (e.item?.type || e.type));
    items.push(e.item.type);
    if (e.type === 'item.completed' && e.item.type === 'agent_message') text = String(e.item.text || '');
  }
  if (text === null || !usage) throw Error('Reviewer produced no complete answer');
  const n = x => (Number.isInteger(x) && x >= 0 ? x : null);
  return { text, items, usage: { inputTokens: n(usage.input_tokens), cachedInputTokens: n(usage.cached_input_tokens),
    outputTokens: n(usage.output_tokens), reasoningOutputTokens: n(usage.reasoning_output_tokens),
    totalTokens: (n(usage.input_tokens) ?? 0) + (n(usage.output_tokens) ?? 0), source: 'codex-json' } };
}

// Processes still descending from the launched shell after it closed.
function survivingDescendants(rootPid, run = execFileSync) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw Error('Invalid reviewer process id');
  if (process.platform !== 'win32') return [];
  const raw = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const table = [].concat(JSON.parse(raw) || []);
  const found = []; const frontier = [rootPid]; const seen = new Set(frontier);
  while (frontier.length) {
    const pid = frontier.pop();
    for (const p of table) if (p.ParentProcessId === pid && !seen.has(p.ProcessId)) { seen.add(p.ProcessId); found.push({ pid: p.ProcessId, name: p.Name }); frontier.push(p.ProcessId); }
  }
  return found;
}

module.exports = { SUPPORTED_VERSION, ALLOWED_TOOLS, DISABLED_FEATURES, writeRestrictedCatalog, configArgs, declaredTools, verifyNoTools, reviewerArgs, auditEvents, survivingDescendants };
