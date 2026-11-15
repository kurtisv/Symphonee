'use strict';
// MANUAL experimental run on a throwaway FICTIONAL project. Not part of the
// automatic suite. It drives the EXISTING autopilot stages (implement,
// code-review, repair): Qwen3 4B in the confined Docker worker as developer,
// the host's independent restricted verifier, Codex CLI (ChatGPT login) as the
// tool-free reviewer through spawnHeadless, then the isolated Mind fixture
// space. No real repository, no merge, no apply. Real projects stay locked.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');

const CHECKOUT = path.resolve(__dirname, '..', '..');
// The fictional task comes from the shared list (QWEN_FIXTURE_TASK, default average):
// the same requirements and hidden cases as the model evaluation.
const { TASKS } = require('./qwen-fixture-tasks');
const TASK = TASKS.find(t => t.id === (process.env.QWEN_FIXTURE_TASK || 'average'));
if (!TASK) throw Error('Unknown QWEN_FIXTURE_TASK');
const NAME = TASK.fn + '.js';
const ORIGINAL = `function ${TASK.fn}(${TASK.params}){return null}\nmodule.exports={${TASK.fn}};\n`;
const TEST = '// protected placeholder: the host verifies independently\n';
const CASES = TASK.cases.map(x => ({ file: NAME, export: x.fn, args: x.args, expected: x.expected }));
const fmtCase = x => x.fn + '(' + JSON.stringify(x.args).slice(1, -1) + ') -> ' + JSON.stringify(x.expected);
const REQUIREMENTS = TASK.req + ' Examples: ' + TASK.show.map(fmtCase).join('; ') + '.';
const REVIEWER_MODEL = 'gpt-6.1-sol';
const DEVELOPER_MODEL = process.env.QWEN_FIXTURE_MODEL || 'qwen3-4b-instruct-2507';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Arms of the teaching demonstration (all optional): teacher on/off, Mind on/off, a persistent Mind space,
// an isolated lessons directory, and a label for the report.
const TEACHER = process.env.QWEN_FIXTURE_TEACHER === '1', USE_MIND = process.env.QWEN_FIXTURE_USE_MIND === '1', TAG = String(process.env.QWEN_FIXTURE_TAG || '').slice(0, 60);
const LESSONS_ROOT = process.env.QWEN_FIXTURE_LESSONS_ROOT ? path.resolve(process.env.QWEN_FIXTURE_LESSONS_ROOT) : path.join(CHECKOUT, '.ai-workspace', 'qwen-fixture-lessons');
const MIND_SPACE = /^fixture_[a-f0-9]{16}$/.test(process.env.QWEN_FIXTURE_MIND_SPACE || '') ? process.env.QWEN_FIXTURE_MIND_SPACE : 'fixture_' + crypto.randomBytes(8).toString('hex');
// Working set of the local model server (what the model really costs in RAM).
const llamaRamMB = () => { try { return Math.round(Number(cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | Measure-Object WorkingSetSize -Sum).Sum"], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim() || 0) / 1e6); } catch { return null; } };
const list = (args) => { try { return cp.execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 20000 }).split(/\r?\n/).filter(x => /^sym-qwen-/.test(x)); } catch { return null; } };
const codexPids = () => { try { return [].concat(JSON.parse(cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name like 'codex%'\" | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true, timeout: 30000 }) || '[]')); } catch { return null; } };

function makeFixture(temp) {
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const template = path.join(temp, 'empty-template'); fs.mkdirSync(template);
  const git = (...a) => cp.execFileSync('git', ['-C', root, '-c', 'core.hooksPath=' + path.join(temp, 'no-hooks'), ...a], { env, windowsHide: true, stdio: 'pipe', timeout: 10000 }).toString();
  git('init', '-q', '--template', template); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, NAME), ORIGINAL, { flag: 'wx' }); fs.writeFileSync(path.join(root, 'test.js'), TEST, { flag: 'wx' });
  git('add', NAME, 'test.js'); git('commit', '-qm', 'fictional fixture');
  return { root, git };
}

// Stress check of the final code against a host reference, in an offline container (used by the loop before a lesson is promoted, and by the report).
function wideCheckOf(code) {
  const argsList = TASK.stress.args();
    const run = cp.spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--memory', '256m', '--pids-limit', '32', '--pull', 'never', '--entrypoint', 'node',
      'ghcr.io/qwenlm/qwen-code:0.27.3', '-e', "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const {code,fn,list}=JSON.parse(d);const vm=require('vm');const m={exports:{}};vm.runInNewContext(code,{module:m,exports:m.exports},{timeout:3000});console.log(JSON.stringify(list.map(a=>{try{const v=vm.runInNewContext('f(...a)',{f:m.exports[fn],a},{timeout:1000});return v===undefined?'undefined':v}catch(e){return 'throws'}})))})"],
      { input: JSON.stringify({ code, fn: TASK.fn, list: argsList }), encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    let got = null; try { got = JSON.parse(String(run.stdout).trim().split('\n').pop()); } catch (_) {}
    const close = (w, g) => JSON.stringify(w) === JSON.stringify(g) || (TASK.stress.tolerance && typeof w === 'number' && typeof g === 'number' && Math.abs(w - g) <= TASK.stress.tolerance * Math.max(1, Math.abs(w)));
    const wrong = got ? argsList.map((a, i) => ({ a, want: TASK.stress.ref(a), got: got[i] })).filter(x => !close(x.want, x.got)) : null;
    return { note: 'offline container, host reference', inputs: argsList.length, mismatches: wrong ? wrong.length : 'container run failed', firstMismatches: wrong ? wrong.slice(0, 3) : null };
}

async function main() {
  const runId = crypto.randomBytes(16).toString('hex');
  const before = { containers: list(['ps', '-a', '--format', '{{.Names}}']), networks: list(['network', 'ls', '--format', '{{.Name}}']), codex: codexPids() };
  if (!before.containers || before.containers.length || !before.networks || before.networks.length) throw Error('Docker state unclear or leftover sym-qwen resources before start');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-autopilot-'));
  const historyDir = path.join(CHECKOUT, '.ai-workspace', 'qwen-fixture-history'); fs.mkdirSync(historyDir, { recursive: true });
  const historyFile = path.join(historyDir, 'autopilot-' + runId + '.json');
  const report = { runId, scope: 'fictional-fixture', task: TASK.id, developer: DEVELOPER_MODEL + ' (LM Studio)', reviewer: 'codex ' + REVIEWER_MODEL + ' (tool-free, ChatGPT login)', startedAt: new Date().toISOString() };
  try {
    const { root, git } = makeFixture(temp);
    const baseHead = git('rev-parse', 'HEAD').trim();
    const { Orchestrator } = require('../orchestrator');
    const workspace = path.join(temp, 'orchestrator'); fs.mkdirSync(workspace);
    const orch = new Orchestrator({ terminals: new Map(), broadcast: () => {}, workspaceDir: workspace, getConfig: () => ({ AiApiKeys: {}, Permissions: { mode: 'edit' } }) });
    orch._pretrust = () => {};
    const { MindAutopilot } = require('../mind/autopilot');
    const sup = require('./qwen-supervision');
    const stateRoot = path.join(temp, 'pilot'); fs.mkdirSync(stateRoot);
    const { makeFixtureController } = require('../mind/qwen-learning-fixture');
    const queue = path.join(CHECKOUT, '.ai-workspace', 'qwen-mind-isolated', MIND_SPACE, 'queue');
    const mind = makeFixtureController({ repoRoot: CHECKOUT, space: MIND_SPACE, queueDir: queue });
    const ramSamples = [llamaRamMB()];
    const pilot = new MindAutopilot({ repoRoot: stateRoot, orchestrator: orch, getUiContext: () => ({}), getRepoPath: () => null, autoTimer: false, id: 'qwen-fixture',
      def: { limits: { repairs: 5 }, stepMinutes: 15 },
      qwenFixture: { capability: sup.QWEN_DEVELOPER_FIXTURE, root, files: [NAME, 'test.js'], editable: [NAME], assertions: CASES, requirements: REQUIREMENTS, reviewerModel: REVIEWER_MODEL, developerModel: DEVELOPER_MODEL,
        // Persistent across runs: this is where the developer's verified lessons accumulate.
        name: TASK.id + '-subset3', lessonsRoot: LESSONS_ROOT, family: TASK.id, teacher: { enabled: TEACHER }, ...(TASK.stress ? { wideCheck: (code) => wideCheckOf(code) } : {}), ...(USE_MIND ? { mind } : {}) } });
    pilot.startFixtureTask({ title: 'Fictional ' + TASK.fn + ' function', objective: `Implement ${TASK.fn}(${TASK.params}) in ${NAME} so that it meets the requirements.` });
    // A killed parent skips cleanup (observed 2026-11-15): keep the run inside its caller's limit.
    const deadline = Date.now() + Math.min(80, Math.max(3, Number(process.env.QWEN_FIXTURE_DEADLINE_MIN) || 80)) * 60000; let lastEvent = 0, tickNo = 0; const startedMs = Date.now();
    while (pilot.state.active && pilot.state.enabled && Date.now() < deadline) {
      await sleep(3000); await pilot.tick(); if (++tickNo % 4 === 0) ramSamples.push(llamaRamMB());
      for (const e of pilot.state.events.slice(lastEvent)) process.stderr.write(`[${e.at}] ${e.kind}: ${e.msg}\n`);
      lastEvent = pilot.state.events.length;
      fs.writeFileSync(historyFile, JSON.stringify({ ...report, live: pilot.state.active }, null, 2));
    }
    if (pilot.state.active && pilot.state.enabled) {
      Object.assign(report, { outcome: 'deadline', attempts: pilot.state.active.attempts || [], events: pilot.state.events });
      const running = pilot.state.active.taskId;
      pilot.stop();
      // Let the cancelled worker finish its own Docker cleanup before verifying it.
      for (let i = 0; i < 40 && ['running', 'pending'].includes(orch.getTask(running)?.state || '') ; i++) await sleep(1000);
      for (let i = 0; i < 30 && (list(['ps', '-a', '--format', '{{.Names}}']) || ['?']).length; i++) await sleep(1000);
      throw Error('Overall deadline reached');
    }
    try { report.lessons = require('../mind/lessons').top(path.join(CHECKOUT, '.ai-workspace', 'qwen-fixture-lessons'), pilot.fixtureLessonScope(), 10)
      .map(x => ({ kind: x.kind, text: x.text, action: x.action || null, confidence: x.confidence, count: x.count, confirmations: x.confirmations || 0 })); } catch (_) {}
    const outcome = pilot.state.history.at(-1) || null;
    Object.assign(report, { outcome: outcome ? outcome.outcome : 'halted', error: pilot.state.error, teachingLog: outcome ? outcome.teachingLog || [] : (pilot.state.active?.teachingLog || []), attempts: outcome ? outcome.attempts : (pilot.state.active?.attempts || []), events: pilot.state.events, budget: pilot.state.budgetCalls || null });

    // Final independent assertions on the approved diff, recomputed now.
    const approved = report.attempts.filter(a => a.review && a.review.decision === 'GO').at(-1);
    if (report.outcome === 'fixture-approved' && approved) {
      report.finalAssertions = await sup.assessReconstructedFixture(root, [NAME, 'test.js'], [NAME], approved.diff, CASES);
      // Independent wide check (informational, not part of the loop): the approved
      // source against a host reference on many more inputs, in an offline container.
      if (TASK.stress) {
        const { reconstructProposal } = require('./qwen-git-snapshot');
        const code = Buffer.from(reconstructProposal(root, [NAME, 'test.js'], approved.diff, [NAME]).files.find(f => f.path === NAME).content, 'base64').toString('utf8');
        report.wideCheck = wideCheckOf(code);
      }
    }
    // Measured, not estimated.
    ramSamples.push(llamaRamMB());
    const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    report.metrics = { tag: TAG, task: TASK.id, arms: { teacher: TEACHER, mind: USE_MIND, mindSpace: USE_MIND ? MIND_SPACE : null },
      outcome: report.outcome, approved: report.outcome === 'fixture-approved', attempts: report.attempts.length, seconds: Math.round((Date.now() - startedMs) / 100) / 10,
      qwenTokens: sum(report.attempts.map(x => x.qwenUsage && x.qwenUsage.total_tokens)), codexReviews: report.attempts.filter(x => x.review).length,
      codexTokens: sum(report.attempts.map(x => x.review && x.review.usage && x.review.usage.totalTokens)), claudeTeacherCalls: outcome ? outcome.teachings || 0 : 0, claudeTokens: outcome ? outcome.teacherTokens || 0 : 0,
      peakLlamaRamMB: Math.max(...ramSamples.filter(Number.isFinite), 0), freeRamMBEnd: Math.round(os.freemem() / 1e6),
      methodsShown: outcome && outcome.shownMethods ? outcome.shownMethods.map(m => ({ key: m.key, source: m.source, reviewTaskId: m.provenance && m.provenance.reviewTaskId })) : [] };
    try { report.lessonStates = require('../mind/lessons').all(LESSONS_ROOT).filter(x => x.scope === pilot.fixtureLessonScope()).map(x => ({ key: x.key, status: require('../mind/lessons').statusOf(x), errorClass: x.errorClass || null })); } catch (_) {}
    try { report.mindLessons = mind.listLessons().map(x => ({ id: x.id, status: x.status, errorClass: x.errorClass, family: x.family, evidence: x.validation && x.validation.evidenceCount, reviewTaskId: x.validation && x.validation.reviewTaskId })); } catch (_) {}
    // The fictional source repository is unchanged.
    report.sourceUnchanged = git('rev-parse', 'HEAD').trim() === baseHead && fs.readFileSync(path.join(root, NAME), 'utf8') === ORIGINAL && git('status', '--porcelain').trim() === '';

    // Mind: one observation per attempt, at the proof level that attempt actually reached.
    const space = MIND_SPACE;
    const ids = [];
    for (const a of report.attempts) {
      const r = a.review;
      const base = { runId, attempt: a.attempt, problem: 'Fictional ' + TASK.fn + ' function (Qwen developer, independent checks, Codex review)', proposal: String(a.diff || '').slice(0, 12000),
        errors: (a.technical?.errors || (a.developerError ? [a.developerError] : [])).slice(0, 20).map(x => String(x).slice(0, 1000)),
        correction: r ? (r.corrections || []).join(' | ').slice(0, 2000) : String(a.developerError || '').slice(0, 2000),
        assertions: CASES, tokens: Number.isInteger(a.qwenUsage?.total_tokens) ? a.qwenUsage.total_tokens : null };
      if (r) ids.push(mind.enqueue({ ...base, supervisor: 'codex-fixture', verdict: r.decision === 'GO' ? 'pass' : 'fail',
        reviewEvidence: { cleanup: r.reviewer.cleanup, diffHash: r.diffHash, items: r.reviewer.items, promptInputHash: r.reviewer.promptInputHash, tools: r.reviewer.tools, version: r.reviewer.version } }));
      else ids.push(mind.enqueue({ ...base, supervisor: 'checks', verdict: 'fail' }));
    }
    mind.drain();
    // Retrieval from a fresh process, by run and proof level.
    const probe = `const {makeFixtureController}=require(${JSON.stringify(path.join(CHECKOUT, 'dashboard', 'mind', 'qwen-learning-fixture.js'))});const c=makeFixtureController({repoRoot:process.argv[1],space:process.argv[2],queueDir:process.argv[3]});const out={};for(const l of ['real-codex-review-fictional-fixture','independent-checks-only','simulated-review'])out[l]=c.findRun(process.argv[4],l).map(r=>({attempt:r.attempt,verdict:r.verdict,proofLevel:r.proofLevel}));out.verifiedLessons=c.verifiedLessons().length;process.stdout.write(JSON.stringify(out));`;
    report.mind = { space, ids, recalledInFreshProcess: JSON.parse(cp.execFileSync(process.execPath, ['-e', probe, CHECKOUT, space, queue, runId], { encoding: 'utf8', windowsHide: true, timeout: 20000 })) };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    const after = { containers: list(['ps', '-a', '--format', '{{.Names}}']), networks: list(['network', 'ls', '--format', '{{.Name}}']), codex: codexPids() };
    report.cleanup = { tempRemoved: !fs.existsSync(temp), dockerLeftovers: after.containers && after.networks ? [...after.containers, ...after.networks] : 'unverified',
      newCodexProcesses: before.codex && after.codex ? after.codex.filter(p => !before.codex.includes(p)) : 'unverified' };
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(historyFile, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ historyFile, outcome: report.outcome, error: report.error, cleanup: report.cleanup, mind: report.mind, sourceUnchanged: report.sourceUnchanged }, null, 2) + '\n');
  }
}
main().catch(e => { process.stderr.write(String(e.stack || e) + '\n'); process.exitCode = 1; });
