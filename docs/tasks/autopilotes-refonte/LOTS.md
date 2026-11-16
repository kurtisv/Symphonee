# Refonte de la page Autopilotes : backlog en lots

Source de verite fonctionnelle : `SPECIFICATION_UX.md` (meme dossier), 26 sections. Reference visuelle : `maquette-reference.png`.
**La maquette n'est pas une capture de l'application reelle** : aucun de ses chiffres, horaires, statuts, pourcentages, versions ou dates ne doit etre repris.

Ce fichier decoupe la refonte en lots petits, ordonnes et verifiables, pour qu'un autopilote (une tache a la fois, 2 a 3 par jour)
puisse les realiser sans jamais fusionner. Chaque lot tient sur une ligne du tableau ci-dessous, puis est detaille plus bas.

## Backlog (une ligne par lot, par ordre d'execution)

- P0 | L0 | Faire tourner les tests `.test.mjs` de la page dans `npm run test:renderer` | aucun | details : section L0
- P0 | L1 | Modele de donnees unifie des boucles (module pur `autopilot-model.js`, sans UI) | L0 | details : section L1
- P0 | L2 | Fraicheur des donnees : valeur recue, date, indicateur "perimee", jamais de retour a zero | L1 | details : section L2
- P0 | L3 | Supprimer les deux listes codees en dur `['default','gas-saver']` et piloter la page par le modele | L1 L2 | details : section L3
- P0 | L4 | Cartes des boucles : vue d'ensemble dynamique, typee, avec actions autorisees par type | L3 | details : section L4
- P0 | L5 | Calendrier 24 h : frise, segments prevus vs observes, curseur "maintenant", minuit, chevauchements | L3 | details : section L5
- P0 | L6 | Quatre cartes KPI avec formules documentees et etats chargement/vide/perime/erreur | L2 L3 | details : section L6
- P1 | L7 | Jetons de design, echelle typographique, grille responsive et mouvement reduit | L3 | details : section L7
- P1 | L8 | Barre superieure : titre, etat global honnete, horloge locale fr-CA, materiel mesure ou "non disponible" | L2 L7 | details : section L8
- P1 | L9 | Tache en cours : chemin d'etapes reel, raisons de pause, reprise uniquement si permise | L4 | details : section L9
- P1 | L10 | Journal : evenements reels, filtres, phrase humaine pour les erreurs, masquage des secrets | L9 | details : section L10
- P1 | L11 | Depot et securite : cinq lignes de preuve, grise/ambre/verte/rouge, jamais verte par defaut | L9 | details : section L11
- P1 | L12 | Activite recente : fil unifie, filtre, regroupement des repetitions, avis de peremption | L10 | details : section L12
- P1 | L13 | Ecosysteme IA : Qwen (local), Mind, Claude, Codex selon preuves reelles | L8 | details : section L13
- P1 | L14 | Apprentissage : lecons Mind, dix categories de competences, indicateurs, entrainement non configure | L13 | details : section L14
- P1 | L15 | Onglets Apercu, Executions, Taches, Apprentissage, Resultats, Configuration dans le sous-onglet existant | L4 L9 L14 | details : section L15
- P1 | L16 | Mobile et tablette : ordre de priorite, panneaux repliables, zero defilement horizontal | L7 L15 | details : section L16
- P1 | L17 | Accessibilite et securite : clavier, aria-live, echappement de tous les champs, validation des chemins | L15 | details : section L17
- P1 | L18 | Documentation, captures avant/apres (fixtures signalees), build officiel et rapport de risques | L16 L17 | details : section L18

## Regles communes a tous les lots

Contexte du code (verifie sur master a604145) :
- La page est `dashboard/public/mind-ui/src/autopilot.js` (environ 600 lignes, une grande fonction `paint()`), avec `autopilot-state.js`
  (`createSnapshotStore`) et `latest.js` (`makeLatest`). Les sources sont a modifier ; `dashboard/public/mind-ui.js` est un fichier GENERE par
  `node scripts/build-renderer.js` (ne jamais l'editer a la main, le regenerer et le commiter avec le lot).
- Boucles : `GET /api/automation/loops` (pilotes, boucle PleinSens, services ; code dans `dashboard/automation/loops-status.js`),
  `GET /api/mind/autopilots`, `GET /api/mind/autopilot?pilot=<id>` (instantane : status, active, history, events, today, budget, limits, nextAt).
  Detail PleinSens : `GET /api/automation/loops/detail?id=`. Resume en clair : `GET /api/automation/loops/summary?loop=`.
- Qwen et Mind : `dashboard/mind/qwen-skills-ledger.js` (dix categories), `dashboard/mind/lessons.js`, `dashboard/orchestrator/QWEN_REAL_REPO.md`.

Interdits (ils s'appliquent a chaque lot) :
- Ne modifier ni les horaires, ni les identifiants, ni les missions, ni les etats des boucles existantes ; ne pas toucher `.symphonee/`.
- Aucune valeur inventee : tout chiffre, horaire, statut, version ou date vient d'une donnee reelle fraiche, sinon "Indisponible", "Aucune donnee",
  "Non mesure" ou "En attente". Pas de coche verte sans preuve. Pas de barre de progression sans ratio reel (par exemple 3/5).
- Ne pas creer d'orchestrateur, de memoire, ni de nouvelles boucles. Ne pas appeler un POST pour simplement afficher une carte.
- Aucun redemarrage, fusion, push ou deploiement. Une boucle de graphe ou un service ne recoit jamais les commandes d'un pilote Mind.
- Echapper tous les champs venant des taches, titres et journaux. Pas de nouveau jeton expose dans le navigateur.

Definition de "termine" pour un lot (a ecrire dans le rapport du lot, sans confondre) : code ecrit ; tests ecrits et executes avec les chiffres reels ;
`node scripts/build-renderer.js` execute et son resultat commite ; revue independante PASS ; les etapes suivantes (PR, fusion, deploiement)
restent humaines.

Verification de chaque lot : `node --test --test-force-exit` sur les tests de la page, puis `npm run test:renderer` et `npm run test:server`
(les nombres de tests doivent etre rapportes tels qu'observes). Les nouveaux tests unitaires sont des `.test.mjs` a cote de la source
(apres L0 ils tournent dans la suite officielle).

Ordre : les lots sont sequentiels. Chaque lot demarre depuis la base de l'autopilote et non depuis le lot precedent : un lot qui depend d'un autre
n'est pris qu'une fois ce dernier fusionne par un humain dans la branche d'integration.

## Details des lots

### L0 Tests de la page dans la suite officielle
Probleme : `npm run test:renderer` ne cible que `*.test.js`, alors que les tests de la page sont `autopilot-interaction.test.mjs`,
`autopilot-state.test.mjs` et `latest.test.mjs` : ils ne tournent pas dans la suite officielle.
Livrable : le script `test:renderer` de `package.json` inclut `dashboard/public/**/*.test.mjs`. Acceptation : les trois fichiers apparaissent dans la sortie ;
les nombres avant/apres sont rapportes ; rien d'autre ne change.

### L1 Modele de donnees unifie
Livrable : `dashboard/public/mind-ui/src/autopilot-model.js`, module pur sans DOM ni reseau. Entrees : reponse de `/api/automation/loops`,
liste `/api/mind/autopilots`, instantanes par pilote. Sortie : liste de vues de boucle avec `id`, `kind` (`pilot-mind`, `graph`, `service`), `label`,
`status` canonique (running, ready, waiting-window, quota-pause, ram-pause, interrupted, stopped, error, unknown), `statusLabel`, `mission`,
`window` (`{start,end}` ou null), `task`, `agent` (prouve ou null), `next`, `progress` (`{done,total}` ou null), `actions` (liste autorisee pour ce type), `receivedAt`.
Acceptation : aucun identifiant code en dur ; tests sur fixtures pour 0, 1, 2, 3 et 5 boucles, champs manquants, fenetre passant minuit,
boucle de graphe sans actions de pilote, service en lecture seule.

### L2 Fraicheur des donnees
Livrable : pour chaque source, `{value, receivedAt, stale}`. En cas d'echec reseau la derniere valeur est conservee et marquee "Derniere valeur recue a ... : perimee".
Reutiliser `createSnapshotStore` et `makeLatest`. Acceptation : tests de reponses HTTP en retard, d'un evenement WebSocket plus recent, d'une coupure puis d'une reprise ;
aucune valeur ne retombe a zero ou "arrete" sur simple echec.

### L3 Page pilotee par le modele
Probleme : `autopilot.js` construit deux cartes en dur avec `['default','gas-saver']` (chargement et panneau d'interventions).
Livrable : ces deux endroits utilisent la liste du modele L1. Acceptation : avec trois, deux ou une seule boucle la page s'adapte ; le comportement des controles
existants (Activer, Arreter, Verifier, Lancer maintenant, Reprendre, Archiver) est inchange ; tests d'interaction existants au vert.

### L4 Cartes des boucles
Livrable : vue d'ensemble dynamique (specification, section 7), dans l'ordre : nom et type de source, statut precis, mission en deux lignes (detail au clic),
creneau reel ou "Creneau non fourni", tache actuelle ou "aucune tache", agent prouve, prochain creneau ou "non determine", progression seulement avec ratio reel,
menu des actions autorisees pour ce type. L'attente d'un creneau n'est jamais presentee comme une erreur. Selectionner une carte n'execute rien.
Acceptation : un pilote Mind, une boucle PleinSens et un service sont tous presentes correctement, sans faux compteur de "3 actifs".

### L5 Calendrier 24 h
Livrable : fonction pure `timelineSegments(loops, now)` testee, puis rendu : regle 00:00 a 24:00 toutes les 4 h, une ligne par boucle, couleur differente par boucle avec
legende en texte, curseur "maintenant" issu de l'horloge locale, segments "prevu" distincts des executions "observees" (tirees de l'historique et des evenements),
creneaux passant minuit, signalement "concurrence de fenetres : execution serialisee" sans rien deplacer, infobulle au survol et au focus.
Interdits : aucune redistribution des 24 h, aucune sauvegarde d'horaire. Sans horaires : "Impossible de charger les horaires depuis Symphonee". Tests : 22:00-04:00, 14:00-19:00, 08:00-13:00 et un chevauchement.

### L6 Cartes KPI
Livrable : quatre cartes (boucles actives, taches en cours, travaux verifies sur 24 h, nouvelles lecons Mind certifiees sur 24 h) avec la formule ecrite en commentaire
et dans `LOTS.md`. "Activee" est distinct de "execute reellement une tache". Les travaux verifies precisent leur niveau (verification locale + revue independante PASS) et
"locaux, non fusionnes". Etats : chargement, vide, perime, erreur. Acceptation : tests de chaque formule sur fixtures ; aucune valeur remise a zero apres un echec.

### L7 Jetons de design et responsive
Livrable : variables CSS (fond, panneaux, violet, bleu, vert reserve aux preuves, ambre, rouge) reutilisant les jetons de theme existants quand ils existent ; echelle typographique
(titre 24-28, panneau 16-18, metadonnees au moins 12 px) ; espacements de 4 et 8 px ; points de rupture 390, 768, 1280 et 1600 ; `prefers-reduced-motion` ; focus visible.
Acceptation : test d'equilibre du CSS ; aucun texte de moins de 12 px pour une information utile ; contraste verifie dans les themes clair et sombre.

### L8 Barre superieure
Livrable : titre et sous-titre ; fonction pure d'etat global ("Operationnel" seulement si tout le necessaire est verifie, sinon "Partiellement disponible", "Verification en cours",
"Hors ligne", "Donnees perimees" ou "Intervention requise") ; date et heure de l'horloge locale au format fr-CA ; heure de la derniere reponse fiable ; materiel :
modele reellement charge (route existante `/api/orchestrator/local-health`) ou "Donnees materielles non disponibles" (pas de jauge inventee). Tests de chaque etat.

### L9 Tache en cours
Livrable : nom exact de la tache, agent reel, depot, branche, chemin de worktree raccourci ; chemin d'etapes (discover = Analyse, plan-review = Plan, implement = Code,
verify = Tests, code-review = Revue independante ; "Apprentissage" seulement s'il existe un evenement Mind) avec reparations et `budget-wait` ; raison exacte d'une pause
(fenetre, credit, RAM, redemarrage, intervention humaine) ; tache interrompue : dernier worktree fiable et "Reprendre" seulement si permis ; sans tache : "Aucune tache en cours ; prochaine verification ...".
"Ouvrir le worktree" n'existe que s'il y a une action locale autorisee, jamais une navigation vers un chemin arbitraire.

### L10 Journal
Livrable : derniers evenements reels (`at`, `kind`, `msg`, `stage`, `taskId`, `cli`), ordre chronologique, retour a la ligne, filtre par source (Qwen, Claude, Codex, Tests, Mind, Orchestrateur)
et par gravite, copie des extraits, "Voir tout le journal". Une erreur est d'abord traduite en phrase humaine, le detail brut ensuite. Secrets, jetons et chemins complets masques par defaut.
Sans flux : "Journal non disponible pour cette execution". Tests : masquage, filtres, vide.

### L11 Depot et securite
Livrable : cinq lignes (worktree isole, depot principal protege, tests avant validation, verification independante, lecons enregistrees), chacune grise, ambre, verte ou rouge selon la preuve de la tache
selectionnee (chemin et empreinte d'origine, empreinte du checkout principal, commandes de verification reelles avec code de retour, verdict de revue avec identite, stockage Mind). Jamais verte par defaut.
Un clic ouvre les preuves disponibles, il ne modifie aucune garantie. Tests : chaque ligne dans chaque etat.

### L12 Activite recente
Livrable : fil unifie (evenements et historique) trie par horodatage reel decroissant, filtre (Tous, Qwen, Claude, Codex, Mind, Erreurs), regroupement des repetitions purement techniques,
lien vers la tache, avis "evenements perimes" si la connexion n'est plus fraiche. Les heures de la maquette ne sont jamais reprises.

### L13 Ecosysteme IA
Livrable : lignes Qwen (modele reellement charge s'il est connu, local ou cloud, lequel des trois modes : developpeur local sur vrai depot, suggestions seulement, Qwen Code cloud), Mind (joignable, lecons certifiees
ou observations), Claude, Codex (GO seulement pour une revue precise effectuee). Pastilles : vert preuve de sante, bleu occupe, ambre inconnu, rouge defaillance, gris non utilise. Chaque ligne s'ouvre sur ses preuves.
Pas de quota cloud pour le modele local ; pas d'entrainement LoRA affiche comme actif.

### L14 Apprentissage
Livrable : lecons Mind avec statut (Observation, Enseignement, Certifiee, Expiree, Obsolete), provenance (fixture ou vrai depot), preuves et limites ; anneau `N/10` calcule depuis les dix categories de
`qwen-skills-ledger.js` (pas fixe a zero) ; quatre indicateurs (taches inedites, reussite autonome, lecons dans Mind, transfert observe) avec definitions ecrites et sans double comptage ; "Pourquoi cette lecon n'a-t-elle pas ete utilisee ?"
quand une decision d'applicabilite existe ; entrainement : "Entrainement non configure / non execute". Une lecon Mind n'est jamais presentee comme un reglage des poids.

### L15 Onglets
Livrable : Apercu, Executions, Taches, Apprentissage, Resultats, Configuration, comme vues du meme sous-onglet, en conservant le pilote selectionne, le filtre et le defilement. Executions : cycles reels (id, tache, depot, debut, duree,
etape, agent, resultat). Taches : en cours, en attente ou a reprendre, terminees ou a examiner, avec le statut exact. Resultats : statuts separes (local, revue PASS, PR ouverte, fusionne, deploye), chacun avec sa source ; graphiques
seulement avec assez de donnees. Configuration : reorganise les controles existants sans perdre leurs garanties ; les trois options Qwen restent distinctes ; aucun redemarrage ni changement d'horaire a la simple visite.
Ce lot peut etre pris en sous-lots (une vue a la fois).

### L16 Mobile et tablette
Livrable : sur 390 px, navigation repliable, une carte par ligne, ordre etat global, alertes, boucle active, autres boucles, tache en cours, prochaine plage, details ; Mind et journal derriere une ouverture explicite ;
aucun tableau qui force un defilement horizontal. Verification aux largeurs 390x844, 768x1024, 1280x900 et 1600x900.

### L17 Accessibilite et securite
Livrable : parcours clavier complet (Tab, Entree, Echap), titres hierarchises, `aria-live` reserve aux changements importants, etats annonces autrement que par la couleur, cibles tactiles suffisantes,
audit d'echappement de tous les champs (taches, titres, journaux), URLs et chemins valides. Tests ciblant les injections de HTML dans chaque champ affiche.

### L18 Documentation, captures et build
Livrable : `node scripts/build-renderer.js` execute et son resultat commite ; captures avant/apres produites a partir du renderer (les fixtures sont signalees comme telles) a 390, 768, 1280 et 1600 px ;
liste des donnees manquantes et des branchements backend a prevoir au plus petit perimetre ; SHA exact ; analyse de risques et de retour arriere. Aucune fusion, aucun redemarrage, aucune modification des horaires.
