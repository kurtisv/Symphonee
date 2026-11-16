'use strict';
// MANUAL, reproducible demonstration of teacher-assisted learning on FICTIONAL
// tasks. Real calls: Qwen3.5-4B (local LM Studio), the independent checker,
// Claude as teacher, Codex as tool-free reviewer. Nothing real is touched.
//
//   node qwen-teaching-demo.manual.js run <demoId> <step>     run one step (resumable)
//   node qwen-teaching-demo.manual.js all <demoId>            run every step in order, then print the comparison
//   node qwen-teaching-demo.manual.js summary <demoId>        print the comparison
//
// Steps (each is one fresh process of qwen-autopilot-fixture.manual.js):
//   A      average, no teacher, no Mind      -> baseline, no teaching
//   B1..B3 average, Claude teaches, Mind on  -> repeated until a lesson is validated (max 3)
//   C0a,C0b meanAbs (analogous, never taught), no Mind    -> without memory
//   C1a,C1b meanAbs, Mind of step B, new lessons directory -> with memory (new session)
//   C3a    meanAbs, Claude teaches, no Mind  -> teacher alone;  C2a  meanAbs, Claude teaches, Mind of step B -> teacher + memory
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');

const CHECKOUT = path.resolve(__dirname, '..', '..');
const HARNESS = path.join(__dirname, 'qwen-autopilot-fixture.manual.js');
const MODEL = 'qwen/qwen3.5-4b';
const dirOf = (id) => path.join(CHECKOUT, '.ai-workspace', 'qwen-teaching-demo', id);
const load = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'state.json'), 'utf8')); } catch { return { id, space: 'fixture_' + crypto.randomBytes(8).toString('hex'), runs: {} }; } };
const save = (st) => { fs.mkdirSync(dirOf(st.id), { recursive: true }); fs.writeFileSync(path.join(dirOf(st.id), 'state.json'), JSON.stringify(st, null, 2)); };
// Validated IN THAT RUN (its own lessons directory), not merely present in a shared Mind space.
const isValidated = (r) => (r.lessonStates || []).some(x => x.status === 'validated');
const STEPS = {
  A: { task: 'average', teacher: 0, mind: 0 }, B1: { task: 'average', teacher: 1, mind: 1 }, B2: { task: 'average', teacher: 1, mind: 1 }, B3: { task: 'average', teacher: 1, mind: 1 },
  C0a: { task: 'meanabs', teacher: 0, mind: 0 }, C0b: { task: 'meanabs', teacher: 0, mind: 0 }, C1a: { task: 'meanabs', teacher: 0, mind: 1 }, C1b: { task: 'meanabs', teacher: 0, mind: 1 },
  // teacher + memory vs teacher alone on the same unseen task: does memory reduce the dependence on Claude? (C2 writes its own lesson into Mind: run it last, once)
  C3a: { task: 'meanabs', teacher: 1, mind: 0 }, C2a: { task: 'meanabs', teacher: 1, mind: 1 },
  C3b: { task: 'meanabs', teacher: 1, mind: 0 }, C2b: { task: 'meanabs', teacher: 1, mind: 1 }, // rerun of C3a/C2a, which were cut by a Claude usage limit
};

function runStep(id, name) {
  const def = STEPS[name]; if (!def) throw Error('Unknown step ' + name);
  const st = load(id);
  if (st.runs[name]) { process.stdout.write(JSON.stringify({ step: name, skipped: 'already done', metrics: st.runs[name].metrics }) + '\n'); return; }
  if (name.startsWith('B') && Object.values(st.runs).some(r => r.step.startsWith('B') && isValidated(r))) { process.stdout.write(JSON.stringify({ step: name, skipped: 'a lesson was already validated' }) + '\n'); return; }
  if (/^C[12]/.test(name) && !Object.values(st.runs).some(r => r.step.startsWith('B') && isValidated(r))) { process.stdout.write(JSON.stringify({ step: name, skipped: 'no validated lesson in Mind to reuse' }) + '\n'); return; }
  const lessons = path.join(dirOf(id), 'lessons-' + (name.startsWith('B') ? 'B' : name));
  const env = { ...process.env, QWEN_FIXTURE_MODEL: MODEL, QWEN_FIXTURE_TASK: def.task, QWEN_FIXTURE_TEACHER: String(def.teacher), QWEN_FIXTURE_USE_MIND: String(def.mind),
    QWEN_FIXTURE_MIND_SPACE: st.space, QWEN_FIXTURE_LESSONS_ROOT: lessons, QWEN_FIXTURE_TAG: id + ':' + name, QWEN_FIXTURE_DEADLINE_MIN: '25' };
  const r = cp.spawnSync(process.execPath, [HARNESS], { env, encoding: 'utf8', windowsHide: true, timeout: 32 * 60000, maxBuffer: 32 * 1024 * 1024 });
  let out; try { out = JSON.parse(r.stdout); } catch { throw Error('Harness gave no report: ' + String(r.stderr).slice(-400)); }
  const rep = JSON.parse(fs.readFileSync(out.historyFile, 'utf8'));
  const validated = (rep.lessonStates || []).some(x => x.status === 'validated');
  st.runs[name] = { step: name, at: new Date().toISOString(), historyFile: path.relative(CHECKOUT, out.historyFile), metrics: rep.metrics, cleanup: rep.cleanup, sourceUnchanged: rep.sourceUnchanged,
    lessonStates: rep.lessonStates, mindLessons: rep.mindLessons, wideCheck: rep.wideCheck || null, validatedLesson: validated, invalid: (rep.teachingLog || []).some(x => x.state !== 'completed') ? 'the teacher was unavailable during the run (' + String((rep.teachingLog.find(x => x.state !== 'completed') || {}).error || '').slice(0, 60) + ')' : null, finalAssertions: rep.finalAssertions ? { passed: rep.finalAssertions.passed, executed: rep.finalAssertions.executed, expected: rep.finalAssertions.expected } : null };
  save(st);
  process.stdout.write(JSON.stringify({ step: name, metrics: rep.metrics, validatedLesson: validated, cleanup: rep.cleanup, sourceUnchanged: rep.sourceUnchanged }, null, 2) + '\n');
}

function summary(id) {
  const st = load(id), rows = Object.values(st.runs).sort((a, b) => a.step.localeCompare(b.step));
  const line = (r) => { const m = r.metrics; return `${r.step.padEnd(4)} ${m.task.padEnd(8)} teacher=${m.arms.teacher ? 'yes' : 'no '} mind=${m.arms.mind ? 'yes' : 'no '} ${m.outcome.padEnd(15)} attempts=${String(m.attempts).padEnd(2)} ${String(m.seconds).padStart(6)}s  qwen=${String(m.qwenTokens).padStart(6)}tok  codex=${m.codexReviews}x/${m.codexTokens}tok  claude=${m.claudeTeacherCalls}x/${m.claudeTokens}tok  peakRAM=${m.peakLlamaRamMB}MB  methodsShown=${m.methodsShown.length}`; };
  rows.forEach(r => process.stdout.write(line(r) + (r.invalid ? '  [INVALID: ' + r.invalid + ']' : '') + '\n'));
  const rate = (names) => { const rs = rows.filter(r => !r.invalid && names.some(n => r.step.startsWith(n))); return rs.length ? { runs: rs.length, approved: rs.filter(r => r.metrics.approved).length, meanAttempts: Math.round(rs.reduce((a, r) => a + r.metrics.attempts, 0) / rs.length * 10) / 10, meanSeconds: Math.round(rs.reduce((a, r) => a + r.metrics.seconds, 0) / rs.length) } : null; };
  const comparison = { id, space: st.space, A_noTeaching: rate(['A']), B_withClaude: rate(['B']), C0_meanAbs_noMemory: rate(['C0']), C1_meanAbs_withMind: rate(['C1']), C3_meanAbs_teacherOnly: rate(['C3']), C2_meanAbs_teacherPlusMemory: rate(['C2']),
    validatedRuns: rows.filter(isValidated).map(r => r.step), invalidRuns: rows.filter(r => r.invalid).map(r => r.step + ': ' + r.invalid), claudeTokensTotal: rows.reduce((a, r) => a + r.metrics.claudeTokens, 0), codexTokensTotal: rows.reduce((a, r) => a + r.metrics.codexTokens, 0), peakRamMB: Math.max(0, ...rows.map(r => r.metrics.peakLlamaRamMB)) };
  process.stdout.write(JSON.stringify(comparison, null, 2) + '\n');
}

const [cmd, id, step] = process.argv.slice(2);
if (!/^[a-z0-9-]{3,40}$/.test(id || '')) { process.stderr.write('usage: run|summary <demoId> [step]\n'); process.exit(2); }
if (cmd === 'run') runStep(id, step); else if (cmd === 'all') { for (const s of Object.keys(STEPS)) runStep(id, s); summary(id); } else if (cmd === 'summary') summary(id); else { process.stderr.write('usage: run|summary <demoId> [step]\n'); process.exit(2); }
