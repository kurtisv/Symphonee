'use strict';
// Terminal hub - PTY management + WebSocket + broadcast. The last kernel piece
// extracted from server.js. Owns the terminal map, shell spawning, session
// persistence, the WS server, and broadcast (the fan-out to all connected UIs).
//
// createTerminalHub({ httpServer, repoRoot, getConfig })
//   -> { broadcast, terminals, termAiMeta, createTerminal, killTerminal, wss }
//
// server.js binds broadcast/terminals/createTerminal/killTerminal from this and
// passes them to the mounts, so all existing call sites keep their names.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { atomicWriteSync } = require('../utils/atomic-write');
const { detectPwsh } = require('./detect-cli');
const { createAiResume, resumeCommand, lastPromptDir } = require('./ai-resume');
// Terminal protocol replies (device attributes, cursor reports, focus events)
// sent automatically by xterm: not the user typing.
const PROTOCOL_REPLY = /^(\x1b\[[?>]?[\d;]*[cRn]|\x1b\[[IO])+$/;

function createTerminalHub({ httpServer, repoRoot, getConfig, verifyUpgrade }) {
  const terminals = new Map();   // termId -> { pty, cols, rows, cwd, label }
  const termAiMeta = new Map();  // termId -> { cli, launched, updatedAt }
  // AI conversations to resume after a restart (see ai-resume.js).
  const aiResume = createAiResume({ file: path.join(repoRoot, '.ai-workspace', 'terminal-ai.json') });
  // Types "claude --continue" (or the CLI's equivalent) once the new shell is
  // ready: after its first output has settled, at most ~10 s after creation.
  const pendingResume = new Map(); // termId -> cancel(): user input or an AI state change wins
  function cancelResume(termId) { const c = pendingResume.get(termId); if (c) c(); }
  // Remember an AI CLI with the folder it was launched in (from the shell prompt).
  function rememberAi(termId, cli) {
    const t = terminals.get(termId);
    aiResume.remember(termId, cli, t ? lastPromptDir(t.outputBuffer) : null);
  }
  function scheduleResume(termId, ptyProcess, cli, cwd) {
    let mode = null;
    try { mode = ((getConfig && getConfig()) || {}).Permissions?.mode || null; } catch (_) {}
    let isDir = false;
    try { isDir = fs.statSync(cwd).isDirectory(); } catch (_) {}
    const cmd = isDir ? resumeCommand(cli, mode, cwd) : null;
    if (!cmd) return;
    let done = false, settle = null;
    const stop = () => { done = true; pendingResume.delete(termId); clearTimeout(settle); clearTimeout(cap); try { sub && sub.dispose && sub.dispose(); } catch (_) {} };
    const fire = () => {
      if (done) return; stop();
      const t = terminals.get(termId);
      if (!t || t.pty !== ptyProcess) return; // terminal replaced or gone meanwhile
      try { ptyProcess.write(cmd + '\r'); } catch (_) { return; }
      termAiMeta.set(termId, { cli, launched: true, updatedAt: Date.now(), source: 'resume' });
      aiResume.remember(termId, cli, cwd);
      broadcast({ type: 'term-ai-resumed', termId, cli, cmd });
    };
    const sub = ptyProcess.onData(() => { clearTimeout(settle); settle = setTimeout(fire, 1500); });
    const cap = setTimeout(fire, 10000);
    pendingResume.set(termId, stop);
  }
  let defaultCols = 120, defaultRows = 30;

  // ── Terminal session persistence (under .ai-workspace, gitignored) ───────
  const termSessionsFile = path.join(repoRoot, '.ai-workspace', 'terminal-sessions.json');
  let _sessionsRestored = false;
  function loadTermSessions() {
    try { return JSON.parse(fs.readFileSync(termSessionsFile, 'utf8')) || {}; }
    catch (_) { return { shells: [], mainLabel: null }; }
  }
  function saveTermSessions() {
    try {
      fs.mkdirSync(path.dirname(termSessionsFile), { recursive: true });
      const shells = [];
      let mainLabel = null;
      for (const [id, t] of terminals) {
        if (id === 'main') { mainLabel = t.label || null; continue; }
        shells.push({ id, label: t.label || null, cwd: t.cwd || null });
      }
      atomicWriteSync(termSessionsFile, JSON.stringify({ shells, mainLabel }, null, 2));
    } catch (_) { /* best-effort */ }
  }
  function restoreTermSessionsOnce() {
    if (_sessionsRestored) return;
    _sessionsRestored = true;
    let saved;
    try { saved = loadTermSessions(); } catch (_) { return; }
    for (const s of (saved && saved.shells) || []) {
      if (!s || !s.id || s.id === 'main' || terminals.has(s.id)) continue;
      let cwd = repoRoot;
      try { if (s.cwd && fs.existsSync(s.cwd)) cwd = s.cwd; } catch (_) {}
      try { createTerminal(s.id, defaultCols, defaultRows, cwd, s.label || null); } catch (_) {}
    }
  }

  function findShell() {
    const pwsh = detectPwsh();
    if (pwsh.installed) return pwsh.path;
    try { execSync('where powershell.exe 2>nul', { encoding: 'utf8', timeout: 3000 }).trim(); return 'powershell.exe'; } catch (_) {
      const fallback = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (fs.existsSync(fallback)) return fallback;
      return 'powershell.exe';
    }
  }
  const shellPath = findShell();

  function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  function _normFsPath(p) {
    return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  }
  function _repoForPath(cwd) {
    const cfg = getConfig();
    const repos = cfg.Repos || {};
    const nCwd = _normFsPath(cwd);
    let best = null;
    let bestLen = -1;
    for (const [name, repoPath] of Object.entries(repos)) {
      const nRepo = _normFsPath(repoPath);
      if (!nRepo) continue;
      if ((nCwd === nRepo || nCwd.startsWith(nRepo + '\\')) && nRepo.length > bestLen) {
        best = name;
        bestLen = nRepo.length;
      }
    }
    return best;
  }
  function _handleTerminalCwd(termId, cwd) {
    if (!cwd) return;
    const t = terminals.get(termId);
    if (t) t.cwd = cwd;
    broadcast({ type: 'term-cwd', termId, cwd, repo: _repoForPath(cwd) });
  }

  function createTerminal(termId, cols = 120, rows = 30, cwd = null, label = null) {
    // New terminals default to Symphonee's repoRoot (where scripts/*.ps1 live).
    if (!cwd) cwd = repoRoot;
    if (terminals.has(termId)) {
      try { terminals.get(termId).pty.kill(); } catch (_) {}
      terminals.delete(termId);
    }
    termAiMeta.delete(termId);
    // A planned resume is taken once (first creation after the restart); any
    // new shell starts without an AI, so the remembered one is forgotten.
    const resume = aiResume.take(termId);
    aiResume.forget(termId);

    const ptyProcess = pty.spawn(shellPath, ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NoLogo', '-NoExit'], {
      name: 'xterm-256color',
      cols, rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        SYMPHONEE_TERM_ID: termId,
      },
    });

    terminals.set(termId, { pty: ptyProcess, cols, rows, cwd, label: label || null, outputBuffer: '' });

    ptyProcess.onData(data => {
      // Retain a bounded scrollback so the AI / DevTools Server panel can read
      // a dev server's recent output server-side without a live socket.
      const t = terminals.get(termId);
      if (t) {
        t.outputBuffer = (t.outputBuffer || '') + data;
        if (t.outputBuffer.length > 200000) t.outputBuffer = t.outputBuffer.slice(-120000);
      }
      broadcast({ type: 'output', termId, data });
    });
    ptyProcess.onExit(() => {
      terminals.delete(termId);
      termAiMeta.delete(termId);
      broadcast({ type: 'term-exited', termId });
    });

    broadcast({ type: 'term-started', termId, cwd, isNew: true });
    _handleTerminalCwd(termId, cwd);
    if (resume) scheduleResume(termId, ptyProcess, resume.cli, resume.cwd);
    return ptyProcess;
  }

  function killTerminal(termId) {
    const t = terminals.get(termId);
    if (t) {
      try { t.pty.kill(); } catch (_) {}
      terminals.delete(termId);
    }
    termAiMeta.delete(termId);
    aiResume.forget(termId); // closed on purpose: nothing to resume
  }

  // ── WebSocket ────────────────────────────────────────────────────────────
  // Same Origin/Host firewall as the HTTP server: a malicious web page can open
  // a WebSocket to ws://127.0.0.1:PORT (WS has no same-origin restriction at the
  // protocol level), so we reject foreign origins / non-loopback hosts at the
  // upgrade handshake. The renderer (same-origin) and local clients pass.
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, cb) => {
      try {
        if (typeof verifyUpgrade === 'function' && !verifyUpgrade(info.req)) {
          return cb(false, 403, 'Forbidden');
        }
      } catch (_) { return cb(false, 403, 'Forbidden'); }
      return cb(true);
    },
  });

  wss.on('connection', (ws) => {
    // First connection after an app restart: bring back saved shells.
    restoreTermSessionsOnce();
    const active = [];
    let mainLabel = null;
    for (const [id, t] of terminals) {
      if (id === 'main') mainLabel = t.label || null;
      active.push({ id, label: t.label || null, cwd: t.cwd || null });
    }
    if (mainLabel == null) { try { mainLabel = loadTermSessions().mainLabel || null; } catch (_) {} }
    ws.send(JSON.stringify({ type: 'term-list', terminals: active, mainLabel }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const termId = msg.termId || 'main';
        switch (msg.type) {
          case 'input': {
            if (!PROTOCOL_REPLY.test(String(msg.data || ''))) cancelResume(termId); // the user typed first: never type over it
            const t = terminals.get(termId);
            if (t) t.pty.write(msg.data || '');
            break;
          }
          case 'resize': {
            if (msg.cols && msg.rows) {
              const cols = Math.max(msg.cols, 20);
              const rows = Math.max(msg.rows, 5);
              defaultCols = cols;
              defaultRows = rows;
              const t = terminals.get(termId);
              if (!t) {
                createTerminal(termId, cols, rows);
              } else if (cols !== t.cols || rows !== t.rows) {
                t.cols = cols;
                t.rows = rows;
                t.pty.resize(cols, rows);
              }
            }
            break;
          }
          case 'create-term': {
            createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows, msg.cwd, msg.label || null);
            saveTermSessions();
            break;
          }
          case 'kill-term': {
            if (termId !== 'main') { killTerminal(termId); saveTermSessions(); }
            break;
          }
          case 'rename-term': {
            const t = terminals.get(termId);
            if (t) { t.label = (String(msg.label || '').slice(0, 60)) || null; saveTermSessions(); }
            break;
          }
          case 'restart': {
            createTerminal(termId, msg.cols || defaultCols, msg.rows || defaultRows);
            break;
          }
          case 'term-ai-state': {
            cancelResume(termId);
            const cli = typeof msg.cli === 'string' ? msg.cli.trim() : '';
            const launched = msg.launched !== false;
            if (!cli || !launched) { termAiMeta.delete(termId); aiResume.forget(termId); }
            else { termAiMeta.set(termId, { cli, launched: true, updatedAt: Date.now() }); rememberAi(termId, cli); }
            break;
          }
        }
      } catch (_) {}
    });
  });

  return { broadcast, terminals, termAiMeta, aiResume, rememberAi, createTerminal, killTerminal, wss };
}

module.exports = { createTerminalHub };
