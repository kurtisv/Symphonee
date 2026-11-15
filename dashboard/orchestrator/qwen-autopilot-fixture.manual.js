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
    const pilot = new MindAutopilot({ repoRoot: stateRoot, orchestrator: orch, getUiContext: () => ({}), getRepoPath: () => null, autoTimer: false, id: 'qwen-fixture',
      def: { limits: { repairs: 5 }, stepMinutes: 15 },
      qwenFixture: { capability: sup.QWEN_DEVELOPER_FIXTURE, root, files: [NAME, 'test.js'], editable: [NAME], assertions: CASES, requirements: REQUIREMENTS, reviewerModel: REVIEWER_MODEL, developerModel: DEVELOPER_MODEL,
        // Persistent across runs: this is where the developer's verified lessons accumulate.
        name: TASK.id + '-subset3', lessonsRoot: path.join(CHECKOUT, '.ai-workspace', 'qwen-fixture-lessons') } });
    pilot.startFixtureTask({ title: 'Fictional ' + TASK.fn + ' function', objective: `Implement ${TASK.fn}(${TASK.params}) in ${NAME} so that it meets the requirements.` });
    // A killed parent skips cleanup (observed 2026-11-15): keep the run inside its caller's limit.
    const deadline = Date.now() + Math.min(80, Math.max(3, Number(process.env.QWEN_FIXTURE_DEADLINE_MIN) || 80)) * 60000; let lastEvent = 0;
    while (pilot.state.active && pilot.state.enabled && Date.now() < deadline) {
      await sleep(3000); await pilot.tick();
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
    Object.assign(report, { outcome: outcome ? outcome.outcome : 'halted', error: pilot.state.error, attempts: outcome ? outcome.attempts : (pilot.state.active?.attempts || []), events: pilot.state.events, budget: pilot.state.budgetCalls || null });

    // Final independent assertions on the approved diff, recomputed now.
    const approved = report.attempts.filter(a => a.review && a.review.decision === 'GO').at(-1);
    if (report.outcome === 'fixture-approved' && approved) {
      report.finalAssertions = await sup.assessReconstructedFixture(root, [NAME, 'test.js'], [NAME], approved.diff, CASES);
      // Independent wide check (informational, not part of the loop): the approved
      // source against a host reference on many more inputs, in an offline container.
      if (TASK.stress) {
        const { reconstructProposal } = require('./qwen-git-snapshot');
        const code = Buffer.from(reconstructProposal(root, [NAME, 'test.js'], approved.diff, [NAME]).files.find(f => f.path === NAME).content, 'base64').toString('utf8');
        const argsList = TASK.stress.args();
        const run = cp.spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--memory', '256m', '--pids-limit', '32', '--pull', 'never', '--entrypoint', 'node',
          'ghcr.io/qwenlm/qwen-code:0.27.3', '-e', "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const {code,fn,list}=JSON.parse(d);const vm=require('vm');const m={exports:{}};vm.runInNewContext(code,{module:m,exports:m.exports},{timeout:3000});console.log(JSON.stringify(list.map(a=>{try{const v=vm.runInNewContext('f(...a)',{f:m.exports[fn],a},{timeout:1000});return v===undefined?'undefined':v}catch(e){return 'throws'}})))})"],
          { input: JSON.stringify({ code, fn: TASK.fn, list: argsList }), encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        let got = null; try { got = JSON.parse(String(run.stdout).trim().split('\n').pop()); } catch (_) {}
        const wrong = got ? argsList.map((a, i) => ({ a, want: TASK.stress.ref(a), got: got[i] })).filter(x => JSON.stringify(x.want) !== JSON.stringify(x.got)) : null;
        report.wideCheck = { note: 'informational, offline container, host reference', inputs: argsList.length, mismatches: wrong ? wrong.length : 'container run failed', firstMismatches: wrong ? wrong.slice(0, 3) : null };
      }
    }
    // The fictional source repository is unchanged.
    report.sourceUnchanged = git('rev-parse', 'HEAD').trim() === baseHead && fs.readFileSync(path.join(root, NAME), 'utf8') === ORIGINAL && git('status', '--porcelain').trim() === '';

    // Mind: one observation per attempt, at the proof level that attempt actually reached.
    const { makeFixtureController } = require('../mind/qwen-learning-fixture');
    const space = 'fixture_' + crypto.randomBytes(8).toString('hex');
    const queue = path.join(CHECKOUT, '.ai-workspace', 'qwen-mind-isolated', space, 'queue');
    const mind = makeFixtureController({ repoRoot: CHECKOUT, space, queueDir: queue });
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
