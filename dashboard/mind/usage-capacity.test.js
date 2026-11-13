'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const c = require('./usage-capacity');

const NOW = Date.parse('2026-11-13T17:00:00Z');
const read = (pct, resetsInMin = 120, ageMin = 1) => ({ windows: [{ name: '5 h', usedPct: pct, resetsAt: NOW + resetsInMin * 60000 }], readAt: NOW - ageMin * 60000, source: 't' });

test('decide: 0..6, the tighter provider limits, review reserved, ceiling per window', () => {
  // Claude 40 % used: 100-40-10 = 50 usable / 15 => 3 ; Codex 20 %: 70/8 => 8 ; min 3
  let d = c.decide({ claude: read(40), codex: read(20), now: NOW });
  assert.equal(d.mode, 'measured'); assert.equal(d.admissible, 3); assert.match(d.reason, /claude/);
  // Codex nearly out: the author task cannot run without its review.
  d = c.decide({ claude: read(0), codex: read(85), now: NOW });
  assert.equal(d.admissible, 0); assert.match(d.reason, /codex/);
  // Plenty of capacity: capped at 6 minus tasks already launched in the window.
  d = c.decide({ claude: read(0), codex: read(0), launched: 4, now: NOW });
  assert.equal(d.admissible, 2);
  d = c.decide({ claude: read(0), codex: read(0), launched: 6, now: NOW });
  assert.equal(d.admissible, 0); assert.match(d.reason, /Plafond de 6/);
});

test('decide: measured costs (largest, not average), visible margin', () => {
  const costLog = [{ provider: 'claude', pct: 5 }, { provider: 'claude', pct: 20 }, { provider: 'claude', pct: 6 }];
  const d = c.decide({ claude: read(30), codex: read(0), costLog, cfg: { marginPct: 20 }, now: NOW });
  // 100-30-20 = 50 / 20 (largest observed) = 2
  assert.equal(d.providers.claude.costPct, 20); assert.match(d.providers.claude.costBasis, /plus forte hausse observee sur 3/);
  assert.equal(d.admissible, 2); assert.equal(d.marginPct, 20);
});

test('decide: stale, missing, incoherent or reset readings are unknown, never assumed', () => {
  let d = c.decide({ claude: read(10, 120, 45), codex: read(10), fallbackTasks: 2, now: NOW });
  assert.equal(d.mode, 'fallback'); assert.match(d.reason, /perimee/); assert.equal(d.admissible, 2);
  d = c.decide({ claude: { error: 'x' }, codex: read(10), fallbackTasks: 2, launched: 2, now: NOW });
  assert.equal(d.admissible, 0, 'fallback counts launches too');
  d = c.decide({ claude: read(130), codex: read(10), cfg: { unknown: { mode: 'block' } }, now: NOW });
  assert.equal(d.admissible, 0); assert.match(d.reason, /incoherente/);
  d = c.decide({ claude: read(10, -5), codex: read(10), now: NOW });
  assert.equal(d.mode, 'fallback'); assert.match(d.reason, /reinitialis/);
});

test('taskCost: per window, skipped when the window was reset in between', () => {
  const b = { '5 h': { usedPct: 10, resetsAt: 1 }, '7 jours': { usedPct: 30, resetsAt: 9 } };
  assert.equal(c.taskCost(b, { '5 h': { usedPct: 14, resetsAt: 1 }, '7 jours': { usedPct: 31, resetsAt: 9 } }), 4);
  assert.equal(c.taskCost(b, { '5 h': { usedPct: 2, resetsAt: 2 }, '7 jours': { usedPct: 31, resetsAt: 9 } }), null, 'reset: no sample');
  assert.equal(c.taskCost(null, b), null);
});

test('readers: Codex rate_limits object only; Claude snapshot from the statusline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const d = new Date(NOW);
  const day = path.join(dir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'r.jsonl'), '{"msg":"secret conversation text"}\n{"timestamp":"' + new Date(NOW - 60000).toISOString() + '","payload":{"rate_limits":{"primary":{"used_percent":26.0,"window_minutes":10080,"resets_at":1795027657},"secondary":{"used_percent":40,"window_minutes":300,"resets_at":1794600000},"credits":{"has_credits":false}}}}\n');
  const r = c.readCodex(dir, NOW);
  assert.deepEqual(r.windows.map((w) => [w.name, w.usedPct]), [['7 jours', 26], ['5 h', 40]]);
  assert.ok(!JSON.stringify(r).includes('secret'), 'nothing else is read from the session');
  assert.match(c.readCodex(path.join(dir, 'none'), NOW).error, /aucune limite/);
  const snap = path.join(dir, 'claude.json');
  fs.writeFileSync(snap, JSON.stringify({ at: new Date(NOW).toISOString(), rate_limits: { five_hour: { used_percentage: 12, resets_at: 1794600000 }, seven_day: { used_percentage: 50, resets_at: 1795000000 } } }));
  assert.deepEqual(c.readClaude(snap).windows.map((w) => w.usedPct), [12, 50]);
  assert.match(c.readClaude(path.join(dir, 'absent.json')).error, /pas activee/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review 1: fallback limited by the known provider; reservations; expired window; null fallback', () => {
  // Claude unknown, Codex known and nearly empty: the fallback cannot authorise tasks without review.
  let d = c.decide({ claude: { error: 'x' }, codex: read(95), fallbackTasks: 2, now: NOW });
  assert.equal(d.mode, 'fallback'); assert.equal(d.admissible, 0);
  // Tasks started after the reading are reserved against it (any pilot).
  d = c.decide({ claude: read(70), codex: read(0), spans: [{ launchedAt: NOW - 30000, endedAt: null }], now: NOW });
  assert.equal(d.providers.claude.reserved, 1); assert.equal(d.admissible, 0, '20/15 = 1, minus 1 reserved');
  // One window reset since the reading: the whole provider is unknown.
  d = c.decide({ claude: { windows: [{ name: '5 h', usedPct: 10, resetsAt: NOW - 1000 }, { name: '7 jours', usedPct: 10, resetsAt: NOW + 9e8 }], readAt: NOW - 60000, source: 't' }, codex: read(0), now: NOW });
  assert.equal(d.providers.claude.status, 'unknown');
  // unknown.tasks: null keeps the former fixed limit (not 0).
  assert.equal(c.settings({ unknown: { tasks: null } }).unknown.tasks, null);
  assert.equal(c.settings({ unknown: { tasks: 0 } }).unknown.tasks, 0);
});

test('review 1: Codex freshness from the event timestamp, not the file time; only the rate_limits line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap2-'));
  const d = new Date(NOW);
  const day = path.join(dir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const old = new Date(NOW - 3 * 3600000).toISOString();
  fs.writeFileSync(path.join(day, 'r.jsonl'),
    '{"timestamp":"' + old + '","payload":{"rate_limits":{"primary":{"used_percent":10,"window_minutes":300,"resets_at":' + Math.round(NOW / 1000 + 600) + '}}}}\n'
    + '{"timestamp":"' + new Date(NOW).toISOString() + '","payload":{"text":"newer unrelated secret"}}\n');
  const r = c.readCodex(dir, NOW);
  assert.equal(r.readAt, Date.parse(old));
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.equal(c.decide({ claude: read(0), codex: r, now: NOW }).providers.codex.status, 'unknown', '3 h old measure: stale');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review 2: invalid readings unknown; unfinished tasks stay reserved', () => {
  const win = (o) => ({ windows: [{ name: '5 h', usedPct: 10, resetsAt: NOW + 3600000, ...o }], readAt: NOW - 60000, source: 't' });
  for (const [label, r] of [['future reading', { ...win({}), readAt: NOW + 3600000 }], ['null percent', win({ usedPct: null })], ['no reset time', win({ resetsAt: null })]]) {
    const d = c.decide({ claude: r, codex: read(0), cfg: { unknown: { mode: 'block' } }, now: NOW });
    assert.equal(d.providers.claude.status, 'unknown', label); assert.equal(d.admissible, 0, label);
  }
  // A task launched BEFORE the reading but still running stays reserved.
  const d = c.decide({ claude: read(70), codex: read(0), spans: [{ launchedAt: NOW - 3600000, endedAt: null }], now: NOW });
  assert.equal(d.providers.claude.reserved, 1); assert.equal(d.admissible, 0);
  // Readers never turn a null percent into 0.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap3-'));
  const snap = path.join(dir, 's.json');
  fs.writeFileSync(snap, JSON.stringify({ at: new Date(NOW).toISOString(), rate_limits: { five_hour: { used_percentage: null, resets_at: 1 } } }));
  assert.equal(c.validReading(c.readClaude(snap), NOW), false, 'null percent: invalid reading, never 0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review 3: one invalid window makes the whole reading unknown; no future tolerance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap4-'));
  const snap = path.join(dir, 's.json');
  fs.writeFileSync(snap, JSON.stringify({ at: new Date(NOW - 60000).toISOString(), rate_limits: {
    five_hour: { used_percentage: 5, resets_at: Math.round(NOW / 1000 + 3600) }, seven_day: { used_percentage: null, resets_at: Math.round(NOW / 1000 + 86400) } } }));
  const r = c.readClaude(snap);
  assert.equal(c.validReading(r, NOW), false);
  const d = c.decide({ claude: r, codex: read(0), cfg: { unknown: { mode: 'block' } }, now: NOW });
  assert.equal(d.admissible, 0, 'the invalid 7-day window is not hidden by the valid 5 h one');
  assert.equal(c.validReading({ ...read(10), readAt: NOW + 60000 }, NOW), false, 'a reading dated 60 s ahead is refused');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review 3: the statusline never writes 0 for a missing percent', () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.copyFileSync(path.join(__dirname, '..', '..', 'scripts', 'statusline-usage.js'), path.join(dir, 'scripts', 's.js'));
  execFileSync(process.execPath, [path.join(dir, 'scripts', 's.js')], { input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: null, resets_at: 1 } } }) });
  const out = JSON.parse(fs.readFileSync(path.join(dir, '.ai-workspace', 'usage', 'claude-rate-limits.json'), 'utf8'));
  assert.equal(out.rate_limits.five_hour.used_percentage, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review 4: a window reset during the task discards the whole cost sample', () => {
  const before = { '5 h': { usedPct: 30, resetsAt: 1 }, '7 jours': { usedPct: 20, resetsAt: 9 } };
  assert.equal(c.taskCost(before, { '5 h': { usedPct: 40, resetsAt: 2 }, '7 jours': { usedPct: 21, resetsAt: 9 } }), null);
  assert.equal(c.taskCost(before, { '7 jours': { usedPct: 21, resetsAt: 9 } }), null, 'window missing after: discarded');
});

test('review 5: calibration needs the same windows before and after', () => {
  const r = { windows: [{ name: '5 h', usedPct: 30, resetsAt: NOW - 1 }, { name: '7 jours', usedPct: 20, resetsAt: NOW + 9e8 }], readAt: NOW - 3600000 };
  const before = c.allWindows(r);
  assert.equal(Object.keys(before).length, 2, 'an expired window is kept, not dropped');
  assert.equal(c.taskCost(before, { '7 jours': { usedPct: 21, resetsAt: NOW + 9e8 } }), null);
  assert.equal(c.taskCost({ '7 jours': { usedPct: 20, resetsAt: 9 } }, { '7 jours': { usedPct: 21, resetsAt: 9 }, '5 h': { usedPct: 40, resetsAt: 2 } }), null, 'a window appearing after: no sample');
});

test('review 6: a usage drop without a reset discards the sample', () => {
  assert.equal(c.taskCost({ '5 h': { usedPct: 80, resetsAt: 1 }, '7 jours': { usedPct: 20, resetsAt: 9 } },
    { '5 h': { usedPct: 10, resetsAt: 1 }, '7 jours': { usedPct: 21, resetsAt: 9 } }), null);
});

test('review 7: a launch at the same instant as the reading stays reserved', () => {
  const r = read(70); // 20 % usable / 15 = 1 task
  const d = c.decide({ claude: r, codex: read(0), spans: [{ launchedAt: r.readAt, endedAt: null }], now: NOW });
  assert.equal(d.providers.claude.reserved, 1); assert.equal(d.admissible, 0);
});

test('review 8: a finished task stays reserved until a reading taken after its end', () => {
  const r = read(70); // reading 1 min old; 20 % usable / 15 = 1 task
  // Task launched before the reading, ended 30 s ago (after the reading): still reserved.
  let d = c.decide({ claude: r, codex: read(0), spans: [{ launchedAt: NOW - 3600000, endedAt: NOW - 30000 }], now: NOW });
  assert.equal(d.providers.claude.reserved, 1); assert.equal(d.admissible, 0);
  // Ended long before the reading: the reading includes it, no reservation.
  d = c.decide({ claude: r, codex: read(0), spans: [{ launchedAt: NOW - 7200000, endedAt: NOW - 3600000 }], now: NOW });
  assert.equal(d.providers.claude.reserved, 0); assert.equal(d.admissible, 1);
});
