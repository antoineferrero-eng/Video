# Choix techniques — Lumière

Ce document explique les choix faits pour construire **Lumière**, l'application qui permet
de parcourir, télécharger et regarder des films et séries : le catalogue vient de TMDB, les
fichiers d'une ou plusieurs extensions Stremio, dont celle de 111477 (le site `a.111477.xyz`
lui-même exigeant une vérification Cloudflare, § 11).

---

## 1. Le point de départ : ce qu'est la source

`a.111477.xyz` est un **index de fichiers HTTP** (un « listing de dossiers ») : pas d'API,
seulement des pages HTML qui listent des dossiers et des fichiers, par exemple
`/movies/100 METERS (2025)/100.Meters.2025.1080p.NF.WEB-DL.MULTi.DDP5.1.H.264-VARYG.mkv`.
Les premières versions de Lumière reconstruisaient le catalogue en lisant ces pages (analyseur
de listings générique, explorateur de dossiers). Le site exigeant désormais une vérification
Cloudflare que seul un vrai navigateur passe (§ 11), cette lecture directe a été **retirée** :

- le **catalogue** vient de **TMDB** (populaires, tendances, à l'affiche, mieux notés,
  « Découvrir » jusqu'à la taille choisie, et toute recherche) ;
- les **fichiers** viennent d'**extensions Stremio** (celle de 111477, `st.111477.xyz`, et toute
  autre extension compatible), qui donnent des liens de lecture directs titre par titre.

Ce qui reste vrai des fichiers eux-mêmes guide la suite de la conception :

- ce sont des releases (MKV, HEVC, DD+ 5.1, multi-pistes audio…) que les navigateurs ne savent
  pas toujours lire → il faut une **chaîne de conversion** ;
- leurs noms contiennent beaucoup d'informations (qualité, langues, codecs) qu'on peut
  exploiter pour une belle interface ;
- leurs liens expirent et sont parfois comptés → il faut leur donner une **identité stable** et
  ne demander un lien qu'au moment d'agir.

> Remarque : l'environnement cloud dans lequel l'application a été développée bloque l'accès
> à 111477. Une **démonstration** locale (faux TMDB, deux fausses extensions Stremio, vidéos
> générées) valide l'application de bout en bout, et `npm run diagnose` vérifie depuis la
> machine de l'utilisateur que chaque extension répond (voir § 11).

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

| Besoin          | Choix                                              | Raisons                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime         | **Node.js 22 LTS**                                 | Excellent pour les entrées/sorties (flux, téléchargements parallèles, proxy vidéo), `fetch` natif, version longue durée.                                                                                                                                                                                                                                                                                       |
| Framework HTTP  | **Fastify 5**                                      | Rapide, typé, gestion propre des flux et des erreurs, écosystème officiel (`@fastify/static`).                                                                                                                                                                                                                                                                                                                 |
| Validation      | **zod 4** + `fastify-type-provider-zod`            | Chaque entrée (paramètres, corps, requête) est validée ; les types TypeScript en sont déduits automatiquement.                                                                                                                                                                                                                                                                                                 |
| Base de données | **SQLite** via le module intégré **`node:sqlite`** | Zéro installation (un fichier), transactions ACID, très rapide en local et **aucune compilation native** : l'installation fonctionne partout. `better-sqlite3` a été essayé puis écarté : lors d'un `npm ci`, il lance une compilation `node-gyp` qui exige Python et un compilateur C++, souvent absents sous Windows. Migrations SQL versionnées appliquées au démarrage, requêtes préparées mises en cache. |
| Journalisation  | **pino**                                           | Logs JSON structurés, mode lisible en développement.                                                                                                                                                                                                                                                                                                                                                           |
| Vidéo           | **ffmpeg / ffprobe** (binaires système)            | La référence pour analyser et convertir n'importe quel format ; inclus dans l'image Docker.                                                                                                                                                                                                                                                                                                                    |
| Temps réel      | **Server-Sent Events**                             | La progression des téléchargements va du serveur vers l'interface uniquement : SSE est plus simple que WebSocket, se reconnecte tout seul et passe par les proxys.                                                                                                                                                                                                                                             |
| Bundle          | **esbuild**                                        | Le serveur est compilé en un seul fichier `dist/main.js` (démarrage rapide, pas de problème d'extensions ESM).                                                                                                                                                                                                                                                                                                 |

---

## 5. Noms de releases

Les noms de fichiers proposés par les extensions sont analysés par un module dédié
(`release-parser.ts`) : titre, année, résolution, source (WEB-DL, BluRay, Remux…), codecs,
HDR/Dolby Vision, audio (DD+ 5.1, TrueHD Atmos…), langues (MULTi, VFF, VOSTFR, TRUEFRENCH…),
service (Netflix…), groupe. Ils servent aux badges des versions, au choix de la version
préférée (qualité, langue) et au rangement de la bibliothèque.

(L'analyseur de listings HTML des premières versions, qui reconnaissait les pages nginx,
Apache, Caddy et les listes JSON, a été retiré avec la lecture directe du site.)

---

## 6. Téléchargements

Moteur écrit sur mesure plutôt qu'un outil externe (aria2, wget) pour une intégration
complète avec l'interface :

- **file d'attente persistée** en base (survit aux redémarrages, reprise automatique) ;
- **reprise réelle** grâce aux requêtes HTTP `Range` (fichier `.part` complété, pas
  recommencé) — vérifié par un test qui coupe et reprend un transfert et compare l'empreinte
  SHA-256 ;
- **plusieurs morceaux simultanés**, comme IDM ou aria2. Constat : un épisode qui venait à
  3 Mo/s passait à 20-30 Mo/s une fois relancé après une lecture avec quelques sauts (donc
  plusieurs connexions). Certains hôtes brident chaque connexion, ou servent lentement un
  fichier tant qu'il n'est pas dans leur cache. Le moteur (`SegmentedTransfer`) part d'une
  connexion et en ajoute une toutes les 4 s environ tant que la vitesse totale progresse
  d'au moins 15 % (6 au plus, morceaux de 8 Mio au minimum) ; chaque nouvelle connexion
  prend la moitié restante du plus gros morceau en cours. Un refus (429, 503…) ou des plages
  ignorées ramènent au nombre qui fonctionnait, sans redemander de liens (jetons). Ce qui
  est reçu est noté dans `<fichier>.part.json` : une reprise ne redemande que les trous ;
  un `.part` d'avant (d'un seul tenant) reprend à sa fin ;
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
  position demandée. L'audio repart du même instant (`-noaccurate_seek`) ;
- l'instant de cette image clé est donné par **ffmpeg lui-même**, dans le même passage
  (seconde sortie `framecrc` du premier paquet vidéo, sur stderr) : pas de seconde analyse
  du fichier distant à chaque positionnement. Le temps du flux part de l'instant de
  **décodage** de cette image (un peu avant son affichage quand la vidéo a des images B) :
  c'est lui qui sert d'origine à l'horloge du lecteur, et donc aux sous-titres ;
- **une piste qui commence après l'autre** : fréquent dans les releases MULTi, où la VF
  vient d'une autre source et est recalée par un retard dans le MKV. L'en-tête du MP4
  fragmenté est écrit avec le premier fragment (`delay_moov`, pas `empty_moov`) : il peut
  ainsi décrire ce décalage (liste d'éditions). Avec `empty_moov`, le premier échantillon
  de chaque piste était ramené à 0 et suivi d'un trou ; le navigateur referme les trous de
  l'audio, le son était donc **en avance de tout le retard** (mesuré dans Chromium : 1 s
  pour une VF retardée d'1 s) jusqu'au premier positionnement. Les décalages de composition
  négatifs (`negative_cts_offsets`) ont été retirés pour la même raison : avec des images B,
  ils avançaient le son d'une image (42 ms à 24 i/s) ;
- au début du fichier, l'audio converti démarre exactement avec la première image
  (`aresample=…:first_pts=…`) : complété par du silence s'il commence après, coupé s'il
  commence avant. Un audio qu'on aurait pu recopier mais qui ne démarre pas avec l'image
  est converti ;
- `playback-sync.integration.test.ts` vérifie avec le vrai ffmpeg (VF retardée, vidéo
  retardée, positionnement, pistes alignées) que l'audio produit n'a pas de trou et que le
  son tombe sur la bonne image à moins de 30 ms ;
- trous de l'audio source comblés par du silence (`aresample=async=1`), fragments de 2 s
  pour démarrer vite ;
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
- **sous-titres en ligne** (voir ci-dessous), **recalage** automatique ou à la main (voir
  « Recalage des sous-titres ») ;
- un fichier déjà téléchargé est toujours lu **depuis la copie locale** ;
- **reprise là où on s'était arrêté**, rangée « Reprendre la lecture », **épisode suivant**
  automatique, raccourcis clavier, plein écran, repli automatique direct → remux → conversion
  en cas d'échec.

---

### Sous-titres en ligne

| Service                               | Accès                                    | Ce qu'il apporte                                                                                                                        |
| ------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Extensions Stremio de sous-titres** | Aucune clé (OpenSubtitles v3 par défaut) | Protocole déjà parlé par Lumière (`/subtitles/{type}/{id}/{extra}.json`) : n'importe quelle extension compatible s'ajoute par son lien. |
| **API OpenSubtitles.com** (REST v1)   | Clé gratuite ; compte facultatif         | Recherche par empreinte du fichier (`moviehash`) : les sous-titres faits pour la version exacte sont signalés et passent en tête.       |

- la recherche est faite **à la demande** (ouverture du menu des sous-titres) ou d'office quand
  la langue de sous-titres préférée manque dans le fichier ; le meilleur résultat est alors
  choisi, sauf si l'utilisateur a déjà fait son choix ;
- le titre est désigné par son identifiant **IMDb** (demandé une fois à TMDB puis gardé),
  la série plus saison et épisode pour un épisode ; sans titre identifié, OpenSubtitles est
  interrogé par le nom du fichier ;
- l'**empreinte OpenSubtitles** (taille + 64 premiers et 64 derniers Kio) est calculée même
  sur un fichier lu à distance : deux petites requêtes `Range` successives ;
- classement : langue préférée, puis fichier exact, puis **release la plus proche** du
  fichier (même équipe, même source, même résolution ; une édition différente, version
  longue ou director's cut, est pénalisée), complets avant « forcés », puis les plus
  téléchargés ; 8 résultats au plus par langue ;
- un sous-titre téléchargé est **gardé sur disque** : OpenSubtitles compte chaque
  téléchargement dans un quota quotidien (plus élevé avec un compte) ;
- les deux services sont interrogés en parallèle ; une panne de l'un est signalée dans le menu
  sans bloquer l'autre ;
- seuls l'identifiant IMDb, le nom, la taille et l'empreinte du fichier quittent la machine, et
  seulement lors d'une recherche ; liste d'extensions vide et pas de clé : aucun service contacté.

### Recalage des sous-titres

Des sous-titres trouvés en ligne sont souvent faits pour une **autre version** du film :
décalage constant (logo, générique de durée différente), ou dérive progressive quand la
cadence diffère (25 i/s accéléré à la télévision européenne contre 23,976 : 4 %, environ
5 minutes à la fin d'un film de 2 h). Modèle : instant d'affichage = vitesse × instant prévu

- décalage, **gardé par fichier et par piste** (base de données).

* **Automatique** (`subtitle-alignment.ts`, sur le principe de ffsubsync et alass) : la
  référence et les sous-titres deviennent deux signaux « on parle / on ne parle pas » ; on
  cherche le décalage (±2 min) et la vitesse (rapports de cadences courants) qui les font
  coïncider, au pas de 100 ms puis affiné au centième ;
  - référence : une piste déjà calée obtenue sans rien télécharger (piste intégrée d'un
    fichier local ou déjà extraite, sous-titres faits pour ce fichier précis), sinon **la
    voix** dans 4 extraits de 20 à 60 s là où les répliques sont denses (voie centrale des
    pistes multicanal, bande de la voix ; ~200 Mo lus au plus sur un fichier distant) ;
  - indice de parole relatif au bruit de fond local et continu (pas de seuil) : tient sous
    la musique et les effets ;
  - appliqué seulement si le résultat est sûr : nette avance sur les autres décalages, et
    plusieurs passages qui indiquent le même ; sinon rien n'est changé (échec retenu une
    semaine) ; la cadence déclarée par OpenSubtitles favorise la vitesse attendue ;
  - lancé d'office pour des sous-titres en ligne qui ne sont pas faits pour ce fichier précis,
    ou un fichier externe ; à la demande depuis le menu pour les autres ; notification
    « Sous-titres resynchronisés … · Annuler » ;
* **À la main** : G / H décalent de 0,25 s ; **Maj+G** cale la réplique suivante sur
  l'instant présent (sous-titres en retard sur la voix), **Maj+H** la précédente (en avance).
  Deux répliques calées à plus de 2 minutes d'écart corrigent aussi la vitesse, arrondie au
  rapport de cadences le plus proche. Menu : « Annuler le recalage » ;
* les notifications du lecteur s'affichent en haut de l'image, pas sur la barre de commandes.

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

Tri par **popularité** (celui de la page « Populaires » de TMDB), par défaut sur les pages
Films et Séries et pour l'accueil :

- l'indice `popularity` de TMDB est gardé avec sa date : il vient des listes importées (dont
  « Populaires » sur 10 pages, soit 200 titres), de « Découvrir », des recherches et des fiches
  détaillées ;
- catalogue issu de la liste du site : à chaque actualisation, les listes TMDB mettent à jour la
  popularité des titres déjà connus, sans en ajouter ;
- une popularité de plus de 3 jours (titre sorti des listes) passe après les valeurs à jour :
  un succès d'il y a des mois ne reste pas en tête ; les titres sans données TMDB viennent en
  dernier, par date d'ajout ;
- les listes seules ne donnaient qu'environ 250 titres par section : elles sont complétées par
  **« Découvrir »** (`/discover/movie`, `/discover/tv`) dans l'ordre de popularité, jusqu'à la
  **taille du catalogue** choisie (Paramètres → Catalogue : 500 à 10 000 titres par section,
  5 000 par défaut ; TMDB ne sert pas plus de 500 pages de 20). Seuls les titres assez votés
  (50 votes pour un film, 20 pour une série) y entrent, sans journaux télévisés ni talk-shows :
  les inconnus n'ont ni fiche complète ni fichiers chez les extensions. Pages demandées par
  lots de 5 ; un catalogue agrandi est réimporté sans attendre, et réduire la taille ne retire
  aucun titre ;
- l'accueil met en avant les plus populaires ; « récemment ajoutés » n'y figure que pour un
  catalogue issu de la liste du site (un catalogue TMDB n'a pas de date d'ajout).

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

## 11. Connexion à la source : de Cloudflare aux extensions Stremio

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
un résultat nul. Puis la lecture directe du site elle-même (liste des dossiers, explorateur,
recherche du dossier d'un titre) a été retirée à son tour : bloquée, elle n'apportait plus rien.

### Le choix : les extensions Stremio, dont celle de 111477

111477 publie une **extension Stremio** (`st.111477.xyz`). Stremio est un lecteur vidéo dont
les extensions répondent à un protocole HTTP+JSON simple : on leur donne l'identifiant d'un
film ou d'un épisode, elles renvoient des liens de lecture directs. Ces liens sont faits pour
des lecteurs vidéo ordinaires, pas pour des navigateurs : pas de vérification JavaScript.

| Élément               | Choix                                                                                                                                                                                                                                                                                                                           | Pourquoi                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocole             | `GET <base>/manifest.json`, puis `<base>/stream/movie/tt1677720.json` (film) ou `<base>/stream/series/tt0903747:1:3.json` (épisode) ; lecture de `url`, `name`/`title`/`description` et `behaviorHints` (`filename`, `videoSize`, `proxyHeaders.request`)                                                                       | Protocole public et stable : n'importe quelle extension compatible convient, pas seulement celle de 111477. Les en-têtes demandés par l'extension sont renvoyés avec le lien.                                                           |
| Adresses              | **Paramètres → Extensions et API** : liste ordonnée de liens d'installation `stremio://…`, adresses de configuration ou manifestes (normalisés), chacun avec son bouton de test ; `STREMIO_ADDON_URLS` pour la valeur de départ (migration de l'ancienne adresse unique)                                                        | La configuration d'une extension (serveurs, nombre de liens par titre…) est encodée dans son adresse : il suffit de coller celle obtenue sur sa page de configuration.                                                                  |
| Plusieurs extensions  | Toutes interrogées en parallèle (seulement celles qui gèrent ce type de titre et cet identifiant, IMDb ou `tmdb:`) ; fichiers réunis par nom ; un fichier proposé par plusieurs garde un seul chemin et une liste de liens, essayés dans l'ordre des extensions ; une extension injoignable est signalée sans priver des autres | Plus d'offre, et un lien de secours quand l'hôte du premier le refuse. Deux fichiers du même nom mais de tailles différentes ne se relaient pas : leurs octets diffèrent.                                                               |
| Catalogue             | **TMDB** (tendances, populaires, à l'affiche, mieux notés, « Découvrir », et toute recherche) ; identifiant IMDb d'un titre obtenu une fois par `external_ids`, puis gardé                                                                                                                                                      | L'extension ne fournit pas de catalogue, seulement des liens titre par titre ; les extensions Stremio identifient les titres par leur identifiant IMDb.                                                                                 |
| Identité des fichiers | **Chemin virtuel** stable par fichier : `/@stremio/movie/tt1677720/<fichier>`, `/@stremio/series/tt0903747/1x3/<fichier>`                                                                                                                                                                                                       | Les liens expirent et changent d'une demande à l'autre. Téléchargements, reprise de lecture, bibliothèque, « vu / non vu » et relais ffmpeg travaillent sur cette identité ; le lien réel n'est résolu qu'au moment de lire les octets. |
| Économie de liens     | Liens demandés seulement à l'ouverture d'un film, à la lecture ou au téléchargement d'un épisode, ou à l'ouverture de « Choisir une version » ; jamais pour afficher une série (saisons et épisodes viennent de TMDB)                                                                                                           | Chez 111477, **chaque lien généré consomme un jeton** d'une réserve de 50 par adresse IP (un regagné toutes les 5 minutes), avec 10 requêtes par 10 s au plus.                                                                          |
| Cache                 | Réponse de **chaque extension** gardée **en base** 12 h avec le lien de chaque fichier (3 min si la réponse est vide ou signale la limite) ; si tous les liens d'un fichier sont refusés (401, 403, 404, 410), ils sont redemandés une fois, aux seules extensions qui les avaient fournis                                      | Rouvrir une fiche, reprendre une lecture ou lancer un téléchargement plus tard ne coûte rien tant que l'hôte accepte le lien, même après un redémarrage.                                                                                |
| Lecture d'un épisode  | Référence `{ type: 'episode', titleId, season, episode }` : copie locale si elle existe, sinon version préférée (qualité, langue) parmi celles des extensions ; l'épisode suivant est proposé de la même façon                                                                                                                  | Lancer un épisode, ou enchaîner sur le suivant, ne demande un lien qu'au moment de le regarder.                                                                                                                                         |
| Saison ou série       | File d'épisodes : une demande toutes les 1,2 s, épisodes déjà téléchargés ou en file ignorés, lot arrêté au premier signal de limite (« ⚠️ Slow down — rate limit reached ») ; bilan en notification                                                                                                                            | Respecter la limite en rafale et ne jamais vider la réserve en arrière-plan : le reste du lot se relance plus tard, en un clic.                                                                                                         |

### Ce qui reste de la couche de connexion

| Couche                  | Choix                                                                                                                                                                                     | Pourquoi                                                                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Liens                   | Requêtes `node:http`/`node:https` (connexions réutilisées) avec l'identité de Chrome et les en-têtes demandés par l'extension (`proxyHeaders`), plages d'octets transmises telles quelles | Un lecteur vidéo enchaîne les plages ; `fetch` (undici) ajoute et réécrit des en-têtes.                                                                                                                                                                                 |
| Imitation de navigateur | **[impit](https://github.com/apify/impit)** (Apify), en secours : empreinte TLS/HTTP2 de Chrome                                                                                           | Sert si une extension ou l'hôte d'un lien refuse la première requête (403/503 de Cloudflare).                                                                                                                                                                           |
| ffmpeg / ffprobe        | **Relais local** `/api/internal/source` (127.0.0.1, jeton aléatoire généré au démarrage)                                                                                                  | ffmpeg lit le fichier par la même connexion que le reste de l'application (liens de secours compris), sans jamais recevoir de lien expiré.                                                                                                                              |
| Messages d'erreur       | Limite de liens, limite de requêtes, extension injoignable ou manifeste invalide traduits en français, préfixés du nom de l'extension quand il y en a plusieurs                           | Dire _quelle_ extension refuse et _pourquoi_, plutôt qu'un « 403 » brut.                                                                                                                                                                                                |
| Diagnostic              | `npm run diagnose [-- --extension=URL…] [--film=tt…] [--serie=tt…:S:E]`                                                                                                                   | Teste depuis la machine de l'utilisateur, extension par extension, le manifeste, les liens d'**un seul** film (pour ménager la réserve) et la lecture des premiers octets du premier lien. Indispensable puisque l'environnement de développement n'atteint pas 111477. |

### Validation

Les extensions sont testées contre de faux services locaux : client et file d'épisodes
(`stremio-addon.test.ts` : normalisation de l'adresse, identifiants IMDb/TMDB, types de titres,
doublons, description, en-têtes, réponse gardée en base, limite signalée, lien redemandé ;
plusieurs extensions réunies, interrogées selon leurs types et préfixes, fichiers homonymes de
tailles différentes, extension injoignable), liens (`source-transport.test.ts` : relais vers
l'extension suivante quand un lien est refusé, renouvellement unique, imitation de Chrome),
migration de l'ancienne adresse unique (`migrations.test.ts`), parcours
complet (`addon-catalog.test.ts` : catalogue TMDB, versions d'un film demandées une seule fois,
série affichée sans aucune demande de liens, téléchargement d'un film avec lien expiré
redemandé, saison téléchargée en arrière-plan, lot arrêté à la limite, épisode suivant). La
démonstration (`npm run demo`) embarque deux fausses extensions (liens qui expirent, réserve de
jetons, limite en rafale, fichiers en partie communs) ; l'interface a été vérifiée de bout en
bout dans Chromium : versions d'un film réunies depuis les deux extensions (et ordre de
préférence respecté), téléchargement, épisodes à la demande, saison en arrière-plan, lecture
d'un épisode à la demande (conversion ffmpeg à travers le relais), bandeau de limite atteinte,
liste des extensions dans les paramètres (ajout, ordre, test, retrait).

### Limites

- Lumière dépend des extensions : de leur disponibilité, de leur offre (un film qu'aucune ne
  propose est marqué « Aucun fichier proposé ») et de leur réserve de liens. Une extension réglée
  pour proposer beaucoup de liens par titre vide la réserve plus vite ; en ajouter une seconde
  étend l'offre et donne des liens de secours.
- Télécharger une série entière d'un coup est limité par la réserve : le lot s'arrête à la
  limite et se relance plus tard. La file des épisodes à demander est en mémoire : un
  redémarrage du serveur l'abandonne (les téléchargements déjà créés, eux, reprennent).
- Une clé TMDB est indispensable : c'est elle qui fournit le catalogue. Un titre absent de TMDB
  n'apparaît pas, même si une extension en propose les fichiers.
- Les téléchargements encore en file qui visaient un fichier de l'ancienne lecture directe du
  site échouent avec un message explicite : il faut les relancer depuis la fiche du titre.
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
  **Vitest** (serveur : noms de releases, plan de lecture, téléchargement avec
  coupure/reprise, catalogue et enrichissement TMDB, configuration et migrations, extensions
  Stremio (plusieurs à la fois, liens expirés ou refusés, limite de liens, saisons en
  arrière-plan), imitation de Chrome, relais de ffmpeg ; interface :
  réfraction, détection des navigateurs, préférences d'accessibilité, palette d'ambiance),
  parcours de bout en bout et audit d'accessibilité (axe-core) dans Chromium (Playwright).
- **Sécurité** :
  - le serveur n'est **pas un proxy ouvert** : il ne contacte que les extensions configurées et
    les liens qu'elles fournissent, désignés par des chemins virtuels validés (pas de `..`) ;
  - les fichiers locaux ne sont accessibles que par identifiant de bibliothèque ;
  - les noms de fichiers sont assainis (Windows/macOS/Linux) et les écritures confinées au
    dossier de téléchargement ;
  - ffmpeg est lancé sans shell (aucune injection possible) et ne lit les fichiers distants
    qu'à travers le relais local protégé par jeton ;
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
- 111477 n'est pas joignable depuis l'environnement de développement : `npm run diagnose`
  vérifie depuis la machine de l'utilisateur que chaque extension répond et que ses liens se
  lisent (voir § 11).
- Design : la réfraction n'est visible que dans les navigateurs Chromium (Chrome, Edge,
  Brave, Opera) ; Safari et Firefox affichent le même verre, dépoli. Le verre ne bascule pas
  automatiquement entre clair et sombre selon le fond comme sur iOS (le Web ne permet pas de
  lire ce qui est rendu sous un élément) : une atténuation de luminosité et des voiles
  garantissent la lisibilité à la place.
