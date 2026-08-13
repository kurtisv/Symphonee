// LOT C -- LE TRANSPORT, TESTE SUR LES VRAIES ENTREES.
//
// Tester la primitive seule ne prouve pas son transport jusqu aux
// consommateurs: c est exactement le reproche fait au correctif precedent, qui
// ne couvrait qu une route sur neuf et laissait le planificateur, l echelle
// d escalade et la reprise sur `process.cwd()`.

'use strict';

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { Orchestrator } = require('../orchestrator.js');
const { resoudreContexteDepot, MODES, ErreurContexteDepot } = require('./repo-context');

function depotJetable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symph-repo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: dir, env, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# depot jetable\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, env, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'c1'], { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

function orchestrateur(activeRepoPath) {
  const neutre = fs.mkdtempSync(path.join(os.tmpdir(), 'symph-neutre-'));
  return new Orchestrator({
    terminals: new Map(), broadcast: () => {}, workspaceDir: neutre,
    createTerminal: () => {}, getConfig: () => ({}),
    getUiContext: () => ({ activeRepoPath }),
  });
}

// --- LA PRIMITIVE ---------------------------------------------------------

test('mode absent: refuse, ne devine pas', () => {
  assert.throws(() => resoudreContexteDepot({}), (e) => e.code === 'context_mode_missing');
});

test('mode repo sans depot: echec nomme, jamais process.cwd()', () => {
  assert.throws(
    () => resoudreContexteDepot({ mode: MODES.REPO, getUiContext: () => ({ activeRepoPath: null }) }),
    (e) => e.code === 'repo_context_missing',
  );
});

test('chemin inexistant: echec nomme', () => {
  assert.throws(
    () => resoudreContexteDepot({ mode: MODES.REPO, cwd: path.join(os.tmpdir(), 'absent-' + Date.now()) }),
    (e) => e.code === 'repo_context_missing',
  );
});

test('un FICHIER au lieu d un depot: echec nomme', () => {
  const f = path.join(os.tmpdir(), 'fichier-' + Date.now() + '.txt');
  fs.writeFileSync(f, 'x');
  assert.throws(
    () => resoudreContexteDepot({ mode: MODES.REPO, cwd: f }),
    (e) => e.code === 'repo_context_missing',
  );
});

test('un repertoire qui n est pas un depot Git: echec nomme', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pasgit-'));
  assert.throws(
    () => resoudreContexteDepot({ mode: MODES.REPO, cwd: d }),
    (e) => e.code === 'repo_context_missing',
  );
});

test('depot different de celui demande: repo_context_mismatch', () => {
  const d = depotJetable();
  assert.throws(
    () => resoudreContexteDepot({ mode: MODES.REPO, cwd: d, repo: 'un-autre-depot' }),
    (e) => e.code === 'repo_context_mismatch',
  );
});

test('depot valide: rend cwd, repo, commit et etat sale', () => {
  const d = depotJetable();
  const c = resoudreContexteDepot({ mode: MODES.REPO, cwd: d });
  assert.strictEqual(c.mode, 'repo');
  assert.strictEqual(c.repo, path.basename(fs.realpathSync(d)));
  assert.match(c.commit, /^[0-9a-f]{40}$/);
  assert.strictEqual(typeof c.sale, 'boolean');
});

test('un SOUS-REPERTOIRE explicite est HONORE, mais rattache a son depot', () => {
  // Ce test affirmait d abord que la racine remplacait le sous-repertoire.
  // C etait MOI qui avais tort: un appelant qui donne un chemin precis --
  // worktree, sous-projet -- sait ce qu il veut, et l ecraser casserait son
  // intention. Ce qui doit etre resolu, c est le DEPOT auquel il appartient,
  // pour que la detection d incoherence fonctionne.
  const d = depotJetable();
  const sous = path.join(d, 'a', 'b');
  fs.mkdirSync(sous, { recursive: true });
  const c = resoudreContexteDepot({ mode: MODES.REPO, cwd: sous });
  assert.strictEqual(fs.realpathSync(c.cwd), fs.realpathSync(sous));
  assert.strictEqual(c.repo, path.basename(fs.realpathSync(d)));
  // Et le rattachement sert vraiment: un depot demande different est refuse.
  assert.throws(
    () => resoudreContexteDepot({ mode: MODES.REPO, cwd: sous, repo: 'autre-depot' }),
    (e) => e.code === 'repo_context_mismatch',
  );
});

test('un chemin AVEC ESPACES est accepte', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'symph-'));
  const avecEspace = path.join(base, 'mon depot a moi');
  fs.mkdirSync(avecEspace);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: avecEspace, env, stdio: 'pipe' });
  fs.writeFileSync(path.join(avecEspace, 'a.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: avecEspace, env, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'c'], { cwd: avecEspace, env, stdio: 'pipe' });
  const c = resoudreContexteDepot({ mode: MODES.REPO, cwd: avecEspace });
  assert.ok(c.cwd.includes('mon depot a moi'));
});

test('mode neutre: espace NOMME, jamais process.cwd()', () => {
  const neutre = fs.mkdtempSync(path.join(os.tmpdir(), 'neutre-'));
  const c = resoudreContexteDepot({ mode: MODES.NEUTRAL, espaceNeutre: neutre });
  assert.strictEqual(c.cwd, neutre);
  assert.notStrictEqual(c.cwd, process.cwd());
  assert.strictEqual(c.repo, null);
});

// --- LE TRANSPORT JUSQU AUX CONSOMMATEURS --------------------------------

test('l orchestrateur RECOIT getUiContext -- sans quoi tout dispatch echoue', () => {
  // Le mount recevait `getUiContext` et ne le transmettait pas au constructeur:
  // un parametre qui n atteint pas son consommateur. La primitive resolvait
  // alors `null` a chaque fois.
  const d = depotJetable();
  const o = orchestrateur(d);
  assert.strictEqual(typeof o.getUiContext, 'function');
  assert.strictEqual(o._depotActifDisponible(), true);
});

test('sans depot actif ni cwd: mode neutre, pas process.cwd()', () => {
  const o = orchestrateur(null);
  const c = o.resoudreContexte({});
  assert.strictEqual(c.mode, 'neutral');
  assert.notStrictEqual(c.cwd, process.cwd());
});

test('avec depot actif: le contexte porte ce depot', () => {
  const d = depotJetable();
  const o = orchestrateur(d);
  const c = o.resoudreContexte({});
  assert.strictEqual(c.mode, 'repo');
  assert.strictEqual(fs.realpathSync(c.cwd), fs.realpathSync(d));
});

test('le cwd EXPLICITE prime sur le depot actif (worktree isolee)', () => {
  const actif = depotJetable();
  const isole = depotJetable();
  const o = orchestrateur(actif);
  const c = o.resoudreContexte({ cwd: isole });
  assert.strictEqual(fs.realpathSync(c.cwd), fs.realpathSync(isole));
});

test('mode repo IMPOSE sans depot: echec explicite et diagnosticable', () => {
  const o = orchestrateur(null);
  assert.throws(() => o.resoudreContexte({ mode: 'repo' }), (e) => {
    assert.ok(e instanceof ErreurContexteDepot);
    assert.strictEqual(e.code, 'repo_context_missing');
    assert.match(e.message, /aucun depot actif/);
    return true;
  });
});

test('LES DEUX SINKS appellent la primitive -- pas seulement les routes', () => {
  // Treize sites d appel convergent vers `spawnHeadless` et `spawnVisible`.
  // Trois ne passent par aucune route: jobs-scheduler, escalation, lifecycle.
  const headless = fs.readFileSync(path.join(__dirname, 'spawn-headless.js'), 'utf8');
  const visible = fs.readFileSync(path.join(__dirname, 'spawn-visible.js'), 'utf8');
  assert.match(headless, /this\.resoudreContexte\(/);
  assert.match(visible, /this\.resoudreContexte\(/);
});

test('AUCUN sink ne retombe silencieusement sur process.cwd() pour le cwd du worker', () => {
  const headless = fs.readFileSync(path.join(__dirname, 'spawn-headless.js'), 'utf8');
  const visible = fs.readFileSync(path.join(__dirname, 'spawn-visible.js'), 'utf8');
  // `cwd || process.cwd()` etait le repli exact qui envoyait les workers dans
  // Symphonee. Il ne doit plus decider du repertoire du processus.
  assert.doesNotMatch(headless, /cwd:\s*cwd\s*\|\|\s*process\.cwd\(\)/);
  assert.doesNotMatch(visible, /createTerminal\([^)]*cwd\s*\|\|\s*process\.cwd\(\)/);
});
