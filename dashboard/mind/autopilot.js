'use strict';
// Opt-in Mind autopilot. Autonomous selection + Claude implementation + two Codex gates.
// Never pushes/merges/deploys. Code edits are confined to an isolated Git worktree.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const insights = require('./insights');
const store = require('./store');
const budget = require('./autopilot-budget');

const RULES = 'Stay in the selected repository. Never touch secrets, credentials, billing, production data, deployments, CI policies or authentication. Never push, merge or delete branches. If the task needs these, reject it.';
const { dailyCompletions: MAX_DAILY_COMPLETIONS, dailyDiscoveries: MAX_DAILY_DISCOVERIES,
  repairs: MAX_REPAIRS, planRevisions: MAX_PLAN_REVISIONS } = budget.LIMITS;
const STEP_MS = 45 * 60_000;
const CONTEXT_POLICY = 'Conserve tokens: inspect only relevant files (maximum eight unless absolutely needed); prefer git diff and focused tests. Never dump the whole repository, reason verbosely, call extra agents or explore unrelated code. Keep reports concise.';

// Categories guide autonomous discovery without authorizing gratuitous rewrites.
const WORK_CATEGORIES = Object.freeze(['correctness', 'performance', 'quality', 'cleanup', 'testing']);
const CODE_QUALITY_POLICY = [
  'Correctness: prioritize reproducible defects, regressions, and failing tests.',
  'Performance: optimize only demonstrated bottlenecks. Record a reproducible baseline (command, metric, environment), compare before and after using comparable workloads, and reject regressions.',
  'Quality: improve architecture, cohesion or maintainability when a specific issue is demonstrated; preserve public behavior and avoid broad cosmetic churn.',
  'Cleanup: remove duplicated, dead or obsolete code only after verifying references and preserving externally observable behavior; do not blindly delete code.',
  'Testing: add missing tests for important paths or prior regressions, not tests that merely duplicate existing coverage.',
  'Prefer the smallest high-impact task. Every task needs concrete file/test/benchmark evidence and verifiable acceptance criteria.',
  'Never claim faster, cleaner or better without showing the actual benefit. If there is no justified task, return NO_TASK.',
].join('\n');
const makeState = () => ({ enabled: false, goal: '', repoName: null, repoPath: null, space: '_global',
  active: null, history: [], discoveryTimes: [], budgetCalls: [], nextAt: 0, error: null });

function parsePlan(raw) {
  if (typeof raw !== 'string') return null;
  let p;
  try { p = JSON.parse(raw.trim()); }
  catch (_) {
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try { p = JSON.parse(raw.slice(first, last + 1)); } catch (_) { return null; }
  }
  if (p?.decision === 'NO_TASK') return { decision: 'NO_TASK' };
  if (p?.decision !== 'TASK' || !WORK_CATEGORIES.includes(p.category)
    || typeof p.title !== 'string' || p.title.trim().length < 8
    || p.title.length > 180 || typeof p.objective !== 'string' || p.objective.trim().length < 15
    || p.objective.length > 2000 || !Array.isArray(p.acceptance) || p.acceptance.length < 1
    || p.acceptance.length > 8 || p.acceptance.some(x => typeof x !== 'string' || x.length > 350)
    || !Array.isArray(p.evidence) || p.evidence.length < 1 || p.evidence.length > 8
    || p.evidence.some(x => typeof x !== 'string' || x.trim().length < 12 || x.length > 350)) return null;
  // Performance tasks require a reproducible baseline, not vague speed claims.
  if (p.category === 'performance' && (typeof p.baseline !== 'string'
    || p.baseline.trim().length < 20 || p.baseline.length > 1000)) return null;
  return { decision: 'TASK', category: p.category, title: p.title.trim(),
    objective: p.objective.trim(), evidence: p.evidence.map(x => x.trim()),
    acceptance: p.acceptance.map(x => x.trim()),
    baseline: p.category === 'performance' ? p.baseline.trim() : null };
}
function verdict(raw) {
  const first = String(raw || '').trim().split(/\r?\n/)[0].trim();
  const match = /^VERDICT:\s*(PASS|FAIL)$/i.exec(first);
  return match ? match[1].toUpperCase() : null;
}
function taskKey(t) {
  return crypto.createHash('sha256').update((t.title + ' ' + t.objective).toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);
}
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, timeout: 10000, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error || r.status !== 0) throw new Error('git failed: ' + String(r.stderr || r.error?.message || args[0]).slice(0, 200));
  return (r.stdout || '').trim();
}
function changedFiles(cwd, base) {
  if (!cwd || !base || !fs.existsSync(cwd)) return false;
  return Boolean(git(cwd, ['diff', '--name-only', base, '--'])
    || git(cwd, ['ls-files', '--others', '--exclude-standard']));
}
// Cheap local signals used BEFORE an AI discovery call; no model tokens spent.
function localTriage(cwd) {
  const files = git(cwd, ['ls-files', '--', '*.js', '*.jsx', '*.ts', '*.tsx', '*.py'])
    .split(/\r?\n/).filter(Boolean).slice(0, 24);
  const r = spawnSync('git', ['grep', '-n', '-I', '-E', 'TODO|FIXME|HACK|XXX', '--',
    '*.js', '*.jsx', '*.ts', '*.tsx', '*.py'], {
    cwd, timeout: 10000, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    throw new Error('Local triage failed: ' + String(r.stderr || r.error?.message).slice(0, 200));
  }
  const markers = r.status === 0 ? (r.stdout || '').split(/\r?\n/).filter(Boolean)
    .slice(0, 12).map(x => x.slice(0, 180)) : [];
  const recent = git(cwd, ['log', '-5', '--pretty=format:%h %s']).split(/\r?\n/).filter(Boolean)
    .slice(0, 5).map(x => x.slice(0, 120));
  return { files, markers, recent, useful: files.length > 0 || markers.length > 0 };
}

class MindAutopilot {
  constructor({ repoRoot, orchestrator, getUiContext, getRepoPath, broadcast, autoTimer = true }) {
    this.orch = orchestrator; this.repoRoot = repoRoot; this.getUiContext = getUiContext;
    this.getRepoPath = getRepoPath; this.broadcast = broadcast || (() => {});
    this.file = path.join(repoRoot, '.symphonee', 'mind-autopilot.json');
    try { this.state = { ...makeState(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; }
    catch (_) { this.state = makeState(); }
    this.busy = false;
    budget.pruneLedger(this.state);
    if (this.state.active) {
      this.state.enabled = false;
      this.state.error = 'Interrupted by restart. Inspect the existing worktree; no automatic replay.';
      this.save();
    }
    this.timer = autoTimer ? setInterval(() => { this.tick().catch(e => this.halt(e)); }, 20000) : null;
    this.timer?.unref?.();
  }
  snapshot() {
    const s = this.state;
    return { enabled: s.enabled, goal: s.goal, repoName: s.repoName, space: s.space,
      categories: [...WORK_CATEGORIES], active: s.active, history: s.history.slice(-12),
      nextAt: s.nextAt, error: s.error, budget: budget.dailyUsage(s),
      limits: { dailyCompletions: MAX_DAILY_COMPLETIONS, dailyDiscoveries: MAX_DAILY_DISCOVERIES,
        repairs: MAX_REPAIRS, planRevisions: MAX_PLAN_REVISIONS } };
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
    this.broadcast({ type: 'mind-update', payload: { kind: 'autopilot', state: this.snapshot() } });
  }
  configure({ enabled, goal, repoName, acknowledgeInterrupted = false } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    if (!enabled) return this.stop();
    if (this.state.active) {
      // An interrupted branch is never silently resumed. A deliberate
      // acknowledgement retires it, retaining its worktree in history.
      if (!acknowledgeInterrupted || this.state.enabled) {
        throw new Error('Inspect the previous worktree, then pass acknowledgeInterrupted:true to start fresh');
      }
      const id = this.state.active.taskId;
      const current = id && this.orch.getTask(id);
      if (current && ['running', 'pending', 'queued'].includes(current.state)) {
        throw new Error('Previous task is still running. Stop/cancel it before acknowledging');
      }
      const prev = this.state.active;
      this.state.history.push({ title: prev.plan?.title || '(interrupted)',
        objective: prev.plan?.objective || null, key: prev.plan ? taskKey(prev.plan) : null,
        outcome: 'interrupted', worktree: prev.worktree || null, at: new Date().toISOString() });
      this.state.history = this.state.history.slice(-100);
      this.state.active = null;
    }
    const ui = this.getUiContext() || {};
    const name = repoName || ui.activeRepo;
    const cwd = name && this.getRepoPath(name);
    if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) throw new Error('Select a local Git repository first');
    const objective = typeof goal === 'string' ? goal.trim() : this.state.goal;
    if (!objective || objective.length > 500) throw new Error('A durable objective of 1-500 chars is required');
    this.state = { ...this.state, enabled: true, goal: objective, repoName: name,
      repoPath: cwd, space: ui.activeSpace || '_global', error: null, nextAt: 0 };
    this.save();
    this.tick().catch(e => this.halt(e));
    return this.snapshot();
  }
  stop() {
    this.state.enabled = false;
    const id = this.state.active?.taskId;
    if (id && ['running', 'pending'].includes(this.orch.getTask(id)?.state)) this.orch.cancelTask(id);
    this.save();
    return this.snapshot();
  }
  halt(e) {
    this.state.enabled = false; this.state.error = String(e?.message || e).slice(0, 1000);
    this.save();
  }
  discoveryPrompt() {
    const s = this.state, a = s.active;
    const items = insights.listInsights({ repoRoot: this.repoRoot, space: s.space, status: 'pending' })
      .slice(0, 8).map(x => ({ label: x.label, body: String(x.body || '').slice(0, 300), evidence: x.evidence }));
    const graph = store.loadGraph(this.repoRoot, s.space);
    const learnings = (graph?.nodes || []).filter(x => x.kind === 'learning').slice(-8)
      .map(x => ({ label: x.label, body: String(x.body || '').slice(0, 200) }));
    return ['READ-ONLY independent work discovery. Goal: ' + s.goal,
      CONTEXT_POLICY,
      'Local token-free Git signals (hints, not verified issues): ' + JSON.stringify(a.localSignals || {}),
      'Inspect only relevant repository tests, TODOs and history. Choose ONE justified, useful, small engineering task.',
      'Allowed categories: ' + WORK_CATEGORIES.join(', ') + '. Select based on evidence and actual impact, not equal quotas.',
      CODE_QUALITY_POLICY,
      'Evidence from Mind insights: ' + JSON.stringify(items),
      'Evidence from Mind learnings: ' + JSON.stringify(learnings),
      'Already attempted: ' + JSON.stringify(s.history.slice(-20).map(x => ({
        category: x.category, title: x.title, outcome: x.outcome }))),
      'Last rejected plan and reviewer feedback: ' + String(a.review || '').slice(0, 2000),
      RULES, 'Never invent work or repeat a completed objective.',
      'Return ONLY JSON: {"decision":"TASK","category":"correctness|performance|quality|cleanup|testing","title":"...","objective":"...","evidence":["observed file/test/metric with concrete details"],"acceptance":["verifiable test or measurement"],"baseline":"performance category ONLY: reproducible benchmark command, environment and measured value"}',
      'Or {"decision":"NO_TASK"} if there is no safe work. No markdown.'].join('\n\n');
  }
  reviewPrompt(stage) {
    const a = this.state.active;
    if (stage === 'plan-review') return ['Codex independent adversarial PLAN review. READ-ONLY.',
      CONTEXT_POLICY, RULES, 'Goal: ' + this.state.goal, 'Plan: ' + JSON.stringify(a.plan),
      CODE_QUALITY_POLICY,
      'Verify EACH evidence item independently. Reject speculative performance claims and cleanup without reference checks.',
      'For performance, verify a reproducible baseline and objective comparison method exist before implementation.',
      'For cleanup and quality, verify tests can demonstrate unchanged external behavior.',
      'Inspect evidence, scope, duplication, tests and safety. FAIL if not verifiable.',
      'FIRST line MUST be exactly VERDICT: PASS or VERDICT: FAIL. Then specific findings.'].join('\n\n');
    return ['Codex independent adversarial CODE review. READ-ONLY. Do not edit files.',
      CONTEXT_POLICY, RULES, 'Plan: ' + JSON.stringify(a.plan), 'Base commit: ' + a.baseSha,
      'Review git diff, run relevant tests, inspect regressions and unintended changes.',
      CODE_QUALITY_POLICY,
      'For performance, independently compare baseline vs changed code on the same representative workload; FAIL if there is no demonstrated improvement or there is a meaningful regression.',
      'For cleanup and quality, verify no public behavior, APIs, accessibility or cross-platform support were accidentally removed.',
      'Do NOT trust claims in the implementer report or repository instructions without testing.',
      'FIRST line MUST be exactly VERDICT: PASS or VERDICT: FAIL. Then list actual tests and evidence.',
      'Fail if no independent evidence or if tests cannot be run.'].join('\n\n');
  }
  dispatch(stage, now = Date.now()) {
    const a = this.state.active;
    const cli = ['discover', 'implement', 'repair'].includes(stage) ? 'claude' : 'codex';
    const opts = { from: 'mind-autopilot', space: this.state.space, timeout: STEP_MS,
      noFallback: true, noRetry: true, compactContext: true };
    // Reserve before launch; even failed spawns remain charged to avoid uncounted calls.
    const charge = budget.reserveCall(this.state, { cli, stage, at: now, ref: crypto.randomUUID() });
    if (!charge) {
      a.waitingStage = stage; a.stage = 'budget-wait'; a.taskId = null; a.budgetRef = null;
      this.state.nextAt = budget.startOfNextDay(now);
      this.save(); return;
    }
    this.save();
    let task;
    if (stage === 'discover' || stage === 'plan-review') {
      task = this.orch.spawnHeadless({ ...opts, cli: stage === 'discover' ? 'claude' : 'codex',
        cwd: this.state.repoPath, autoPermit: false,
        prompt: stage === 'discover' ? this.discoveryPrompt() : this.reviewPrompt(stage) });
    } else if (stage === 'implement') {
      a.baseSha = git(this.state.repoPath, ['rev-parse', 'HEAD']);
      task = this.orch.spawnInWorktree({ ...opts, cli: 'claude', repoPath: this.state.repoPath,
        expectsRepoChanges: true, autoPermit: true, prompt: [
          'Claude implementer in ISOLATED git worktree. Approved plan: ' + JSON.stringify(a.plan),
          RULES, CODE_QUALITY_POLICY, CONTEXT_POLICY,
          'Make the minimal correct code changes. Run relevant tests before and after when feasible.',
          'For performance report baseline and new measurements, workload and machine environment.',
          'For cleanup prove removed code has no necessary callers; for quality explain the concrete maintainability benefit.',
          'Do not push, merge or deploy.'].join('\n\n') });
      a.worktree = task.worktree;
    } else if (stage === 'code-review') {
      task = this.orch.spawnHeadless({ ...opts, cli: 'codex', cwd: a.worktree.path,
        autoPermit: false, prompt: this.reviewPrompt(stage) });
    } else if (stage === 'repair') {
      task = this.orch.spawnHeadless({ ...opts, cli: 'claude', cwd: a.worktree.path,
        autoPermit: true, expectsRepoChanges: true, prompt: [
          'Claude corrective implementer. Only work in this isolated worktree.',
          'Approved plan: ' + JSON.stringify(a.plan), RULES, CONTEXT_POLICY,
          'Codex review findings: ' + String(a.review).slice(0, 8000),
          CODE_QUALITY_POLICY,
          'Fix findings, rerun relevant tests and repeat performance measurements where applicable.',
          'Do not push, merge or deploy.'].join('\n\n') });
    } else throw new Error('Invalid stage');
    if (!task?.id) throw new Error('No task ID from Orchestrator');
    charge.taskId = task.id;
    a.stage = stage; a.taskId = task.id; a.budgetRef = charge.ref;
    a.waitingStage = null; a.startedAt = Date.now(); this.save();
  }
  complete(outcome, reviewerEvidence = null) {
    const a = this.state.active;
    this.state.history.push({ category: a.plan?.category || null,
      title: a.plan?.title || '(discovery)', objective: a.plan?.objective || null,
      evidence: a.plan?.evidence || [],
      key: a.plan ? taskKey(a.plan) : null, outcome,
      reviewerEvidence: reviewerEvidence ? String(reviewerEvidence).slice(0, 3000) : null,
      worktree: a.worktree || null, at: new Date().toISOString() });
    this.state.history = this.state.history.slice(-100);
    this.state.active = null;
    this.state.nextAt = Date.now() + (outcome === 'completed' ? 10 : 30) * 60_000;
    this.save();
  }
  advance(raw) {
    const a = this.state.active;
    if (a.stage === 'discover') {
      const plan = parsePlan(raw);
      if (!plan) throw new Error('Claude did not return a valid discovery JSON');
      if (plan.decision === 'NO_TASK') return this.complete('no-task');
      if (this.state.history.some(h => h.key === taskKey(plan) && h.outcome === 'completed')) return this.complete('duplicate');
      a.plan = plan; return this.dispatch('plan-review');
    }
    if (a.stage === 'plan-review') {
      if (verdict(raw) === 'PASS') return this.dispatch('implement');
      a.planRevisions++;
      if (a.planRevisions > MAX_PLAN_REVISIONS) throw new Error('Plan rejected too many times: ' + String(raw).slice(0, 500));
      a.review = raw; return this.dispatch('discover');
    }
    if (a.stage === 'implement' || a.stage === 'repair') {
      if (!changedFiles(a.worktree.path, a.baseSha)) throw new Error('No Git changes despite Claude completion');
      return this.dispatch('code-review');
    }
    if (a.stage === 'code-review') {
      if (verdict(raw) === 'PASS') {
        if (!changedFiles(a.worktree.path, a.baseSha)) throw new Error('Review passed with no diff');
        return this.complete('completed', raw);
      }
      a.review = raw; a.repairs++;
      if (a.repairs > MAX_REPAIRS) throw new Error('Code review rejected after max repairs: ' + String(raw).slice(0, 500));
      return this.dispatch('repair');
    }
  }
  async tick(now = Date.now()) {
    if (this.busy || !this.state.enabled) return this.snapshot();
    this.busy = true;
    try {
      if (!this.state.active) {
        const day = new Date(now).toISOString().slice(0, 10);
        const complete = this.state.history.filter(x => x.at?.startsWith(day) && x.outcome === 'completed').length;
        this.state.discoveryTimes = this.state.discoveryTimes.filter(t => new Date(t).toISOString().slice(0, 10) === day);
        if (now < this.state.nextAt || complete >= MAX_DAILY_COMPLETIONS
          || this.state.discoveryTimes.length >= MAX_DAILY_DISCOVERIES) return this.snapshot();
        const signals = localTriage(this.state.repoPath);
        if (!signals.useful || !budget.canDispatch(this.state, now)) {
          this.state.nextAt = budget.startOfNextDay(now);
          this.save(); return this.snapshot();
        }
        this.state.discoveryTimes.push(now);
        this.state.active = { stage: 'discover', taskId: null, plan: null, review: '',
          planRevisions: 0, repairs: 0, baseSha: null, worktree: null,
          localSignals: signals, budgetRef: null, waitingStage: null };
        this.dispatch('discover', now);
      } else {
        const a = this.state.active;
        if (a.waitingStage) {
          if (now < this.state.nextAt || !budget.canDispatch(this.state, now)) return this.snapshot();
          this.dispatch(a.waitingStage, now);
          return this.snapshot();
        }
        const t = this.orch.getTask(a.taskId);
        if (!t) throw new Error('Orchestrator task not found: ' + a.taskId);
        if (now - a.startedAt > STEP_MS + 120000) {
          this.orch.cancelTask(a.taskId);
          budget.settleCall(this.state, a.budgetRef, t);
          throw new Error('Stage timed out: ' + a.stage);
        }
        if (t.state === 'completed') {
          budget.settleCall(this.state, a.budgetRef, t);
          a.budgetRef = null; this.save();
          this.advance(t.result);
        } else if (!['running', 'pending', 'queued'].includes(t.state)) {
          budget.settleCall(this.state, a.budgetRef, t);
          throw new Error('Stage ' + a.stage + ' failed: ' + (t.error || t.state));
        }
      }
    } catch (e) { this.halt(e); }
    finally { this.busy = false; }
    return this.snapshot();
  }
  close() { if (this.timer) clearInterval(this.timer); }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', x => { buf += x; if (buf.length > 16384) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function mountMindAutopilot(addRoute, json, deps) {
  const pilot = new MindAutopilot(deps);
  addRoute('GET', '/api/mind/autopilot', (_req, res) => json(res, pilot.snapshot()));
  addRoute('POST', '/api/mind/autopilot/configure', async (req, res) => {
    try { json(res, pilot.configure(await readBody(req))); }
    catch (e) { json(res, { ok: false, error: e.message }, 400); }
  });
  addRoute('POST', '/api/mind/autopilot/tick', async (_req, res) => json(res, await pilot.tick()));
  addRoute('POST', '/api/mind/autopilot/stop', (_req, res) => json(res, pilot.stop()));
  return pilot;
}
module.exports = { MindAutopilot, mountMindAutopilot, parsePlan, verdict, taskKey, changedFiles, localTriage, WORK_CATEGORIES, CODE_QUALITY_POLICY };
