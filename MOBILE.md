# Symphonee Mobile - guide Android

## A quoi ca sert
Consulter et piloter Symphonee depuis le telephone, par une connexion privee Tailscale. Le telephone utilise le meme serveur, les memes terminaux et les memes donnees que le PC. L'interface du PC n'est pas modifiee.

## Prerequis
- Tailscale installe et connecte avec le MEME compte sur le PC et sur le telephone.
- Tailscale Serve actif vers le port 3800 (tailnet seulement, jamais Funnel).
- La variable d'environnement utilisateur `SYMPHONEE_TAILNET_ORIGIN` egale a l'adresse https du PC, par exemple `https://desktop-xxxx.tailNNNN.ts.net`. Redemarrer Symphonee apres l'avoir definie.
- Sur le telephone, "Use Tailscale DNS" active. Si Internet coupe quand Tailscale est actif, verifier les serveurs DNS globaux dans la console Tailscale.

## Premiere connexion
1. Sur le PC : `node scripts/mobile-pair.js` affiche un code a 6 chiffres, valable 5 minutes, utilisable une seule fois.
2. Sur le telephone : ouvrir `https://<adresse-du-PC>/remote` et saisir le code.
3. Ouvrir ensuite `https://<adresse-du-PC>/mobile`.

## Installer sur l'ecran d'accueil
Dans Chrome : menu des trois points, faire defiler, "Installer et creer un raccourci", puis "Installer".

## Les ecrans
- Accueil : etat du PC, terminaux, taches, autopilotes, boucles planifiees, erreurs recentes, validations en attente.
- Terminal : sortie en direct des terminaux du PC. On peut y envoyer UNE ligne de commande (voir ci-dessous).
- Mind : recherche dans la memoire, apprentissages, souvenirs recents.
- Autopilotes : etat et limites du jour, boucles planifiees. Lecture seule : demarrer ou arreter se fait sur le PC.
- Projets : branche, modifications, commits, pull requests, et navigation des fichiers en lecture seule.
- Reglages : etat de la session, deconnexion.

## Envoyer une commande
1. Onglet Terminal, choisir le terminal, ecrire une ligne, appuyer sur "Envoyer au terminal".
2. Par defaut (mode `auto`) la commande part directement, sans rien valider sur le PC : prevu pour les deplacements. Chaque commande est inscrite dans `.symphonee/remote-commands.log` (heure, session, terminal, texte).
3. Les commandes destructrices (`rm -rf`, `Remove-Item -Recurse`, `format`, `shutdown`, `git push --force`, `git reset --hard`, `git clean -f`, `git branch -D`, `| bash`, `iex`...) attendent toujours l'accord du PC (90 s), meme en mode `auto`.
4. Pour revenir a la validation de CHAQUE commande sur le PC : `node scripts/mobile-pair.js mode ask` (et `mode auto` pour revenir). `mode` seul affiche le mode actuel. Le telephone ne peut pas changer ce reglage.
5. Une seule ligne, 2000 caracteres au plus, sans caractere de controle.

## Ce que le telephone ne peut pas faire
Approuver sa propre commande, lire la configuration ou les secrets (`config`, `.env`, cles, jetons), fusionner ou pousser du code, installer des plugins, redimensionner les terminaux du PC. Les fichiers caches, les dossiers `config` et `node_modules` et tout contenu qui ressemble a un secret sont invisibles.

## Gerer les telephones appaires
- `node scripts/mobile-pair.js list` : liste les telephones (identifiant, creation, expiration).
- `node scripts/mobile-pair.js revoke <id>` : retire un telephone. `revoke all` retire tout.
Une session dure 30 jours. Le secret n'est jamais stocke en clair sur le PC.

## Mise a jour de l'application
Si l'ecran du telephone affiche une ancienne version, tirer vers le bas pour recharger, ou fermer et rouvrir l'application.

## Tests
- `node --test dashboard/lib/remote-*.test.js` : tests unitaires.
- Sur un serveur de TEST (jamais sur le port 3800 pour les deux derniers) : `node scripts/test-remote-access.js <port> <origine>`, `node scripts/test-remote-ws.js <port> <origine> live`, `node scripts/test-remote-command.js <port> <origine>`.
