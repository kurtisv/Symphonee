/**
 * Watch mode: hook into a filesystem watcher (chokidar if present, fs.watch
 * fallback otherwise) on the active repo's path and the notes namespace.
 * Debounce 3s, then trigger an incremental update.
 *
 * One watcher per Mind instance. Restartable via setSources().
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE = 3000;
// A watch-triggered build re-ingests every repo and rewrites the whole graph
// (about 20 s of work at 59k nodes). The targets include the CLI transcript
// folders, which change continuously while any agent works, so with the
// debounce alone builds ran back to back: 371 in one day, one every ~25 s.
//   minIntervalMs: quiet time enforced between the END of one build and the
//                  start of the next. Changes seen meanwhile are kept and
//                  built once when it elapses.
//   maxWaitMs:     upper bound on how long a steady stream of events may keep
//                  postponing a trigger through the debounce.
// Explicit knowledge events (teach, save-result) do not go through here.
function envMs(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
const DEFAULT_MIN_INTERVAL = envMs('SY_MIND_WATCH_MIN_INTERVAL_MS', 120000);
const DEFAULT_MAX_WAIT = 30000;
const WATCH_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.cs', '.md', '.mdx',
  '.go', '.java', '.kt', '.kts', '.scala', '.sc', '.rs', '.rb', '.php', '.swift',
  '.css', '.scss', '.sass', '.less', '.styl', '.svelte', '.vue',
  '.json', '.yaml', '.yml',
  // CLI drawer transcripts (Claude, Codex, Gemini, Grok, Qwen, Copilot)
  '.jsonl',
]);
const SKIP_SEG = /[\\/](node_modules|\.git|\.next|dist|build|out|\.cache|coverage|\.symphonee|\.ai-workspace|__pycache__)([\\/]|$)/;

function tryRequireChokidar() {
  try { return require('chokidar'); } catch (_) { return null; }
}

class MindWatcher {
  constructor({ repoRoot, getUiContext, broadcast, onTrigger, debounceMs = DEFAULT_DEBOUNCE, minIntervalMs = DEFAULT_MIN_INTERVAL, maxWaitMs = DEFAULT_MAX_WAIT }) {
    this.repoRoot = repoRoot;
    this.getUiContext = getUiContext;
    this.broadcast = broadcast;
    this.onTrigger = onTrigger;
    this.debounceMs = debounceMs;
    this.minIntervalMs = minIntervalMs;
    this.maxWaitMs = maxWaitMs;
    this._firstPendingAt = 0; // when the oldest not-yet-built change arrived
    this._lastDoneAt = 0;     // when the previous build finished (0 = never)
    this._running = false;    // a build triggered from here is in flight
    this._stopped = false;
    this._timer = null;
    this._pending = new Set();
    this._watchers = [];
    this._enabled = false;
  }

  start() {
    if (this._enabled) return;
    this._stopped = false;
    this._enabled = true;
    const ui = this.getUiContext ? this.getUiContext() : {};
    const targets = [];
    if (ui.activeRepoPath) targets.push(ui.activeRepoPath);
    const notesNs = ui.notesNamespace || ui.activeSpace || '_global';
    targets.push(path.join(this.repoRoot, 'notes', notesNs));
    targets.push(path.join(this.repoRoot, 'recipes'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'instructions'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'plugins'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'app-recipes'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'app-memory'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'app-recipe-history'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'site-recipes'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'site-memory'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'site-snapshots'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'site-recipe-history'));
    // Learnings ledger so /api/learnings POST flows into Mind without a
    // separate event hook — the file watcher already covers it.
    targets.push(path.join(this.repoRoot, '.ai-workspace'));
    // CLI drawer transcripts in the user's home dir. Each CLI writes its
    // session log here. The cli-drawers extractor filters to the active
    // repo, so cross-project noise doesn't pollute the graph; the watcher
    // still triggers, but the build is cheap when nothing relevant
    // changed (manifest skips unchanged sessions).
    const home = require('os').homedir();
    targets.push(path.join(home, '.claude', 'projects'));
    targets.push(path.join(home, '.codex', 'sessions'));
    targets.push(path.join(home, '.qwen', 'projects'));
    targets.push(path.join(home, '.grok', 'sessions'));
    targets.push(path.join(home, '.copilot', 'session-state'));
    targets.push(path.join(home, '.gemini', 'tmp'));

    const chokidar = tryRequireChokidar();
    if (chokidar) {
      const w = chokidar.watch(targets, {
        ignored: (p) => SKIP_SEG.test(p),
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      });
      w.on('all', (event, p) => this._onEvent(event, p));
      this._watchers.push({ close: () => w.close() });
    } else {
      // fs.watch fallback: shallow per-target watchers, recursive when supported.
      for (const t of targets) {
        if (!fs.existsSync(t)) continue;
        try {
          const w = fs.watch(t, { recursive: true }, (event, fname) => {
            if (!fname) return;
            const full = path.join(t, fname);
            if (SKIP_SEG.test(full)) return;
            this._onEvent(event, full);
          });
          this._watchers.push({ close: () => w.close() });
        } catch (_) { /* recursive not supported on Linux; skip */ }
      }
    }

    if (this.broadcast) this.broadcast({ type: 'mind-update', payload: { kind: 'watch-start', targets } });
  }

  stop() {
    this._enabled = false;
    this._stopped = true;
    for (const w of this._watchers) { try { w.close(); } catch (_) {} }
    this._watchers = [];
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending.clear();
    this._firstPendingAt = 0;
  }

  _onEvent(event, fullPath) {
    if (!fullPath) return;
    const ext = path.extname(fullPath).toLowerCase();
    if (!WATCH_EXT.has(ext)) return;
    this._pending.add(fullPath);
    if (!this._firstPendingAt) this._firstPendingAt = Date.now();
    if (this.broadcast) this.broadcast({ type: 'mind-update', payload: { kind: 'watch-trigger', event, file: fullPath } });
    this._arm();
  }

  // (Re)schedule the next trigger. Due time = debounce after the latest event,
  // but no later than maxWait after the oldest pending one, and never before
  // the cooldown since the previous build has elapsed. While a build is in
  // flight nothing is scheduled: its completion re-arms if changes are pending.
  _arm() {
    if (this._stopped || this._running) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._pending.size) return;
    const now = Date.now();
    let due = Math.min(now + this.debounceMs, this._firstPendingAt + this.maxWaitMs);
    if (this._lastDoneAt) due = Math.max(due, this._lastDoneAt + this.minIntervalMs);
    this._timer = setTimeout(() => this._fire(), Math.max(0, due - now));
  }

  _fire() {
    this._timer = null;
    if (this._stopped || this._running || !this._pending.size) return;
    const batch = Array.from(this._pending);
    this._pending.clear();
    this._firstPendingAt = 0;
    this._running = true;
    const done = () => {
      this._running = false;
      this._lastDoneAt = Date.now();
      this._arm();
    };
    let result;
    try { result = this.onTrigger && this.onTrigger(batch); } catch (e) {
      console.warn('[mind/watch] onTrigger error:', e.message);
      done();
      return;
    }
    Promise.resolve(result).then(done, (e) => {
      console.warn('[mind/watch] onTrigger error:', e && e.message);
      done();
    });
  }
}

module.exports = { MindWatcher };
