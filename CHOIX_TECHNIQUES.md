# Choix techniques — Lumière

Ce document explique les choix faits pour construire **Lumière**, l'application qui permet
de parcourir, télécharger et regarder les films et séries de `a.111477.xyz` — aujourd'hui
via son extension Stremio, le site lui-même exigeant une vérification Cloudflare (§ 11).

---

## 1. Le point de départ : ce qu'est la source

`a.111477.xyz` est un **index de fichiers HTTP** (un « listing de dossiers ») : il n'y a pas
d'API, seulement des pages HTML qui listent des dossiers et des fichiers, par exemple
`/movies/100 METERS (2025)/100.Meters.2025.1080p.NF.WEB-DL.MULTi.DDP5.1.H.264-VARYG.mkv`.
Les films sont rangés dans `/movies/<Titre (Année)>/`, les séries dans `/tvs/<Série>/<Saison>/`.

Conséquences sur la conception :

- tout le catalogue doit être **reconstruit en lisant ces pages HTML** ;
- le format exact du HTML peut changer du jour au lendemain → l'analyseur doit être
  **générique et tolérant**, pas écrit pour une seule mise en page ;
- les fichiers sont des releases (MKV, HEVC, DD+ 5.1, multi-pistes audio…) que les
  navigateurs ne savent pas toujours lire → il faut une **chaîne de conversion** ;
- les noms de fichiers contiennent beaucoup d'informations (qualité, langues, codecs)
  qu'on peut exploiter pour une belle interface.

> Remarque : l'environnement cloud dans lequel l'application a été développée bloque l'accès
> à `a.111477.xyz`. L'analyseur a donc été conçu pour reconnaître **tous les formats de
> listing courants** (nginx, Apache, Caddy, lighttpd, listes `<ul>`, grilles `<div>`, JSON),
> testé sur ces formats, et une **source de démonstration** locale a été construite pour
> valider l'application de bout en bout. L'outil `npm run probe` permet de vérifier en une
> commande ce que l'analyseur comprend du vrai site, et `npm run diagnose` si l'extension
> Stremio (ou le site) répond depuis la machine de l'utilisateur (voir § 11).

---

## 2. Type d'application : une application web auto‑hébergée

**Choix : un serveur local (Node.js) + une interface web (navigateur), installable comme
application (PWA).**

| Option envisagée                   | Pourquoi elle n'a pas été retenue                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Application de bureau Electron     | Plus lourde (Chromium embarqué par OS), ne lit pas mieux les MKV/HEVC/AC3 sans ffmpeg, packaging et mises à jour à gérer pour chaque système. |
| Application native (Swift/Kotlin…) | Une base de code par plateforme, coût disproportionné.                                                                                        |
| Simple script de téléchargement    | Ne répond pas au besoin « belle interface » ni « regarder ».                                                                                  |

Avantages du modèle retenu (celui de Plex, Jellyfin, Sonarr…) :

- les **téléchargements tournent côté serveur**, même si l'onglet est fermé, et reprennent
  après un redémarrage ;
- on peut **regarder depuis n'importe quel appareil** du réseau local (PC, tablette,
  téléphone, TV avec navigateur) ;
- un seul code pour tous les systèmes (Windows, macOS, Linux) et un déploiement **Docker**
  possible (NAS, serveur domestique).

---

## 3. Langage et organisation du code

- **TypeScript partout** (serveur, interface, outils) en mode strict : une seule langue, et
  surtout des **contrats d'API partagés** (`packages/shared`) — le serveur et l'interface
  utilisent exactement les mêmes types, une erreur de format est détectée à la compilation.
- **Monorepo npm workspaces** (outil natif de Node, pas de dépendance supplémentaire) :

```
apps/server        API, moteur de téléchargement, lecture
apps/web           interface React
packages/shared    types partagés (contrats d'API)
tools/demo-source  source de démonstration (vidéos générées par ffmpeg + faux TMDB)
```

- Côté serveur, **architecture modulaire en couches** : `routes` (HTTP, validation) →
  `services` (logique métier) → `repositories` (SQL), plus un dossier `domain` de fonctions
  pures (analyse des noms de releases, des épisodes…) testées unitairement. Les dépendances
  sont assemblées dans une **racine de composition** unique (`container.ts`) : injection de
  dépendances manuelle, sans framework, facile à lire et à tester.

---

## 4. Serveur

| Besoin          | Choix                                                | Raisons                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime         | **Node.js 22 LTS**                                   | Excellent pour les entrées/sorties (flux, téléchargements parallèles, proxy vidéo), `fetch` natif, version longue durée.                                                                                                                                                                                                                                                                                       |
| Framework HTTP  | **Fastify 5**                                        | Rapide, typé, gestion propre des flux et des erreurs, écosystème officiel (`@fastify/static`).                                                                                                                                                                                                                                                                                                                 |
| Validation      | **zod 4** + `fastify-type-provider-zod`              | Chaque entrée (paramètres, corps, requête) est validée ; les types TypeScript en sont déduits automatiquement.                                                                                                                                                                                                                                                                                                 |
| Base de données | **SQLite** via le module intégré **`node:sqlite`**   | Zéro installation (un fichier), transactions ACID, très rapide en local et **aucune compilation native** : l'installation fonctionne partout. `better-sqlite3` a été essayé puis écarté : lors d'un `npm ci`, il lance une compilation `node-gyp` qui exige Python et un compilateur C++, souvent absents sous Windows. Migrations SQL versionnées appliquées au démarrage, requêtes préparées mises en cache. |
| Analyse HTML    | **cheerio** (moteur htmlparser2) + algorithme maison | Voir §5. 50 000 entrées analysées en < 1 s.                                                                                                                                                                                                                                                                                                                                                                    |
| Journalisation  | **pino**                                             | Logs JSON structurés, mode lisible en développement.                                                                                                                                                                                                                                                                                                                                                           |
| Vidéo           | **ffmpeg / ffprobe** (binaires système)              | La référence pour analyser et convertir n'importe quel format ; inclus dans l'image Docker.                                                                                                                                                                                                                                                                                                                    |
| Temps réel      | **Server-Sent Events**                               | La progression des téléchargements va du serveur vers l'interface uniquement : SSE est plus simple que WebSocket, se reconnecte tout seul et passe par les proxys.                                                                                                                                                                                                                                             |
| Bundle          | **esbuild**                                          | Le serveur est compilé en un seul fichier `dist/main.js` (démarrage rapide, pas de problème d'extensions ESM).                                                                                                                                                                                                                                                                                                 |

---

## 5. L'analyseur de listings (le cœur de l'intégration avec le site)

Plutôt que de dépendre du HTML exact du site, l'analyseur :

1. repère tous les liens de la page et ne garde que ceux qui pointent vers un **enfant direct
   du dossier courant** (ce qui élimine navigation, tri, liens externes, dossier parent) ;
2. remonte depuis chaque lien jusqu'à la plus grande « ligne » qui ne contient qu'une entrée
   (`<tr>`, `<li>`, `<div>`…) ou lit la fin de ligne dans un `<pre>` ;
3. y cherche une **taille** (« 1.4G », « 734 Mo », « 2147483648 »…) et une **date** (formats
   nginx, Apache, ISO, US, européen, attributs `datetime`/`data-*`, horodatages Unix) ;
4. accepte aussi les **listings JSON** (nginx `autoindex_format json`, Caddy, rclone).

Il est couvert par des tests sur chaque format, optimisé (parcours linéaire, moteur
htmlparser2 : 50 000 entrées en moins d'une seconde) et un **explorateur** dans l'interface
permet de naviguer dans la source même si l'organisation films/séries changeait.

Les noms de releases sont analysés par un module dédié (`release-parser.ts`) : titre, année,
résolution, source (WEB-DL, BluRay, Remux…), codecs, HDR/Dolby Vision, audio (DD+ 5.1,
TrueHD Atmos…), langues (MULTi, VFF, VOSTFR, TRUEFRENCH…), service (Netflix…), groupe.

---

## 6. Téléchargements

Moteur écrit sur mesure plutôt qu'un outil externe (aria2, wget) pour une intégration
complète avec l'interface :

- **file d'attente persistée** en base (survit aux redémarrages, reprise automatique) ;
- **reprise réelle** grâce aux requêtes HTTP `Range` (fichier `.part` complété, pas
  recommencé) — vérifié par un test qui coupe et reprend un transfert et compare l'empreinte
  SHA-256 ;
- **concurrence réglable**, **limitation de débit** globale, **nouvelles tentatives** avec
  temporisation exponentielle, détection des transferts bloqués, vérification de l'espace
  disque ;
- **rangement automatique** : `Films/<Titre (Année)>/…`, `Séries/<Série>/Saison 01/…` ;
- téléchargement d'un film (meilleure version selon vos préférences), d'une saison, d'une
  série entière ou d'un dossier quelconque de la source ;
- progression, débit et temps restant diffusés **en temps réel** (SSE).

---

## 7. Lecture vidéo

Les navigateurs ne lisent pas tout : pas d'AC3/DTS, pas de HEVC sur la plupart des PC,
pas de H.264 10 bits, MKV non lu par Safari/Firefox… Le serveur choisit donc pour chaque
fichier, **en fonction des codecs réellement supportés par le navigateur** (détectés côté
client) :

| Mode                | Quand                                                                                                | Coût                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Lecture directe** | Conteneur et codecs compatibles                                                                      | Aucun ; avance rapide native (HTTP Range)                                     |
| **Remultiplexage**  | Vidéo compatible mais audio/conteneur non (ex. MKV H.264 + AC3, ou piste audio française secondaire) | Très faible : la vidéo est recopiée, seul l'audio est converti                |
| **Conversion**      | Vidéo non décodable (HEVC 10 bits, HDR…)                                                             | ffmpeg (H.264, ou VP9 si le navigateur n'a pas H.264) ; tonemapping HDR → SDR |

Le flux converti est un **MP4 fragmenté** envoyé au fil de l'eau ; se positionner relance
ffmpeg au bon endroit. L'alternative HLS a été écartée : plus complexe (segments sur
disque, nettoyage) pour un usage domestique.

Se positionner sans désynchroniser, surtout sur un fichier lu à distance :

- **vidéo recopiée** (remultiplexage) : elle repart forcément de l'image clé qui précède la
  position demandée. L'audio repart du même instant (`-noaccurate_seek`) : le MP4 fragmenté
  fait démarrer chaque piste à zéro, un audio coupé plus tard que l'image serait joué en
  avance (et les sous-titres, calés sur l'horloge, avec lui) ;
- l'instant exact de cette image clé est donné par **ffmpeg lui-même**, dans le même
  passage (seconde sortie `framecrc` du premier paquet vidéo, sur stderr) : pas de seconde
  analyse du fichier distant à chaque positionnement, et une valeur toujours juste ;
- trous de l'audio source comblés par du silence (`aresample=async=1`), décalages de
  composition négatifs (B-frames : première image affichée à 0 comme l'audio), fragments
  de 2 s pour démarrer vite ;
- un seul ffmpeg par session, l'ancien est arrêté **et attendu** avant le suivant ; un
  démarrage raté est retenté (la source refuse parfois un instant) et n'envoie jamais de
  flux vide ; ffmpeg se reconnecte aussi aux réponses 5xx du relais ;
- côté lecteur : appuis rapprochés (±10 s répétés) regroupés en un seul positionnement,
  événements d'un flux remplacé ignorés, coupure d'un flux déjà lu reprise au même endroit
  au lieu de basculer vers une conversion plus lourde ;
- extension Stremio : un lien refusé n'est renouvelé qu'une fois par minute et par fichier
  (chaque demande consomme des jetons), et une réponse « limite atteinte » ne fait pas
  oublier les liens déjà obtenus.

Autres points :

- la **langue audio préférée** (français par défaut) est choisie automatiquement dans les
  releases MULTi, et on peut changer de piste pendant la lecture ;
- **sous-titres** intégrés (MKV) ou externes (`.srt`, `.vtt`, `.ass`) convertis en WebVTT,
  encodage Windows‑1252 détecté, affichage personnalisé et synchronisé dans le lecteur ;
- un fichier déjà téléchargé est toujours lu **depuis la copie locale** ;
- **reprise là où on s'était arrêté**, rangée « Reprendre la lecture », **épisode suivant**
  automatique, raccourcis clavier, plein écran, repli automatique direct → remux → conversion
  en cas d'échec.

---

## 8. Métadonnées : TMDB

Les affiches, résumés, notes, genres et titres d'épisodes viennent de **The Movie Database**
(clé gratuite, saisie dans les paramètres ou via `TMDB_API_KEY`) :

- recherche par titre + année avec un score de correspondance (titre exact, titre original,
  année, popularité) ;
- enrichissement progressif en arrière-plan + à la demande quand une affiche s'affiche ;
- **cache disque des images** (la bibliothèque reste illustrée hors ligne) ;
- **sans clé**, l'application reste fonctionnelle avec des affiches générées quand le
  catalogue vient de la liste du site ; avec l'extension Stremio, la clé est indispensable
  puisque TMDB fournit le catalogue (§ 11).

---

## 9. Interface

| Besoin                | Choix                        | Raisons                                                                         |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| Bibliothèque UI       | **React 19**                 | Standard du marché, écosystème riche.                                           |
| Outil de build        | **Vite 8**                   | Démarrage instantané, build rapide, découpage du code par page.                 |
| Styles                | **Tailwind CSS 4**           | Design system cohérent (jetons de couleurs dans `@theme`), pas de CSS mort.     |
| Données serveur       | **TanStack Query 5**         | Cache, revalidation, pagination infinie ; mis à jour en direct par le flux SSE. |
| Navigation            | **React Router 8**           | Routage déclaratif, pages chargées à la demande.                                |
| Icônes, notifications | **lucide-react**, **sonner** | Légers et élégants.                                                             |
| Police                | **Système Apple / Inter**    | SF Pro via `-apple-system` sur macOS/iOS (sans l'embarquer), Inter ailleurs.    |

Direction artistique : thème sombre « salle de cinéma », design **Liquid Glass** inspiré
d'Apple (voir la section suivante), accent ambre « lumière du projecteur » réservé aux actions
principales, grandes affiches, interface 100 % en français, adaptée au mobile et installable
comme application (manifeste PWA).

---

## 10. Design « Liquid Glass »

### Recherches préalables

Avant la refonte, j'ai étudié la documentation d'Apple et l'état de l'art sur le Web :

- **Ce qu'est Liquid Glass** (HIG « Materials », WWDC25 « Meet Liquid Glass ») : un matériau
  réservé à la **couche fonctionnelle** (barres, commandes, menus) qui flotte au-dessus du
  contenu — jamais dans le contenu lui-même, jamais « verre sur verre », avec parcimonie. Il se
  définit par la **lentille** (la lumière est courbée et concentrée sur les bords, pas
  seulement diffusée), des **reflets spéculaires** qui réagissent au mouvement, une
  **adaptation** au contenu (ombre, teinte, luminosité), une **matérialisation** progressive
  plutôt qu'un fondu et une **souplesse de gel** quand on le touche.
- **Variantes** : « normale » (lisible, la plupart des composants), « claire » (sur photos et
  vidéos, avec un voile d'atténuation de 35 % si le fond est clair), teinte de couleur
  réservée aux actions principales.
- **Mise en page** (WWDC25 « Get to know the new design system », « Adopting Liquid Glass »,
  HIG « Tab bars » et « Sidebars ») : formes **concentriques** et capsules, barre latérale
  **incrustée** sous laquelle le contenu s'étend (« background extension »), barre d'onglets
  **flottante qui se réduit au défilement** avec un onglet de recherche séparé, **effet de bord
  de défilement** à la place des séparateurs, menus qui jaillissent de leur bouton.
- **Accessibilité** : Apple adapte le verre à « Réduire la transparence » (plus givré),
  « Augmenter le contraste » (noir/blanc avec bordure) et « Réduire les animations ». Les
  critiques de lisibilité (contrastes mesurés jusqu'à 1,5:1) ont conduit Apple à ajouter une
  option **« Teinté »** dans iOS 26.1.
- **Sur le Web** : `backdrop-filter` (flou, saturation) fonctionne partout, mais la vraie
  réfraction exige un filtre SVG `feDisplacementMap` référencé dans `backdrop-filter`, ce que
  **seul Chromium** sait appliquer (Safari et Firefox l'ignorent) ; `backdrop-filter` coûte
  cher au GPU s'il est multiplié ; la police SF Pro et les SF Symbols **ne peuvent pas** être
  embarqués sur le Web (licence).

### Choix

| Principe d'Apple              | Mise en œuvre dans Lumière                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Couche fonctionnelle en verre | Barre latérale, barre d'outils, barre d'onglets, menus, dialogues, notifications, commandes du lecteur. Le contenu (affiches, listes, réglages) utilise des « remplissages » translucides, jamais du verre.                                 |
| Lentille (réfraction)         | Carte de déplacement calculée pour la **forme exacte** de chaque élément (distance signée d'un rectangle arrondi, biseau convexe), appliquée par `feDisplacementMap` dans `backdrop-filter`. Navigateurs non Chromium : verre dépoli.       |
| Reflets spéculaires           | Arête en dégradé orientée vers la source de lumière, qui suit le pointeur (ou l'inclinaison sur Android) ; lueur interne qui part du point de contact.                                                                                      |
| Adaptation au contenu         | Fond d'ambiance coloré par l'illustration affichée (palette extraite de l'affiche) ; luminosité du fond atténuée sous le verre, ce qui assombrit surtout les fonds clairs.                                                                  |
| Matérialisation, élasticité   | Courbes « ressort » simulées physiquement puis échantillonnées en CSS `linear()` ; goutte de sélection qui s'étire puis se rétracte ; boutons qui se soulèvent à l'appui ; menus et dialogues qui se matérialisent.                         |
| Variantes                     | Normale, claire (sur vidéo et images, toujours avec un voile), épaisse (menus, feuilles), proéminente ambrée (action principale seulement).                                                                                                 |
| Formes                        | Rayons concentriques (28, 22, 18, 14 px) et capsules pour toutes les commandes.                                                                                                                                                             |
| Navigation                    | Grand écran : barre latérale flottante, contenu et bandeaux qui s'étendent dessous. Mobile : barre d'onglets flottante qui se réduit à l'onglet actif en descendant, bouton de recherche circulaire séparé (comme iOS 26).                  |
| Typographie                   | Police système d'Apple via `-apple-system` (aucun fichier embarqué), Inter ailleurs ; grands titres gras alignés à gauche.                                                                                                                  |
| Accessibilité                 | Réglage **Apparence** (Transparent, Teinté, Opaque) ; respect automatique de `prefers-reduced-transparency`, `prefers-contrast`, `prefers-reduced-motion` et `forced-colors` ; contrastes mesurés (ci-dessous).                             |
| Performance                   | Réfraction limitée à une dizaine d'éléments, filtres partagés entre éléments de même forme et recalculés seulement à la fin d'un redimensionnement, fond d'ambiance statique, **garde-fou** qui coupe la réfraction si l'affichage saccade. |

Le tout est isolé dans un petit design system (`apps/web/src/design/` et
`apps/web/src/styles/`), décrit dans **[docs/DESIGN.md](docs/DESIGN.md)**. Pas de bibliothèque
« liquid glass » tierce : celles qui existent sont soit réservées à Chromium sans repli, soit
basées sur une copie figée de l'arrière-plan, inutilisable sur une interface vivante.

### Mesures

- **Contraste, pire cas** (contenu blanc pur sous le verre, mesuré sur les pixels rendus) :
  texte blanc à 5,0:1 sur le verre normal, 6,6:1 sur le verre épais (WCAG AA : 4,5:1),
  3,1:1 sur le verre clair, réservé aux icônes et grands textes posés sur un voile (seuil 3:1),
  plus de 7:1 en mode « Teinté ».
- **axe-core** : aucune violation WCAG 2.1 AA sur les 8 pages principales, sur ordinateur et
  sur mobile.
- **Parcours de bout en bout** (Playwright) : 15 étapes couvrant toutes les fonctionnalités,
  les trois matériaux, l'émulation des réglages d'accessibilité et la barre d'onglets mobile.

### Sources

- Apple — HIG, Materials : https://developer.apple.com/design/human-interface-guidelines/materials
- Apple — WWDC25, Meet Liquid Glass : https://developer.apple.com/videos/play/wwdc2025/219/
- Apple — WWDC25, Get to know the new design system : https://developer.apple.com/videos/play/wwdc2025/356/
- Apple — Adopting Liquid Glass : https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass
- Apple — HIG, Tab bars : https://developer.apple.com/design/human-interface-guidelines/tab-bars
- Apple — HIG, Sidebars : https://developer.apple.com/design/human-interface-guidelines/sidebars
- Apple — refonte de l'app TV : https://www.apple.com/newsroom/2025/06/apple-tv-brings-a-beautiful-redesign-and-enhanced-home-entertainment-experience/
- Option « Teinté » d'iOS 26.1 : https://gulfnews.com/technology/companies/apple-yields-tinted-control-in-ios-261-beta-4-tones-down-liquid-glass-after-backlash-1.500315176
- Accessibilité de Liquid Glass (Infinum) : https://infinum.com/blog/apples-ios-26-liquid-glass-sleek-shiny-and-questionably-accessible/
- Réfraction CSS/SVG (LogRocket) : https://blog.logrocket.com/how-create-liquid-glass-effects-css-and-svg/
- Liquid Glass en CSS et SVG (ekino) : https://medium.com/ekino-france/liquid-glass-in-css-and-svg-839985fcb88d
- MDN, `backdrop-filter` : https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/backdrop-filter
- WebKit, filtres SVG dans `backdrop-filter` : https://bugs.webkit.org/show_bug.cgi?id=245510
- MDN, `prefers-reduced-transparency` : https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency
- Coût de `backdrop-filter` (OpenReplay) : https://blog.openreplay.com/creating-blurred-backgrounds-css-backdrop-filter/
- Licence de SF Pro sur le Web : https://developer.apple.com/forums/thread/127350

---

## 11. Connexion à la source : de Cloudflare à l'extension Stremio

### Le problème constaté

Sur une vraie machine, l'actualisation du catalogue échouait avec « 403 Forbidden » alors que
le même site s'affichait normalement dans le navigateur. Les en-têtes reçus par le navigateur
(`Server: cloudflare`, `Cf-Cache-Status`) montrent que `a.111477.xyz` est désormais servi
derrière **Cloudflare**, dont le pare-feu refuse les requêtes qui ne ressemblent pas à celles
d'un navigateur.

Or la première version utilisait `fetch` (undici, intégré à Node.js) avec un simple
User-Agent de Chrome. Un serveur d'écho montre ce qui partait réellement : `fetch` impose
`sec-fetch-mode: cors` (même quand on demande `navigate`) et ajoute `accept-language: *`.
Un User-Agent de Chrome accompagné d'en-têtes qu'aucun Chrome n'envoie lors d'une navigation
est une signature typique de robot. Au-delà des en-têtes, Cloudflare peut aussi comparer
l'**empreinte TLS/HTTP2** du client (ordre des suites de chiffrement, extensions, réglages
HTTP/2) à celle du navigateur annoncé.

Après un premier correctif (en-têtes exacts, puis imitation de Chrome), le journal de
l'utilisateur a montré que même l'imitation recevait `cf-mitigated: challenge` et la page
« Just a moment… » : le site impose désormais une **vérification JavaScript** (Managed
Challenge) à tout client qui n'est pas un vrai navigateur. Aucune requête HTTP, aussi bien
imitée soit-elle, ne peut l'exécuter : il faut un navigateur.

Les contournements essayés ensuite ont tous buté sur cette vérification : la vérification
lancée dans le navigateur de l'utilisateur tournait en boucle chez lui (Edge : case cochée, page
rechargée sur la même vérification) ; le service de scraping **ZenRows** obtenait la racine du
site mais pas la liste `/movies/`, trop volumineuse pour son offre (« RESP005 ») ; enfin, avec
un catalogue venu de TMDB, les dossiers des titres et les fichiers eux-mêmes restaient bloqués.
Ces mécanismes (navigateur piloté, ZenRows, point d'accès `p.111477.xyz/bulk`) ont donc été
**retirés** : ils ajoutaient du code, une dépendance payante et une fenêtre qui s'ouvre, pour
un résultat nul.

### Le choix : l'extension Stremio de 111477

111477 publie une **extension Stremio** (`st.111477.xyz`). Stremio est un lecteur vidéo dont
les extensions répondent à un protocole HTTP+JSON simple : on leur donne l'identifiant d'un
film ou d'un épisode, elles renvoient des liens de lecture directs. Ces liens sont faits pour
des lecteurs vidéo ordinaires, pas pour des navigateurs : pas de vérification JavaScript.

| Élément               | Choix                                                                                                                                                                                                                                                     | Pourquoi                                                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocole             | `GET <base>/manifest.json`, puis `<base>/stream/movie/tt1677720.json` (film) ou `<base>/stream/series/tt0903747:1:3.json` (épisode) ; lecture de `url`, `name`/`title`/`description` et `behaviorHints` (`filename`, `videoSize`, `proxyHeaders.request`) | Protocole public et stable : n'importe quelle extension compatible convient, pas seulement celle de 111477. Les en-têtes demandés par l'extension sont renvoyés avec le lien.                                                           |
| Adresse               | **Paramètres → Extension Stremio** : lien d'installation `stremio://…`, adresse de configuration ou manifeste (normalisés), avec un bouton de test ; `STREMIO_ADDON_URL` pour la valeur de départ                                                         | La configuration d'une extension (serveurs, nombre de liens par titre…) est encodée dans son adresse : il suffit de coller celle obtenue sur sa page de configuration.                                                                  |
| Catalogue             | **TMDB** (tendances, populaires, à l'affiche, mieux notés, et toute recherche) ; identifiant IMDb d'un titre obtenu une fois par `external_ids`, puis gardé                                                                                               | L'extension ne fournit pas de catalogue, seulement des liens titre par titre ; les extensions Stremio identifient les titres par leur identifiant IMDb.                                                                                 |
| Identité des fichiers | **Chemin virtuel** stable par fichier : `/@stremio/movie/tt1677720/<fichier>`, `/@stremio/series/tt0903747/1x3/<fichier>`                                                                                                                                 | Les liens expirent et changent d'une demande à l'autre. Téléchargements, reprise de lecture, bibliothèque, « vu / non vu » et relais ffmpeg travaillent sur cette identité ; le lien réel n'est résolu qu'au moment de lire les octets. |
| Économie de liens     | Liens demandés seulement à l'ouverture d'un film, à la lecture ou au téléchargement d'un épisode, ou à l'ouverture de « Choisir une version » ; jamais pour afficher une série (saisons et épisodes viennent de TMDB)                                     | Chez 111477, **chaque lien généré consomme un jeton** d'une réserve de 50 par adresse IP (un regagné toutes les 5 minutes), avec 10 requêtes par 10 s au plus.                                                                          |
| Cache                 | Réponses gardées **en base** 12 h avec le lien de chaque fichier (3 min si la réponse est vide ou signale la limite) ; un lien refusé par l'hôte (401, 403, 404, 410) est redemandé une fois                                                              | Rouvrir une fiche, reprendre une lecture ou lancer un téléchargement plus tard ne coûte rien tant que l'hôte accepte le lien, même après un redémarrage.                                                                                |
| Lecture d'un épisode  | Référence `{ type: 'episode', titleId, season, episode }` : copie locale si elle existe, sinon version préférée (qualité, langue) parmi celles de l'extension ; l'épisode suivant est proposé de la même façon                                            | Lancer un épisode, ou enchaîner sur le suivant, ne demande un lien qu'au moment de le regarder.                                                                                                                                         |
| Saison ou série       | File d'épisodes : une demande toutes les 1,2 s, épisodes déjà téléchargés ou en file ignorés, lot arrêté au premier signal de limite (« ⚠️ Slow down — rate limit reached ») ; bilan en notification                                                      | Respecter la limite en rafale et ne jamais vider la réserve en arrière-plan : le reste du lot se relance plus tard, en un clic.                                                                                                         |
| Sans extension        | Champ vide : la liste du site est lue directement (en-têtes exacts de Chrome, puis imitation **impit**), avec repli possible sur le catalogue TMDB et la recherche des dossiers à la demande                                                              | Pour un index HTTP non protégé, et la démonstration en mode liste (`DEMO_MODE=listing`).                                                                                                                                                |

### Ce qui reste de la couche de connexion

| Couche                            | Choix                                                                                                                                                                                                                                               | Pourquoi                                                                                                                                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connexion standard                | Requêtes `node:http`/`node:https` qui envoient **exactement** les en-têtes d'une navigation Chrome (`sec-ch-ua*`, `sec-fetch-*`, `accept`, `accept-language: fr-FR…`, `priority`, `upgrade-insecure-requests`), cohérents avec le User-Agent choisi | `fetch` (undici) impose des en-têtes qu'aucun navigateur n'envoie lors d'une navigation.                                                                                                                                                                                             |
| Cookies                           | Petit « cookie jar » par origine                                                                                                                                                                                                                    | Un navigateur renvoie les cookies déposés par le site ; les ignorer est un signe de robot.                                                                                                                                                                                           |
| Imitation de navigateur           | **[impit](https://github.com/apify/impit)** (Apify), en secours : empreinte TLS/HTTP2 de Chrome                                                                                                                                                     | Passe les filtres qui comparent l'empreinte réseau au navigateur annoncé ; sert aussi de secours si l'extension ou l'hôte d'un lien refuse la première requête (403/503).                                                                                                            |
| Mode « Automatique » (par défaut) | Standard, puis imitation de Chrome ; le transport qui passe est **mémorisé par origine**                                                                                                                                                            | Le chemin léger sert tant qu'il suffit ; chaque mode est forçable dans **Paramètres → Source**.                                                                                                                                                                                      |
| ffmpeg / ffprobe                  | **Relais local** `/api/internal/source` (127.0.0.1, jeton aléatoire généré au démarrage)                                                                                                                                                            | ffmpeg lit la source (ou le lien de l'extension) par la même connexion que le reste de l'application, sans jamais recevoir de lien expiré.                                                                                                                                           |
| Messages d'erreur                 | Analyse des refus : page de vérification (`cf-mitigated: challenge`, « Just a moment… »), règle de pare-feu (erreur 1020), User-Agent banni (1010), autre refus ; limite de l'extension traduite en français                                        | Dire _pourquoi_ la source refuse, plutôt qu'un « 403 » brut.                                                                                                                                                                                                                         |
| Diagnostic                        | `npm run diagnose [-- --extension=URL] [--film=tt…] [--serie=tt…:S:E] [--site]`                                                                                                                                                                     | Teste depuis la machine de l'utilisateur le manifeste, les liens d'**un seul** film (pour ménager la réserve), la lecture des premiers octets du premier lien, et, sur demande, l'accès direct au site. Indispensable puisque l'environnement de développement n'atteint pas 111477. |

### Validation

L'extension est testée contre de faux services locaux : client et file d'épisodes
(`stremio-addon.test.ts` : normalisation de l'adresse, identifiants IMDb/TMDB, doublons,
description, en-têtes, réponse gardée en base, limite signalée, lien redemandé), parcours
complet (`addon-catalog.test.ts` : catalogue TMDB, versions d'un film demandées une seule fois,
série affichée sans aucune demande de liens, téléchargement d'un film avec lien expiré
redemandé, saison téléchargée en arrière-plan, lot arrêté à la limite, épisode suivant). La
démonstration (`npm run demo`) embarque une fausse extension (liens qui expirent, réserve de
jetons, limite en rafale) ; l'interface a été vérifiée de bout en bout dans Chromium : versions
d'un film, téléchargement, épisodes à la demande, saison en arrière-plan, lecture d'un épisode
à la demande (conversion ffmpeg à travers le relais), bandeau de limite atteinte, paramètres.

### Limites

- Lumière dépend de l'extension : de sa disponibilité, de son offre (un film qu'elle ne propose
  pas est marqué « Aucun fichier proposé ») et de sa réserve de liens. Une extension réglée pour
  proposer beaucoup de liens par titre vide la réserve plus vite.
- Télécharger une série entière d'un coup est limité par la réserve : le lot s'arrête à la
  limite et se relance plus tard. La file des épisodes à demander est en mémoire : un
  redémarrage du serveur l'abandonne (les téléchargements déjà créés, eux, reprennent).
- Le protocole Stremio permet à une extension de fournir des sous-titres avec ses liens ;
  Lumière ne les lit pas encore (les sous-titres intégrés aux fichiers restent disponibles).
- Avec l'extension, une clé TMDB est indispensable : c'est elle qui fournit le catalogue.
- L'explorateur, qui parcourt le site directement, ne fonctionne que si le site est accessible.
- Un blocage par adresse IP ou par pays (erreur 1020) ne se contourne pas côté application.

### Sources

- Cloudflare, [Detect a Challenge Page response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response) (en-tête `cf-mitigated: challenge`) et [Cloudflare challenges](https://developers.cloudflare.com/waf/reference/cloudflare-challenges).
- MDN, [Sec-Fetch-Mode](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Mode).
- Apify, [impit](https://github.com/apify/impit) et sa [documentation JavaScript](https://apify.github.io/impit/js).
- Kinsta, [Error 1020 Access Denied](https://kinsta.com/docs/error-1020-access-denied).
- 111477, [page de configuration de l'extension Stremio](https://st.111477.xyz/) (réserve de
  50 jetons par adresse IP, un de plus toutes les 5 minutes, 10 requêtes par 10 s,
  avertissement « Slow down — rate limit reached »).
- Stremio, [Stream object](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md)
  (`url`, `name`, `description`, `behaviorHints.filename`, `videoSize`, `proxyHeaders`) et
  [ressources d'une extension](https://www.mintlify.com/Stremio/stremio-core/addons/resources).

---

## 12. Qualité, sécurité, exploitation

- **Qualité** : TypeScript strict, ESLint 10 (règles React Compiler incluses), Prettier,
  **Vitest** (serveur : analyseur de listings, noms de releases, plan de lecture,
  téléchargement avec coupure/reprise, enrichissement TMDB, configuration, connexion à la
  source derrière un pare-feu anti-robot simulé, extension Stremio (liens expirés, limite de
  liens, saisons en arrière-plan), relais de ffmpeg ; interface :
  réfraction, détection des navigateurs, préférences d'accessibilité, palette d'ambiance),
  parcours de bout en bout et audit d'accessibilité (axe-core) dans Chromium (Playwright).
- **Sécurité** :
  - le serveur n'est **pas un proxy ouvert** : toutes les URL sont construites à partir de
    la source configurée et de chemins relatifs validés (pas de `..`) ;
  - les fichiers locaux ne sont accessibles que par identifiant de bibliothèque ;
  - les noms de fichiers sont assainis (Windows/macOS/Linux) et les écritures confinées au
    dossier de téléchargement ;
  - ffmpeg est lancé sans shell (aucune injection possible) et ne lit la source qu'à travers
    le relais local protégé par jeton ;
  - écoute sur `127.0.0.1` par défaut (accès réseau local sur choix explicite) ;
  - la clé TMDB n'est jamais renvoyée à l'interface.
- **Journal** : pino, écrit via `process.stdout` pour que Node.js convertisse le texte pour la
  console Windows (sinon les accents s'affichent « ├® »).
- **Déploiement** : `npm run build && npm start`, ou **Docker** (image multi‑étapes avec
  ffmpeg, utilisateur non‑root, volumes `/data` et `/media`, `HEALTHCHECK`) et
  `docker-compose.yml`.

---

## 13. Limites connues et pistes d'évolution

- Pas d'authentification : l'application est prévue pour un usage personnel/local. Avant de
  l'exposer sur Internet, la placer derrière un reverse proxy avec authentification.
- En mode conversion, l'avance rapide relance la conversion (une à deux secondes d'attente).
- L'accélération matérielle (NVENC, QSV, VAAPI) n'est pas activée : conversion logicielle.
- Le format HTML exact de `a.111477.xyz` n'a pas pu être observé depuis l'environnement de
  développement : en cas de souci, `npm run probe -w @lumiere/server -- https://a.111477.xyz/movies/`
  montre immédiatement ce que l'analyseur comprend, et les chemins `/movies/` et `/tvs/`
  sont modifiables dans les paramètres. Le site exigeant une vérification Cloudflare, les
  fichiers passent par l'extension Stremio ; `npm run diagnose` vérifie qu'elle répond depuis
  la machine (voir § 11).
- Design : la réfraction n'est visible que dans les navigateurs Chromium (Chrome, Edge,
  Brave, Opera) ; Safari et Firefox affichent le même verre, dépoli. Le verre ne bascule pas
  automatiquement entre clair et sombre selon le fond comme sur iOS (le Web ne permet pas de
  lire ce qui est rendu sous un élément) : une atténuation de luminosité et des voiles
  garantissent la lisibilité à la place.
