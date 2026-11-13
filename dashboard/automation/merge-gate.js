'use strict';
// Merge gate ("porte de fusion"): pushes, opens and merges the branches that
// Symphonee's unattended loops produce, ONLY when every rule below holds. It
// never deploys. Run by a script job (scripts/merge-gate.js); one pass per run.
//
// Rules (all must hold; any failure refuses the candidate and sends a message):
//  1. Kill switch: policy.enabled, no STOP file, gate not stopped by a failure.
//  2. The base branch's governance file carries the authorization marker
//     (merged by a human). Without it the gate goes as far as a green PR and waits.
//  3. Origin: a known loop source, an allowed branch prefix, and that loop's own
//     proof (PleinSens: final review DECISION: GARDER committed + decision node;
//     autopilot: completed task, Codex review VERDICT: PASS, local checks passed).
//  4. Paths: nothing matching the forbidden list; a source with an allow-list
//     may touch only those paths. No binary file. No deleted test.
//  5. Size: code lines/files (tests, docs, data excluded) under the source limit.
//  6. No secret in added lines; the diff does not weaken verification (diffLint).
//  7. Merges cleanly into the CURRENT base, and the repository's full check chain
//     passes on that merge result, run here by the gate (never trusted from a report).
//  8. GitHub CI on the exact pushed commit: at least one check, all completed,
//     none failing. Absence or pending is never success.
//  9. Pace: at most maxMergesPerDay per repo, minHoursBetweenMerges apart, and the
//     previous automatic merge must be confirmed green on the base first.
// 10. Just before merging: the PR head is still the verified commit and the base
//     has not moved since the chain ran (else everything is re-evaluated).
// After a merge the base CI is watched; red -> the gate stops itself, opens a
// revert PR (never merged automatically) and sends an error message.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TEST_FILE = /(\.test|\.spec|_test)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)(__tests__|tests?)\//;
const NON_CODE = /\.(md|txt|jsonl|csv|sha256|log)$|(^|\/)docs\/|(^|\/)evidence\//;
const SECRET_LINE = [
  [/sntry[su]_[A-Za-z0-9_=+/-]{10,}/, 'jeton Sentry'], [/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, 'jeton GitHub'],
  [/sk_(live|test)_[A-Za-z0-9]{10,}|rk_live_[A-Za-z0-9]{10,}/, 'cle Stripe'], [/sk-[A-Za-z0-9_-]{20,}/, 'cle API'],
  [/AKIA[0-9A-Z]{16}/, 'cle AWS'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'cle privee'],
  [/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, 'JWT (cle Supabase ?)'],
  [/service_role/i, 'service_role'], [/xox[abpr]-[A-Za-z0-9-]{10,}/, 'jeton Slack'],
];
const MARK = 'FUSION_AUTOMATIQUE_ENCADREE_V1';

const re = (list) => (list || []).map((p) => new RegExp(p, 'i'));
const anyMatch = (list, s) => list.some((r) => r.test(s));

// ── Pure rules ──────────────────────────────────────────────────────────
// numstat: [{ path, added, deleted, binary }], status: [{ path, code }] ('A','M','D','R..')
function evaluateDiff({ numstat, status, addedLines }, repo, source) {
  const reasons = [];
  const forbidden = re([...(repo.forbidden || []), ...(source.forbidden || [])]), allowed = source.allowed ? re(source.allowed) : null;
  const files = numstat.map((f) => f.path);
  if (!files.length) reasons.push('aucun changement par rapport a la base');
  const hitForbidden = files.filter((f) => anyMatch(forbidden, f));
  if (hitForbidden.length) reasons.push('chemins interdits touches : ' + hitForbidden.slice(0, 8).join(', '));
  if (allowed) {
    const outside = files.filter((f) => !anyMatch(allowed, f));
    if (outside.length) reasons.push('chemins hors du perimetre de la source ' + source.type + ' : ' + outside.slice(0, 8).join(', '));
  }
  const binaries = numstat.filter((f) => f.binary).map((f) => f.path);
  if (binaries.length) reasons.push('fichiers binaires : ' + binaries.slice(0, 5).join(', '));
  const deletedTests = status.filter((s) => s.code === 'D' && TEST_FILE.test(s.path)).map((s) => s.path);
  if (deletedTests.length) reasons.push('tests supprimes : ' + deletedTests.slice(0, 5).join(', '));
  const code = numstat.filter((f) => !TEST_FILE.test(f.path) && !NON_CODE.test(f.path));
  const codeLines = code.reduce((n, f) => n + (f.added || 0) + (f.deleted || 0), 0);
  if (codeLines > source.maxCodeLines) reasons.push('trop gros : ' + codeLines + ' lignes de code (max ' + source.maxCodeLines + ')');
  if (code.length > source.maxCodeFiles) reasons.push('trop de fichiers de code : ' + code.length + ' (max ' + source.maxCodeFiles + ')');
  const secrets = [];
  for (const { file, line } of addedLines) for (const [r, why] of SECRET_LINE) if (r.test(line)) secrets.push(why + ' dans ' + file);
  if (secrets.length) reasons.push('secret probable : ' + [...new Set(secrets)].slice(0, 5).join(', '));
  return { ok: reasons.length === 0, reasons, stats: { files: files.length, codeFiles: code.length, codeLines } };
}

// GitHub checks of one commit -> 'success' | 'pending' | 'failure'
function checksVerdict(checks) {
  if (!Array.isArray(checks) || !checks.length) return 'pending';
  if (checks.some((c) => c.status === 'completed' && !['success', 'neutral', 'skipped'].includes(c.conclusion))) return 'failure';
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  return checks.some((c) => c.conclusion === 'success') ? 'success' : 'pending';
}

// windows: [{ start:'HH:MM', end:'HH:MM' }] local time (may cross midnight); absent = always.
function inAnyWindow(windows, now) {
  if (!Array.isArray(windows) || !windows.length) return true;
  const d = new Date(now), m = d.getHours() * 60 + d.getMinutes();
  const min = (s) => { const x = /^(\d{2}):(\d{2})$/.exec(String(s)); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  return windows.some((w) => { const a = min(w.start), b = min(w.end); if (a === null || b === null) return false; return a < b ? m >= a && m < b : m >= a || m < b; });
}

function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
// Pace rule (9). merges: [{ repo, at, status }]
function paceAllows(merges, repo, now) {
  const mine = merges.filter((m) => m.repo === repo.name);
  if (mine.some((m) => m.status === 'merged')) return { ok: false, reason: 'la fusion precedente n est pas encore confirmee par la CI de ' + repo.base };
  if (mine.filter((m) => dayKey(m.at) === dayKey(now)).length >= repo.maxMergesPerDay) return { ok: false, reason: 'plafond de ' + repo.maxMergesPerDay + ' fusions par jour atteint' };
  const last = mine.reduce((t, m) => Math.max(t, m.at), 0);
  if (last && now - last < repo.minHoursBetweenMerges * 3600000) return { ok: false, reason: 'moins de ' + repo.minHoursBetweenMerges + ' h depuis la derniere fusion' };
  return { ok: true };
}

function parseNumstat(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split('\t');
    // Renames: "src/{old => new}/b.ts" -> "src/new/b.ts", "old.ts => new.ts" -> "new.ts".
    const file = p.join('\t').replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/^.* => /, '').replace(/\/{2,}/g, '/');
    return { path: file, added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d), binary: a === '-' };
  });
}
function parseNameStatus(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean).map((l) => { const p = l.split('\t'); return { code: p[0][0], path: p[p.length - 1] }; });
}
function parseAddedLines(diff) {
  const out = []; let file = '';
  for (const l of String(diff || '').split(/\r?\n/)) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) out.push({ file, line: l.slice(1) });
  }
  return out;
}

// ── Candidate discovery ─────────────────────────────────────────────────
async function discover(repo, io) {
  const found = [];
  for (const source of repo.sources) {
    try {
      if (source.type === 'pleinsens-loop') found.push(...await discoverLoop(repo, source, io));
      else if (source.type === 'autopilot') found.push(...discoverAutopilot(repo, source, io));
    } catch (e) { io.log('decouverte ' + source.type + ' impossible : ' + e.message); }
  }
  return found;
}
async function discoverLoop(repo, source, io) {
  const list = await io.api('GET', '/api/graph-runs');
  const out = [];
  for (const r of (Array.isArray(list) ? list : list.runs || [])) {
    if (!String(r.name || '').startsWith(source.runPrefix) || r.status !== 'completed') continue;
    const run = await io.api('GET', '/api/graph-runs/' + r.id);
    const n = Number((run.state || {}).cycle);
    const node = (id) => run.nodes.find((x) => x.id === 'c' + n + '-' + id) || {};
    const res = (id) => String(((node(id).output) || {}).result || '');
    const m = res('consigner-garde').match(/CYCLE_CONSIGNE\s+decision=GARDE\s+commit=([0-9a-f]{7,40})/);
    if (node('consigner-garde').status !== 'completed' || !m) continue;
    const branch = String((run.state || {}).branche || '');
    if (!branch.startsWith(source.branchPrefix)) continue;
    let sha;
    try { sha = io.git(repo.path, ['rev-parse', '--verify', m[1] + '^{commit}']); } catch (_) { continue; }
    out.push({ repo: repo.name, source: source.type, branch, sha, origin: { run: run.id, cycle: n },
      proof: { decision: /DECISION:\s*GARDER/.test(res('revue-finale')) && /MESURES_PRETES[^\n]*proposition=GARDER/.test(res('implementation')),
        reviewFile: 'docs/agent-governance/evidence/pleinsens-boucle-c' + n + '/revue-finale-claude.md' } });
  }
  return out;
}
function discoverAutopilot(repo, source, io) {
  const st = io.readPilot(source.pilot);
  const out = [];
  for (const h of (st && st.history) || []) {
    if (h.outcome !== 'completed' || !h.worktree || !h.worktree.branch) continue;
    if (!h.worktree.branch.startsWith(source.branchPrefix)) continue;
    let sha;
    try { sha = io.git(repo.path, ['rev-parse', '--verify', h.worktree.branch + '^{commit}']); } catch (_) { continue; }
    out.push({ repo: repo.name, source: source.type, branch: h.worktree.branch, sha, origin: { pilot: source.pilot, title: h.title, at: h.at },
      proof: { review: /^\s*VERDICT:\s*PASS\b/.test(String(h.reviewerEvidence || '')), verified: Array.isArray(h.verified) && h.verified.length > 0, verifiedList: h.verified || [] } });
  }
  return out;
}

// Rule 3: the loop's own proof.
function proofReasons(c, repo, io) {
  const r = [];
  if (c.source === 'pleinsens-loop') {
    if (!c.proof.decision) r.push('la decision du cycle n est pas GARDER (revue finale + proposition)');
    let review = '';
    try { review = io.git(repo.path, ['show', c.sha + ':' + c.proof.reviewFile]); } catch (_) {}
    if (!/DECISION:\s*GARDER/.test(review)) r.push('revue finale Claude absente du commit ou sans DECISION: GARDER (' + c.proof.reviewFile + ')');
    if (/NO-GO/.test(review.split(/\r?\n/).slice(-5).join('\n'))) r.push('la revue finale se termine par NO-GO');
  } else if (c.source === 'autopilot') {
    if (!c.proof.review) r.push('pas de revue Codex VERDICT: PASS');
    if (!c.proof.verified) r.push('verifications locales de l autopilote absentes');
  } else r.push('source inconnue');
  return r;
}

// ── One pass of the state machine ───────────────────────────────────────
// io: { git, api, runChain, notify, log, readPilot, now, stopFile }
async function pass(policy, state, io) {
  state.candidates = state.candidates || {};
  state.merges = state.merges || [];
  const now = io.now();
  const stopped = !policy.enabled || io.stopFileExists() || !!state.stopped;
  // The full chain (CPU heavy) only runs inside policy.chainWindows, so it never
  // competes with a loop's own work (e.g. the PleinSens CPU benchmark). Light
  // steps (PR, CI reading, merge) run at any time.
  let heavyDone = !inAnyWindow(policy.chainWindows, now);

  for (const repo of policy.repos) {
    try { io.git(repo.path, ['fetch', '--quiet', 'origin', repo.base]); } catch (e) { io.log('fetch impossible pour ' + repo.name + ' : ' + e.message); continue; }
    const baseSha = io.git(repo.path, ['rev-parse', 'origin/' + repo.base]);

    // Post-merge watch runs even when stopped.
    for (const m of state.merges.filter((x) => x.repo === repo.name && x.status === 'merged')) await watchMerge(m, repo, state, io);
    if (stopped) continue;

    for (const c of await discover(repo, io)) {
      const key = c.repo + '|' + c.branch + '|' + c.sha;
      if (!state.candidates[key] && io.isAncestor(repo.path, c.sha, baseSha)) continue; // already in the base (merged by hand)
      if (!state.candidates[key]) {
        state.candidates[key] = { ...c, key, status: 'new', attempts: 0, createdAt: now, history: [] };
        io.log('nouvelle candidate ' + key);
      }
    }
    const mine = Object.values(state.candidates).filter((c) => c.repo === repo.name && !['refused', 'merged', 'confirmed'].includes(c.status))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const c of mine) {
      if (c.status === 'new' && heavyDone) continue; // one chain per pass
      if (c.status === 'new') heavyDone = true;
      // A transient error (network, GitHub, Symphonee API) leaves the candidate
      // where it was: retried at the next pass, the other candidates go on.
      try { await step(c, repo, baseSha, state, io); }
      catch (e) {
        const msg = String(e && e.message || e).slice(0, 300);
        io.log(c.key + ' : erreur pendant ' + c.status + ', nouvel essai au prochain passage : ' + msg);
        if (c.lastError !== msg) io.notify('warning', 'Porte de fusion : erreur transitoire sur ' + c.branch + ' (' + c.status + '), nouvel essai dans 30 min : ' + msg,
          ['porte-fusion', 'transitoire', c.key]);
        c.lastError = msg;
      }
    }
  }
  return state;
}

function setStatus(c, status, note, io) {
  c.status = status; c.updatedAt = io.now();
  c.history = [...(c.history || []), { at: io.now(), status, note: String(note || '').slice(0, 500) }].slice(-20);
  io.log(c.key + ' -> ' + status + (note ? ' : ' + note : ''));
}
async function refuse(c, repo, reasons, io) {
  setStatus(c, 'refused', reasons.join(' ; '), io);
  if (c.pr) await io.api('POST', '/api/github/pulls/comment', { repo: repo.github, number: c.pr,
    body: 'Porte de fusion automatique : **fusion refusee**.\n\n- ' + reasons.join('\n- ') + '\n\nLa PR reste ouverte pour une decision humaine.' }).catch(() => {});
  io.notify('warning', 'Fusion refusee (' + repo.name + ', ' + c.branch + ') : ' + reasons.join(' ; ').slice(0, 400),
    ['porte-fusion', 'refus', c.key], { pr: c.prUrl || null, raisons: reasons });
}

async function step(c, repo, baseSha, state, io) {
  const source = repo.sources.find((s) => s.type === c.source);
  if (c.status === 'new') {
    const reasons = proofReasons(c, repo, io);
    if (!c.branch.startsWith(source.branchPrefix)) reasons.push('prefixe de branche non autorise');
    const mergeBase = io.git(repo.path, ['merge-base', baseSha, c.sha]);
    const diffArgs = [mergeBase, c.sha];
    const ev = evaluateDiff({
      numstat: parseNumstat(io.git(repo.path, ['diff', '--numstat', ...diffArgs])),
      status: parseNameStatus(io.git(repo.path, ['diff', '--name-status', ...diffArgs])),
      addedLines: parseAddedLines(io.git(repo.path, ['diff', '--unified=0', ...diffArgs])),
    }, repo, source);
    reasons.push(...ev.reasons);
    c.stats = ev.stats;
    if (reasons.length) return refuse(c, repo, reasons, io);
    io.log(c.key + ' : chaine complete sur la fusion avec ' + repo.base + ' ' + baseSha.slice(0, 8));
    const chain = await io.runChain(repo, baseSha, c.sha);
    c.chain = (chain.results || []).map((r) => ({ name: r.name, ok: r.ok, code: r.code, s: Math.round((r.ms || 0) / 1000), preexisting: r.preexisting }));
    if (chain.conflict) return refuse(c, repo, ['conflit de fusion avec ' + repo.base], io);
    if (chain.lint && chain.lint.length) return refuse(c, repo, ['le diff affaiblit la verification : ' + chain.lint.slice(0, 5).join('; ')], io);
    if (!chain.ok) {
      const f = (chain.results || []).find((r) => !r.ok) || { name: '?' };
      return refuse(c, repo, ['chaine de verification en echec : ' + f.name + (f.timedOut ? ' (delai)' : ' (code ' + f.code + ')')
        + (f.preexisting === true ? ' -- echoue AUSSI sur ' + repo.base + ' (preexistant)' : f.preexisting === false ? ' -- introduit par la branche' : '')], io);
    }
    c.evaluatedBase = baseSha;
    setStatus(c, 'ready', 'regles 3-7 vertes, chaine ' + c.chain.length + '/' + c.chain.length, io);
  }
  if (c.status === 'ready') {
    // Re-verified after the base moved: the PR already exists, its CI is checked again.
    if (c.pr) setStatus(c, 'pr-open', 're-verifiee sur ' + repo.base + ' ' + baseSha.slice(0, 8), io);
    else {
      try { io.git(repo.path, ['push', 'origin', c.sha + ':refs/heads/' + c.branch]); }
      catch (e) { return refuse(c, repo, ['push refuse : ' + String(e.message).split('\n')[0]], io); }
      // GitHub may not see a just-pushed branch yet (422 "head invalid"): retry.
      let pr = null, lastErr = null;
      for (let i = 0; i < 4 && !pr; i++) {
        try { pr = await io.api('POST', '/api/github/pulls/create', { repo: repo.github, head: c.branch, base: repo.base,
          title: prTitle(c), body: prBody(c, repo) }); }
        catch (e) { lastErr = e; await (io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(5000 * (i + 1)); }
      }
      if (!pr) throw lastErr;
      if (!pr || !pr.number) return refuse(c, repo, ['creation de la PR impossible : ' + JSON.stringify(pr).slice(0, 200)], io);
      c.pr = pr.number; c.prUrl = pr.url;
      setStatus(c, 'pr-open', 'PR #' + pr.number, io);
      io.notify('info', 'PR ouverte automatiquement (' + repo.name + ') : #' + pr.number + ' ' + prTitle(c), ['porte-fusion', 'pr', c.key], { pr: pr.url });
      return;
    }
  }
  if (c.status === 'pr-open') {
    const ck = await io.api('GET', '/api/github/pulls/checks?repo=' + encodeURIComponent(repo.github) + '&number=' + c.pr);
    if (ck.sha && ck.sha !== c.sha) return refuse(c, repo, ['la PR a change depuis la verification (tete ' + String(ck.sha).slice(0, 8) + ')'], io);
    const v = checksVerdict(ck.checks);
    if (v === 'failure') return refuse(c, repo, ['CI GitHub en echec : ' + ck.checks.filter((x) => x.status === 'completed' && !['success', 'neutral', 'skipped'].includes(x.conclusion)).map((x) => x.name).join(', ')], io);
    if (v === 'pending') {
      if (io.now() - c.updatedAt > 12 * 3600000) return refuse(c, repo, ['CI GitHub sans resultat apres 12 h'], io);
      return;
    }
    setStatus(c, 'ci-green', 'CI GitHub verte', io);
  }
  if (c.status === 'ci-green' || c.status === 'waiting-governance' || c.status === 'waiting-pace') {
    let gov = '';
    try { gov = io.git(repo.path, ['show', 'origin/' + repo.base + ':' + repo.governanceMarker.file]); } catch (_) {}
    if (!gov.includes(repo.governanceMarker.text)) {
      if (c.status !== 'waiting-governance') {
        setStatus(c, 'waiting-governance', 'marqueur ' + repo.governanceMarker.text + ' absent de ' + repo.governanceMarker.file + ' sur ' + repo.base, io);
        io.notify('warning', 'PR #' + c.pr + ' prete mais la fusion automatique n est pas encore autorisee sur ' + repo.name
          + ' : fusionner d abord la PR de gouvernance (marqueur ' + repo.governanceMarker.text + ')', ['porte-fusion', 'gouvernance', repo.name], { pr: c.prUrl });
      }
      return;
    }
    const pace = paceAllows(state.merges, repo, io.now());
    if (!pace.ok) { if (c.status !== 'waiting-pace') setStatus(c, 'waiting-pace', pace.reason, io); return; }
    if (baseSha !== c.evaluatedBase) {
      c.attempts = (c.attempts || 0) + 1;
      if (c.attempts > 3) return refuse(c, repo, [repo.base + ' a bouge trois fois pendant la verification'], io);
      return setStatus(c, 'new', repo.base + ' a bouge (' + baseSha.slice(0, 8) + ') : nouvelle verification complete', io);
    }
    const ck = await io.api('GET', '/api/github/pulls/checks?repo=' + encodeURIComponent(repo.github) + '&number=' + c.pr);
    if (ck.sha !== c.sha) return refuse(c, repo, ['la tete de la PR n est plus le commit verifie'], io);
    if (checksVerdict(ck.checks) !== 'success') return setStatus(c, 'pr-open', 'CI a revoir avant fusion', io);
    const r = await io.api('POST', '/api/github/pulls/merge', { repo: repo.github, number: c.pr, method: 'merge',
      title: 'Fusion automatique encadree : ' + prTitle(c) + ' (#' + c.pr + ')',
      message: 'Porte de fusion ' + MARK + '. Commit verifie ' + c.sha + ' sur ' + repo.base + ' ' + baseSha + '.' });
    if (!r || !r.merged) return refuse(c, repo, ['GitHub a refuse la fusion : ' + String((r && (r.message || r.error)) || '').slice(0, 200)], io);
    c.mergeSha = r.sha;
    setStatus(c, 'merged', 'fusionnee : ' + r.sha, io);
    state.merges.push({ repo: repo.name, key: c.key, at: io.now(), sha: r.sha, pr: c.pr, prUrl: c.prUrl, verified: c.sha, status: 'merged' });
    io.notify('info', 'Fusion automatique faite (' + repo.name + ') : PR #' + c.pr + ' ' + prTitle(c) + '. Annulation : git revert -m 1 ' + r.sha,
      ['porte-fusion', 'fusion', c.key], { pr: c.prUrl, commit: r.sha, regles: 'toutes vertes', chaine: c.chain });
  }
}

async function watchMerge(m, repo, state, io) {
  let parent2 = '';
  try { parent2 = io.git(repo.path, ['rev-parse', m.sha + '^2']); } catch (_) {}
  if (parent2 && parent2 !== m.verified) return stopGate(state, m, repo, 'le commit fusionne (' + parent2.slice(0, 8) + ') n est pas le commit verifie (' + m.verified.slice(0, 8) + ')', io);
  const ck = await io.api('GET', '/api/github/pulls/checks?repo=' + encodeURIComponent(repo.github) + '&sha=' + m.sha);
  const v = checksVerdict(ck.checks);
  if (v === 'success') {
    m.status = 'confirmed'; m.confirmedAt = io.now();
    const c = state.candidates[m.key]; if (c) setStatus(c, 'confirmed', 'CI verte sur ' + repo.base, io);
    io.notify('info', 'Fusion confirmee : CI verte sur ' + repo.base + ' (' + repo.name + ', PR #' + m.pr + ')', ['porte-fusion', 'confirmee', m.key], { commit: m.sha });
  } else if (v === 'failure') {
    await stopGate(state, m, repo, 'CI rouge sur ' + repo.base + ' apres la fusion de la PR #' + m.pr, io);
  } else if (io.now() - m.at > 24 * 3600000 && !m.slowWarned) {
    m.slowWarned = true;
    io.notify('warning', 'CI de ' + repo.base + ' toujours sans resultat 24 h apres la fusion de la PR #' + m.pr, ['porte-fusion', 'lente', m.key]);
  }
}
async function stopGate(state, m, repo, why, io) {
  m.status = 'failed-after-merge';
  state.stopped = { at: io.now(), reason: why };
  let revert = null;
  try { revert = await io.openRevert(repo, m); } catch (e) { io.log('PR d annulation impossible : ' + e.message); }
  io.notify('error', 'PORTE DE FUSION ARRETEE (' + repo.name + ') : ' + why + '. Plus aucune fusion automatique. '
    + (revert ? 'PR d annulation ouverte (non fusionnee) : ' + revert : 'Annulation manuelle : git revert -m 1 ' + m.sha),
    ['porte-fusion', 'arret', m.key], { commit: m.sha, pr: m.prUrl });
}

function prTitle(c) {
  return c.source === 'pleinsens-loop' ? 'PleinSens boucle : cycle ' + c.origin.cycle + ' (GARDE)'
    : 'Autopilote ' + c.origin.pilot + ' : ' + String(c.origin.title || c.branch).slice(0, 90);
}
function prBody(c, repo) {
  const lines = [
    'PR ouverte par la **porte de fusion automatique encadree** de Symphonee (' + MARK + ').',
    '', '- Source : ' + c.source + (c.origin.run ? ' (graph run ' + c.origin.run + ', cycle ' + c.origin.cycle + ')' : ' (pilote ' + c.origin.pilot + ')'),
    '- Commit verifie : `' + c.sha + '` sur `' + repo.base + '` `' + c.evaluatedBase + '`',
    '- Taille : ' + c.stats.codeLines + ' lignes de code dans ' + c.stats.codeFiles + ' fichiers (' + c.stats.files + ' fichiers au total)',
    '- Preuve de la boucle : ' + (c.source === 'pleinsens-loop' ? 'revue finale Claude DECISION: GARDER (' + c.proof.reviewFile + ')' : 'revue Codex VERDICT: PASS ; verifications ' + c.proof.verifiedList.join(', ')),
    '- Chaine executee par la porte sur le resultat de la fusion : ' + c.chain.map((r) => r.name + ' ' + (r.ok ? 'OK' : 'ECHEC') + ' (' + r.s + ' s)').join(', '),
    '', 'Fusion seulement si la CI GitHub est verte sur ce commit et si toutes les regles tiennent encore juste avant. Aucun deploiement.',
    'Annulation apres fusion : `git revert -m 1 <commit de fusion>`.',
  ];
  return lines.join('\n');
}

module.exports = { pass, discover, step, inAnyWindow, evaluateDiff, checksVerdict, paceAllows, parseNumstat, parseNameStatus, parseAddedLines, proofReasons, MARK };
