// mind-ui :: autopilot-card. The "plain sentence" card shown at the top of the Autopilotes page for the
// selected pilot: one sentence that says what it is doing, the six real stages, the day budget and four
// buttons. Pure functions (no DOM, no fetch) so every state is unit tested.
// Rule of truth: every value comes from the pilot snapshot. A missing value is shown as unknown, never invented.
// Every button maps to a real MindAutopilot action; there is no pause because the autopilot has none.

export const CARD_STAGES = ['discover', 'plan-review', 'implement', 'verify', 'code-review', 'done'];
export const CARD_STAGE_LABELS = { discover: 'Decouverte', 'plan-review': 'Plan', implement: 'Ecriture', verify: 'Tests', 'code-review': 'Relecture', done: 'Termine' };
const clip = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; };
const fmtWhen = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return t ? new Date(t).toLocaleString('fr-CA') : null; };

// Which stage is on screen (same rule as the detailed pipeline below the card).
function currentStage(s) {
  const a = s.active;
  const raw = a ? (a.waitingStage || a.stage) : ((s.history || [])[0] && (s.history || [])[0].outcome === 'completed' ? 'done' : null);
  return raw === 'repair' ? 'implement' : raw;
}

function parkSentence(a) {
  switch (a && a.parkReason) {
    case 'credit': return { word: 'En pause', text: 'Je suis en pause : la limite de credit du fournisseur est atteinte.', sub: 'Rien n\'est perdu, je reprends plus tard.' };
    case 'quota': return { word: 'En pause', text: 'Je suis en pause : le budget interne du jour est atteint.', sub: 'Ce budget est une reservation de Symphonee, pas le quota restant chez le fournisseur.' };
    case 'window': return { word: 'En pause', text: 'Je suis en pause : je suis hors de ma fenetre horaire.', sub: 'Je reprends a l\'ouverture de ma fenetre.' };
    case 'restart': return { word: 'En pause', text: 'Je reprends apres un redemarrage : mon etape attend son prochain passage.', sub: '' };
    default: return { word: 'En pause', text: 'Une etape est en attente : budget, limite du fournisseur ou horaire.', sub: 'Le motif exact est dans le detail.' };
  }
}

// Returns null when there is no snapshot yet.
export function cardModel(s, now = Date.now()) {
  if (!s || typeof s !== 'object') return null;
  const a = s.active || null;
  const L = s.limits || {};
  const used = Number.isFinite((s.today || {}).completed) ? s.today.completed : null;
  const max = Number.isFinite(L.dailyCompletions) && L.dailyCompletions > 0 ? L.dailyCompletions : null;
  const stage = currentStage(s);
  const next = s.nextAt && s.nextAt > now ? fmtWhen(s.nextAt) : null;
  const dayDone = used !== null && max !== null && used >= max;
  const blocked = !!(a && a.handoff && a.handoff.status === 'blocked');
  let tone, word, text, sub, icon;

  if (s.status === 'error') {
    tone = 'red'; icon = 'alert'; word = 'Erreur'; text = 'Je me suis arrete sur une erreur.'; sub = s.error ? clip(s.error, 160) : 'Voir le detail pour le motif.';
  } else if (s.status === 'interrupted') {
    tone = 'red'; icon = 'alert'; word = 'Interrompu'; text = 'Une tache a ete interrompue.';
    sub = a && a.resumable ? 'Je peux reprendre depuis le worktree conserve.' : 'Inspectez le worktree, puis archivez la tache.';
  } else if (blocked) {
    tone = 'red'; icon = 'alert'; word = 'Bloque'; text = 'Je suis bloque : ' + clip(a.handoff.reason || 'motif non fourni', 140); sub = 'Votre decision est necessaire. Voir le detail.';
  } else if (s.status === 'running') {
    tone = 'green'; icon = 'gear'; word = 'En train de travailler';
    text = a && a.plan && a.plan.title ? 'Je travaille sur : ' + clip(a.plan.title, 120) : 'Je cherche quoi ameliorer.';
    sub = (stage ? 'Etape : ' + CARD_STAGE_LABELS[stage] + '.' : '') + (a && a.currentProvider ? ' Agent : ' + clip(a.currentProvider, 40) + '.' : '');
  } else if (s.status === 'disabled') {
    tone = 'gray'; icon = 'power'; word = 'Desactive'; text = 'Je suis arrete : je ne lance rien.'; sub = 'Activez-moi pour que je cherche des taches utiles.';
  } else if (dayDone && !a) {
    tone = 'amber'; icon = 'moon'; word = 'Repos pour aujourd\'hui'; text = 'J\'ai termine mes ' + max + ' taches du jour.'; sub = next ? 'Prochaine verification possible : ' + next + '.' : 'Je reprends demain.';
  } else if (s.status === 'quota') {
    const p = parkSentence(a); tone = 'amber'; icon = 'hourglass'; word = p.word; text = p.text; sub = p.sub;
  } else {
    tone = 'blue'; icon = 'clock'; word = 'En attente';
    if (s.schedule && s.inWindow === false) { text = 'Je suis hors de ma fenetre horaire : je travaille de ' + s.schedule.start + ' a ' + s.schedule.end + '.'; sub = next ? 'Prochaine verification possible : ' + next + '.' : ''; }
    else { text = 'J\'attends la prochaine verification pour chercher une tache.'; sub = next ? 'Prochaine verification possible : ' + next + '.' : 'Elle a lieu toutes les 20 s environ.'; }
  }

  const idx = CARD_STAGES.indexOf(stage);
  const failing = tone === 'red' && s.status !== 'disabled';
  const steps = CARD_STAGES.map((k, i) => {
    let st = 'todo';
    if (stage === 'done') st = 'done';
    else if (idx >= 0 && i < idx) st = 'done';
    else if (idx >= 0 && i === idx) st = failing ? 'error' : (s.status === 'running' ? 'active' : 'paused');
    return { key: k, label: CARD_STAGE_LABELS[k], state: st };
  });

  const facts = [];
  if (s.schedule) facts.push('Fenetre de travail : ' + s.schedule.start + ' a ' + s.schedule.end + (s.inWindow === true ? ' (dans la plage)' : (s.inWindow === false ? ' (hors plage)' : '')));
  else facts.push('Fenetre de travail : non limitee');
  if (next && !/Prochaine verification/.test(sub)) facts.push('Prochaine verification possible : ' + next);

  const busy = false;
  const slot1 = s.status === 'interrupted'
    ? (a && a.resumable ? { key: 'resume', label: 'Reprendre', hint: 'Depuis le worktree conserve', enabled: true, action: 'MindAutopilot.resume()' }
      : { key: 'acknowledge', label: 'Archiver la tache', hint: 'Le worktree est conserve', enabled: true, action: 'MindAutopilot.acknowledge()' })
    : (s.enabled ? { key: 'enable', label: 'Activer', hint: 'Deja actif', enabled: false, action: 'MindAutopilot.enable()' }
      : { key: 'enable', label: 'Activer', hint: 'Lance la boucle', enabled: true, action: 'MindAutopilot.enable()' });
  const buttons = [
    slot1,
    { key: 'tick', label: 'Verifier maintenant', hint: s.enabled ? 'Sans attendre 20 s' : 'Pilote desactive', enabled: !!s.enabled, action: 'MindAutopilot.tick()' },
    { key: 'stop', label: 'Arreter', hint: s.enabled ? 'Arrete aussi la tache en cours' : 'Rien a arreter', enabled: !!s.enabled, action: 'MindAutopilot.stop()' },
    { key: 'detail', label: 'Voir le detail', hint: 'Journal, limites, worktrees', enabled: true, action: 'MindAutopilot.detail()' },
  ];
  let primary = 'detail';
  if (s.status === 'interrupted') primary = slot1.key;
  else if (s.status === 'disabled') primary = 'enable';
  else if (tone === 'blue' || tone === 'amber') primary = 'tick';
  buttons.forEach((b) => { b.primary = b.key === primary && b.enabled; if (busy) b.enabled = b.enabled && b.key === 'detail'; });

  return {
    name: s.label || 'Pilote', tone, icon, word, text, sub: sub || '', steps, used, max, facts, buttons,
    safe: !!(a && a.worktree) || !!(s.consent && s.consent.worktreeWrites),
  };
}

const ICONS = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
  hourglass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v9"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
};

// Markup uses the page's own CSS variables so every theme works. `esc` is the page's HTML escaper.
export function cardHtml(m, esc, busy = false) {
  if (!m) return '';
  const steps = m.steps.map((st, i) => {
    const mark = st.state === 'done' ? 'ok' : (st.state === 'error' ? '!' : String(i + 1));
    const say = { done: 'terminee', active: 'en cours', error: 'en echec', paused: 'en attente', todo: 'a venir' }[st.state];
    return '<li class="apc-step" data-s="' + st.state + '" aria-label="' + esc(st.label + ' : ' + say) + '"><span class="apc-dot">' + esc(mark) + '</span><span class="apc-lbl">' + esc(st.label) + '</span></li>';
  }).join('');
  const dots = m.max !== null && m.max <= 12 && m.used !== null
    ? '<span class="apc-meter" aria-hidden="true">' + Array.from({ length: m.max }, (_, i) => '<i class="' + (i < m.used ? 'on' : '') + '"></i>').join('') + '</span>' : '';
  const budget = m.used !== null && m.max !== null ? 'Taches reussies aujourd\'hui : <b>' + esc(m.used) + ' sur ' + esc(m.max) + '</b>' + dots : 'Taches reussies aujourd\'hui : information non fournie';
  const buttons = m.buttons.map((b) => '<button type="button" class="tab-bar-btn apc-btn' + (b.primary ? ' ap-primary' : '') + '" onclick="' + b.action + '" '
    + ((!b.enabled || (busy && b.key !== 'detail')) ? 'disabled ' : '') + '><span>' + esc(b.label) + '</span><small>' + esc(b.hint) + '</small></button>').join('');
  return '<section class="ap-card apc" aria-label="Resume de la boucle ' + esc(m.name) + '">'
    + '<div class="apc-top"><div class="apc-name">' + esc(m.name) + ' <span class="apc-badge" data-tone="' + m.tone + '">' + (ICONS[m.icon] || '') + esc(m.word) + '</span></div>'
    + (m.safe ? '<span class="apc-safe">' + ICONS.shield + 'Travail dans un worktree isole</span>' : '') + '</div>'
    + '<p class="apc-sentence" role="status">' + esc(m.text) + (m.sub ? '<small>' + esc(m.sub) + '</small>' : '') + '</p>'
    + '<ol class="apc-steps" aria-label="Etapes de la tache">' + steps + '</ol>'
    + '<div class="apc-facts"><span>' + budget + '</span>' + m.facts.map((f) => '<span>' + esc(f) + '</span>').join('') + '</div>'
    + '<div class="apc-actions">' + buttons + '</div></section>';
}

export const CARD_CSS = `
  .apc { display:grid; gap:14px; padding:16px; }
  .apc-top { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; }
  .apc-name { font-size:15px; font-weight:600; color:var(--text); display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .apc-badge { display:inline-flex; align-items:center; gap:6px; padding:3px 12px; border-radius:999px; border:1px solid currentColor; font-size:13px; font-weight:600; }
  .apc-badge svg, .apc-safe svg { width:15px; height:15px; flex:none; }
  .apc-badge[data-tone="green"] { color:var(--green); } .apc-badge[data-tone="blue"] { color:var(--accent); }
  .apc-badge[data-tone="amber"] { color:var(--yellow); } .apc-badge[data-tone="red"] { color:var(--red); } .apc-badge[data-tone="gray"] { color:var(--subtext0); }
  .apc-safe { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--subtext1, var(--subtext0)); }
  .apc-sentence { margin:0; font-size:clamp(18px, 2.6vw, 24px); line-height:1.3; font-weight:600; color:var(--text); text-wrap:balance; }
  .apc-sentence small { display:block; margin-top:6px; font-size:13px; font-weight:400; color:var(--subtext0); }
  .apc-steps { display:grid; grid-template-columns:repeat(6, minmax(0,1fr)); gap:6px; list-style:none; margin:0; padding:0; }
  .apc-step { position:relative; display:grid; justify-items:center; gap:6px; text-align:center; font-size:13px; color:var(--subtext0); min-width:0; }
  .apc-step::before { content:""; position:absolute; top:13px; left:-50%; width:100%; height:2px; background:var(--surface1); }
  .apc-step:first-child::before { display:none; }
  .apc-dot { position:relative; z-index:1; width:28px; height:28px; border-radius:50%; border:2px solid var(--surface1); background:var(--base); display:grid; place-items:center; font-size:12px; font-weight:700; }
  .apc-step[data-s="done"] { color:var(--text); } .apc-step[data-s="done"]::before { background:var(--green); }
  .apc-step[data-s="done"] .apc-dot { border-color:var(--green); color:var(--green); }
  .apc-step[data-s="active"], .apc-step[data-s="paused"], .apc-step[data-s="error"] { color:var(--text); font-weight:600; }
  .apc-step[data-s="active"] .apc-dot { border-color:var(--accent); background:var(--accent); color:#000; }
  .apc-step[data-s="paused"] .apc-dot { border-color:var(--yellow); color:var(--yellow); }
  .apc-step[data-s="error"] .apc-dot { border-color:var(--red); background:var(--red); color:#000; }
  .apc-lbl { overflow-wrap:anywhere; }
  .apc-facts { display:flex; flex-wrap:wrap; gap:6px 20px; align-items:center; border-top:1px solid var(--surface1); padding-top:10px; font-size:13px; color:var(--subtext0); }
  .apc-facts b { color:var(--text); }
  .apc-meter { display:inline-flex; gap:4px; vertical-align:middle; margin-left:6px; }
  .apc-meter i { display:block; width:16px; height:7px; border-radius:4px; background:var(--surface1); } .apc-meter i.on { background:var(--accent); }
  .apc-actions { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; }
  .apc-btn { display:grid; gap:2px; justify-items:center; align-content:center; min-height:52px; padding:8px 10px; font-size:14px; font-weight:600; }
  .apc-btn small { font-size:12px; font-weight:400; opacity:.8; }
  .apc-btn:disabled { opacity:.5; cursor:not-allowed; }
  @media (max-width: 600px) { .apc-actions { grid-template-columns:1fr 1fr; } .apc-lbl { display:none; } .apc-step[data-s="active"] .apc-lbl, .apc-step[data-s="error"] .apc-lbl, .apc-step[data-s="paused"] .apc-lbl { display:block; position:absolute; top:34px; width:90px; left:50%; transform:translateX(-50%); } .apc-steps { margin-bottom:24px; } }
  @media (prefers-reduced-motion: no-preference) { .apc-step[data-s="active"] .apc-dot { animation:apcPulse 2.4s ease-in-out infinite; } }
  @keyframes apcPulse { 0%,100% { box-shadow:0 0 0 0 rgba(137,180,250,.5); } 50% { box-shadow:0 0 0 6px rgba(137,180,250,0); } }
`;
