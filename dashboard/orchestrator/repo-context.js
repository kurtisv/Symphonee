// LA PRIMITIVE UNIQUE DE CONTEXTE DE DEPOT.
//
// POURQUOI ELLE EXISTE, ET POURQUOI ELLE VIT ICI
// ---------------------------------------------------------------------------
// Une sonde dispatchee a MESURE ce qu un worker recevait reellement:
//
//     repertoire de travail : C:\Symphonee
//     CLAUDE.md recu        : "# CLAUDE.md - Symphonee"
//
// Les regles du depot sur lequel on travaille -- son CLAUDE.md, son AGENTS.md,
// son protocole -- n etaient JAMAIS chargees. Codex ne les lisait que parce que
// les prompts epelaient le chemin en premiere ligne: une convention, pas un
// mecanisme.
//
// UN CORRECTIF PAR ROUTE AURAIT LAISSE TROIS TROUS. La cartographie a montre
// treize sites d appel, dont trois hors des routes: `jobs-scheduler.js` (les
// taches PLANIFIEES, celles que personne ne regarde), l echelle d escalade de
// `escalation.js`, et la reprise de `lifecycle.js`. Tous convergent vers DEUX
// sinks: `spawnHeadless` et `spawnVisible`. La garde vit donc au point
// d etranglement -- le meme argument que l echeance ambiante du drain: la ou
// tout passe, pour qu on ne puisse pas l oublier.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Modes explicites. Aucun defaut: l absence est une erreur, pas une supposition. */
const MODES = { REPO: 'repo', NEUTRAL: 'neutral' };

class ErreurContexteDepot extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ErreurContexteDepot';
    this.code = code;              // repo_context_missing | repo_context_mismatch | context_mode_missing
    this.details = details || null;
  }
}

function racineGit(chemin) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: chemin, stdio: 'pipe' })
      .toString().trim().replace(/\\/g, '/');
  } catch { return null; }
}

/**
 * Resout le repertoire de travail d une mission.
 *
 * @param {object} opts
 *   - mode        'repo' | 'neutral'  -- OBLIGATOIRE, jamais deduit du prompt
 *   - cwd         chemin explicite, prioritaire (worktree isolee)
 *   - repo        nom du depot attendu, pour detecter une incoherence
 *   - getUiContext  accesseur du contexte actif
 *   - espaceNeutre  repertoire des missions sans depot
 * @returns {{ mode, cwd, repo, commit, sale }}
 * @throws {ErreurContexteDepot}
 */
function resoudreContexteDepot(opts) {
  const o = opts || {};
  const mode = o.mode;

  if (mode !== MODES.REPO && mode !== MODES.NEUTRAL) {
    // NI `repo` NI `neutral` PAR DEFAUT. `repo` casserait les missions
    // legitimement neutres (une question generale, une revue de Symphonee
    // lui-meme); `neutral` rouvrirait le trou qu on vient de fermer. L absence
    // est donc une erreur nommee, que l appelant doit corriger.
    throw new ErreurContexteDepot('context_mode_missing',
      "mode de contexte absent: attendu 'repo' ou 'neutral'", { recu: mode });
  }

  if (mode === MODES.NEUTRAL) {
    const espace = o.espaceNeutre;
    if (!espace || !fs.existsSync(espace)) {
      throw new ErreurContexteDepot('neutral_space_missing',
        'mode neutre demande mais aucun espace neutre utilisable', { espace: espace || null });
    }
    return { mode, cwd: espace, repo: null, commit: null, sale: null };
  }

  // MODE REPO -- le cwd explicite prime (worktree isolee).
  let chemin = o.cwd || null;
  if (!chemin && typeof o.getUiContext === 'function') {
    try { chemin = o.getUiContext().activeRepoPath || null; } catch { chemin = null; }
  }

  if (!chemin) {
    // MESURE DU 12 AOUT: `activeRepoPath` valait `null`. Le correctif precedent
    // reposait sur une precondition jamais lue. Elle est desormais un cas TESTE
    // et BLOQUANT, pas une supposition.
    throw new ErreurContexteDepot('repo_context_missing',
      'aucun depot actif: une mission de code ne peut pas demarrer sans depot', null);
  }
  if (!fs.existsSync(chemin)) {
    throw new ErreurContexteDepot('repo_context_missing',
      `chemin de depot inexistant: ${chemin}`, { chemin });
  }
  if (!fs.statSync(chemin).isDirectory()) {
    throw new ErreurContexteDepot('repo_context_missing',
      `chemin de depot qui n est pas un repertoire: ${chemin}`, { chemin });
  }

  const reel = fs.realpathSync(chemin).replace(/\\/g, '/');
  const racine = racineGit(reel);
  if (!racine) {
    throw new ErreurContexteDepot('repo_context_missing',
      `le chemin n est pas un depot Git: ${reel}`, { chemin: reel });
  }

  // INCOHERENCE: le depot demande n est pas celui qu on a sous la main.
  if (o.repo) {
    const nom = path.basename(racine);
    if (nom.toLowerCase() !== String(o.repo).toLowerCase()) {
      throw new ErreurContexteDepot('repo_context_mismatch',
        `depot demande "${o.repo}" mais chemin actif "${nom}"`, { demande: o.repo, actif: nom });
    }
  }

  let commit = null;
  let sale = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: reel, stdio: 'pipe' }).toString().trim(); } catch { /* depot sans commit */ }
  try {
    sale = execFileSync('git', ['status', '--porcelain'], { cwd: reel, stdio: 'pipe' })
      .toString().trim().length > 0;
  } catch { /* indeterminable */ }

  // Le cwd EXPLICITE reste prioritaire, mais on rend la racine reelle pour
  // qu un sous-repertoire ne fasse pas croire a un autre depot.
  return { mode, cwd: o.cwd ? reel : racine, repo: path.basename(racine), commit, sale };
}

module.exports = { MODES, ErreurContexteDepot, resoudreContexteDepot, racineGit };
