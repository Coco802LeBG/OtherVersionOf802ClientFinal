# 802 Client Launcher

Launcher pour **802 Client** (Minecraft 1.21.11 + Fabric), en Electron.

- Connexion Microsoft officielle (device code), tokens chiffrés par le système, aucun mot de passe.
- Minecraft téléchargé depuis les serveurs de Mojang (SHA-1 vérifié), jamais redistribué.
- Fabric Loader + Fabric API installés automatiquement, dossier de jeu séparé de `.minecraft`.
- Profils : RAM, arguments JVM, Java (officiel Mojang / détecté / Temurin 21), résolution, plein écran.
- Page Mods Modrinth (Fabric 1.21.11), SHA-512 vérifié, liste de tout ce qui est installé.
- Mises à jour automatiques du launcher et de 802 Client.

Dossier des données : `%APPDATA%\802-client` (Windows). Rien n'est exécuté en cachette : chaque fichier installé est listé dans la page Mods > Installés.

---

## Mise en place, étape par étape

### Étape 1 — Mettre le launcher sur GitHub
1. Sur github.com : **New repository**, nom `802-launcher`, **Public**.
2. Dézippe le zip sur ton PC. Dans le dépôt : **Add file > Upload files**, glisse **tout le contenu** du dossier `802-launcher` (dossiers `src`, `build`, `docs`, `test`, `.github` + `package.json`, `package-lock.json`, `README.md`, `.gitignore`), puis **Commit changes**.
3. Si le dossier `.github` n'est pas parti (dossier caché) : **Add file > Create new file**, écris `.github/workflows/build.yml` dans le nom, et colle le contenu du fichier du même nom.
4. Si ton pseudo GitHub n'est pas `Coco802`, change-le dans `package.json` (ligne `"owner"`) et dans `src/main/config.js`.

### Étape 2 — Créer ton application Azure (gratuit)
1. Va sur https://portal.azure.com > **Inscriptions d'applications** (App registrations) > **Nouvelle inscription**.
2. Nom : par exemple `802 Launcher` (sans les mots Minecraft, Mojang, Microsoft, Xbox, Live).
3. Types de comptes : **Comptes dans un annuaire organisationnel et comptes Microsoft personnels**.
4. Après création : **Authentification > Paramètres avancés > Autoriser les flux clients publics = Oui**. Enregistre.
5. Copie l'**ID d'application (client)**.
6. Demande l'approbation à Mojang avec le formulaire https://aka.ms/mce-reviewappid. Tant que ce n'est pas approuvé, la connexion échoue avec `Invalid app registration`. Les délais ne dépendent pas de moi.
7. Colle l'ID dans le launcher : **Réglages > Client ID Azure**.

En attendant l'approbation : Réglages > **Mode développeur** active un compte de test hors-ligne, pour vérifier que Minecraft démarre. Il ne permet pas de rejoindre les serveurs officiels.

### Étape 3 — Faire publier 802 Client avec des Releases (dépôt du mod)
1. Dans le dépôt du mod `802-client`, remplace `.github/workflows/build.yml` par le contenu de `docs/802-client-mod-build.yml`.
2. Dans `gradle.properties` du mod, mets `mod_version` à la même version que ton tag.
3. **Releases > Draft a new release**, tag `v1.0.0` (Create new tag), **Publish release**. Le workflow compile et ajoute `802-client-x.y.z.jar` + son `.sha256`.
4. Le dépôt du mod doit être **public**.

### Étape 4 — Obtenir l'installeur .exe
- À chaque modification poussée sur `main` : onglet **Actions** > le dernier run > **Artifacts** > `802-client-windows-latest` (contient `802-Client-Setup-x.y.z.exe`).
- Pour une vraie version avec mises à jour automatiques : **Releases > Draft a new release**, tag `v1.0.0` > **Publish**. Le workflow ajoute le `.exe` et `latest.yml` à la Release. Pour sortir `v1.0.1` plus tard : change `"version"` dans `package.json` puis publie le tag `v1.0.1`.
- Windows affichera « SmartScreen » car l'installeur n'est pas signé (certificat payant). Clique **Informations complémentaires > Exécuter quand même**.

---

## Si ça échoue
- **Build rouge** : Actions > run rouge > étape rouge > copie les lignes avec `error`.
- **Launcher** : page **Logs** > **Copier**.
- Ajoute une phrase sur ce que tu as vu à l'écran.

## Ce qui est vérifié, et comment
| Élément | Source | Vérification |
|---|---|---|
| Minecraft, libraries, assets, Java | Mojang | SHA-1 |
| Fabric Loader | maven.fabricmc.net | SHA-1 (publié par Fabric) |
| Fabric API, mods | Modrinth | SHA-512 |
| 802 Client | Releases GitHub du mod | SHA-256 (`.sha256` ou empreinte GitHub) |
| Temurin (secours) | Adoptium | SHA-256 |

## Licences et règles
- Aucun mod « All Rights Reserved » n'est embarqué. Les mods Modrinth sont téléchargés quand l'utilisateur clique, avec leur licence affichée.
- Pas de cheats. Le launcher avertit que certains modules peuvent être interdits sur certains serveurs.
- Ce launcher n'est pas affilié à Mojang, Microsoft ou Modrinth.
