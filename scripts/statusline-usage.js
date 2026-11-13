#!/usr/bin/env node
'use strict';
// Claude Code statusline command that also records the subscription limits for
// Symphonee's adaptive task capacity (dashboard/mind/usage-capacity.js).
//
// Claude Code passes a JSON object on stdin; for Pro/Max/Ultra subscribers it
// contains the DOCUMENTED field rate_limits.five_hour / seven_day
// (used_percentage 0-100, resets_at in Unix seconds), after the first answer
// of the session (https://code.claude.com/docs/en/statusline).
// Only that object and a timestamp are written; nothing else from the input.
//
// Enable it (your decision) in ~/.claude/settings.json:
//   "statusLine": { "type": "command", "command": "node \"<Symphonee>/scripts/statusline-usage.js\"" }
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '.ai-workspace', 'usage', 'claude-rate-limits.json');
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(input); } catch (_) {}
  const rl = j && j.rate_limits;
  // Values copied as they are (number or null): a missing percent is never turned into 0.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pick = (w) => (w ? { used_percentage: num(w.used_percentage), resets_at: num(w.resets_at) } : undefined);
  const parts = [];
  if (rl && (rl.five_hour || rl.seven_day)) {
    const snap = { at: new Date().toISOString(), rate_limits: { five_hour: pick(rl.five_hour), seven_day: pick(rl.seven_day) } };
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      const tmp = OUT + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(snap)); fs.renameSync(tmp, OUT);
    } catch (_) {}
    const fmt = (w) => (w && w.used_percentage !== null ? Math.round(w.used_percentage) + ' %' : '?');
    if (snap.rate_limits.five_hour) parts.push('5 h ' + fmt(snap.rate_limits.five_hour));
    if (snap.rate_limits.seven_day) parts.push('7 j ' + fmt(snap.rate_limits.seven_day));
  }
  const model = j && j.model && (j.model.display_name || j.model.id);
  process.stdout.write([model, parts.length ? 'Claude ' + parts.join(' | ') : null].filter(Boolean).join('  ·  ') + '\n');
});
