# Mission Codex — Autopilotes Claude → Qwen et refonte de la page Autopilote
Date du brief : 2026-11-14. Dépôt : `kurtisv/Symphonee`.

## Livrable et portée
IMPLÉMENTER le code, les tests et le design réellement fonctionnel ; ouvrir une **PR en brouillon**. NE PAS fusionner, déployer, redémarrer ni reconfigurer les pilotes actifs sans accord final. Pilotes : `default` (Principale / Symphonee) et `gas-saver` (Gas Saver). Ne pas changer le fonctionnement scientifique de PleinSens, de la porte de fusion ou des autres tâches externes.

## Audit initial obligatoire
1. Synchroniser **le dernier `master`** (ne pas coder sur cette branche). Base vérifiée lors de la rédaction : `edf4c7b465c5bc9e3f2b1fdd65835df8d4c726a8` ; vérifier si elle a changé.
2. Inspecter prioritairement :
   - `dashboard/mind/autopilot.js`, `autopilot-budget.js`, `usage-capacity.js`, `autopilot-verify.js`, `AUTOPILOT.md`, `autopilot.test.js`, `autopilot-integration.test.js`.
   - `dashboard/orchestrator/provider-health.js`, `task-router.js`, `escalation.js`, `spawn-headless.js`, `task-store.js`, `cli-config.js`, `local-providers.js`.
   - `dashboard/automation/loops-status.js`, `plain-summary.js`, `dashboard/public/mind-ui/src/autopilot.js`, `router.js`, `dashboard/server.js`, `scripts/build-renderer.js`.
3. Vérifier les contrats API, le WebSocket, les tests et les changements récents. Ne pas ajouter de deuxième orchestrateur ni de deuxième ledger.
4. Constats à confirmer : dans `dispatch()`, `discover/implement/repair` sont fixés à Claude, `plan-review/code-review` à Codex ; options `noFallback:true` et `noRetry:true` ; `parkForCredit()` suspend au quota ; `usage-capacity.js` examine seulement les fenêtres Claude et Codex ; le tableau de bord affiche encore des textes Claude-only, et plusieurs endpoints avec actualisation périodique. Ne pas supposer que ces constats restent vrais après évolution du code.

## Lot 1 — Relève sécurisée de Claude par Qwen Code
- Profil par pilote, **rétrocompatible et opt-in** : auteur principal `claude`, secours `qwen` (Qwen Code **cloud**, différent des Qwen LM Studio 1.5B et 7B), relecteur indépendant `codex`. Désactivé par défaut tant que non autorisé.
- Consentement explicite séparé pour autoriser Qwen à écrire dans le worktree ET pour d'éventuels coûts cloud (ne pas réutiliser automatiquement l'ancien consentement Claude). Vérifier la disponibilité Qwen, l'authentification, la permission d'exécution, la compatibilité du rôle, le budget, et la capacité de revue Codex. Pas de dépense implicite.
- Basculer seulement sur **épuisement réel de quota/limite d'utilisation** (ou catégories additionnelles explicitement activées) : classifier proprement quota, rate limit, auth, contexte trop grand, réseau, erreurs de code/tests et sécurité. Une mauvaise réponse, un échec de revue ou une violation de sécurité ne déclenche jamais une bascule de contournement.
- **Handoff idempotent** : dès l'échec Claude, arrêter et vérifier la terminaison de l'arbre de processus Claude sur Windows ; aucune écriture concurrente dans le même worktree ; sauvegarder plan approuvé, état du diff/empreintes, checkpoints, commandes déjà tentées, tests et erreurs ; créer un paquet de reprise borné et sans secrets ; Qwen reprend le **même worktree**, pas une autre branche concurrente. Une seule bascule par étape par défaut ; doublons d'événements ignorés ; état incertain => arrêt contrôlé.
- Pour `discover`, conserver le format et `parsePlan` ; pour `implement/repair`, conserver les restrictions de chemins, permissions, base SHA, revue et vérification. Si Qwen écrit, Codex relit. Si Codex n'est pas disponible : attendre, ne JAMAIS marquer PASS.
- Ne pas interrompre Qwen lorsqu'une limite Claude se réinitialise ; réévaluer Claude seulement à la **prochaine frontière d'étape/tâche**. Aucun ping payant en boucle.
- Préserver le comportement actuel des deux autopilotes (une seule tâche intensive globale ; arrêt sécurité ; aucun push/merge/deploy par autopilote), sauf fonctionnalités opt-in.
- Persister fournisseur initial/actuel, reason/time, nombre de bascules, taskId, stage, worktree, empreinte, checkpoint, quota/budget et nextAction. Redémarrer sans double dispatch et sans rejouer les étapes approuvées. Respecter l'état in-flight des deux pilotes.

## Lot 2 — Quotas et observabilité
- Étendre `autopilot-budget.js` et `usage-capacity.js` sans confondre budget interne (réservation de tokens) et quota réel du fournisseur.
- Claude/Codex : conserver la lecture des *pourcentages de fenêtres* et leurs temps de réinitialisation, sans les convertir fictivement en tokens disponibles.
- Qwen : lecture fiable si possible, sinon `unknown`. Ne pas attribuer `0` ou « illimité » aux données absentes. Politique de plafond explicite et contrôles des coûts éventuels.
- Réserver la capacité du relecteur Codex même si l'auteur devient Qwen.
- Fournir au tableau de bord mesures réelles vs estimations vs inconnues, dernier état provider, prochain essai, provenance de la lecture, fraîcheur, et événement `claude -> qwen` horodaté.

## Lot 3 — Refonte complète de l'interface Autopilote
La page actuelle est lourde et technique. Créer une page de contrôle *réellement actualisée*, sans gros framework supplémentaire, avec le thème/variables existants, responsive et WCAG AA.
1. En-tête « Centre de contrôle des autopilotes » et synthèse : pilotes actifs, tâches en cours, tâches terminées aujourd'hui, interventions requises, heure du dernier état fiable.
2. Deux cartes Principale/Gas Saver : statut compréhensible (actif, travaille, attend la plage, quota, erreur, désactivé), dépôt, tâche en cours, agent réel (Claude/Qwen/Codex), étape, durée, prochain passage, dernier résultat, actions utiles. Bouton « Arrêter » avec confirmation.
3. Pipeline lisible : Découverte → Revue du plan → Implémentation → Vérification → Revue Codex → Terminé, avec statut + agent par étape, indication claire de la bascule Claude→Qwen, sa raison et son heure.
4. Historique simple et filtrable. Distinction **travail local terminé ≠ PR créée ≠ PR fusionnée ≠ CI post-fusion verte ≠ déploiement vérifié** ; jamais « En production » sans preuve d'intégration/deploy. Garder les services PleinSens, porte de fusion et veille visibles, mais ne pas modifier leurs moteurs.
5. Paramètres avancés dans une section repliable : horaires, objectifs, repos, quotas, modèles, fallback, permissions, worktrees, commandes, logs. Informations sensibles non affichées.
6. Accessibilité : contrôles au clavier, ARIA, non-dépendance à la couleur, contrastes, états vides/chargement/erreur/périmé, fenêtres étroites ; aucun bouton purement décoratif. Captures comparatives avant/après sur l'application réelle Windows.

## Lot 4 — Actualisation et source de vérité
Revoir `GET /api/mind/autopilot`, `GET /api/mind/autopilots`, `GET /api/automation/loops`, `/detail`, `/summary` et WebSocket `mind-update`. Normaliser les états côté serveur avec horodatage et origine :
- Les réponses plus anciennes ne doivent jamais écraser l'état le plus récent ou celui d'un autre pilote.
- Ne pas afficher « travaille » si la boucle attend sa plage.
- Montrer clairement l'attente de quota Claude même si Qwen a repris.
- Une source inaccessible/périmée ne doit pas apparaître « à jour » ; WebSocket + polling de secours raisonnable, sans rafraîchissements concurrents inutiles.
- Les décisions de sécurité/CI/PR et leur état sont déterministes, jamais devinés par le modèle.

## Tests / validation obligatoires
**Tests rouges avant correctifs**, puis verts. Simulations déterministes et sans vrais appels payants :
1. Claude disponible ; quota réel déclenche Qwen ; Qwen absent/auth refusée/budget bloqué ; autre erreur ne déclenche pas ; doublon quota ne lance pas deux processus ; quota Codex attend la revue ; pas de baisse de qualité.
2. Reprise du même worktree après fin prouvée du processus ; deux pilotes exclusifs ; protection des chemins/checkout ; absence de diff et échec des tests ; pas de PASS sans revue ; crash/restart idempotent ; retour à Claude à frontière d'étape.
3. Tests unitaires API/état/frontend : sélection pilote pendant polling, réponse obsolète, perte WS, fraîcheur, statuses, quotas inconnus, boutons fonctionnels, responsive et clavier.
4. Suites ciblées et suite appropriée du dépôt ; build officiel (inspecter `node scripts/build-renderer.js`) ; test Windows contrôlé et preuves. Ne pas déclencher d'appels réseau facturables pour simuler des limites.
5. Revue indépendante adversariale ; pas de suppression/affaiblissement de tests, permissions ou CI.

## Séquence de livraison
Audit et note de conception → contrats → tests rouges → moteur + persistance → quotas/API → refonte UI → tests et captures Windows → revue indépendante.
Éviter les loops de corrections sans bornes et les répétitions de revues sur le même SHA. Créer une branche distincte `codex/autopilot-qwen-fallback-dashboard` (ou variante si existante), des commits cohérents par lot et une PR **DRAFT** contenant résultats vérifiables, exemples de fallback, screenshots, limites, rollback, activation opt-in par pilote.

### Interdictions et condition d'arrêt
Ne modifier ni l'état local des autopilotes actifs ni les données de production pendant l'implémentation. Aucun merge, push sur `master`, déploiement, changement des autorisations réelles ou restart sans accord humain final. Si preuve/test/permission manque, documenter le blocage et laisser la PR en brouillon.

**C'est une demande d'implémentation complète, pas un exercice de planification.**
