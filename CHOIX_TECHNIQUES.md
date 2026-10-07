# Choix techniques — Lumière

Ce document explique les choix faits pour construire **Lumière**, l'application qui permet
de parcourir, télécharger et regarder les films et séries de `a.111477.xyz`.

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
> commande ce que l'analyseur comprend du vrai site, et `npm run diagnose` pourquoi la source
> refuserait une connexion (voir § 11).

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
ffmpeg au bon endroit (le serveur calcule l'image clé exacte pour garder le temps et les
sous-titres synchronisés). L'alternative HLS a été écartée : plus complexe (segments sur
disque, nettoyage) pour un usage domestique.

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

## 8. Métadonnées : TMDB (facultatif)

Les affiches, résumés, notes, genres et titres d'épisodes viennent de **The Movie Database**
(clé gratuite, saisie dans les paramètres ou via `TMDB_API_KEY`) :

- recherche par titre + année avec un score de correspondance (titre exact, titre original,
  année, popularité) ;
- enrichissement progressif en arrière-plan + à la demande quand une affiche s'affiche ;
- **cache disque des images** (la bibliothèque reste illustrée hors ligne) ;
- **sans clé**, l'application reste pleinement fonctionnelle avec des affiches générées.

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

## 11. Connexion à la source : passer le filtrage anti‑robot

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

Enfin, chez l'utilisateur, la vérification lancée dans son propre navigateur (Edge) tournait
en boucle : la case cochée, la page se rechargeait sur la même vérification — Cloudflare
repère sans doute le navigateur piloté. Plutôt que de jouer au chat et à la souris, Lumière
peut confier les seules **pages de listing** à **ZenRows**, un service dont c'est le métier,
et télécharger les fichiers directement.

### Les choix

| Couche                            | Choix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Pourquoi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connexion standard                | Requêtes `node:http`/`node:https` qui envoient **exactement** les en-têtes d'une navigation Chrome (`sec-ch-ua*`, `sec-fetch-*`, `accept`, `accept-language: fr-FR…`, `priority`, `upgrade-insecure-requests`), cohérents avec le User-Agent choisi                                                                                                                                                                                                                                                                                                                                                                                                                                      | Contrairement à `fetch`, rien n'est ajouté ni réécrit. Les pages sont décompressées (gzip/deflate/br) ; les fichiers sont demandés sans compression pour que les plages d'octets (`Range`) restent exactes.                                                                                                                                                                                                                                                                                              |
| Cookies                           | Petit « cookie jar » par origine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Cloudflare dépose des cookies (`__cf_bm`…) qu'un navigateur renvoie ; les ignorer est un autre signe de robot.                                                                                                                                                                                                                                                                                                                                                                                           |
| Imitation de navigateur           | **[impit](https://github.com/apify/impit)** (Apify), en secours                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Bibliothèque Rust (reqwest + rustls) livrée en binaires précompilés pour Windows, macOS et Linux : elle reproduit la poignée de main TLS, les réglages HTTP/2 et l'ordre des en-têtes de Chrome, avec une API proche de `fetch`. Aucune installation supplémentaire, contrairement à un vrai navigateur piloté (Playwright/Puppeteer : centaines de Mo, lent, gourmand) ou à curl-impersonate (binaires externes à installer et maintenir à part).                                                       |
| Mode « Automatique » (par défaut) | Pages : standard, imitation de Chrome, puis **ZenRows** si une clé est configurée, sinon navigateur réel. Fichiers : standard, imitation, `p.111477.xyz`, puis navigateur réel (jamais si ZenRows est configuré). Le transport qui passe est **mémorisé par origine et par type de requête**                                                                                                                                                                                                                                                                                                                                                                                             | Le chemin gratuit et léger sert tant qu'il suffit ; dès que la source filtre, les requêtes suivantes vont directement au bon transport. Chaque mode est forçable dans **Paramètres → Source**.                                                                                                                                                                                                                                                                                                           |
| Navigateur réel                   | Le navigateur installé (Chrome, Edge — toujours présent sous Windows —, Brave, Chromium ; `BROWSER_PATH` pour l'imposer) est lancé normalement dans un **profil dédié**, avec le port de débogage (protocole DevTools, client minimal sur le WebSocket intégré à Node.js). Pendant la vérification, Lumière ne fait qu'observer le titre de l'onglet et les cookies ; ensuite il réutilise le passage : cookies (`cf_clearance`), User-Agent, indices clients et langues du navigateur, avec l'empreinte impit de **la même version de Chrome**. Si Cloudflare refuse ce passage hors du navigateur, les requêtes sont faites **depuis la page** (fenêtre réduite), fichiers lus en flux | Seul un navigateur peut exécuter la vérification ; l'utilisateur peut cocher la case Turnstile si elle apparaît. Aucun mode « automatisation » (pas de `--enable-automation`, donc `navigator.webdriver` faux) et aucune dépendance lourde (Playwright/Puppeteer). La fenêtre se ferme d'elle-même quand le passage suffit ; le passage expiré est repassé automatiquement (une seule fois par minute au plus, pour éviter les boucles). L'interface affiche chaque étape (notifications en temps réel). |
| ZenRows (pages de listing)        | API [ZenRows](https://www.zenrows.com/) : `mode=auto` (ZenRows choisit la configuration la moins chère qui passe), puis rendu JavaScript + proxys résidentiels ; `original_status` pour garder le 404 d'un dossier absent, `Zr-Final-Url` comme adresse de base des liens. Clé saisie dans **Paramètres → Source** (stockée comme la clé TMDB, jamais renvoyée à l'interface) ou `ZENROWS_API_KEY`                                                                                                                                                                                                                                                                                       | C'est son métier : vrais navigateurs, IP résidentielles. Seuls les succès sont facturés (jusqu'à 25 crédits par page) ; les pages ainsi payées restent 6 h en cache et deux requêtes au plus partent en parallèle. Les erreurs du service (clé invalide, crédits épuisés…) sont traduites. Quand une clé est configurée, le navigateur n'est jamais ouvert.                                                                                                                                              |
| Fichiers                          | Lien direct (en-têtes de Chrome, puis imitation) ; s'il est refusé, point d'accès de lecture `p.111477.xyz/bulk?u=…` (111477 uniquement), accepté seulement s'il renvoie bien le fichier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Les fichiers (plusieurs Go) ne peuvent pas passer par ZenRows : l'idée est de lister par ZenRows puis de télécharger le lien. `p.111477.xyz` est le point d'accès qu'utilise l'extension Stremio de 111477, limité par un réservoir de jetons par adresse IP.                                                                                                                                                                                                                                            |
| ffmpeg / ffprobe                  | **Relais local** `/api/internal/source` (127.0.0.1, jeton aléatoire généré au démarrage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ffmpeg a son propre client HTTP (User-Agent `Lavf`, autre pile TLS) que le même pare-feu bloquerait. En lisant via le relais, la lecture en streaming emprunte exactement la même connexion que le catalogue et les téléchargements. Le relais n'accepte que des chemins de la source configurée et un jeton comparé en temps constant : ce n'est pas un proxy ouvert.                                                                                                                                   |
| Messages d'erreur                 | Analyse des refus : page de vérification (`cf-mitigated: challenge`, « Just a moment… »), règle de pare-feu (erreur 1020), User-Agent banni (1010), autre refus                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Dire _pourquoi_ la source refuse, plutôt qu'un « 403 » brut ; le journal ajoute `cf-ray`, serveur et titre de la page pour le diagnostic.                                                                                                                                                                                                                                                                                                                                                                |
| Diagnostic                        | `npm run diagnose [-- <url>] [--zenrows=CLÉ] [--navigateur]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Compare depuis la machine de l'utilisateur l'ancien `fetch`, Node.js + en-têtes de Chrome, l'imitation impit, curl, puis ZenRows (détail de chaque configuration et crédits consommés) ; sur un vrai fichier trouvé ainsi, il teste le **téléchargement direct** et `p.111477.xyz` ; la vérification dans le navigateur n'est essayée que sur demande. Indispensable puisque l'environnement de développement n'atteint pas le site.                                                                     |

ZenRows et le point d'accès de lecture ont été validés contre de faux services locaux
(`zenrows.test.ts` : configuration de secours, statut d'origine, erreurs, crédits, clé jamais
renvoyée, fichiers directs ou via le point d'accès, navigateur jamais sollicité).
Les autres mécanismes ont été validés contre de faux « Cloudflare » locaux : l'un refuse les
requêtes sans métadonnées de navigation (`source-transport.test.ts`), l'autre impose une
vérification JavaScript qui délivre un cookie `cf_clearance` HttpOnly lié au User-Agent, avec
un mode où seul le navigateur lui-même est accepté (`real-browser.test.ts`, avec un vrai
Chromium, avec et sans fenêtre). L'application complète a aussi été vérifiée derrière ce
dernier : catalogue, téléchargement (fichier identique à l'octet près) et lecture convertie
par ffmpeg à travers le relais et la page du navigateur.

### Limites

- La vérification dans le navigateur demande un navigateur Chromium installé et un écran :
  elle n'est pas disponible dans Docker ni sur un serveur sans affichage. Elle peut demander un
  clic (case « Je suis humain ») et le passage expire au bout d'une durée choisie par le site
  (souvent de 30 minutes à quelques heures) : une fenêtre s'ouvre alors brièvement.
- En mode « requêtes depuis la page », les fichiers transitent par le navigateur : un peu plus
  de processeur, mais une seule requête HTTP par fichier, comme un téléchargement normal.
- ZenRows est payant : chaque page de listing obtenue coûte des crédits (jusqu'à 25). Le
  catalogue en lit deux par actualisation, puis une par fiche ou dossier ouvert (mise en cache
  6 h). Si les liens directs des fichiers sont eux aussi bloqués, il reste `p.111477.xyz`,
  limité par ses jetons.
- Un blocage par adresse IP ou par pays (erreur 1020) ne se contourne pas côté application.
- Les services annexes de 111477 ne remplacent pas le listing : l'extension Stremio
  (`st.111477.xyz`) ne fournit que des liens de lecture titre par titre, puisés dans un
  réservoir de 50 jetons par adresse IP (un de plus toutes les 5 minutes), et
  `p.111477.xyz/bulk?u=…` est le point d'accès de lecture qu'elle utilise. Le diagnostic les
  sonde pour décider s'ils peuvent servir à la lecture.

### Sources

- Cloudflare, [Detect a Challenge Page response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response) (en-tête `cf-mitigated: challenge`) et [Cloudflare challenges](https://developers.cloudflare.com/waf/reference/cloudflare-challenges).
- MDN, [Sec-Fetch-Mode](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Mode).
- Apify, [impit](https://github.com/apify/impit) et sa [documentation JavaScript](https://apify.github.io/impit/js).
- Kinsta, [Error 1020 Access Denied](https://kinsta.com/docs/error-1020-access-denied).
- Chrome DevTools, [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
  (domaines `Target`, `Storage`, `Runtime`, `Browser`).
- 111477, [page de configuration de l'extension Stremio](https://st.111477.xyz/) (jetons par
  adresse IP, hôte de lecture).
- ZenRows, [Universal Scraper API](https://docs.zenrows.com/universal-scraper-api),
  [Adaptive Stealth Mode](https://docs.zenrows.com/universal-scraper-api/features/adaptive-stealth-mode),
  [système de crédits](https://docs.zenrows.com/first-steps/faq/understanding-zenRows-pricing-system)
  et [codes d'erreur](https://docs.zenrows.com/api-error-codes).

---

## 12. Qualité, sécurité, exploitation

- **Qualité** : TypeScript strict, ESLint 10 (règles React Compiler incluses), Prettier,
  **Vitest** (serveur : analyseur de listings, noms de releases, plan de lecture,
  téléchargement avec coupure/reprise, enrichissement TMDB, configuration, connexion à la
  source derrière un pare-feu anti-robot simulé, vérification Cloudflare passée dans un vrai
  Chromium, relais de ffmpeg ; interface :
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
  sont modifiables dans les paramètres. Si la source refuse la connexion (403),
  `npm run diagnose` indique quelle méthode passe depuis la machine (voir § 11).
- Design : la réfraction n'est visible que dans les navigateurs Chromium (Chrome, Edge,
  Brave, Opera) ; Safari et Firefox affichent le même verre, dépoli. Le verre ne bascule pas
  automatiquement entre clair et sombre selon le fond comme sur iOS (le Web ne permet pas de
  lire ce qui est rendu sous un élément) : une atténuation de luminosité et des voiles
  garantissent la lisibilité à la place.
