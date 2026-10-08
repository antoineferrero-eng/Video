# Architecture de Lumière

## Vue d'ensemble

```mermaid
flowchart LR
  subgraph Navigateur
    UI[Interface React<br/>TanStack Query]
    Player[Lecteur vidéo<br/>+ sous-titres]
  end
  subgraph Serveur Node.js
    API[API Fastify<br/>/api/*]
    SSE[Flux temps réel<br/>SSE /api/events]
    Catalog[Catalogue]
    Downloads[Moteur de<br/>téléchargement]
    Playback[Lecture<br/>direct / remux / conversion]
    Metadata[Métadonnées TMDB<br/>+ cache d'images]
    DB[(SQLite<br/>node:sqlite)]
    FF[ffmpeg / ffprobe]
    Client[Lecture des fichiers<br/>liens de secours · imitation TLS]
    Addon[Client des extensions<br/>Stremio · liens en base]
  end
  Stremio[(Extensions Stremio<br/>st.111477.xyz, …)]
  Hosts[(Hôtes des fichiers)]
  TMDB[(API TMDB)]
  Disk[(Dossier<br/>bibliothèque)]

  UI -- REST --> API
  SSE -- événements --> UI
  Player -- flux vidéo --> Playback
  API --> Catalog & Downloads & Playback & Metadata
  Catalog -- versions d'un titre --> Addon
  Downloads -- HTTP Range --> Client
  Downloads --> Disk
  Playback --> FF
  FF -- relais local --> Client
  FF -- lit --> Disk
  Client -- chemins /@stremio/ --> Addon
  Addon -- liens --> Stremio
  Client -- octets --> Hosts
  Catalog -- catalogue --> TMDB
  Metadata --> TMDB
  Catalog & Downloads & Playback & Metadata --> DB
```

L'application est un **monorepo npm** :

| Paquet              | Rôle                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/server`       | API HTTP, catalogue TMDB, fichiers des extensions Stremio, téléchargements, lecture, bibliothèque.              |
| `apps/web`          | Interface React (SPA) servie par le serveur en production.                                                      |
| `packages/shared`   | Types TypeScript des échanges client/serveur (contrats d'API).                                                  |
| `tools/demo-source` | Démonstration hors ligne : vidéos générées par ffmpeg, faux TMDB, deux fausses extensions Stremio, sous-titres. |

## Serveur (`apps/server/src`)

```
main.ts              démarrage, arrêt propre (SIGINT/SIGTERM)
app.ts               instance Fastify : validation zod, gestion d'erreurs, routes /api, interface statique
container.ts         racine de composition : création et câblage de tous les services
config/env.ts        variables d'environnement validées (zod)
core/                utilitaires transverses (erreurs, logs, bus d'événements, fichiers, Range, asynchrone)
infra/database/      connexion SQLite, migrations versionnées, cache clé/valeur
domain/              fonctions pures : noms de releases, épisodes/saisons, titres, choix de version
modules/
  source/            lecture des fichiers distants (liens des extensions essayés dans l'ordre,
                     imitation de Chrome en secours), relais local pour ffmpeg
    stremio/         client des extensions Stremio (manifestes, liens d'un film ou d'un
                     épisode réunis et gardés en base) et chemins virtuels /@stremio/… des fichiers
  catalog/           catalogue TMDB (listes, recherche, popularité), fiches ;
                     addon-catalog.ts : titres TMDB ↔ extensions (identifiant IMDb, saisons)
  metadata/          client TMDB, rapprochement des titres, cache des images
  downloads/         file d'attente, moteur de transfert, rangement des fichiers ;
                     episode-queue.ts : épisodes demandés un par un aux extensions
  library/           fichiers locaux, analyse du dossier
  playback/          ffprobe, plan de lecture, sessions, flux ffmpeg, sous-titres, progression
  subtitles/         sous-titres en ligne : API OpenSubtitles.com, extensions Stremio de
                     sous-titres, empreinte OpenSubtitles des fichiers
  availability/      état combiné téléchargement / bibliothèque / visionnage d'un fichier
  settings/          paramètres persistés (modifiables à chaud)
  events/, system/   flux SSE, santé et informations système
```

Chaque module suit le même découpage : **routes** (HTTP + validation zod) → **service**
(règles métier) → **repository** (SQL). Les services reçoivent leurs dépendances par le
constructeur : ils se testent isolément ou ensemble (tests d'intégration avec de faux
serveurs HTTP).

### Catalogue TMDB et extensions Stremio

Le site a.111477.xyz exige une vérification Cloudflare que seul un vrai navigateur passe : il
n'est plus lu. Les extensions Stremio (`stremioAddonUrls`, par ordre de préférence) fournissent
au contraire des liens destinés aux lecteurs vidéo :

1. Le catalogue vient de **TMDB** (`tmdb-catalog.ts` : populaires, tendances, à l'affiche,
   mieux notés, « Découvrir » jusqu'à `catalogSize` titres, et toute recherche), importé dans
   `titles` avec sa popularité.
2. À l'ouverture d'un **film**, `AddonCatalog` obtient son identifiant IMDb (TMDB
   `external_ids`, demandé une fois puis gardé dans `titles.imdb_id`) et `StremioAddons`
   interroge en parallèle chaque extension capable de chercher ce titre (types et préfixes de
   son manifeste : `tt…`, ou `tmdb:…`) : `GET <base>/stream/movie/tt….json`. Chaque fichier
   proposé reçoit un **chemin virtuel** stable, `/@stremio/movie/tt1677720/<fichier>`
   (`stremio/virtual-path.ts`), le même quelle que soit l'extension : téléchargements,
   bibliothèque, reprise de lecture et relais ffmpeg le manipulent comme un chemin ordinaire.
   Les fichiers des extensions sont réunis par nom ; le titre est rattaché à son dossier
   virtuel (`/@stremio/movie/tt1677720/`).
3. Pour une **série**, saisons et épisodes viennent de TMDB ; aucun lien n'est demandé pour
   afficher la fiche. Les liens d'un épisode (`…/stream/series/tt…:S:E.json`, chemins
   `/@stremio/series/tt…/SxE/<fichier>`) ne sont demandés qu'à la lecture, au téléchargement,
   ou à l'ouverture de « Choisir une version ». Une référence `{ type: 'episode', titleId,
season, episode }` permet de lancer la lecture (ou l'épisode suivant) sans connaître le
   fichier : le serveur prend la copie locale, sinon la version préférée.
4. La réponse de **chaque extension** est gardée en base (`kv_cache`, 12 h ; 3 min si vide ou
   limitée) avec le lien de chaque fichier. `SourceClient.openFile` obtient au moment de lire
   les octets la liste des liens d'un fichier (un par extension qui le propose, dans l'ordre de
   préférence) et les essaie tour à tour ; s'ils sont tous refusés (401/403/404/410), ils sont
   redemandés une fois aux extensions qui les avaient fournis. Chez 111477, chaque lien
   consomme un jeton d'une réserve par adresse IP : ces règles évitent d'en gaspiller.
5. « Télécharger la saison » met les épisodes dans `EpisodeQueue` : une demande toutes les
   1,2 s (limite de 10 requêtes par 10 s), épisodes déjà téléchargés ignorés, lot abandonné dès
   qu'une extension signale sa limite ; le bilan est diffusé (`downloads.notice`).
6. `MetadataService` complète les fiches (détails localisés, genres, durée, saisons) en
   arrière-plan, et à la demande lorsqu'une affiche ou une fiche est affichée.

### Téléchargement

```mermaid
sequenceDiagram
  participant UI
  participant DM as DownloadManager
  participant S as Hôte du lien
  participant FS as Disque
  UI->>DM: POST /api/downloads (fichiers / film / saison / série)
  DM->>DM: file d'attente SQLite (statut queued)
  loop tant que des places sont libres
    DM->>S: GET fichier (Range: bytes=<déjà reçu>-)
    S-->>DM: 206 Partial Content
    DM->>FS: ajout au fichier .part (limiteur de débit)
    DM-->>UI: SSE download.updated (octets, débit, ETA)
  end
  DM->>FS: renommage .part → fichier final
  DM->>DM: ajout à la bibliothèque
  DM-->>UI: SSE library.changed
```

Pause, annulation et arrêt du serveur interrompent proprement le transfert (AbortController) ;
au redémarrage, les téléchargements interrompus repartent de l'octet où ils s'étaient arrêtés.

### Lecture

1. Le navigateur détecte ses codecs (`capabilities.ts`) et demande une session :
   `POST /api/playback/sessions { media, capabilities, audioTrack? }`.
2. Le serveur résout le média (copie locale prioritaire), l'analyse avec **ffprobe** et
   calcule un plan (`planner.ts`) : **direct**, **remux** (vidéo copiée) ou **conversion**
   (H.264 ou VP9 selon le navigateur, tonemapping HDR).
3. Le lecteur lit `GET /api/playback/sessions/:id/stream` :
   - direct : fichier local ou relais du lien de l'extension avec prise en charge de `Range` ;
   - remux/conversion : ffmpeg produit un MP4 fragmenté à partir de `?start=<secondes>` ;
     un fichier distant est lu par le **relais local** `/api/internal/source` (jeton aléatoire),
     pour que ffmpeg passe par la même connexion que le reste de l'application ;
     chaque chargement porte un identifiant (`&stream=<id>`) et
     `GET …/streams/:id/origin` donne l'instant réel de départ (image clé atteinte en
     recopie vidéo, lue par ffmpeg dans le même passage) pour rester synchronisé.
4. Sous-titres : `GET …/subtitles/:piste` renvoie du WebVTT (extraction ffmpeg ou conversion
   SRT/ASS), affiché par le lecteur. `GET …/subtitles/online` cherche en ligne (OpenSubtitles,
   extensions de sous-titres) ; les résultats rejoignent les pistes de la session et se
   chargent de la même façon (téléchargés une fois, gardés en cache).
5. La position est enregistrée régulièrement (`POST …/progress`) : reprise, « Reprendre la
   lecture », marquage « vu ».

## Modèle de données (SQLite)

| Table               | Contenu                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `titles`            | Films et séries du catalogue + métadonnées TMDB (affiche, résumé, genres JSON…). |
| `catalog_sections`  | État de l'import TMDB des sections films/séries.                                 |
| `downloads`         | File et historique des téléchargements (statut, octets, erreurs).                |
| `library_items`     | Fichiers présents dans la bibliothèque locale.                                   |
| `watch_progress`    | Position de lecture par média (clé = chemin distant ou fichier local).           |
| `settings`          | Paramètres modifiés depuis l'interface.                                          |
| `kv_cache`          | Cache des réponses TMDB (saisons…) et des liens de chaque extension Stremio.     |
| `schema_migrations` | Migrations appliquées.                                                           |

## API REST (principales routes)

| Méthode   | Route                                            | Rôle                                                                  |
| --------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| GET       | `/api/home`                                      | Accueil (titres mis en avant, films et séries populaires).            |
| GET       | `/api/titles?kind&q&sort&genre&page`             | Catalogue paginé.                                                     |
| GET       | `/api/titles/:id`                                | Fiche complète (versions, saisons, épisodes, disponibilité).          |
| GET       | `/api/titles/:id/episodes/:saison/:épisode`      | Versions d'un épisode (demandées aux extensions Stremio).             |
| GET       | `/api/titles/:id/artwork/:type`                  | Affiche/fond (recherche TMDB à la demande).                           |
| GET       | `/api/images/:taille/:fichier`                   | Image TMDB mise en cache.                                             |
| POST      | `/api/catalog/refresh`                           | Réimporter les listes de TMDB.                                        |
| GET/POST  | `/api/downloads`                                 | Liste / ajout de fichiers.                                            |
| POST      | `/api/downloads/title`                           | Film, épisode, saison ou série.                                       |
| POST      | `/api/downloads/:id/pause` · `resume` · `cancel` | Contrôle d'un téléchargement.                                         |
| GET       | `/api/library`, `/api/library/:id/file`          | Bibliothèque, enregistrement d'un fichier.                            |
| POST      | `/api/playback/sessions`                         | Création d'une session de lecture.                                    |
| GET       | `/api/playback/sessions/:id/stream?start=`       | Flux vidéo.                                                           |
| GET       | `/api/playback/continue`                         | Lectures en cours.                                                    |
| GET/PATCH | `/api/settings`                                  | Paramètres.                                                           |
| POST      | `/api/settings/test-addon`                       | Test d'une adresse d'extension Stremio (manifeste).                   |
| GET       | `/api/events`                                    | Flux temps réel (Server-Sent Events).                                 |
| GET       | `/api/system`, `/api/health`                     | État du système.                                                      |
| GET       | `/api/internal/source?path&token`                | Relais des fichiers distants réservé à ffmpeg/ffprobe (jeton requis). |

## Interface (`apps/web/src`)

```
main.tsx, router.tsx    point d'entrée, routes (pages chargées à la demande)
styles/                 jetons de design, matériau Liquid Glass, fond d'ambiance
design/glass/           moteur du verre : préférences d'apparence, réfraction (cartes de
                        déplacement + filtres SVG), lumière dynamique, garde-fou de fluidité
design/ambient/         palette extraite des illustrations, fond d'ambiance
api/                    client HTTP typé, hooks TanStack Query, abonnement SSE
components/ui/          boutons, badges, barres de progression, dialogues, menus, contrôles
                        segmentés, interrupteurs…
components/layout/      barre latérale flottante, barre d'outils, barre d'onglets mobile
components/media/       affiches, rangées défilantes, badges de release
features/               une page par dossier : home, catalog, title, downloads, library,
                        settings, search, player
lib/                    formatage (tailles, durées), codecs du navigateur, WebVTT
```

Le cache TanStack Query est la source de vérité côté client ; le flux SSE y injecte la
progression des téléchargements et invalide les vues concernées (bibliothèque, fiches,
catalogue) quand le serveur signale un changement.

Le design system (couches, matériaux, jetons, accessibilité, prise en charge des navigateurs)
est décrit dans [DESIGN.md](DESIGN.md). Les fonctions pures de l'interface (réfraction,
détection des navigateurs, préférences, palette, navigation) sont couvertes par des tests
Vitest (`apps/web/src/**/*.test.ts`).
