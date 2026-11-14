'use strict';
// Resume the AI conversations of the terminals after a Symphonee restart.
// While running, the hub remembers which AI CLI is running in which terminal
// (set when it starts or is detected, cleared when it stops or is no longer
// detected; NOT cleared when Symphonee itself shuts down). At the next start,
// a terminal that had one gets the CLI's own "continue" command once its shell
// is ready. File: .ai-workspace/terminal-ai.json (gitignored).
const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 24 * 3600000;
// Only CLIs with a documented "continue the last conversation in this folder".
const CONTINUE = { claude: 'claude --continue', codex: 'codex resume --last' };
const YOLO = { claude: '--dangerously-skip-permissions', codex: '--dangerously-bypass-approvals-and-sandbox' };

// PowerShell: go back to the folder the CLI was launched in, then continue
// its last conversation there ("continue" is per folder).
function resumeCommand(cli, permissionMode, cwd) {
  const base = CONTINUE[cli];
  if (!base || typeof cwd !== 'string' || !cwd) return null;
  const cmd = permissionMode === 'bypass' && YOLO[cli] ? base + ' ' + YOLO[cli] : base;
  return "Set-Location -LiteralPath '" + cwd.replace(/'/g, "''") + "'; " + cmd;
}
// The folder of the last PowerShell prompt shown in a terminal ("PS C:\x>"),
// i.e. where the CLI was launched; null when none can be read.
function lastPromptDir(output) {
  const text = String(output || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  let m, dir = null;
  const rx = /PS ([A-Za-z]:\\[^\r\n<>|"*?]*?)> ?/g;
  while ((m = rx.exec(text))) dir = m[1];
  return dir;
}

function createAiResume({ file, now = () => Date.now(), write }) {
  const save = write || ((f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f); });
  let live = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) live = j; } catch (_) {}
  // The plan is what was running when Symphonee stopped: captured once, at start.
  const plan = {};
  for (const [id, e] of Object.entries(live)) {
    if (e && CONTINUE[e.cli] && typeof e.cwd === 'string' && e.cwd && Number.isFinite(e.at) && now() - e.at < MAX_AGE_MS) plan[id] = { cli: e.cli, cwd: e.cwd, at: e.at };
  }
  live = { ...plan };
  const persist = () => { try { save(file, JSON.stringify(live, null, 2)); } catch (_) {} };
  return {
    // cwd: folder the CLI was launched in (unknown: nothing to resume safely).
    remember(termId, cli, cwd) {
      if (!termId || !CONTINUE[cli]) return this.forget(termId);
      const prev = live[termId];
      // Folder unreadable now (prompt scrolled out of the buffer): keep what was
      // remembered for this same CLI, never invent one.
      if (typeof cwd !== 'string' || !cwd) {
        if (prev && prev.cli === cli) cwd = prev.cwd; else return;
      }
      // Refresh the timestamp at most once a minute (detection polls often).
      if (prev && prev.cli === cli && prev.cwd === cwd && now() - prev.at < 60000) return;
      live[termId] = { cli, cwd, at: now() }; persist();
    },
    forget(termId) { if (termId && live[termId]) { delete live[termId]; persist(); } },
    // One-shot: the entry for this terminal, if any, removed from the plan.
    take(termId) { const e = plan[termId] || null; delete plan[termId]; return e; },
    planned() { return { ...plan }; },
  };
}
module.exports = { createAiResume, resumeCommand, lastPromptDir, CONTINUE, MAX_AGE_MS };
