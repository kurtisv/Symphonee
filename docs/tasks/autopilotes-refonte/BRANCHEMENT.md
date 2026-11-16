# Brancher la refonte sur l'autopilote Principale

Ce document n'est pas lu par l'autopilote (il n'est pas dans `sources.files`). Il decrit comment le brancher, apres accord. Rien n'est applique par ce commit.

## Etat constate le 2026-11-15 (lecture seule)

Pilote `default` (libelle "Principale") :
- active, statut `waiting`, etape `budget-wait` en attente de la revue de code, avec une tache deja en vol : correctif des routes MCP (`dashboard/mcp/mcp-server.js`) ;
- fenetre 14:00-19:00 ; profil `standard` ; ambition `small` ; limites par defaut (3 taches reussies par jour) ; Qwen active ;
- depot vise : "Symphonee (source)" ; objectif general ("corriger des defauts prouves, optimiser, nettoyer, ajouter des tests") ; `sources.files` vide ; pas de `baseRef` ;
- verification locale : `tests-serveur` et `tests-interface` ; aucun chemin protege.

Mecanisme (voir `dashboard/mind/AUTOPILOT.md` et `dashboard/mind/autopilot.js`) :
- une decouverte en lecture seule choisit UNE tache, Codex relit le plan, l'implementation se fait dans un worktree isole, Codex relit le diff, le resultat est garde pour une revue humaine ;
  l'autopilote ne fusionne, ne pousse ni ne deploie jamais ;
- avec l'ambition `big`, il peut prendre "la premiere tranche autonome" d'un probleme plus grand ; avec `sources.files`, il lit en priorite les lignes P0 et P1 de ces fichiers ;
- chaque tache part de `baseRef` (ou de la tete du depot), jamais de la tache precedente : un lot qui depend d'un autre attend que celui-ci soit fusionne par un humain.

## Contrainte decouverte : ou doit se trouver le backlog

`extractPriorities(repoPath, files)` lit `path.join(repoPath, fichier)` : le fichier doit exister dans le dossier du depot cible. Le chemin absolu n'est pas pris en charge.
Pour "Symphonee (source)", c'est le checkout principal, qui contient du travail non commite. Trois options :

| Option | Principe | Avantage | Inconvenient |
|---|---|---|---|
| A (recommandee) | Enregistrer ce worktree (branche `claude/autopilotes-refonte`) comme depot "Symphonee (refonte autopilotes)" et viser ce depot | n'ecrit rien dans ton checkout principal ; branche d'integration isolee ; pas de `baseRef` a configurer | le pilote Principale change de depot vise ; les taches generales de maintenance de Symphonee sont suspendues tant que dure la refonte |
| B | Copier `docs/tasks/autopilotes-refonte/` comme fichiers non suivis dans le checkout principal | garde le depot "Symphonee (source)" | ecrit dans un dossier ou tu as du travail en cours ; les taches partent de la tete de ta branche de travail, sans le code recent |
| C | Basculer le checkout principal sur la branche d'integration | tout est au bon endroit | impossible sans mettre ton travail en cours de cote |

## Configuration proposee pour l'option A (a appliquer seulement apres accord)

Prealables :
1. Decider du sort de la tache MCP en vol : la laisser finir, ou l'archiver (`POST /api/mind/autopilot/acknowledge`, le worktree est conserve).
2. Enregistrer le depot : `POST /api/repos {"name":"Symphonee (refonte autopilotes)","path":"C:/Users/kurtis verres/source/Symphonee-autopilotes-refonte"}` (ou `scripts/Add-Repo.ps1`).

Definition du pilote (a renvoyer INTEGRALEMENT, la route remplace tout ; l'horaire et le reste sont recopies tels quels) :
- `id` : `default`, `label` : `Principale`, `schedule` : `{"start":"14:00","end":"19:00"}` (inchange), `qwen` : `{"enabled":true}` (inchange), `profile` et `verify` : inchanges ;
- `ambition` : `big` ; `sources` : `{"files":["docs/tasks/autopilotes-refonte/LOTS.md"],"sentry":false}` ;
- `protectedPaths` : au minimum `.symphonee/`, `package-lock.json`, `scripts/Restart-Symphonee.ps1`, `dashboard/server.js`, `dashboard/mind/autopilot.js`, `docs/tasks/autopilotes-refonte/` (le backlog lui-meme) ;
- `limits` : a decider (3 taches par jour avec les valeurs par defaut ; une ambition `big` demande un budget plus large).
Objectif (`goal`, via `POST /api/mind/autopilot/configure` avec `repoName`) : realiser la refonte de la page Autopilotes en suivant `docs/tasks/autopilotes-refonte/LOTS.md` dans l'ordre,
un lot a la fois, sans modifier les horaires des boucles, sans valeur inventee, sans fusion ni deploiement.

## Deroulement ensuite

Un lot reussi donne un worktree et une branche `mind-autopilot/<jour>-<id>` gardes pour relecture. Pour que le lot suivant parte du bon etat, un humain fusionne la branche relue
dans `claude/autopilotes-refonte` (jamais dans `master`). L'ordre des lots est celui du backlog. A la fin, la branche d'integration est relue en bloc et la PR vers `master` reste une decision humaine.

## Risques et retour arriere

- Effort : environ 19 lots ; au rythme de 2 a 3 taches par jour cela prend une a deux semaines, avec relecture humaine entre chaque.
- Qualite visuelle : les lots donnent une base fonctionnelle et honnete ; le polish final (espacements, hierarchie) demandera des passes de relecture sur captures.
- Retour arriere : renvoyer la definition d'origine du pilote (horaire, ambition `small`, `sources.files` vide, depot "Symphonee (source)") ; la branche d'integration peut etre supprimee sans effet sur `master`.
