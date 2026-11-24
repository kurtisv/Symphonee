// mind-ui :: "Mes decisions" (decision of 2026-11-24). The questions the autopilots ask the owner, answered here: each card names its pilot,
// its task, the exact question, the consequences, the choices and its state. An answer is sent with the pilot, the suspended task id AND the
// decision id, so it can only reach the task that asked (the server refuses a stale or second answer). Pure HTML builders: tested alone.
export const DECISION_STATUS = {
  waiting: { label: 'Attend ta reponse', tone: 'var(--yellow)' },
  conflict: { label: 'Le worktree a change : ta reponse est demandee', tone: 'var(--red)' },
  'answered-resume-pending': { label: 'Repondu : reprise au prochain passage du pilote', tone: 'var(--accent)' },
  'question-lost': { label: 'Question perdue : elle sera reposee', tone: 'var(--red)' },
};
const HISTORY_LABEL = { resumed: 'Reprise apres ta reponse', refused: 'Refusee : la tache reprend sans cette operation', abandoned: 'Archivee sur ta decision' };

export function decisionCard(it, esc, busy) {
  const st = DECISION_STATUS[it.status] || { label: it.status, tone: 'var(--subtext0)' };
  const ids = ' data-pilot="' + esc(it.pilot) + '" data-sus="' + esc(it.suspendedId) + '" data-dec="' + esc(it.decisionId) + '"';
  const open = it.status === 'waiting' || it.status === 'conflict';
  const buttons = open ? (it.options || []).map((o) => '<button class="tab-bar-btn' + (o.id === 'allow' || o.id === 'resume' ? ' ap-primary' : o.id === 'refuse' || o.id === 'abandon' ? ' ap-danger' : '') + '"' + ids
    + ' data-choice="' + esc(o.id) + '" onclick="MindAutopilot.answerDecision(this)" ' + (busy ? 'disabled' : '') + '>' + esc(o.label) + '</button>').join(' ') : '';
  const text = open && it.allowText ? '<label class="ap-form" style="margin-top:8px;">Reponse personnalisee (facultative)<textarea id="apDecText-' + esc(it.suspendedId) + '" maxlength="1000" placeholder="Precise ta reponse, ou donne une condition"></textarea></label>'
    + '<button class="tab-bar-btn"' + ids + ' data-choice="" onclick="MindAutopilot.answerDecision(this)" ' + (busy ? 'disabled' : '') + '>Envoyer seulement le texte</button>' : '';
  return '<article class="ap-card ap-decision" aria-label="Decision ' + esc(it.decisionId) + '">'
    + '<div class="ap-status"><span class="ap-dot" style="background:' + st.tone + '"></span><b>' + esc(it.pilotLabel || it.pilot) + '</b><span class="ap-tag">' + esc(it.categoryLabel || it.category) + '</span><span class="ap-muted">' + esc(st.label) + '</span></div>'
    + '<div class="ap-note">Tache : <b>' + esc(it.task || '-') + '</b> (etape ' + esc(it.stage || '-') + ', en attente depuis ' + esc(it.at ? new Date(it.at).toLocaleString('fr-CA') : '-') + ')</div>'
    + '<p style="margin:8px 0;font-size:14px;color:var(--text);">' + esc(it.question) + '</p>'
    + (it.consequences ? '<div class="ap-note"><b>Consequences :</b> ' + esc(it.consequences) + '</div>' : '')
    + (it.problems && it.problems.length ? '<div class="ap-err">' + esc(it.problems.join('; ')) + '</div>' : '')
    + (it.answer ? '<div class="ap-note">Ta reponse : ' + esc([it.answer.choice, it.answer.text].filter(Boolean).join(' / ')) + ' (' + esc(it.answer.by || '') + ')</div>' : '')
    + (it.worktree ? '<div class="ap-note ap-path">' + esc(it.worktree) + (it.branch ? ' (' + esc(it.branch) + ')' : '') + '</div>' : '')
    + (buttons || text ? '<div class="ap-btns" style="margin-top:8px;">' + buttons + '</div>' + text : '')
    + '</article>';
}

// The owner's policy per category, per pilot. Sensitive categories are shown but cannot be made automatic.
export function policyHtml(view, pilot, esc, busy) {
  const cats = view.categories || {}, always = new Set(view.alwaysAsk || []), pol = (view.policies || {})[pilot] || {};
  const rows = Object.entries(cats).map(([id, label]) => {
    const locked = always.has(id);
    return '<tr><td>' + esc(label) + '</td><td>' + (locked ? '<span class="ap-muted">Toujours me demander</span>'
      : '<select data-cat="' + esc(id) + '" onchange="MindAutopilot.setPolicy(this)" ' + (busy ? 'disabled' : '') + '><option value="ask"' + (pol[id] !== 'auto' ? ' selected' : '') + '>Me demander</option><option value="auto"' + (pol[id] === 'auto' ? ' selected' : '') + '>Autoriser automatiquement</option></select>') + '</td></tr>';
  }).join('');
  return '<details><summary>Politique de decision de ce pilote (par categorie)</summary><p class="ap-note">Une categorie automatique est autorisee sans te demander, et la decision reste enregistree. '
    + 'Supprimer des donnees, les secrets, contourner une verification, une zone protegee, PleinSens et les deploiements te sont toujours demandes.</p><table class="ap-table"><tbody>' + rows + '</tbody></table></details>';
}

export function decisionsHtml(view, pilot, esc, busy, message) {
  if (!view) return '<section class="ap-card" id="apDecisions"><div class="ap-title">Mes decisions</div><div class="ap-muted">Chargement...</div></section>';
  const items = view.items || [];
  const open = items.filter((x) => x.status === 'waiting' || x.status === 'conflict');
  const history = (view.history || []).slice(0, 8).map((h) => '<tr><td>' + esc(h.at ? new Date(h.at).toLocaleString('fr-CA') : '-') + '</td><td>' + esc(h.pilotLabel || h.pilot) + '</td><td>' + esc(h.task || '-') + '</td><td>' + esc(HISTORY_LABEL[h.status] || h.status) + (h.by ? ' (' + esc(h.by) + ')' : '') + '</td></tr>').join('');
  return '<section class="ap-card" id="apDecisions" aria-labelledby="apDecTitle"><div class="ap-title" id="apDecTitle">Mes decisions (' + open.length + ' a repondre)</div>'
    + '<p class="ap-note">Une tache qui attend ta decision est mise de cote : le pilote continue avec d autres taches, puis la reprend apres ta reponse.</p>'
    + (message ? '<div class="ap-msg" role="status" aria-live="polite">' + esc(message) + '</div>' : '')
    + (items.length ? items.map((it) => decisionCard(it, esc, busy)).join('') : '<div class="ap-muted">Aucune tache n attend ta decision.</div>')
    + (history ? '<details><summary>Decisions recentes</summary><table class="ap-table"><tbody>' + history + '</tbody></table></details>' : '')
    + policyHtml(view, pilot, esc, busy) + '</section>';
}
