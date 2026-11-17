// mind-ui :: autopilot-overview. Pure models + renderers for the top of the Autopilotes page:
//   - pilotIdsFrom : the pilots to read, from the server list (no hard-coded ids)
//   - calendarModel / calendarHtml : the 24 h strip (planned windows, midnight wrap, overlaps, "now")
//   - kpiModel / kpiHtml : four indicator cards with a documented formula and honest empty states
// No DOM, no fetch. Rule of truth: every number comes from a real snapshot; a missing source is shown as
// "Non mesure" or "Indisponible", never as zero. The formulas are in the title of each card.

const DAY = 1440;
const clip = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; };
const hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// Pilots to read: the server list when known, else the two historical ids as a first-load fallback.
export function pilotIdsFrom(pilots, fallback = ['default', 'gas-saver']) {
  const ids = (Array.isArray(pilots) ? pilots : []).map((p) => p && p.pilot).filter((x) => typeof x === 'string' && x);
  return ids.length ? [...new Set(ids)] : fallback.slice();
}

// "14:00-19:00" -> segments in minutes of the day. A window that passes midnight gives two segments.
// Anything else ("toutes les 30 min ...") is not a window: null.
export function parseWindow(text) {
  const m = /(\d{1,2}):(\d{2})\s*[^\d\s:]+\s*(\d{1,2}):(\d{2})/.exec(String(text || ''));
  if (!m) return null;
  const a = Number(m[1]) * 60 + Number(m[2]); const b = Number(m[3]) * 60 + Number(m[4]);
  if (![a, b].every((x) => x >= 0 && x <= DAY) || m[1] > 24 || m[3] > 24 || a === b) return null;
  return b > a ? { start: a, end: b, segments: [[a, b]] } : { start: a, end: b, segments: [[a, DAY], [0, b]] };
}

function overlap(a, b) {
  const out = [];
  for (const [s1, e1] of a) for (const [s2, e2] of b) { const s = Math.max(s1, s2), e = Math.min(e1, e2); if (e > s) out.push([s, e]); }
  return out;
}

const STATE_LABEL = { working: 'travaille', resting: 'en pause', stopped: 'arretee', error: 'en erreur' };

// loops: the /api/automation/loops "loops" array (and optionally "services"). now: a Date.
export function calendarModel(loops, now = new Date()) {
  const list = Array.isArray(loops) ? loops : [];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const rows = []; const unscheduled = [];
  for (const l of list) {
    if (!l) continue;
    const w = parseWindow(l.window);
    const row = { id: String(l.id || l.label || ''), label: clip(l.label || l.name || l.id || 'Boucle', 60), kind: l.kind || '', status: l.status || 'unknown',
      statusLabel: l.statusLabel || STATE_LABEL[l.status] || 'etat inconnu', windowText: w ? hhmm(w.start) + ' a ' + hhmm(w.end) : '', segments: w ? w.segments : [] };
    row.inWindowNow = w ? w.segments.some(([s, e]) => nowMin >= s && nowMin < e) : null;
    row.runningNow = l.status === 'working';
    if (w) rows.push(row); else unscheduled.push({ id: row.id, label: row.label, text: clip(l.window || 'plage non fournie', 90), status: row.status, statusLabel: row.statusLabel });
  }
  const overlaps = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    for (const [s, e] of overlap(rows[i].segments, rows[j].segments)) overlaps.push({ a: rows[i].label, b: rows[j].label, from: s, to: e, text: rows[i].label + ' et ' + rows[j].label + ' se chevauchent de ' + hhmm(s) + ' a ' + (e === DAY ? '24:00' : hhmm(e)) });
  }
  return { nowMin, nowText: hhmm(nowMin), rows, unscheduled, overlaps };
}

// pilotSnaps: array of pilot snapshots ({ history:[{outcome, at}] }). now: ms. fresh: false when the read is stale.
export function kpiModel({ loops, pilotSnaps, now = Date.now(), fresh = true } = {}) {
  const known = Array.isArray(loops);
  const L = known ? loops.filter((l) => l && l.kind !== 'script') : [];
  const stale = !fresh;
  const mk = (id, label, value, sub, formula, state) => ({ id, label, value, sub, formula, state: state === 'ok' && stale ? 'stale' : state });

  const active = L.filter((l) => l.status === 'working' || l.status === 'resting');
  const errors = L.filter((l) => l.status === 'error');
  const resting = L.filter((l) => l.status === 'resting');
  const working = L.filter((l) => l.status === 'working');

  const k1 = known ? mk('active', 'Boucles actives', String(active.length), resting.length + ' planifiee(s) / ' + errors.length + ' en erreur',
    'Boucles dont l\'etat est "travaille" ou "en pause" (activees). Les arretees et en erreur sont exclues. Source : /api/automation/loops.', 'ok')
    : mk('active', 'Boucles actives', '-', 'Indisponible', 'Source : /api/automation/loops (non recue).', 'unknown');
  const k2 = known ? mk('running', 'Taches en cours', String(working.length), working.length ? working.map((l) => clip(l.label || l.name || l.id, 28)).join(', ') : 'Aucune tache en cours',
    'Boucles a l\'etat "travaille" (execution constatee), tous types confondus. Pas le nombre de pilotes actives. Source : /api/automation/loops.', 'ok')
    : mk('running', 'Taches en cours', '-', 'Indisponible', 'Source : /api/automation/loops (non recue).', 'unknown');

  const snaps = (Array.isArray(pilotSnaps) ? pilotSnaps : []).filter((s) => s && Array.isArray(s.history));
  let done = 0; for (const s of snaps) for (const h of s.history) if (h && h.outcome === 'completed' && Number.isFinite(h.at) && h.at >= now - 86400000 && h.at <= now + 60000) done++;
  const k3 = snaps.length ? mk('verified', 'Travaux locaux termines (24 h)', String(done), 'Taches d\'autopilote terminees avec succes (verification locale + revue). Pas une PR fusionnee.',
    'Entrees d\'historique des pilotes Mind avec le resultat "Reussie" datees de moins de 24 h. Ne couvre pas les boucles de graphe. Source : /api/mind/autopilot (historique).', 'ok')
    : mk('verified', 'Travaux locaux termines (24 h)', '-', 'Historique des pilotes non recu', 'Source : /api/mind/autopilot (historique), non recue.', 'unknown');
  const k4 = mk('lessons', 'Nouvelles lecons Mind (24 h)', '-', 'Non mesure : aucune source datee pour les lecons certifiees',
    'Aucune route ne fournit les lecons certifiees avec leur date. Le chiffre sera affiche des qu\'elle existe ; aucune valeur n\'est supposee.', 'unknown');
  return [k1, k2, k3, k4];
}

export function kpiHtml(cards, esc) {
  if (!cards || !cards.length) return '';
  return '<section class="apo-kpis" aria-label="Indicateurs">' + cards.map((c) => {
    const note = c.state === 'stale' ? ' <span class="apo-stale">donnee perimee</span>' : '';
    return '<article class="apo-kpi" data-state="' + esc(c.state) + '" title="' + esc(c.formula) + '"><div class="apo-kpi-top"><span class="apo-kpi-ico" aria-hidden="true"></span><span class="apo-kpi-label">' + esc(c.label) + '</span></div>'
      + '<div class="apo-kpi-val">' + esc(c.value) + '</div><div class="apo-kpi-sub">' + esc(c.sub) + note + '</div></article>';
  }).join('') + '</section>';
}

const pct = (m) => ((m / DAY) * 100).toFixed(3) + '%';
export function calendarHtml(m, esc) {
  if (!m) return '';
  const ticks = [0, 4, 8, 12, 16, 20, 24].map((h) => '<span class="apo-tick" style="left:' + pct(h * 60) + '">' + (h === 0 ? 'minuit' : (h === 24 ? '' : String(h).padStart(2, '0') + ' h')) + '</span>').join('');
  const rows = m.rows.map((r) => {
    const segs = r.segments.map(([s, e]) => '<i class="apo-seg apo-' + esc(r.status) + (r.runningNow && r.inWindowNow && s <= m.nowMin && m.nowMin < e ? ' apo-live' : '') + '" style="left:' + pct(s) + ';width:' + pct(e - s) + '"></i>').join('');
    return '<li class="apo-row"><div class="apo-name"><b>' + esc(r.label) + '</b><span>' + esc(r.windowText) + ' | ' + esc(r.statusLabel) + (r.inWindowNow === false && r.status !== 'stopped' ? ' | hors plage maintenant' : '') + '</span></div>'
      + '<div class="apo-track" role="img" aria-label="' + esc(r.label + ' : ' + r.windowText) + '">' + segs + '<b class="apo-now" style="left:' + pct(m.nowMin) + '"></b></div></li>';
  }).join('');
  const un = m.unscheduled.length ? '<div class="apo-unsched"><b>Sans plage fixe</b>' + m.unscheduled.map((u) => '<span>' + esc(u.label) + ' : ' + esc(u.text) + ' (' + esc(u.statusLabel) + ')</span>').join('') + '</div>' : '';
  const ov = m.overlaps.length ? '<div class="apo-warn" role="status">' + m.overlaps.map((o) => esc(o.text)).join(' ; ') + '. Une seule tache tourne a la fois, toutes boucles confondues.</div>' : '<div class="apo-ok">Aucun chevauchement de plages.</div>';
  return '<section class="ap-card apo-cal" aria-label="Calendrier des boucles sur 24 h"><div class="ap-title">Boucles sur 24 h (heure locale, il est ' + esc(m.nowText) + ')</div>'
    + (m.rows.length ? '<div class="apo-axis" aria-hidden="true">' + ticks + '</div><ul class="apo-rows">' + rows + '</ul>' : '<div class="ap-muted">Aucune plage horaire fournie par les boucles.</div>')
    + ov + un + '<div class="ap-note">Plages prevues, lues sur la configuration des boucles. Le trait "maintenant" suit l\'horloge de ce poste ; une plage pleine ne prouve pas qu\'une tache tourne.</div></section>';
}

export const OVERVIEW_CSS = `
  .apo-kpis { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; }
  .apo-kpi { background:var(--mantle); border:1px solid var(--surface1); border-radius:8px; padding:12px 14px; display:grid; gap:4px; min-width:0; }
  .apo-kpi[data-state="unknown"] { border-style:dashed; } .apo-kpi[data-state="stale"] { border-color:var(--yellow); }
  .apo-kpi-top { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--subtext0); }
  .apo-kpi-ico { width:10px; height:10px; border-radius:50%; background:var(--accent); flex:none; }
  .apo-kpi-val { font-size:30px; font-weight:700; color:var(--text); line-height:1.1; }
  .apo-kpi-sub { font-size:13px; color:var(--subtext0); overflow-wrap:anywhere; }
  .apo-stale { color:var(--yellow); font-weight:600; }
  .apo-cal { display:grid; gap:10px; }
  .apo-axis { position:relative; height:16px; margin-left:230px; font-size:12px; color:var(--subtext0); }
  .apo-tick { position:absolute; transform:translateX(-50%); white-space:nowrap; }
  .apo-rows { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
  .apo-row { display:grid; grid-template-columns:220px 1fr; gap:10px; align-items:center; }
  .apo-name { display:grid; min-width:0; font-size:13px; } .apo-name b { color:var(--text); font-size:14px; overflow-wrap:anywhere; } .apo-name span { color:var(--subtext0); }
  .apo-track { position:relative; height:22px; background:var(--surface0); border-radius:6px; overflow:hidden; }
  .apo-seg { position:absolute; top:3px; bottom:3px; border-radius:4px; background:var(--surface2); border:1px solid var(--overlay0, var(--surface2)); box-sizing:border-box; }
  .apo-seg.apo-working { background:var(--accent); border-color:var(--accent); } .apo-seg.apo-resting { background:color-mix(in srgb, var(--accent) 40%, var(--surface1)); border-color:var(--accent); }
  .apo-seg.apo-error { background:color-mix(in srgb, var(--red) 55%, var(--surface1)); border-color:var(--red); } .apo-seg.apo-stopped { background:var(--surface1); }
  .apo-seg.apo-live { box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent); }
  .apo-now { position:absolute; top:0; bottom:0; width:2px; background:var(--text); }
  .apo-warn { font-size:13px; color:var(--yellow); } .apo-ok { font-size:13px; color:var(--subtext0); }
  .apo-unsched { display:grid; gap:2px; font-size:13px; color:var(--subtext0); } .apo-unsched b { color:var(--text); }
  @media (max-width: 900px) { .apo-kpis { grid-template-columns:repeat(2, minmax(0,1fr)); } .apo-row { grid-template-columns:1fr; gap:4px; } .apo-axis { margin-left:0; } }
  @media (max-width: 460px) { .apo-kpis { grid-template-columns:1fr; } }
`;
