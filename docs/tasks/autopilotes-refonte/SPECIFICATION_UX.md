# Symphonee — Spécification exhaustive de la refonte « Centre de contrôle des autopilotes »

**Document à transmettre à Claude — conception visuelle, comportement fonctionnel et critères de réception**  
**Référence :** maquette sombre générée dans la conversation ChatGPT du 15 novembre 2026 ; **la maquette n'est pas une capture de l'application réelle.**  
**Code consulté :** `kurtisv/Symphonee`, branche `claude/qwen-teacher-learning`, HEAD observé `660109463424abebf44c5f78f5f03633739664ad`. Revérifier le HEAD au début de l'implémentation.  
**Nature :** proposition de refonte de l'interface existante. Aucun démarrage, aucune fusion ou modification de configuration n'est autorisé par ce seul document.

## 0. Instruction fondamentale à Claude

Tu dois **modifier l'interface existante**, pas construire une nouvelle application, un nouvel orchestrateur, une nouvelle mémoire Mind ni trois nouveaux autopilotes. Lire avant de coder : `dashboard/public/mind-ui/src/autopilot.js`, `dashboard/public/mind-ui/src/autopilot-state.js`, `dashboard/automation/loops-status.js`, `dashboard/mind/autopilot.js`, `dashboard/mind/AUTOPILOT.md`, `dashboard/orchestrator/QWEN_REAL_REPO.md`, les styles, les tests de l'interface, les routes utilisées et la configuration locale **en lecture seule**. Vérifier les composants de navigation et les variables de thème existants.

Les trois boucles qui se partagent une période de 24 h sont **déjà configurées localement** ; conserver leurs identifiants, missions, états et horaires. Le fichier `.symphonee/mind-autopilots.json` est la source de vérité pour les définitions de pilotes, et les autres boucles/services ont leurs propres sources dans le backend. Ne pas confondre les autopilotes de type Mind avec les autres boucles de graphes telles que PleinSens, ni avec les services de surveillance et de fusion. Charger dynamiquement les entrées réelles ; ne jamais recréer artificiellement « AP1 », « AP2 » et « AP3 ».

**Règle absolue de vérité :** la maquette contient plusieurs valeurs inventées pour montrer une mise en page : « 3 actifs », « 1 tâche », « 4 validées », « 1 leçon », « 72 % », les horaires `06:00–14:00`, `14:00–22:00`, `22:00–06:00`, les noms des cartes, les heures du journal, la version, la date et les voyants verts. **Aucune de ces valeurs ne peut être recopiée en dur dans le produit**. Toutes doivent venir d'une preuve backend fraîche, ou être remplacées par « Indisponible », « Aucune donnée », « Non mesuré », « En attente », etc. Le 15 novembre 2026 est un dimanche, pas un samedi : date/heure doivent toujours venir de l'horloge locale et respecter le fuseau réel. Même la couleur verte « opérationnel » n'est admissible que si tous les services nécessaires ont réellement été vérifiés.

## 1. Philosophie générale : l'utilisateur doit comprendre en cinq secondes

Répondre sans défiler à : **(a)** quelles boucles existent et laquelle travaille ; **(b)** sur quelle tâche, dans quel dépôt et avec quel agent ; **(c)** ce qui a été vérifié ou bloqué ; **(d)** quand les autres boucles pourront travailler ; **(e)** s'il faut une intervention humaine. Les détails techniques restent accessibles mais secondaires.

Hiérarchie visuelle : première ligne = santé/alertes et bilan ; deuxième = les vraies boucles et calendrier ; troisième = la tâche active et ses étapes ; panneaux adjacents = IA/Mind, progression, sécurité et activité. Pas de bruit permanent de journal d'exécution au premier regard. Le mot « terminé » doit toujours être qualifié : tâche terminée localement ≠ tests réussis ≠ revue Codex GO ≠ commit présent ≠ PR créée ≠ fusion ≠ déploiement.

## 2. Direction artistique et design system

Inspirée du visuel : ambiance **dark premium technique**, fond bleu-noir très profond, panneaux anthracite/bleu nuit, violet électrique pour la marque et la sélection, bleu clair pour l'activité, vert réservé aux succès prouvés, ambre pour attente/inconnu, rouge pour arrêt/échec. Les néons sont subtils : pas de saturation excessive, pas de gros halos qui gênent la lecture.

- Fond principal approximatif : `#090E1D` à `#0D1325` ; rail latéral un ton plus sombre ; panneaux `#131B30` ou tokens existants. Ces valeurs sont **directions graphiques**, pas une obligation de remplacer les thèmes déjà définis.
- Accent violet proche de `#8067F8`, bleu proche de `#4B8FEA`, succès vert proche de `#3CD99B`, avertissement `#E7B34C`, danger `#F16B80`. Tester les contrastes réels dans les thèmes de Symphonee ; éviter le vert comme décoration si le système n'est pas validé.
- Espacements : unités de 4/8 px ; marges horizontales 20–28 px ; 12–18 px entre cartes ; 16–22 px de padding interne ; rayons 12–16 px ; bordures 1 px translucides, ombres discrètes. Sur petit écran, conserver 16 px de marge.
- Texte : titre principal ~24–28 px ; titre de panneau ~16–18 px ; titres de cartes ~15–16 px ; statistiques ~24–30 px ; corps 13–15 px ; métadonnées **au moins 12 px**, pas 10–11 px partout comme dans la version actuelle. Police d'interface sans-serif déjà installée ; monospace uniquement pour SHA, logs, chemins et code.
- Icônes simples, de style uniforme, 16–22 px ; ne jamais utiliser seulement une couleur pour communiquer un état. Indiquer état en texte et éventuellement un pictogramme.
- Responsive : desktop autour de 1440–1680 px avec rail 220–240 px ; tablette 2 colonnes, panneaux repositionnés ; mobile 360–430 px avec navigation repliable, cartes une par ligne, sans tableau qui oblige à défiler horizontalement. Ne jamais reproduire de force les trois colonnes de la capture à 390 px.
- Animations seulement pour les transitions utiles : chargement léger, changement de sélection, pulsation discrète de tâche active ; respecter `prefers-reduced-motion`. Aucune animation ne doit servir de preuve d'exécution.

## 3. Barre latérale — navigation globale

La maquette présente un grand logo violet « Symphonee » en haut, puis des entrées verticales avec icônes : **Tableau de bord**, **Autopilotes** (surligné violet), **Mind (Mémoire)**, **Qwen**, **Outils**, **Projets & Worktrees**, **Tests & Vérifications**, **Apprentissage**, **Indicateurs**, **Journaux**, **Configuration**. En bas, un encart version/branche/commit avec un indicateur d'état.

**Comportement attendu :** réutiliser la navigation réellement présente dans l'application. Ne pas créer dix fausses rubriques. Les destinations qui n'existent pas encore peuvent être liées à des vues internes réellement implémentées dans cette refonte, ou omises ; jamais des boutons cliquables inertes. L'élément actif possède fond violet contrasté, icône et libellé clair, focus clavier visible. Afficher la version, branche et SHA **détectés** seulement si disponibles ; le texte fictif de la maquette est interdit comme valeur réelle. Au mobile : rail escamotable et intitulé de page visible en permanence.

## 4. Barre supérieure — page et santé système

À gauche : icône de petit robot, titre « Autopilotes », sous-titre explicite « Orchestration, exécution et apprentissage de Qwen avec Mind, Claude et Codex ». À droite : un état global, un résumé du matériel local, date/heure mises à jour.

**État global :** « Opérationnel » seulement si le backend et les dépendances indispensables sont joignables, si les snapshots sont frais et qu'aucune intervention majeure n'est requise. Sinon « Partiellement disponible », « Vérification en cours », « Hors ligne », « Données périmées » ou « Intervention requise ». Un modèle local disponible n'implique pas qu'il ait été utilisé.

**Matériel :** la configuration historique de l'utilisateur est RX 580 / 16 Gio RAM, mais le panneau doit distinguer information de configuration connue de **mesures en direct** (modèle réellement chargé dans LM Studio, RAM libre, GPU, etc.). Si aucun endpoint autorisé ne fournit ces mesures, afficher « Données matérielles non disponibles », et ne pas afficher un faux thermomètre ou un pourcentage de RAM.

**Horloge :** utiliser la date système locale et un format français correct, éviter les dates figées et discordantes. Icône de synchronisation/actualisation avec dernière réponse fiable.

## 5. Onglets horizontaux du haut

Dans la maquette : **Aperçu** (sélection violette), **Exécutions**, **Tâches**, **Apprentissage**, **Résultats**, **Configuration**. Barre de navigation secondaire avec onglets en pilules (environ 34–40 px de haut), icône à gauche et état actif explicite.

Les onglets sont des **vues de la même fonctionnalité**, pas six nouvelles applications. Si l'architecture actuelle utilise d'autres sous-onglets, adapter sans dupliquer. La bascule doit conserver pilote sélectionné, filtre historique et scroll pertinent ; chargement via les routes existantes ; aucune API réseau ne part sans nécessité. Tous les onglets doivent afficher un contenu réel (défini en §14–18). Si une section n'a pas encore de données, montrer un état vide informatif plutôt qu'un nombre inventé.

## 6. Quatre cartes KPI tout en haut

Quatre tuiles égales, compactes et très lisibles, bordure accentuée et pictogramme sur carré arrondi :

**KPI 1 — Boucles actives** : chiffre calculé à partir des vraies boucles, avec libellé secondaire « X planifiées / Y en erreur ». Distinguer « activée » de « exécutant réellement une tâche ». Ne pas annoncer trois actifs parce que l'utilisateur a trois boucles configurées. Si les graphes et les pilotes ont des modes différents, documenter la formule et ne pas comparer des notions incompatibles.

**KPI 2 — Tâches en cours** : nombre de tâches en exécution **réellement constatée**, tous types de boucles inclus, pas nombre de pilotes `enabled`. Sous-texte « Qwen / Claude / Codex / vérification locale » seulement si la source connaît l'agent. Un processus arrêté mais avec un état persistant « running » exige un avertissement de fraîcheur.

**KPI 3 — Travaux vérifiés (24 h)** : nombre de tâches arrivées à un niveau de validation **explicitement choisi et défini**, par exemple vérification locale réussie + revue indépendante PASS. Afficher « Locaux, non fusionnés » si c'est le cas. Éviter « validées » pour un simple worktree créé ou un test jamais exécuté.

**KPI 4 — Nouvelles leçons Mind (24 h)** : nombre de leçons **réellement certifiées** sur la période ; ne pas confondre observations non certifiées, leçons de fixture et leçons de production. Le détail doit dire « certifiées », « observations à confirmer » ou « aucune nouvelle leçon ».

Chaque KPI est ouvrable seulement si un écran de détail réel existe. Horodatage des compteurs et états de chargement/erreur. Aucune valeur ne doit revenir automatiquement à zéro lors d'un échec réseau : préférer « Dernière valeur reçue à ... — périmée ».

## 7. Bloc central gauche « Autopilotes — cycle 24 h »

C'est le cœur de l'expérience. Grand panneau avec titre, icône de robot, action **« Voir le planning (24 h) »** qui ouvre le calendrier. Le visuel montre trois grandes lignes/cartes horizontales avec petit avatar rond, nom, plage horaire, objectif, statut (En cours/Planifié), travail et progression. Ces trois lignes sont illustratives : **les construire depuis les boucles réellement présentes**.

Chaque carte/liste doit afficher, dans cet ordre :
1. Nom réel de la boucle et type de source (« pilote Mind » ou « boucle de graphe » si nécessaire).
2. Statut précis : exécution active, prête, en attente de créneau, pause quota, pause RAM, interrompue, arrêtée, erreur, inconnue.
3. Mission courte (tirée de `goal`/définition ou donnée équivalente), affichable sur deux lignes puis détail complet au clic.
4. Créneau réel `start–end` si connu ; sinon « Créneau non fourni ». Pour PleinSens, privilégier la source de l'ordonnanceur plutôt que transformer une description codée en vérité universelle.
5. Tâche actuelle en termes humains ou « aucune tâche ». Compteur de tâches approuvées aujourd'hui si preuve disponible.
6. Agent actuel **prouvé** (Qwen local, Claude, Codex, exécuteur de tests) ; ne pas reprendre des mappages statiques `stage → agent` lorsqu'un handoff est possible.
7. Prochain créneau ou prochaine étape si l'information a été calculée ; sinon « non déterminé ».
8. Une barre d'avancement uniquement si un ratio fiable existe : par exemple 3 étapes terminées sur 5 définies, avec `3/5`, jamais « 72 % » calculé à l'intuition.
9. Un menu `…` n'offrant que des actions disponibles et autorisées pour **ce type** de boucle : « Voir le détail », « Voir la tâche », « Consulter les logs », « Reprendre » seulement en état interrompu et via l'endpoint prévu ; « Arrêter » exige confirmation sur le vrai pilote. Une boucle de graphe en lecture seule ne doit pas recevoir les commandes d'un pilote Mind.

La carte en cours peut avoir une bordure verte ou bleue discrète ; la carte planifiée reste sobre ; la carte en erreur affiche rouge + message précis. Le texte ne doit jamais suggérer que l'attente horaire est une erreur. La sélection d'une carte charge son détail **sans modifier sa configuration ni déclencher l'exécution**.

**Point de code existant à corriger :** la page `autopilot.js` ne construit que deux cartes dédiées, en dur via `['default','gas-saver']`, alors que `GET /api/automation/loops` rassemble les pilotes, PleinSens et les services. Construire une vue dynamique correctement typée ; ne pas déclarer tous les services comme pilotes.

## 8. Calendrier 24 heures et partage du temps — fonctionnalité fortement prioritaire

La maquette montre surtout un bouton « Voir le planning » ; **ajouter une vraie frise temporelle lisible**, pas seulement un tableau d'horaires. Sous les trois boucles ou dans un panneau ouvrable, afficher une règle `00:00, 04:00, 08:00, 12:00, 16:00, 20:00, 24:00`, et une ligne de segment par boucle réelle. Respecter la date locale et le fuseau du système ; traiter correctement les créneaux passant minuit.

- Couleurs différentes par boucle, avec légende textuelle.
- Traits/segments de planification distincts d'une **exécution observée** : un créneau prévu n'est pas une preuve de travail.
- Curseur « maintenant » alimenté par l'horloge ; zones de pause, fenêtres terminées, prochaines fenêtres ; hover/focus affichant horaire, nom, tâche si connue.
- Si deux fenêtres se chevauchent et que l'orchestrateur empêche deux travaux lourds, signaler « concurrence de fenêtres — exécution sérialisée » sans déplacer les horaires.
- Si une tâche déborde, identifier « étape en cours » versus « prochaine étape reportée » et afficher la reprise prévue. Ne pas promettre une continuité automatique que le code n'offre pas.
- Ne proposer aucune redistribution automatique des 24 h, aucun arrondi arbitraire à 8 h par boucle et aucune sauvegarde d'horaires sans action séparée explicitement autorisée.

Sans accès aux définitions locales, afficher un calendrier vide explicatif (« Impossible de charger les horaires depuis Symphonee »), **jamais** les exemples horaires de la maquette.

## 9. Carte « Écosystème IA »

Dans une colonne intermédiaire : rangées Qwen 4B, Mind, Claude, Codex avec icône, nom, fonction et indicateur d'état. Son rôle est de répondre à « Qui est prêt ? Qui travaille réellement ? ».

- **Qwen (local)** : modèle réellement chargé si connu (`qwen/qwen3.5-4b`), serveur LM Studio joignable, session active ou non, intervention actuelle sur vraie tâche si confirmée. Distinguer « modèle opérationnel en inférence », « pont de fichiers outillé autorisé », « travail en cours », « expérimental non activé ». Pas de quota cloud affiché pour ce modèle local. L'entraînement LoRA ne doit pas être marqué actif sur la base de Mind.
- **Mind** : accessible/inaccessible, nombre de leçons certifiées ou observations si la route existe ; avertir en cas de synchronisation en attente. Ne pas afficher « 1 leçon certifiée sur vrais projets » si la leçon provient d'une expérience fictive.
- **Claude** : rôle mentor / implémentation de secours ; état de processus en cours si connu ; quotas fournisseurs non directement connus ne doivent pas être décrits comme exacts.
- **Codex** : relecteur indépendant ; GO uniquement pour une revue précise effectuée, pas parce que le service est configuré.

Pastille : vert = santé prouvée, bleu = occupé, ambre = inconnu/en attente, rouge = défaillance constatée, gris = non utilisé/désactivé. Un simple test HTTP ne suffit pas à démontrer que le modèle peut modifier et vérifier un dépôt réel. Chaque ligne doit s'ouvrir sur les preuves de connexion ou d'exécution existantes.

## 10. Carte « Indicateurs de progression »

Dans la colonne droite : petit graphique circulaire en forme d'anneau portant `N/10`, liste de quatre indicateurs et action « Voir le détail des indicateurs ».

- Le `N/10` représente les **catégories de compétences réellement maîtrisées selon la règle définie**, pas un sentiment de progression. Le code `qwen-skills-ledger.js` contient dix catégories : bugs, fonctionnalités, refactorisation, tests, analyse, débogage, fichiers/modules, algorithmes, performance, intégration. À la dernière expérience publiée, aucune catégorie n'était maîtrisée ; l'affichage futur doit être calculé sur la source de données effectivement intégrée, pas être fixé à 0 non plus.
- « Tâches inédites » : définir les unités et dénominateurs sans double compter deux essais de la même tâche comme deux problèmes distincts.
- « Réussite autonome » : réussite sans code écrit par Claude, avec vérifications réelles ; distinguer fixture et dépôt réel.
- « Leçons dans Mind » : nombre validé/certifié avec source ; ne pas ajouter les observations en attente.
- « Transfert observé » : résultat sur tâche différente, avec qualification « proche » ou « généralisation non démontrée » ; ne pas annoncer apprentissage du modèle de poids quand seule la mémoire a été utilisée.

Cliquer sur le panneau ouvre les critères détaillés, le périmètre des essais, les données brutes disponibles et les limites de mesure. Ne pas multiplier les métriques juste pour remplir la carte.

## 11. Carte « Dernières leçons Mind »

Sous les indicateurs : petite carte avec icône de livre, compteur « N leçons », dernière leçon contextualisée et une flèche de détail. En cas de multiples leçons, lister les dernières 2–3, avec défilement vers la vue Apprentissage.

Pour chacune : nom court, problème traité, statut **Observation / Enseignement / Certifiée / Expirée / Obsolète**, famille de problèmes, preuves (tests, stress, Codex GO) et origine (fixture ou vrai dépôt). Afficher le principe général et l'application spécifique en détail, les limitations, les échecs de réutilisation et pourquoi la leçon a été rappelée ou non. Le détail doit permettre de distinguer la **mémoire stockée** d'un **entraînement effectif des poids**.

Dans la maquette, « Calcul de moyenne absolue (meanAbs) — méthode validée » est un exemple lié à une expérience : ne pas le présenter comme compétence acquise de Qwen sur vrais projets.

## 12. Grande carte « Tâche en cours »

Sous les trois boucles dans la grande colonne gauche : titre « Tâche en cours », nom exact de la tâche, badge d'agent réel, dépôt, branche de travail, worktree (chemin raccourci), bouton « Ouvrir le worktree » **uniquement si l'application possède une action locale autorisée**. Le bouton ne doit jamais naviguer vers une chaîne de chemin arbitraire sans validation.

**Progression en six étapes sur la maquette** : « Analyse », « Plan », « Code », « Tests », « Vérification », « Apprentissage ». Les représenter comme un chemin lisible avec pastilles reliées. Correspondances possibles : `discover` → Analyse ; `plan-review` → Plan approuvé ; `implement` → Code ; `verify` → Tests locaux ; `code-review` → Revue indépendante ; « Apprentissage » → événement Mind **uniquement s'il existe**. La vraie machine à états comprend également `repair`, `budget-wait` et des répétitions. Ne pas prétendre que « Apprentissage » est une étape obligatoire ou validée si elle n'existe pas.

Code couleur des étapes : gris futur, bleu/violet en cours, vert succès prouvé, ambre pause, rouge échec, retour de « Code » à « Tests » lors de corrections. Montrer la **raison exacte** de pause : fenêtre, crédit fournisseur, RAM, redémarrage, besoin d'examen humain.

Pour les tâches interrompues, afficher le dernier worktree fiable, le point de reprise et l'action « Reprendre » si effectivement permise. Pour un travail achevé localement, montrer les tests, le verdict Codex et ce qui reste à faire humainement. Si aucune tâche : état vide utile « Aucune tâche en cours ; prochaine vérification ... ».

## 13. Console de journal et détail des étapes

Sous le chemin de progression, la maquette montre un encart type terminal bleu-noir à hauteur fixe, texte monospace, horodatage et flux d'événements (lecture, proposition, correctif, tests, erreur).

Comportement : afficher les derniers événements **réellement reçus** de l'orchestrateur/du pilotage, avec source `Qwen`, `Claude`, `Codex`, `Tests`, `Mind`, `Orchestrateur`. Respecter l'ordre chronologique, prévoir retour à la ligne, copier les extraits autorisés, filtre par source et sévérité, et bascule « Voir tout le journal ». Ne pas fabriquer des événements pour donner une impression d'activité. Une erreur critique doit être traduite en phrase humaine avant de proposer le détail technique brut. Ne pas afficher de secrets, clés, tokens d'accès, prompts sensibles, contenu privé inutile ou chemin complet si l'utilisateur n'a pas explicitement demandé le détail. Quand aucun flux n'est disponible, afficher « Journal non disponible pour cette exécution ».

## 14. Panneau « Dépôt & sécurité »

Colonne intermédiaire basse : titre avec bouclier, petites lignes à pictogramme. La maquette illustre « Travail en worktree isolé », « Dépôt principal protégé », « Tests avant validation », « Vérification indépendante (Codex) », « Leçons enregistrées (Mind) ».

**Ne surtout pas mettre une coche verte à chaque ligne par défaut.** Ces affirmations ne deviennent vertes que si elles sont prouvées pour la tâche sélectionnée :

- Worktree : chemin et empreinte d'origine conformes, confinement vérifié.
- Checkout principal : empreinte inchangée après la tâche ou après la dernière étape vérifiable, sinon inconnu ou alerte.
- Tests : commandes réellement exécutées, sorties et code de retour ; indiquer `311/313` seulement si cette exécution présente effectivement ces résultats, pas parce que ce chiffre vient d'un ancien essai.
- Codex : verdict PASS/GO avec identité du run et preuve, sinon en attente/non lancé/refusé.
- Mind : preuve de stockage/synchronisation d'une leçon certifiée, sinon « observation conservée » ou « aucun enseignement certifié ».

Les cinq lignes peuvent être grises, ambre, vertes ou rouges individuellement. Cliquer permet d'accéder aux preuves et rapports disponibles, pas de modifier les garde-fous.

## 15. Panneau « Activité récente »

Colonne droite basse : titre avec courbe de pulsation, menu de filtre (« Tous », « Qwen », « Claude », « Codex », « Mind », « Erreurs »), ligne verticale et points colorés. Chaque événement : heure locale, agent/source, verbe précis, résultat, lien vers tâche ou rapport.

Classer par timestamp réel décroissant ; si deux événements arrivent hors ordre, ne pas réécrire l'histoire ; grouper les répétitions purement techniques, mais garder l'accès aux journaux complets. Afficher éventuellement « dernière mise à jour » et un message « événements périmés » si la connexion n'est plus fraîche. Vert pour succès vérifié, bleu pour étape, violet pour apprentissage, ambre pour attente, rouge pour erreur. Les heures `14:11–14:14` de la maquette sont des exemples non vérifiés.

## 16. Onglet « Exécutions » — zoom sur les traitements

Vue détaillée de la liste des cycles / runs réels : filtre par boucle, date, agent, statut ; colonnes ou cartes comprenant ID, nom de tâche, dépôt, début, durée, étape active, état, agent ayant modifié le code, reprise et résultat. Les tâches interrompues exposent checkpoint et raison d'interruption. Pour PleinSens/graphes, reprendre les nœuds disponibles dans `GET /api/automation/loops/detail`. Pour les pilotes Mind, reprendre snapshots, historiques et événements. Ne jamais offrir à une boucle de graphe les commandes d'un pilote Mind sans API adaptée.

Sur clic, ouvrir un détail avec chronologie, diff si disponible, commandes vérifiées, revues et ressources consommées. Définir la granularité des données réellement récupérables avant de construire des visuels sophistiqués.

## 17. Onglet « Tâches » — catalogue de travaux

Trois ensembles filtrables : « En cours », « En attente / à reprendre », « Terminées / à examiner ». Pour une tâche : titre orienté résultat, objectif, critère d'acceptation, dépôt, source, risque, agent, dernier état et preuve. Action « Voir le travail » toujours ; « Reprendre » ou « Arrêter » seulement si le backend l'autorise. Afficher **le statut exact** : découverte, plan validé, code proposé, tests échoués, revue demandée, revue refusée, revue acceptée, intervention humaine requise.

L'utilisateur veut laisser Qwen apprendre sur de vrais dossiers, sans lui donner le droit de fusionner automatiquement. Une tâche approuvée reste distincte d'un travail déjà intégré dans l'application.

## 18. Onglet « Apprentissage » — Mind + compétences + entraînement

Sous-vues/logique :

1. **Leçons Mind** : certifiées, observations, en attente de synchronisation, obsolètes ; provenance, version du vérificateur et applicabilité.
2. **Compétences Qwen** : les dix catégories, nombre de tâches inédites, taux de succès autonome, cas de transfert proches ou lointains ; critères de maîtrise documentés ; pas de claims sans corpus.
3. **Entraînement du modèle** : espace prévu pour préparation de données, jeux train/validation/test, versions de base/adaptateurs LoRA, évaluations avant/après. Tant qu'aucun entraînement réel n'est exécuté, afficher « Entraînement non configuré / non exécuté ». Ne pas faire passer l'ajout d'une leçon Mind pour un fine-tuning réussi.

Inclure « Pourquoi cette leçon n'a-t-elle pas été utilisée ? » en exploitant les décisions d'applicabilité si elles existent. Historique non effacé.

## 19. Onglet « Résultats » — preuves plutôt que promesses

Synthèse de réalisations avec filtre « travaux locaux », « revues PASS », « PR ouvertes », « fusionné », « déployé » ; chaque statut doit avoir une source spécifique (ne pas extrapoler un résultat GitHub à partir d'un worktree local). Graphiques possibles : tâches vérifiées par jour, répartition des blocages, transfert Qwen avec/sans Mind, provenance du code, taux de revue GO, évolution des catégories maîtrisées. Montrer une note « données insuffisantes » pour les séries trop courtes, et bannir les graphiques artificiellement remplis.

Distinguer les résultats **de fixture expérimentale** des **vrais dépôts**. Le Qwen 4B testé fonctionne déjà en local ; les expériences précédentes ont montré un transfert proche sur `meanAbs`, pas une généralisation à dix catégories.

## 20. Onglet « Configuration » — pouvoirs et consentements

Réorganiser les paramètres avancés déjà existants sans effacer leurs garanties : sélection de pilote/dépôt, objectif, fenêtre horaire **affichée sans modification par défaut**, profils, `verify`, chemins protégés, autorisations d'écriture en worktree, profil d'implémentation Qwen réel si présent, relève Claude→Qwen sur limite fournisseur (fonction distincte), paramètres de Claude/Codex, plafonds cloud et capacité.

**Différence à expliquer à l'utilisateur :**
- « Qwen 4B développeur local sur vrai dépôt » = voie expérimentale contrôlée, avec lecture/édition via protocole hôte et tests ; disponibilité dépend de la configuration et des preuves.
- « Qwen local + Mind : suggestions seulement » = ancienne voie de secours sur limite Claude, sans droit d'édition, distincte.
- « Qwen Code cloud » = fournisseur différent, potentiellement payant, soumis à consentement explicite.

Ne pas fusionner ces trois options dans un commutateur « Qwen activé ». Les configurations sensibles ne changent qu'avec validation, traitement d'erreur et confirmation claire ; pas de redémarrage ni modification d'horaires par la simple visite de l'onglet.

## 21. États, interactions et honnêteté de l'interface

Pour chaque composant, prévoir : chargement, vide, opérationnel, en attente, erreur, inaccessible, données périmées. Conserver le dernier snapshot reçu, mais le marquer explicitement comme périmé si l'actualisation échoue ; ne pas annoncer « zéro » ou « arrêté » uniquement parce que le serveur ne répond pas. Utiliser WebSocket + repli polling déjà existants, en gardant `makeLatest()` et `createSnapshotStore()` pour empêcher une réponse HTTP tardive d'écraser une observation plus récente.

Les contrôles « Activer », « Arrêter », « Vérifier », « Lancer maintenant », « Reprendre », « Archiver » doivent appeler les routes **déjà autorisées** et montrer les confirmations/erreurs du serveur. Les actions susceptibles d'annuler un travail sont séparées visuellement des actions de consultation. Les boutons d'affichage ne doivent jamais lancer un agent. Pour les métriques non existantes, ne pas faire semblant : noter exactement la source manquante et proposer un branchement backend minimal si justifié.

## 22. Accessibilité, responsive, robustesse

Navigation clavier complète (Tab, Enter, Esc, focus visible), titres hiérarchiques, `aria-live` réservé aux changements importants, sous-titres compréhensibles, états annoncés autrement que par la couleur, cibles tactiles suffisamment larges, texte français avec accents corrects, dates en `fr-CA`, contraste adapté aux thèmes clair/sombre existants. Sur mobile : prioriser « état global → alertes → boucle active → autres boucles → tâche en cours → prochaine plage → détails » ; panneaux Mind et logs derrière une ouverture explicite. Aucun tableau large sans alternative en cartes, pas de scroll horizontal global.

Côté sécurité, échapper tous les champs provenant des tâches, titres et journaux (`escapeHtml` et protections DOM), éviter HTML non fiable, URLs non validées, chemin arbitraire ; ne pas introduire de nouveaux tokens d'authentification exposés dans le navigateur. Éviter les actualisations agressives en arrière-plan. La page ne doit pas ralentir les autopilotes.

## 23. Correspondance avec le code et les données à réutiliser

| Fonction de l'interface | Code/route disponible à examiner | Prudence |
| --- | --- | --- |
| Statut et commandes d'un pilote | `dashboard/public/mind-ui/src/autopilot.js`, `GET /api/mind/autopilot?pilot=...`, routes POST correspondantes | Ne pas appeler un POST pour simplement afficher une carte |
| Liste dynamique des pilotes | `GET /api/mind/autopilots` et `.symphonee/mind-autopilots.json` (local) | Les IDs et horaires ne sont pas dans GitHub |
| Vue de toutes les boucles et services | `dashboard/automation/loops-status.js`, `GET /api/automation/loops` | Une boucle de graphe n'est pas un pilote Mind |
| Détail PleinSens, fusion, veille | `GET /api/automation/loops/detail?id=...` | Certains détails sont en lecture seule |
| « En clair » des travaux | `GET /api/automation/loops/summary?loop=...` | Texte rédigé distinct du statut calculé par les faits |
| États WebSocket, concurrence de lectures | `autopilot-state.js`, `latest.js` | Préserver le rejet des vieux snapshots |
| Horaires, budget, worktrees, étapes | `dashboard/mind/autopilot.js` | Respecter reprise, créneaux, blocage par pair |
| Qwen sur vrais dépôts | `dashboard/orchestrator/QWEN_REAL_REPO.md`, worker et pont de l'orchestrateur | Implémentation expérimentale et permissions séparées |
| Mémoire, compétences, indicateurs | `dashboard/mind/lessons.js`, `qwen-learning-fixture.js`, `qwen-skills-ledger.js` | Ne pas confondre fixture / production / poids entraînés |

Lire les vrais schémas et types au HEAD réel : cette table signale où regarder, pas la garantie que chaque champ existe dans chaque réponse. Si une mesure nécessite un nouvel endpoint, le définir au plus petit périmètre en conservant la compatibilité.

## 24. Scénarios de test et critères d'acceptation

A. **Aucune donnée simulée en production** : recherche dans les fichiers générés d'horaires AP1/AP2/AP3, fausses statistiques, faux journal, version/SHA figés, « 72 % » ; tout doit venir d'une donnée réelle ou d'un état inconnu.

B. **Trois boucles existantes préservées** : lire la configuration avant/après, comparer identifiants, missions, fenêtres et flags ; aucun changement non demandé. Si la machine contient une autre quantité, l'interface s'adapte sans casser.

C. **Un pilote Mind, une boucle PleinSens, un service** : présentation et détails corrects, sans actions illégitimes ; aucun faux statut « 3 autopilotes actifs ».

D. **Interruption et reprise** : statut et raison corrects, worktree préservé, bouton de reprise uniquement quand admissible, erreur claire sinon.

E. **Qwen** : différencier disponible, réellement actif, bloqué, transféré à Claude et validé par Codex ; distinguer Qwen local et Qwen cloud ; ne jamais afficher une formation LoRA non réalisée.

F. **Sécurité** : pas de coche verte sans preuve ; pas de push/merge/déploiement ; toutes les actions destructrices exigent confirmation et droits existants.

G. **Concurrence/fraîcheur** : réponses HTTP retardées, WebSocket plus récent, changement rapide de pilote, coupure serveur, reprise réseau, boucle sans horodatage.

H. **Responsive** : captures et test d'interactions au minimum à 390×844, 768×1024, 1280×900, 1600×900 ; pas de débordement ni de texte illisible. Tester clavier, focus, synthèse vocale si possible, thèmes et contraste.

I. **Non-régression** : tests de `autopilot.js` et UI, `dashboard/automation/loops-status` et routes concernées ; build officiel `node scripts/build-renderer.js`. Tout échec est documenté, jamais occulté.

J. **Qualité de livraison** : captures avant/après réellement produites à partir du renderer (avec fixtures **signalées** si ce n'est pas le live), liste des données manquantes, commit SHA exact, analyse de risques et de rollback ; aucune fusion dans `master` et aucune modification des trois horaires sans autorisation.

## 25. Ordre de réalisation conseillé à Claude

1. Auditer HEAD réel, composants, feuilles de style, routes et snapshots ; lire la configuration locale en lecture seule.
2. Mettre en place la structure visuelle et le responsive **sans ajouter de faux chiffres**.
3. Brancher la synthèse des vraies boucles et les cartes KPI ; corriger les deux cartes codées en dur.
4. Ajouter le calendrier 24 h depuis les horaires locaux, sans les modifier.
5. Représenter la tâche active, la chronologie, les agents et les preuves de sécurité.
6. Brancher Mind, les indicateurs et les deux mécanismes Qwen distincts.
7. Réorganiser les vues secondaires et la configuration existante, toujours en préservant les contrôles actuels.
8. Ajouter les états vides/périmés, le responsive, les tests, la documentation et les captures avant/après.
9. Commettre sur branche de travail sans fusion, fournir un rapport de ce qui est réellement fonctionnel et de ce qui reste à brancher.

**Critère final :** l'utilisateur doit immédiatement savoir « quelle boucle travaille, à quoi elle sert, ce qu'elle a fait, avec quel agent, quelles preuves, et quelle est la prochaine étape », sans se fier à une image décorative. La page est un **centre de contrôle honnête des boucles existantes**, pas une vitrine qui prétend que tout est vert.
