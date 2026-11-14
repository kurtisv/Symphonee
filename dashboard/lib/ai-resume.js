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

function resumeCommand(cli, permissionMode) {
  const base = CONTINUE[cli];
  if (!base) return null;
  return permissionMode === 'bypass' && YOLO[cli] ? base + ' ' + YOLO[cli] : base;
}

function createAiResume({ file, now = () => Date.now(), write }) {
  const save = write || ((f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f); });
  let live = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) live = j; } catch (_) {}
  // The plan is what was running when Symphonee stopped: captured once, at start.
  const plan = {};
  for (const [id, e] of Object.entries(live)) {
    if (e && CONTINUE[e.cli] && Number.isFinite(e.at) && now() - e.at < MAX_AGE_MS) plan[id] = { cli: e.cli, at: e.at };
  }
  live = { ...plan };
  const persist = () => { try { save(file, JSON.stringify(live, null, 2)); } catch (_) {} };
  return {
    remember(termId, cli) {
      if (!termId || !CONTINUE[cli]) return this.forget(termId);
      const prev = live[termId];
      // Refresh the timestamp at most once a minute (detection polls often).
      if (prev && prev.cli === cli && now() - prev.at < 60000) return;
      live[termId] = { cli, at: now() }; persist();
    },
    forget(termId) { if (termId && live[termId]) { delete live[termId]; persist(); } },
    // One-shot: the entry for this terminal, if any, removed from the plan.
    take(termId) { const e = plan[termId] || null; delete plan[termId]; return e; },
    planned() { return { ...plan }; },
  };
}
module.exports = { createAiResume, resumeCommand, CONTINUE, MAX_AGE_MS };
