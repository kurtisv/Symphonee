// mind-ui :: autopilot module. Visual control surface for the Mind autopilot
// (dashboard/mind/autopilot.js): status, Activer / Arreter, goal + repository,
// current stage, daily limits, per-provider budget, history, worktrees, events.
// Every button calls a real /api/mind/autopilot/* route; nothing is decorative.
// Build: node scripts/build-renderer.js
import { $, state } from './core.js';
import { escapeHtml } from './helpers.js';
import { makeLatest } from './latest.js';

  const STATUS = {
    disabled:    { label: 'Desactive',  color: 'var(--subtext0)', hint: 'Le pilote ne lance rien.' },
    active:      { label: 'Actif',      color: 'var(--green)',    hint: 'Pret : la prochaine verification peut lancer une decouverte.' },
    running:     { label: 'En cours',   color: 'var(--accent)',   hint: 'Une etape est en cours d\'execution.' },
    waiting:     { label: 'En attente', color: 'var(--yellow)',   hint: 'Pause entre deux taches avant la prochaine verification.' },
    quota:       { label: 'Quota atteint', color: 'var(--yellow)', hint: 'Limite quotidienne atteinte : reprise le jour suivant (heure locale).' },
    error:       { label: 'Erreur',     color: 'var(--red)',      hint: 'Le pilote s\'est arrete sur une erreur.' },
    interrupted: { label: 'Interrompu', color: 'var(--red)',      hint: 'Une tache a ete interrompue : inspectez son worktree puis archivez-la avant de relancer.' },
  };
  const STAGE_LABELS = { discover: 'Decouverte', 'plan-review': 'Revue du plan', implement: 'Implementation',
    verify: 'Verification locale', 'code-review': 'Revue Codex', repair: 'Reparation', done: 'Termine', 'budget-wait': 'En attente de quota' };
  const OUTCOME_LABELS = { completed: 'Reussie', 'no-task': 'Aucune tache justifiee', duplicate: 'Doublon ignore',
    interrupted: 'Interrompue', 'plan-rejected': 'Plan refuse' };
  const CATEGORY_LABELS = { correctness: 'Correction', performance: 'Performance', quality: 'Structure',
    cleanup: 'Nettoyage', testing: 'Tests' };

  const ap = { snap: null, busy: false, message: '', poll: null, draftGoal: null, draftRepo: null, draftConsent: false, pilot: 'default',
    // A non-autopilot loop shown in detail (pleinsens | porte-fusion | veille), else null.
    loopView: null, loopDetail: null,
    // Plain-language summary ("En clair") of the loop on screen: { loop, items }.
    clair: null };
  try { ap.pilot = localStorage.getItem('mind-autopilot-pilot') || 'default'; } catch (_) {}
  const esc = (v) => escapeHtml(v == null ? '' : String(v));
  const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('fr-CA') : '0');
  const when = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return t ? new Date(t).toLocaleString('fr-CA') : '-'; };

  async function call(pathname, body) {
    // Every call names its pilot: POST in the body, GET in the query string.
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, pilot: ap.pilot }) };
    const r = await fetch(body === undefined ? pathname + '?pilot=' + encodeURIComponent(ap.pilot) : pathname, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      const err = new Error(data.error || ('HTTP ' + r.status));
      err.state = data.state; throw err;
    }
    return data;
  }

  async function load() {
    // Overview of every unattended loop (autopilots, PleinSens loop, merge gate, watchdog).
    fetch('/api/automation/loops', { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.loops) { ap.loops = d; paint(); } }).catch(() => {});
    if (ap.loopView) loadLoopDetail();
    loadClair();
    try { ap.snap = await call('/api/mind/autopilot'); ap.pilots = ap.snap.pilots || ap.pilots; ap.message = ap.message || ''; }
    catch (e) {
      // A remembered pilot that no longer exists falls back to the main loop.
      if (ap.pilot !== 'default') { ap.pilot = 'default'; return load(); }
      ap.message = 'Lecture impossible : ' + e.message;
    }
    paint();
  }

  const detailRequests = makeLatest();
  const clairRequests = makeLatest();
  // The loop whose plain summary belongs on screen: the shown loop, else the pilot.
  const clairLoop = () => ap.loopView ? (ap.loopView === 'pleinsens' ? 'pleinsens' : null) : ap.pilot;
  function loadClair() {
    const loop = clairLoop();
    const current = clairRequests.start();
    if (!loop) { ap.clair = null; return Promise.resolve(); }
    return fetch('/api/automation/loops/summary?loop=' + encodeURIComponent(loop), { cache: 'no-store' })
      .then(r => r.json()).then(d => { if (current()) { ap.clair = d && d.items ? { loop, items: d.items } : null; paint(); } })
      .catch(() => {});
  }
  function loadLoopDetail() {
    const id = ap.loopView;
    const current = detailRequests.start(); // an older answer never paints over a newer request
    return fetch('/api/automation/loops/detail?id=' + encodeURIComponent(id), { cache: 'no-store' })
      .then(r => r.json()).then(d => { if (current()) { ap.loopDetail = d; paint(); } })
      .catch(e => { if (current()) { ap.loopDetail = { error: e.message }; paint(); } });
  }

  async function act(label, fn) {
    if (ap.busy) return;
    ap.busy = true; ap.message = label + '...'; paint();
    try { ap.snap = await fn(); if (ap.snap.pilots) ap.pilots = ap.snap.pilots; ap.message = label + ' : fait.'; }
    catch (e) { if (e.state) ap.snap = e.state; ap.message = label + ' : ' + e.message; }
    finally { ap.busy = false; paint(); }
  }

  const MindAutopilot = {
    enable() {
      const goal = ($('apGoal') || {}).value || '';
      const repoName = ($('apRepo') || {}).value || '';
      const consent = !!($('apConsent') || {}).checked;
      const body = { enabled: true, goal, repoName };
      if (consent) body.allowWorktreeWrites = true;
      return act('Activation', () => call('/api/mind/autopilot/configure', body));
    },
    stop() { return act('Arret', () => call('/api/mind/autopilot/stop', {})); },
    tick() { return act('Verification', () => call('/api/mind/autopilot/tick', {})); },
    acknowledge() { return act('Archivage', () => call('/api/mind/autopilot/acknowledge', {})); },
    resume() { return act('Reprise', () => call('/api/mind/autopilot/resume', {})); },
    refresh() { return load(); },
    showLoop(id) {
      if (ap.busy) return;
      ap.loopView = id; ap.loopDetail = null; ap.message = ''; ap.clair = null;
      paint(); loadClair(); return loadLoopDetail();
    },
    async retryNode(runId, nodeId, taskId) {
      if (ap.busy) return;
      ap.busy = true; ap.message = 'Reprise de l etape ' + nodeId + '...'; paint();
      try {
        const r = await fetch('/api/graph-runs/' + encodeURIComponent(runId) + '/retry/' + encodeURIComponent(nodeId), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(taskId ? { taskId } : {}) });
        const d = await r.json().catch(() => ({}));
        ap.message = r.ok && !d.error
          ? 'Etape ' + nodeId + ' reprise' + (taskId ? ' (tache ' + taskId + ' adoptee : si elle a fini, rien n est relance)' : '') + '.'
          : 'Reprise refusee : ' + (d.error || 'HTTP ' + r.status);
      } catch (e) { ap.message = 'Reprise impossible : ' + e.message; }
      ap.busy = false; return loadLoopDetail();
    },
    select(id) {
      if (ap.busy) return;
      if (ap.loopView) { detailRequests.invalidate(); ap.loopView = null; ap.loopDetail = null; ap.clair = null; if (id === ap.pilot) { paint(); loadClair(); return; } }
      if (id === ap.pilot) return;
      ap.pilot = id; ap.snap = null; ap.message = ''; ap.clair = null; ap.draftGoal = null; ap.draftRepo = null; ap.draftConsent = false;
      try { localStorage.setItem('mind-autopilot-pilot', id); } catch (_) {}
      paint(); return load();
    },
    remember() {
      ap.draftGoal = ($('apGoal') || {}).value;
      ap.draftRepo = ($('apRepo') || {}).value;
      ap.draftConsent = !!($('apConsent') || {}).checked;
    },
    onUpdate(snapshot) {
      if (!snapshot) return;
      // Live updates of another loop only refresh its chip in the selector.
      if ((snapshot.pilot || 'default') !== ap.pilot) {
        const row = (ap.pilots || []).find(p => p.pilot === snapshot.pilot);
        if (row) { row.status = snapshot.status; row.today = snapshot.today; if (state.view === 'autopilot') paint(); }
        return;
      }
      ap.snap = snapshot;
      if (state.view === 'autopilot') paint();
    },
  };
  window.MindAutopilot = MindAutopilot;

  function pipeline(s) {
    const a = s.active;
    const order = s.pipeline || ['discover', 'plan-review', 'implement', 'code-review', 'repair', 'done'];
    const current = a ? (a.waitingStage || a.stage) : (s.history[0] && s.history[0].outcome === 'completed' ? 'done' : null);
    const idx = order.indexOf(current);
    return '<div class="ap-pipe">' + order.map((st, i) => {
      const cls = st === current ? 'ap-step ap-now' : (idx > i && current !== 'done' ? 'ap-step ap-past' : (current === 'done' ? 'ap-step ap-past' : 'ap-step'));
      return '<span class="' + cls + '">' + esc(STAGE_LABELS[st]) + '</span>';
    }).join('<span class="ap-arrow">></span>') + '</div>';
  }

  const LOOP_COLOR = { working: 'var(--accent)', resting: 'var(--yellow)', stopped: 'var(--subtext0)', error: 'var(--red)' };
  function overview() {
    const d = ap.loops; if (!d) return '';
    const row = (l, svc) => {
      // Every row opens its detail: an autopilot below, the other loops in their own view.
      const click = l.pilot ? ' style="cursor:pointer;" data-pilot="' + esc(l.pilot) + '" onclick="MindAutopilot.select(this.dataset.pilot)" title="Voir le detail"'
        : LOOP_DETAIL.includes(l.id) ? ' style="cursor:pointer;" data-loop="' + esc(l.id) + '" onclick="MindAutopilot.showLoop(this.dataset.loop)" title="Voir le detail"' : '';
      const shown = ap.loopView ? l.id === ap.loopView : (l.pilot && l.pilot === ap.pilot);
      return '<tr' + click + '><td><span class="ap-dot" style="background:' + (LOOP_COLOR[l.status] || 'var(--subtext0)') + ';margin-right:6px;"></span><b>' + esc(l.label) + '</b>' + (shown ? ' <span class="ap-tag">affichee</span>' : '') + '</td>' +
        '<td>' + esc(l.window) + '</td><td><b>' + esc(l.statusLabel) + '</b></td><td>' + esc(l.detail) + '</td></tr>';
    };
    return '<div class="ap-card"><div class="ap-title">Les boucles automatiques</div>' +
      '<table class="ap-table"><thead><tr><th>Boucle</th><th>Plage</th><th>Etat</th><th>Maintenant</th></tr></thead><tbody>' +
      d.loops.map(l => row(l)).join('') + '</tbody></table>' +
      '<div class="ap-title" style="margin-top:12px;">Services</div><table class="ap-table"><tbody>' + (d.services || []).map(l => row(l, true)).join('') + '</tbody></table>' +
      '<div class="ap-note">Mis a jour ' + esc(when(d.now)) + '. Une boucle au repos attend sa plage horaire : c est normal. Cliquez sur une ligne pour voir ce qu elle a fait.</div></div>';
  }

  const LOOP_DETAIL = ['pleinsens', 'porte-fusion', 'veille'];
  const NODE_COLOR = { completed: 'var(--green)', running: 'var(--accent)', failed: 'var(--red)', awaiting_approval: 'var(--yellow)', pending: 'var(--subtext0)', cancelled: 'var(--subtext0)' };
  const NODE_LABEL = { completed: 'terminee', running: 'en cours', failed: 'en echec', awaiting_approval: 'attend une approbation', pending: 'a venir', cancelled: 'annulee', paused: 'en pause' };
  const RUN_LABEL = { pending: 'en attente', running: 'en cours', completed: 'termine', failed: 'en echec', cancelled: 'annule', paused: 'en pause', awaiting_approval: 'attend une approbation' };
  const hm = (t) => t ? new Date(t).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' }) : '';
  const dur = (a, b) => { if (!a) return ''; const m = Math.round(((b || Date.now()) - a) / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
  const logBlock = (lines) => '<pre style="white-space:pre-wrap;font-size:11px;max-height:260px;overflow:auto;margin:0;">' + esc((lines || []).join('\n') || '(vide)') + '</pre>';

  // Plain-language card: the state is computed by the server from facts; only
  // the two sentences are written by a model, and the card says so.
  const CLAIR_STATE = {
    termine: { label: 'Termine', color: 'var(--green)' },
    'a-integrer': { label: 'Fait, pas encore dans l application', color: 'var(--yellow)' },
    'en-cours': { label: 'En cours', color: 'var(--accent)' },
    abandonne: { label: 'Abandonne', color: 'var(--subtext0)' },
    arrete: { label: 'Arrete', color: 'var(--red)' },
  };
  function clairHtml() {
    const c = ap.clair;
    if (!c || c.loop !== clairLoop()) return '';
    const items = (c.items || []).map(it => {
      const st = CLAIR_STATE[it.state] || CLAIR_STATE.arrete;
      return '<div style="border-top:1px solid var(--surface1);padding:10px 0;">'
        + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><span class="ap-tag" style="background:' + st.color + ';color:var(--base);">' + esc(st.label) + '</span>'
        + '<b>' + esc(it.titre || it.rawTitle) + '</b><span class="ap-muted">' + esc(when(it.at)) + '</span></div>'
        // The computed state comes first; the written sentences are labelled as
        // the report's account and never as the state.
        + '<div style="margin-top:6px;"><b>Est-ce termine ?</b> ' + esc(it.stateText) + '</div>'
        + (it.fait ? '<div style="margin-top:6px;"><b>Ce qui a ete fait, selon le rapport :</b> ' + esc(it.fait) + '</div>'
          + '<div style="margin-top:4px;"><b>Ce que ca ameliore :</b> ' + esc(it.ameliore) + '</div>'
          : '<div class="ap-muted" style="margin-top:6px;">' + esc(it.redaction) + '</div>')
        + (it.fait ? '<div class="ap-muted" style="margin-top:4px;font-size:11px;">' + esc(it.redaction) + '</div>' : '')
        + '</div>';
    }).join('');
    return '<div class="ap-card"><div class="ap-title">En clair : ce qui a ete fait</div>'
      + (items || '<div class="ap-muted">Rien a resumer pour l instant.</div>') + '</div>';
  }

  function loopDetailHtml() {
    const d = ap.loopDetail; const id = ap.loopView;
    const back = '<button class="tab-bar-btn" data-pilot="' + esc(ap.pilot) + '" onclick="MindAutopilot.select(this.dataset.pilot)">Retour aux autopilotes</button> '
      + '<button class="tab-bar-btn" data-loop="' + esc(id) + '" onclick="MindAutopilot.showLoop(this.dataset.loop)">Actualiser</button>';
    const head = (t) => '<div class="ap-card"><div class="ap-btns" style="align-items:center;justify-content:space-between;"><div class="ap-big">' + esc(t) + '</div><div>' + back + '</div></div>'
      + (ap.message ? '<div class="ap-msg" style="margin-top:6px;">' + esc(ap.message) + '</div>' : '') + '</div>';
    if (!d) return head('Chargement...');
    if (d.error) return head('Detail indisponible') + '<div class="ap-card ap-err">' + esc(d.error) + '</div>';
    if (id === 'pleinsens') {
      const runs = (d.runs || []).map((r, i) => {
        const rows = r.nodes.map(n => {
          const canRetry = n.status === 'failed' && ['running', 'pending', 'failed', 'paused'].includes(r.status);
          const adopt = canRetry && n.taskId && !/^worker (failed|cancelled|timeout) on /.test(String(n.error || '')) ? n.taskId : '';
          return '<tr><td><span class="ap-dot" style="background:' + (NODE_COLOR[n.status] || 'var(--subtext0)') + ';margin-right:6px;"></span><b>' + esc(n.id) + '</b></td>'
            + '<td>' + esc(NODE_LABEL[n.status] || n.status) + '</td>'
            + '<td>' + esc(n.cli ? n.cli + (n.model ? ' ' + n.model : '') : (n.type === 'branch' ? 'decision (sans IA)' : '')) + '</td>'
            + '<td>' + esc(hm(n.startedAt)) + (n.startedAt ? ' (' + esc(dur(n.startedAt, n.endedAt)) + ')' : '') + '</td>'
            + '<td style="max-width:520px;">' + (n.error ? '<div class="ap-err">' + esc(n.error) + '</div>' : '')
            + (n.result ? '<details><summary>Resultat</summary><pre style="white-space:pre-wrap;font-size:11px;margin:4px 0;">' + esc(n.result) + '</pre></details>' : '')
            + (canRetry ? '<button class="tab-bar-btn" style="margin-top:4px;" data-run="' + esc(r.id) + '" data-node="' + esc(n.id) + '" data-task="' + esc(adopt) + '"'
              + ' onclick="MindAutopilot.retryNode(this.dataset.run, this.dataset.node, this.dataset.task)" title="'
              + (adopt ? 'Reprend l etape en adoptant sa tache deja lancee : si elle a fini, rien n est repaye' : 'Relance l etape avec un nouveau worker') + '">'
              + (adopt ? 'Reprendre l etape (adopter sa tache)' : 'Relancer l etape') + '</button>' : '')
            + '</td></tr>';
        }).join('');
        const done = r.nodes.filter(n => n.status === 'completed').length;
        return '<div class="ap-card"' + (i ? ' style="opacity:.75;"' : '') + '><div class="ap-title">' + (i ? 'Run precedent' : 'Dernier run') + ' : ' + esc(r.id)
          + ' | ' + esc(RUN_LABEL[r.status] || r.status) + ' | ' + done + '/' + r.nodes.length + ' etapes | lance ' + esc(when(r.createdAt))
          + (r.waitingUntil ? ' | reprend ' + esc(when(r.waitingUntil)) : '') + '</div>'
          + '<table class="ap-table"><thead><tr><th>Etape</th><th>Etat</th><th>Modele</th><th>Debut (duree)</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      }).join('');
      return head('Boucle PleinSens : ce qu elle a fait') + clairHtml() + (runs || '<div class="ap-card ap-muted">Aucun run de la boucle.</div>')
        + '<div class="ap-card"><div class="ap-title">Journal du lanceur (08:00)</div>' + logBlock(d.log) + '</div>';
    }
    if (id === 'porte-fusion') {
      const rows = (d.candidates || []).map(c => '<tr><td><b>' + esc(c.branch) + '</b><div class="ap-muted">' + esc(c.sha) + ' | ' + esc(c.source || '') + '</div></td>'
        + '<td>' + esc(c.status) + (c.attempts ? ' (' + esc(c.attempts) + ' essai(s))' : '') + '</td><td>' + esc(c.title || '') + '</td>'
        + '<td>' + esc(c.note || '') + (c.pr ? ' <span class="ap-tag">PR #' + esc(c.pr) + '</span>' : '') + '</td></tr>').join('');
      const merges = (d.merges || []).map(m => '<tr><td>' + esc(m.branch) + '</td><td>PR #' + esc(m.pr) + '</td><td>' + esc(m.status) + '</td><td>' + esc(when(m.at)) + '</td></tr>').join('');
      return head('Porte de fusion : ce qu elle a fait') + (d.stopped ? '<div class="ap-card ap-err">Arretee : ' + esc(d.stopped.reason || '') + '</div>' : '')
        + '<div class="ap-card"><div class="ap-title">Branches candidates</div><table class="ap-table"><thead><tr><th>Branche</th><th>Etat</th><th>Tache</th><th>Derniere note</th></tr></thead><tbody>'
        + (rows || '<tr><td colspan="4" class="ap-muted">Aucune.</td></tr>') + '</tbody></table></div>'
        + '<div class="ap-card"><div class="ap-title">Fusions</div><table class="ap-table"><tbody>' + (merges || '<tr><td class="ap-muted">Aucune fusion pour l instant.</td></tr>') + '</tbody></table></div>'
        + '<div class="ap-card"><div class="ap-title">Journal</div>' + logBlock(d.log) + '</div>';
    }
    return head('Veille : ses derniers passages') + '<div class="ap-card">' + logBlock(d.log) + '</div>';
  }

  function selector() {
    const rows = ap.pilots || [];
    if (rows.length < 2) return '';
    return '<div class="ap-card" style="padding:8px 12px;"><div class="ap-btns" style="align-items:center;"><span class="ap-muted">Boucles :</span>' + rows.map(p => {
      const st = STATUS[p.status] || STATUS.disabled;
      return '<button class="tab-bar-btn' + (p.pilot === ap.pilot ? ' ap-primary' : '') + '" data-pilot="' + esc(p.pilot) + '" onclick="MindAutopilot.select(this.dataset.pilot)" ' + (ap.busy ? 'disabled' : '') + '>' +
        '<span class="ap-dot" style="background:' + st.color + ';margin-right:6px;"></span>' + esc(p.label) + ' | ' + esc(p.profileLabel) + ' | ' + esc(st.label) + ' | ' + esc((p.today || {}).completed || 0) + '/' + esc((p.limits || {}).dailyCompletions || 0) + '</button>';
    }).join('') + '<span class="ap-muted">Une seule tache tourne a la fois, toutes boucles confondues.</span></div></div>';
  }

  // What the deep loop checks by itself, without any AI call.
  function verifyLine(s) {
    if (!(s.verify || []).length && !(s.protectedPaths || []).length) return '';
    const v = s.active && s.active.verify;
    const names = (s.verify || []).map(n => {
      const r = v && (v.results || []).find(x => x.name === n);
      const mark = r ? (r.ok ? ' ok ' + Math.round(r.ms / 1000) + ' s' : ' ECHEC') : (v && v.running && v.current === n ? ' en cours...' : '');
      return esc(n) + (mark ? '<b>' + esc(mark) + '</b>' : '');
    }).join(', ');
    const night = s.schedule ? '<div class="ap-note">Mode nuit : nouvelles taches entre <b>' + esc(s.schedule.start) + '</b> et <b>' + esc(s.schedule.end) + '</b>'
      + (s.inWindow ? ' (dans la plage)' : ' (hors plage)') + (s.ambition === 'big' ? ' | ambition : <b>gros problemes reels</b>' : '')
      + ((s.sources && s.sources.files && s.sources.files.length) ? ' | sources : ' + esc(s.sources.files.join(', ')) : '') + ((s.sources && s.sources.sentry) ? ' + Sentry' : '')
      + ' | en cas de limite de credit : pause, nouvel essai 1 h plus tard ou la nuit suivante.</div>' : '';
    return night + '<div class="ap-note">Garde-fous sans IA apres chaque implementation : ' + (names ? 'verifications ' + names + ' ; ' : '') +
      'refus des tests desactives (.skip/.only) et de @ts-ignore ; ' + esc((s.protectedPaths || []).length) + ' motifs de chemins proteges' +
      ((s.protectedPaths || []).length ? ' <span class="ap-muted" title="' + esc((s.protectedPaths || []).join('\n')) + '">(survoler pour la liste)</span>' : '') + '.</div>';
  }

  function meter(label, used, max, note) {
    const pct = Math.max(0, Math.min(100, max ? (used / max) * 100 : 0));
    const color = pct >= 100 ? 'var(--red)' : (pct >= 75 ? 'var(--yellow)' : 'var(--green)');
    return '<div class="ap-meter"><div class="ap-meter-head"><span>' + esc(label) + '</span><b>' + esc(fmt(used)) + ' / ' + esc(fmt(max)) + '</b></div>' +
      '<div class="ap-bar"><div style="width:' + pct.toFixed(1) + '%;background:' + color + ';"></div></div>' +
      (note ? '<div class="ap-note">' + note + '</div>' : '') + '</div>';
  }

  function paint() {
    if (state.view !== 'autopilot') return;
    const main = $('mindMain'); if (!main) return;
    const s = ap.snap;
    if (!s) { main.innerHTML = '<div class="ap-wrap">Chargement du pilote...</div>'; return; }
    const st = STATUS[s.status] || STATUS.disabled;
    const b = s.budget || {}; const L = s.limits || {};
    const a = s.active;
    const goalVal = ap.draftGoal != null ? ap.draftGoal : (s.goal || '');
    const repoVal = ap.draftRepo != null ? ap.draftRepo : (s.repoName || '');
    const consentKnown = !!(s.consent && s.consent.worktreeWrites);
    const repos = (s.repos || []);
    const locked = s.enabled || ap.busy;

    const providers = Object.entries(b.byProvider || {});
    const providerRows = providers.length ? providers.map(([name, v]) =>
      '<tr><td>' + esc(name === 'claude' ? 'Claude' : name === 'codex' ? 'Codex' : name) + '</td><td>' + esc(fmt(v.calls)) + '</td><td>' + esc(fmt(v.measuredTokens)) +
      '</td><td>' + (v.unmeteredCalls ? '~ ' + esc(fmt(v.reservedTokens)) + ' <span class="ap-tag">estimation</span>' : '0') + '</td><td>' + esc(fmt(v.cacheReadTokens || 0)) + '</td></tr>').join('')
      : '<tr><td colspan="5" class="ap-muted">Aucun appel aujourd\'hui.</td></tr>';

    const history = (s.history || []).map(h =>
      '<tr><td>' + esc(when(h.at)) + '</td><td>' + esc(CATEGORY_LABELS[h.category] || h.category || '-') + '</td><td>' + esc(h.title || '-') +
      '</td><td>' + esc(OUTCOME_LABELS[h.outcome] || h.outcome) + '</td><td class="ap-path">' +
      (h.worktree ? esc(h.worktree.path) + '<br><span class="ap-muted">branche ' + esc(h.worktree.branch || '-') + '</span>' : '-') + '</td></tr>').join('')
      || '<tr><td colspan="5" class="ap-muted">Aucune tache encore.</td></tr>';
    const events = (s.events || []).map(e =>
      '<div class="ap-ev ap-ev-' + esc(e.kind) + '"><span class="ap-muted">' + esc(when(e.at)) + '</span> <b>' + esc(e.kind) + '</b> ' + esc(e.msg) + '</div>').join('')
      || '<div class="ap-muted">Aucun evenement.</div>';

    main.innerHTML = `
      <style>
        .ap-wrap { display:flex; flex-direction:column; gap:14px; }
        .ap-card { background:var(--mantle); border:1px solid var(--surface1); border-radius:6px; padding:12px; }
        .ap-title { font-size:11px; font-weight:600; color:var(--subtext0); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; }
        .ap-grid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:14px; }
        @media (max-width: 900px) { .ap-grid { grid-template-columns: 1fr; } }
        .ap-status { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .ap-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
        .ap-big { font-size:16px; font-weight:600; color:var(--text); }
        .ap-muted { color:var(--subtext0); font-size:11px; }
        .ap-note { color:var(--subtext0); font-size:11px; margin-top:4px; line-height:1.4; }
        .ap-pipe { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:10px; }
        .ap-step { font-size:11px; padding:3px 8px; border-radius:10px; border:1px solid var(--surface1); color:var(--subtext0); }
        .ap-past { color:var(--text); border-color:var(--surface2); }
        .ap-now { color:#000; background:var(--accent); border-color:var(--accent); font-weight:600; }
        .ap-arrow { color:var(--subtext0); font-size:12px; }
        .ap-form { display:flex; flex-direction:column; gap:8px; font-size:12px; color:var(--text); }
        .ap-form textarea, .ap-form select { background:var(--base); color:var(--text); border:1px solid var(--surface1); border-radius:4px; padding:6px; font:inherit; }
        .ap-form textarea { min-height:54px; resize:vertical; }
        .ap-btns { display:flex; gap:8px; flex-wrap:wrap; }
        .ap-primary { background:var(--accent) !important; color:#000 !important; border:none !important; font-weight:600; }
        .ap-danger { background:var(--red) !important; color:#000 !important; border:none !important; font-weight:600; }
        .ap-meter { margin-bottom:10px; }
        .ap-meter-head { display:flex; justify-content:space-between; font-size:12px; color:var(--text); margin-bottom:4px; }
        .ap-bar { height:6px; background:var(--surface0); border-radius:3px; overflow:hidden; }
        .ap-bar > div { height:100%; }
        .ap-table { width:100%; border-collapse:collapse; font-size:11px; color:var(--text); }
        .ap-table th { text-align:left; color:var(--subtext0); font-weight:600; padding:4px 6px; border-bottom:1px solid var(--surface1); }
        .ap-table td { padding:5px 6px; border-bottom:1px solid var(--surface0); vertical-align:top; }
        .ap-path { font-family:var(--font-mono, monospace); word-break:break-all; }
        .ap-tag { font-size:10px; padding:1px 5px; border-radius:8px; background:var(--surface1); color:var(--yellow); }
        .ap-ev { font-size:11px; color:var(--text); padding:3px 0; border-bottom:1px solid var(--surface0); }
        .ap-ev-error b, .ap-ev-interrupted b { color:var(--red); }
        .ap-ev-decision b { color:var(--accent); }
        .ap-ev-quota b { color:var(--yellow); }
        .ap-msg { font-size:11px; color:var(--subtext1); min-height:14px; }
        .ap-err { color:var(--red); font-size:12px; white-space:pre-wrap; }
      </style>
      <div class="ap-wrap">
        ${overview()}
        ${ap.loopView ? loopDetailHtml() + '<div style="display:none">' : ''}
        ${selector()}
        ${ap.loopView ? '' : clairHtml()}
        <div class="ap-card">
          <div class="ap-status">
            <span class="ap-dot" style="background:${st.color};"></span>
            <span class="ap-big" id="apStatusLabel">${esc(st.label)}</span>
            <span class="ap-muted">${esc(st.hint)}</span>
            <span style="flex:1;"></span>
            <button class="tab-bar-btn" onclick="MindAutopilot.refresh()" ${ap.busy ? 'disabled' : ''}>Actualiser</button>
            <button class="tab-bar-btn" onclick="MindAutopilot.tick()" ${(!s.enabled || ap.busy) ? 'disabled' : ''} title="Forcer la verification immediate (le pilote verifie aussi seul toutes les 20 s)">Verifier maintenant</button>
            ${s.enabled ? '<button class="tab-bar-btn ap-danger" id="apStop" onclick="MindAutopilot.stop()" ' + (ap.busy ? 'disabled' : '') + '>Arreter</button>' : ''}
          </div>
          <div class="ap-note">Depot : <b>${esc(s.repoName || '-')}</b> <span class="ap-path">${esc(s.repoPath || '')}</span> | Objectif : ${esc(s.goal || '-')}</div>
          ${pipeline(s)}
          ${verifyLine(s)}
          ${a ? '<div class="ap-note">Tache : <b>' + esc(a.plan ? '[' + (CATEGORY_LABELS[a.plan.category] || a.plan.category) + '] ' + a.plan.title : '(decouverte en cours)') + '</b> | revisions du plan ' + esc(a.planRevisions || 0) + '/' + esc(L.planRevisions) + ' | reparations ' + esc(a.repairs || 0) + '/' + esc(L.repairs) + (a.worktree ? ' | worktree <span class="ap-path">' + esc(a.worktree.path) + '</span>' : '') + (a.taskId ? ' | tache Orchestrator ' + esc(a.taskId) : '') + '</div>' : ''}
          ${a && a.parkReason === 'credit' ? '<div class="ap-note" style="color:var(--yellow);">Limite de credit du fournisseur atteinte (' + esc(a.creditHits) + ' fois) : la tache est en pause, rien n\'est perdu. Reprise prevue : ' + esc(when(s.nextAt)) + '.</div>' : ''}
          ${s.nextAt && s.nextAt > Date.now() ? '<div class="ap-note">Prochaine verification possible : ' + esc(when(s.nextAt)) + '</div>' : ''}
          ${s.error ? '<div class="ap-err">' + esc(s.error) + '</div>' : ''}
          ${(!s.enabled && a && a.waitingStage) ? '<div class="ap-note">Plan approuve en attente de quota : il reprendra a l\'etape ' + esc(STAGE_LABELS[a.waitingStage] || a.waitingStage) + ' quand vous reactiverez le pilote.</div><div class="ap-btns" style="margin-top:8px;"><button class="tab-bar-btn" onclick="MindAutopilot.acknowledge()" ' + (ap.busy ? 'disabled' : '') + '>Abandonner ce plan</button></div>' : ''}
          ${s.status === 'interrupted' && a && a.resumable ? '<div class="ap-btns" style="margin-top:8px;"><button class="tab-bar-btn ap-primary" onclick="MindAutopilot.resume()" ' + (ap.busy ? 'disabled' : '') + ' title="Relance la verification locale (sans IA) sur le worktree conserve, puis la revue Codex. Decouverte et implementation ne sont pas repayees.">Reprendre depuis le worktree</button></div>' : ''}
          ${s.status === 'interrupted' ? '<div class="ap-btns" style="margin-top:8px;"><button class="tab-bar-btn" onclick="MindAutopilot.acknowledge()" ' + (ap.busy ? 'disabled' : '') + '>Archiver la tache interrompue (le worktree est conserve)</button></div>' : ''}
          <div class="ap-msg" id="apMsg">${esc(ap.message)}</div>
        </div>

        <div class="ap-grid">
          <div class="ap-card">
            <div class="ap-title">Configuration - boucle ${esc(s.label || '')} (${esc(s.profileLabel || 'Standard')})</div>
            <div class="ap-form">
              <label>Depot
                <select id="apRepo" onchange="MindAutopilot.remember()" ${locked ? 'disabled' : ''} style="width:100%;">
                  ${repos.map(r => '<option value="' + esc(r) + '"' + (r === repoVal ? ' selected' : '') + '>' + esc(r) + '</option>').join('')}
                </select>
              </label>
              <label>Objectif de travail (1 a 500 caracteres)
                <textarea id="apGoal" maxlength="500" oninput="MindAutopilot.remember()" ${locked ? 'disabled' : ''} style="width:100%;">${esc(goalVal)}</textarea>
              </label>
              <label style="display:flex;gap:8px;align-items:flex-start;">
                <input type="checkbox" id="apConsent" onchange="MindAutopilot.remember()" ${locked ? 'disabled' : ''} ${(ap.draftConsent || consentKnown) ? 'checked' : ''}>
                <span>J'autorise Claude a modifier des fichiers <b>sans confirmation</b> (permissions elevees) dans un worktree Git isole, et a lancer une liste fermee de commandes (node --test, npm test, pytest, git status/diff/log/show). git push/merge/reset/branch/checkout/commit, npm publish/install, npx et le web sont refuses. La decouverte et les revues Codex restent en lecture seule ; rien n'est pousse ni fusionne. Ce n'est pas un bac a sable du systeme : les tests executes peuvent faire ce que fait le code du depot, d'ou le controle du checkout principal apres chaque etape.${consentKnown ? ' <span class="ap-muted">(deja accorde le ' + esc(when(s.consent.at)) + ')</span>' : ''}</span>
              </label>
              <div class="ap-btns">
                ${s.enabled ? '' : '<button class="tab-bar-btn ap-primary" id="apEnable" onclick="MindAutopilot.enable()" ' + ((ap.busy || s.status === 'interrupted') ? 'disabled' : '') + '>Activer</button>'}
              </div>
              <div class="ap-note">Categories : correction, performance (mesure avant/apres exigee), structure, nettoyage (comportement preserve), tests. Aucune tache n'est inventee pour consommer le quota.</div>
            </div>
          </div>

          <div class="ap-card">
            <div class="ap-title">Limites du jour (${esc(b.day || '')}, heure locale)</div>
            ${meter('Taches reussies', (s.today || {}).completed || 0, L.dailyCompletions)}
            ${meter('Decouvertes Claude', (s.today || {}).discoveries || 0, L.dailyDiscoveries)}
            ${meter('Lancements Claude/Codex', b.calls || 0, L.dailyCalls)}
            ${meter('Budget de reservation (tokens)', b.chargedTokens || 0, L.dailyTokenBudget,
              (b.tokenUsageExact ? 'Toutes les valeurs sont mesurees.' : '<span class="ap-tag">estimation</span> ' + esc(fmt(b.unmeteredCalls || 0)) + ' appel(s) sans mesure reelle, comptes ' + esc(fmt(L.reservedTokensPerCall)) + ' tokens chacun.') +
              ' Ce budget est une reservation appliquee AVANT chaque lancement : il ne plafonne pas la consommation a l\'interieur d\'un CLI en cours.')}
            <table class="ap-table"><thead><tr><th>Fournisseur</th><th>Appels</th><th>Tokens mesures</th><th>Reserves (sans mesure)</th><th>Lecture cache</th></tr></thead><tbody>${providerRows}</tbody></table>
            <div class="ap-note">Revisions du plan : ${esc(L.planRevisions)} max par tache | reparations du code : ${esc(L.repairs)} max par tache | aucun retry ni repli automatique.</div>
          </div>
        </div>

        <div class="ap-card">
          <div class="ap-title">Historique des taches et worktrees (a valider par un humain)</div>
          <table class="ap-table"><thead><tr><th>Date</th><th>Categorie</th><th>Tache</th><th>Resultat</th><th>Worktree</th></tr></thead><tbody>${history}</tbody></table>
        </div>
        <div class="ap-card">
          <div class="ap-title">Decisions, erreurs et evenements</div>
          ${events}
        </div>
        ${ap.loopView ? '</div>' : ''}
      </div>`;
  }

  function renderAutopilot() {
    const main = $('mindMain'); if (!main) return;
    if (ap.poll) clearInterval(ap.poll);
    // WebSocket 'mind-update' {kind:'autopilot'} drives live updates; the slow
    // poll only covers a dropped socket. Cleared by _autopilotTeardown().
    ap.poll = setInterval(() => { if (state.view === 'autopilot' && !ap.busy) load(); }, 15000);
    paint();
    load();
  }
  function _autopilotTeardown() {
    if (ap.poll) { clearInterval(ap.poll); ap.poll = null; }
  }

export { MindAutopilot, renderAutopilot, _autopilotTeardown };
