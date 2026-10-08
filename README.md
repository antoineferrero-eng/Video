# Lumière

**Lumière** est une application pour parcourir, télécharger et regarder vos films et séries
depuis l'index de fichiers [a.111477.xyz](https://a.111477.xyz) (ou tout autre index HTTP du
même type), avec une interface au design **Liquid Glass** inspiré d'Apple : barres et
commandes en verre qui flottent au-dessus du contenu, réfraction de la lumière sur les bords,
reflets qui suivent le pointeur, ambiance colorée par les affiches.

![Accueil de Lumière](docs/captures/accueil.jpg)

---

## Fonctionnalités

- **Catalogue films et séries** : tendances, titres populaires et recherche de **TMDB**, avec les
  fichiers fournis par l'**extension Stremio de 111477** (le site lui-même est protégé par
  Cloudflare) ; ou, pour un index HTTP accessible, construit à partir de la liste du site.
  Recherche instantanée (sans accents ni majuscules), tri (ajouts récents, titre, année, note),
  filtre par genre, défilement infini.
- **Fiches détaillées** : affiche, image de fond, résumé, note, genres, durée, accroche
  (via TMDB, facultatif) ; toutes les **versions** disponibles avec leurs caractéristiques
  (4K, HDR, Dolby Vision, H.265, DD+ 5.1, MULTi, VFF, VOSTFR…) ; **saisons et épisodes** avec
  titres, résumés et vignettes.
- **Téléchargements** : file d'attente persistante, plusieurs téléchargements en parallèle,
  **pause / reprise** (même après un redémarrage, sans repartir de zéro), nouvelles tentatives
  automatiques, limite de débit, progression en temps réel ; téléchargement d'un film, d'une
  saison, d'une série entière ou d'un dossier complet.
- **Bibliothèque locale** rangée automatiquement (`Films/…`, `Séries/<série>/Saison 01/…`),
  lecture hors ligne, suppression, enregistrement d'un fichier sur l'appareil qui consulte
  l'interface (téléphone, autre PC).
- **Lecteur vidéo intégré** : lecture directe quand c'est possible, sinon **conversion à la
  volée avec ffmpeg** (MKV, HEVC 10 bits, HDR, AC3/DTS…), choix de la **piste audio** (français
  sélectionné automatiquement dans les releases MULTi), **sous-titres** intégrés, externes ou
  **trouvés en ligne** (OpenSubtitles.com, extensions Stremio de sous-titres comme OpenSubtitles
  v3 : ceux faits pour votre fichier exact passent en tête), décalage des sous-titres réglable,
  **reprise là où vous vous étiez arrêté**, **épisode suivant** automatique, plein écran,
  raccourcis clavier. On peut regarder **sans télécharger** (streaming depuis le site) ou
  depuis la copie locale.
- **Explorateur** pour naviguer librement dans l'arborescence du site.
- **Design Liquid Glass** : barre latérale flottante sous laquelle les illustrations
  s'étendent, barre d'onglets mobile qui se réduit au défilement (comme iOS 26), menus et
  dialogues en verre, contrôles segmentés à goutte « liquide », lecteur aux commandes
  flottantes. Réglage **Apparence** (Transparent, Teinté, Opaque) et respect des réglages
  d'accessibilité du système (transparence et animations réduites, contraste élevé).
- Interface **100 % en français**, thème sombre, adaptée au **mobile**, installable comme
  application (PWA), mise à jour **en temps réel**.

|                                                                |                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| ![Catalogue](docs/captures/films.jpg)                          | ![Fiche d'une série](docs/captures/serie.jpg)                 |
| ![Téléchargements en cours](docs/captures/telechargements.jpg) | ![Lecteur avec sous-titres](docs/captures/lecteur.jpg)        |
| ![Fiche d'un film](docs/captures/film.jpg)                     | ![Réglages d'apparence](docs/captures/apparence.jpg)          |
| ![Mobile : accueil](docs/captures/mobile.jpg)                  | ![Mobile : fiche d'une série](docs/captures/mobile-serie.jpg) |

> Les captures proviennent de la démonstration hors ligne incluse (`npm run demo`) : vidéos
> et affiches de test générées par ffmpeg.

---

## Démarrage rapide

### 1. Prérequis

| Logiciel                  | Version                                  | Installation                                                                                               |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Node.js**               | 22.22 ou plus récent (24 LTS recommandé) | <https://nodejs.org>                                                                                       |
| **ffmpeg** (avec ffprobe) | 5 ou plus récent                         | Windows : `winget install Gyan.FFmpeg` · macOS : `brew install ffmpeg` · Linux : `sudo apt install ffmpeg` |

ffmpeg sert à analyser et convertir les vidéos que le navigateur ne sait pas lire. Sans lui,
l'application fonctionne mais ne lit que les fichiers directement compatibles.

### 2. Installation et lancement

```bash
git clone https://github.com/antoineferrero-eng/Video.git lumiere
cd lumiere
npm install
npm run build
npm start
```

Ouvrez ensuite **<http://localhost:8484>**.

### 3. Ajouter une clé TMDB (nécessaire avec l'extension)

Créez un compte gratuit sur [themoviedb.org](https://www.themoviedb.org/settings/api), copiez
la « clé d'API » et collez-la dans **Paramètres → Métadonnées (TMDB)**. Avec l'extension
Stremio (réglage par défaut), c'est TMDB qui fournit le catalogue : sans clé, il reste vide.
La clé apporte aussi affiches, résumés et titres d'épisodes.

### 4. Vérifier l'extension Stremio

Par défaut, Lumière demande les liens des fichiers à l'extension Stremio de 111477
(`https://st.111477.xyz/manifest.json`). **Paramètres → Extension Stremio → Tester
l'extension** vérifie qu'elle répond. Si vous l'avez configurée sur
[st.111477.xyz](https://st.111477.xyz/) (nombre de liens par titre, serveurs…), collez-y le
lien d'installation obtenu (`stremio://…` ou `https://…/manifest.json`).

### 5. Sous-titres en ligne (facultatif)

Sans réglage, Lumière cherche les sous-titres manquants avec l'extension Stremio
**OpenSubtitles v3** (gratuite, sans clé) quand vous ouvrez le menu des sous-titres du lecteur,
ou d'office si la langue de sous-titres préférée manque dans le fichier. Pour des résultats
calés sur votre fichier exact, créez une clé gratuite sur
[opensubtitles.com](https://www.opensubtitles.com/consumers) (rubrique « API consumers ») et
collez-la dans **Paramètres → Sous-titres en ligne**, avec votre compte pour plus de
téléchargements par jour. D'autres extensions de sous-titres compatibles s'ajoutent par leur lien.
Lors d'une recherche, l'identifiant IMDb du titre, le nom et l'empreinte du fichier sont envoyés à
ces services ; videz la liste des extensions et la clé pour n'en contacter aucun.

### Avec Docker

```bash
docker compose up -d --build
```

L'image contient Node.js et ffmpeg. Les données sont conservées dans `./data` et les
téléchargements dans `./media` (voir [`docker-compose.yml`](docker-compose.yml)).

### Essayer sans connexion : la démonstration

```bash
npm run build
npm run demo
```

Génère des vidéos d'exemple (films, séries, MKV multi-pistes, HEVC HDR, sous-titres…), lance
une source locale qui imite le site, un faux service TMDB et une fausse extension Stremio (liens
qui expirent, réserve de liens limitée), puis l'application sur <http://localhost:8484> avec une
base dédiée (`data/demo`). `DEMO_MODE=listing npm run demo` lit plutôt la liste de la source,
sans extension ; `DEMO_MAX_CONNECTIONS=2 npm run demo` limite les connexions simultanées à un
même fichier, comme un hébergeur strict (pour éprouver les positionnements du lecteur).

---

## Configuration

La plupart des réglages se font dans l'interface (**Paramètres**) : apparence du verre
(propre à chaque appareil), adresse et dossiers de la source, dossier de téléchargement, téléchargements simultanés, limite de débit, qualité
préférée, langue audio et sous-titres par défaut, qualité de conversion, clé et langue TMDB,
extension Stremio (adresse et test), sous-titres en ligne (extensions de sous-titres, clé et
compte OpenSubtitles.com, test), fréquence d'actualisation et source du catalogue (sans
extension : liste complète de la source, ou TMDB avec recherche des dossiers à la demande), mode
de connexion à la source (automatique, standard ou imitation de navigateur), test de connexion à
la source.

Les variables d'environnement définissent les valeurs de départ. Elles peuvent aussi être
placées dans un fichier `.env` à la racine du dépôt (copiez [`.env.example`](.env.example)) :

| Variable                                    | Défaut                                            | Rôle                                                                                              |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `HOST`                                      | `127.0.0.1`                                       | Interface réseau. `0.0.0.0` pour accéder à Lumière depuis la TV, le téléphone…                    |
| `PORT`                                      | `8484`                                            | Port HTTP.                                                                                        |
| `DATA_DIR`                                  | `./data`                                          | Base de données, caches (affiches, sous-titres).                                                  |
| `MEDIA_DIR`                                 | `<DATA_DIR>/media`                                | Dossier des téléchargements (modifiable dans l'interface).                                        |
| `SOURCE_BASE_URL`                           | `https://a.111477.xyz`                            | Adresse de la source.                                                                             |
| `SOURCE_MOVIES_PATH` / `SOURCE_SERIES_PATH` | `/movies/` / `/tvs/`                              | Dossiers des films et des séries sur la source.                                                   |
| `TMDB_API_KEY`                              | —                                                 | Clé TMDB (v3) ou jeton d'accès (v4).                                                              |
| `STREMIO_ADDON_URL`                         | `https://st.111477.xyz/manifest.json`             | Extension Stremio qui fournit les liens des fichiers (vide : liste de la source lue directement). |
| `SUBTITLE_ADDON_URLS`                       | `https://opensubtitles-v3.strem.io/manifest.json` | Extensions Stremio de sous-titres, séparées par des virgules (vide : aucune).                     |
| `OPENSUBTITLES_API_KEY`                     | —                                                 | Clé d'API OpenSubtitles.com (sous-titres faits pour le fichier exact).                            |
| `FFMPEG_PATH` / `FFPROBE_PATH`              | `ffmpeg` / `ffprobe`                              | Chemins des binaires s'ils ne sont pas dans le PATH.                                              |
| `LOG_LEVEL`                                 | `info`                                            | `debug` pour diagnostiquer.                                                                       |

> **Pourquoi une extension Stremio ?** Le site a.111477.xyz impose une vérification Cloudflare
> que seul un vrai navigateur passe. Son extension Stremio (st.111477.xyz) donne au contraire
> des liens faits pour les lecteurs vidéo. Lumière lui demande les liens **au moment d'agir** :
> à l'ouverture d'un film (ses versions), à la lecture ou au téléchargement d'un épisode (la
> liste des saisons vient de TMDB). Les réponses sont gardées en base et réutilisées tant que
> l'hôte accepte le lien. Chez 111477, **chaque lien consomme un jeton** d'une réserve propre à
> votre adresse IP (50 jetons, un regagné toutes les 5 minutes) : réglez l'extension pour
> qu'elle propose peu de liens par titre. « Télécharger la saison » demande les épisodes un par
> un en arrière-plan et s'arrête proprement si la réserve est vide.

> **Accès depuis d'autres appareils** : lancez avec `HOST=0.0.0.0 npm start` (PowerShell :
> `$env:HOST="0.0.0.0"; npm start`) puis ouvrez `http://<ip-du-pc>:8484`. L'application n'a pas
> d'authentification : ne l'exposez pas directement sur Internet.

---

## Utilisation

- **Accueil** : reprise de lecture, ajouts récents, contenu de la bibliothèque.
- **Films / Séries** : catalogue complet, filtres et tri ; cliquez sur une affiche pour la fiche.
- **Fiche** : « Lecture » (streaming ou copie locale), « Télécharger » (meilleure version selon
  vos préférences) ou choix d'une version précise ; pour une série, onglets de saisons,
  « Télécharger la saison » ou « Tout télécharger ». Avec l'extension, chaque épisode a ses
  boutons « Lecture » et « Télécharger » (version préférée demandée au moment voulu) et
  « Choisir une version » pour voir toutes celles que propose l'extension.
- **Téléchargements** : pause, reprise, annulation, nouvel essai, historique.
- **Ma bibliothèque** : vos fichiers, lisibles hors ligne.
- **Explorateur** : parcours brut du site, téléchargement d'un fichier ou d'un dossier entier
  (seulement si le site est accessible sans vérification).

Raccourcis du lecteur :

| Touche         | Action                        | Touche  | Action             |
| -------------- | ----------------------------- | ------- | ------------------ |
| `Espace` / `K` | Lecture / pause               | `F`     | Plein écran        |
| `←` / `→`      | −10 s / +10 s (`Maj` : 30 s)  | `M`     | Couper le son      |
| `↑` / `↓`      | Volume                        | `N`     | Épisode suivant    |
| `G` / `H`      | Sous-titres −0,25 s / +0,25 s | `Échap` | Quitter le lecteur |

---

## Développement

```bash
npm install
npm run dev        # API (port 8484, rechargement à chaud) + interface Vite (http://localhost:5173)
```

| Commande                                                      | Rôle                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                               | Compile l'interface (Vite) puis le serveur (esbuild).                                                                                         |
| `npm start`                                                   | Démarre le serveur de production (sert aussi l'interface compilée).                                                                           |
| `npm test`                                                    | Tests unitaires et d'intégration du serveur et de l'interface (Vitest).                                                                       |
| `npm run typecheck`                                           | Vérification TypeScript de tous les paquets.                                                                                                  |
| `npm run lint` / `npm run format`                             | ESLint / Prettier.                                                                                                                            |
| `npm run check`                                               | Types + lint + tests.                                                                                                                         |
| `npm run demo:media`                                          | (Re)génère les vidéos et affiches de démonstration.                                                                                           |
| `npm run demo`                                                | Démonstration complète hors ligne.                                                                                                            |
| `npm run probe -w @lumiere/server -- <url>`                   | Affiche ce que l'analyseur comprend d'une page de listing.                                                                                    |
| `npm run diagnose -- [--extension=URL] [--film=tt…] [--site]` | Teste l'extension Stremio (manifeste, liens d'un film, lecture des premiers octets) et, avec `--site`, l'accès direct au site ; puis conclut. |

Structure du dépôt :

```
apps/server         API Fastify, catalogue, téléchargements, lecture (TypeScript)
apps/web            interface React + Vite + Tailwind CSS
packages/shared     types partagés entre serveur et interface (contrats d'API)
tools/demo-source   source de démonstration (index HTTP, vidéos ffmpeg, faux TMDB et fausse extension Stremio)
docs/               architecture, design system et captures d'écran
```

Les choix techniques sont détaillés dans **[CHOIX_TECHNIQUES.md](CHOIX_TECHNIQUES.md)**,
l'architecture dans **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** et le design system
Liquid Glass dans **[docs/DESIGN.md](docs/DESIGN.md)**.

---

## Dépannage

| Symptôme                                                                | Piste                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le catalogue reste vide / « Aucune entrée reconnue »                    | **Paramètres → Tester la source**. Vérifiez l'adresse et les dossiers (`/movies/`, `/tvs/`). Lancez `npm run probe -w @lumiere/server -- https://a.111477.xyz/movies/` pour voir ce que l'analyseur extrait de la page.                                                             |
| « La source a répondu 403 » / « vérification anti-robot »               | Le site est protégé par Cloudflare : gardez l'extension Stremio renseignée (**Paramètres → Extension Stremio**), Lumière ne lit alors plus le site directement. Lancez `npm run diagnose` pour vérifier l'extension depuis votre machine et joignez le rapport à votre signalement. |
| Catalogue vide avec l'extension                                         | Le catalogue vient de TMDB : ajoutez une clé TMDB (**Paramètres → Métadonnées**), puis **Catalogue → Actualiser maintenant**.                                                                                                                                                       |
| « L'extension a atteint sa limite de liens »                            | La réserve de liens de votre adresse IP est vide (chez 111477 : un lien regagné toutes les 5 minutes). Patientez, et réglez l'extension sur [st.111477.xyz](https://st.111477.xyz/) pour qu'elle propose moins de liens par titre. Les liens déjà obtenus restent utilisables.      |
| « Extension Stremio injoignable » / « manifest.json invalide »          | Vérifiez l'adresse dans **Paramètres → Extension Stremio** (bouton « Tester l'extension ») : collez le lien d'installation complet, configuration comprise.                                                                                                                         |
| « Aucun fichier proposé » / « Introuvable sur la source » sur une fiche | L'extension ne propose aucun fichier pour ce titre (nouvel essai à la prochaine ouverture) ; sans extension, le dossier du titre n'a pas été trouvé sous les noms essayés (affichés sur la fiche), nouvel essai au bout de 24 h.                                                    |
| Une vidéo ne se lance pas                                               | Vérifiez que ffmpeg est détecté (**Paramètres → Système**). Le lecteur bascule automatiquement en conversion en cas d'échec.                                                                                                                                                        |
| Pas d'affiches                                                          | Ajoutez/testez la clé TMDB dans les paramètres.                                                                                                                                                                                                                                     |
| Défilement saccadé                                                      | **Paramètres → Apparence** : désactivez la réfraction ou choisissez « Teinté » ou « Opaque » (la réfraction se coupe d'elle-même si l'affichage saccade).                                                                                                                           |
| Pas d'effet de réfraction                                               | Normal hors Chrome, Edge, Brave ou Opera : Safari et Firefox affichent un verre dépoli.                                                                                                                                                                                             |
| « Le port 8484 est déjà utilisé »                                       | `PORT=8585 npm start`                                                                                                                                                                                                                                                               |

---

## Avertissement

Lumière est un outil générique de navigation et de téléchargement pour des index HTTP.
Utilisez-le uniquement pour des contenus que vous avez le droit de télécharger et de
visionner, dans le respect de la législation de votre pays.
