# Fusion automatique encadree - Symphonee

FUSION_AUTOMATIQUE_ENCADREE_V1

Autorisee par Kurtis le 2026-11-13 : les taches terminees par l autopilote
Principale peuvent etre fusionnees dans `master` par la porte de fusion
(`dashboard/automation/merge-gate.js`, politique `config/merge-gate.json`).

Conditions (toutes obligatoires) :
- revue Codex `VERDICT: PASS` et commit exact du worktree revu ;
- chemins interdits non touches, taille limitee, aucun secret ;
- suites de tests serveur et interface vertes sur la fusion exacte avec `master` ;
- une fusion a la fois, rythme limite.

Aucun deploiement ni installation n est automatique : fusionner dans `master`
ne change pas le Symphonee installe. Retirer ce fichier (ou son marqueur)
arrete la fusion automatique sur ce depot.

(Place a la racine : le dossier docs/ est ignore par git dans ce depot.)
