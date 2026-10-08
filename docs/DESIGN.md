# Design system « Liquid Glass » de Lumière

Ce document décrit comment l'interface applique le langage Liquid Glass d'Apple : où se
trouve le code, quels jetons et quels matériaux utiliser, et les règles à respecter en
ajoutant un écran ou un composant. Les raisons de ces choix et les sources sont dans
[CHOIX_TECHNIQUES.md](../CHOIX_TECHNIQUES.md#10-design--liquid-glass-).

## Deux couches, deux traitements

| Couche                                            | Exemples                                                                                  | Traitement                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Fonctionnelle** (flotte au-dessus)              | barre latérale, barre d'outils, barre d'onglets, menus, dialogues, notifications, lecteur | **verre** (`.glass`, composant `<Glass>`, bouton `variant="glass"`)                         |
| **Contenu** (défile sous la couche fonctionnelle) | affiches, épisodes, listes, sections des paramètres                                       | **remplissages** translucides (`.fill`, `.fill-strong`) et cadres d'images (`.media-frame`) |

Règles d'Apple reprises telles quelles :

- pas de verre dans le contenu ni de **verre sur verre** : dans une surface en verre, utiliser
  des boutons `ghost`, des remplissages ou l'indicateur `lens-indicator` ;
- la **teinte d'accent** (bouton `primary`, verre proéminent ambré) est réservée à l'action
  principale d'un écran ;
- le **verre clair** (`glass-clear`) uniquement sur des images ou des vidéos, toujours au-dessus
  d'un voile d'atténuation (dégradé sombre) ;
- les éléments en verre ne recouvrent pas le contenu à l'état de repos : les marges
  `--inset-*` leur réservent la place, seul le contenu qui défile passe dessous.

## Organisation du code

```
apps/web/src/styles/
  theme.css        jetons (@theme Tailwind) : couleurs, rayons concentriques, ressorts, animations
  base.css         fond d'ambiance, bords de défilement, cadre de l'application, cadres d'images
  glass.css        matériau : variantes, arêtes, interactions, accessibilité, notifications
apps/web/src/design/
  glass/
    appearance.ts       préférences (Transparent/Teinté/Opaque, réfraction, reflets) + réglages système
    refraction.ts       cartes de déplacement et registre des filtres SVG partagés
    useLens.ts          applique la réfraction à un élément (suit sa taille et son rayon)
    light.ts            lumière dynamique (pointeur, inclinaison) des reflets
    frameGuard.ts       garde-fou de fluidité (coupe la réfraction si l'affichage saccade)
    useLiquidIndicator.ts  goutte de sélection qui glisse et s'étire
    Glass.tsx           composant de surface en verre
    GlassRuntime.tsx    branche la lumière et le garde-fou selon les préférences
  ambient/
    palette.ts          palette extraite d'une illustration (ou dérivée d'un titre)
    ambient.ts          magasin de l'ambiance courante + hook useAmbient
    AmbientBackground.tsx  fond coloré derrière toute l'application
```

## Jetons

| Jeton (Tailwind)                   | Valeur                        | Usage                                              |
| ---------------------------------- | ----------------------------- | -------------------------------------------------- |
| `rounded-panel`                    | 28 px                         | barre latérale, panneau du lecteur, feuilles       |
| `rounded-card`                     | 22 px                         | cartes et sections du contenu, menus               |
| `rounded-tile`                     | 18 px                         | affiches, vignettes, éléments de la barre latérale |
| `rounded-inner`                    | 14 px                         | éléments imbriqués (options de menu…)              |
| `rounded-full`                     | capsule                       | tous les boutons, champs, onglets                  |
| `ease-spring` / `ease-spring-soft` | ressorts échantillonnés       | interactions / apparitions                         |
| `animate-materialize`              | mise au point + échelle       | menus, dialogues, notifications de lecture         |
| `bg-ink-*`, `text-brand-*`         | fond « salle obscure », ambre | surfaces opaques, accent                           |

Rayons **concentriques** : un élément imbriqué prend le rayon de son conteneur moins la marge
qui les sépare (barre latérale 28 px, marge 12 px → éléments 18 px environ).

Variables du matériau (`glass.css`) : `--lg-alpha`, `--lg-blur`, `--lg-dim` (normale),
`--lg-clear-*`, `--lg-thick-*`, `--lg-edge` (intensité des reflets), `--lg-light-angle`
(direction de la lumière). Les modes Teinté, Opaque, contraste élevé ne font que les modifier.

## Matériaux et composants

| Besoin                             | À utiliser                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Panneau ou barre flottante         | `<Glass as="aside" lens={{ bezel, strength }}>`                                                             |
| Groupe d'actions dans une barre    | `<Glass className="rounded-full p-1">` + boutons `variant="ghost"`                                          |
| Bouton flottant (sur image, barre) | `<Button variant="glass">` (`glass-clear` sur une vidéo)                                                    |
| Action principale                  | `<Button variant="primary">` (verre proéminent ambré)                                                       |
| Action secondaire dans le contenu  | `<Button variant="secondary">` (remplissage)                                                                |
| Choix exclusif (saisons, réglages) | `<Tabs>` (contrôle segmenté, `kind="radio"` pour un réglage)                                                |
| Liste de choix                     | `<Menu>` (verre épais qui jaillit du bouton)                                                                |
| Champ de formulaire à choix        | `<Select>` (liste en verre épais, jamais le `<select>` natif, dont la liste suit le thème clair du système) |
| Progression                        | `<ProgressBar>` (remplissage découpé par `clip-path`, segment animé sans valeur, reflet `active`)           |
| Configuration à terminer           | `<SetupCard>` (accueil, catalogue vide) ou `<SetupBanner>` (rappel compact)                                 |
| Interrupteur                       | `<Switch>` (curseur qui devient lentille pendant l'appui)                                                   |
| Confirmation                       | `<Dialog>` (verre épais, matérialisation)                                                                   |
| Affiche ou vignette cliquable      | `.media-frame` + `data-glow` dans un lien `group`                                                           |
| Section de contenu                 | `.fill rounded-card`                                                                                        |

### Ajouter la réfraction à un nouvel élément

```tsx
const ref = useRef<HTMLDivElement>(null);
useLens(ref, { bezel: 18, strength: 14 }); // ou {} : valeurs proportionnelles à la taille
return (
  <div ref={ref} className="glass rounded-full">
    …
  </div>
);
```

La carte de déplacement est générée pour la taille et le rayon réels de l'élément, partagée
avec les éléments de même forme, et recalculée 140 ms après la fin d'un redimensionnement.
Réserver la réfraction aux éléments importants : chaque filtre est recalculé à chaque image
où le contenu bouge dessous.

### Colorer l'ambiance d'une page

```tsx
useAmbient(title.backdropUrl ?? title.posterUrl, title.title);
```

La palette (trois couleurs vives, assombries) est extraite de l'image ou, à défaut, dérivée
du titre ; l'ambiance revient à la palette par défaut quand on quitte la page.

## Accessibilité

| Réglage                                                 | Effet                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Apparence → **Teinté**                                  | verre plus opaque et plus contrasté (comme iOS 26.1)           |
| Apparence → **Opaque** / `prefers-reduced-transparency` | surfaces givrées sans transparence, sans réfraction ni reflets |
| `prefers-contrast: more`                                | verre presque opaque, contour blanc, pas de réfraction         |
| `prefers-reduced-motion`                                | ni élasticité, ni goutte qui s'étire, ni reflets dynamiques    |
| `forced-colors` (Windows)                               | couleurs système, contours visibles                            |

Contrôles effectués : contraste du pire cas mesuré sur le rendu (texte blanc ≥ 4,5:1 sur le
verre normal et épais, ≥ 3:1 sur le verre clair réservé aux icônes), audit axe-core sans
violation, navigation au clavier (onglets aux flèches, menus aux flèches/Échap, raccourci
`/` pour la recherche, curseur du lecteur au clavier), anneau de focus décalé pour rester
visible autour du verre.

## Navigateurs

| Navigateur                                     | Rendu                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Chrome, Edge, Brave, Opera (bureau et Android) | verre complet : flou, saturation, **réfraction des bords**, reflets |
| Safari (macOS, iOS), tous les navigateurs iOS  | verre dépoli : flou, saturation, reflets (pas de réfraction)        |
| Firefox                                        | verre dépoli                                                        |

La détection (`detectRefractionSupport`) repose sur `CSS.supports` et l'identification de
Chromium ; les navigateurs iOS (WebKit) sont exclus même s'ils s'annoncent comme Chrome.
