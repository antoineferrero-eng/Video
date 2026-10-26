# Lumière — prototype de bureau (étape 1)

Petit programme Electron, **à part du reste de Lumière**, qui vérifie sur votre PC le parcours
prévu pour loadix :

1. **Connexion à loadix** dans une fenêtre de l'application. La session est gardée : on se
   connecte une seule fois.
2. **« Télécharger (essai) »** sur une version : la fiche loadix s'ouvre directement sur ce lien,
   le bouton « Révéler » est cliqué pour vous, **vous cochez la case Cloudflare** si elle
   apparaît, puis le lien 1fichier affiché est récupéré et la fenêtre se ferme.
3. **1fichier premium** : avec votre clé API, le prototype demande le lien direct puis lit
   quelques Mo (début du fichier, puis deux morceaux en parallèle) pour vérifier ce dont le
   moteur de téléchargement de Lumière aura besoin. Rien n'est enregistré sur le disque.

Aucun débogueur n'est attaché aux pages de loadix (c'est ce qui faisait boucler la vérification
dans l'ancienne version de Lumière) : le prototype observe seulement les codes de réponse et lit
la page une fois le lien affiché.

## Lancer le prototype (Windows)

Dans un terminal (PowerShell), depuis votre dossier Lumière :

```powershell
git fetch origin claude/inspiring-cori-ea7h6f
git checkout claude/inspiring-cori-ea7h6f
cd apps/desktop
npm install
npm start
```

`npm install` télécharge Electron (environ 100 Mo) la première fois. Ce dossier n'est pas
relié au reste du projet : `npm install` à la racine de Lumière ne l'installe pas.

## Essai pas à pas

1. **Loadix** : laissez `https://loadix.fun` (ou la nouvelle adresse si le site change).
   L'adresse de l'API se déduit toute seule (`https://api.loadix.fun`) ; ne la remplissez que si
   elle diffère. Cliquez sur **Se connecter**, connectez-vous dans la fenêtre : elle se ferme
   d'elle-même, et l'état passe à « Connecté en tant que … ».
2. **1fichier** : collez votre clé API (1fichier.com → Mon compte → Paramètres → API),
   **Enregistrer la clé**, puis **Tester la clé**. La clé est chiffrée par Windows sur votre PC.
3. **Essai** : copiez l'adresse d'une fiche de film sur loadix (`https://loadix.fun/media/…`),
   **Afficher les versions**, puis **Télécharger (essai)** sur une version **légère** (la taille
   n'a pas d'importance pour l'essai, seuls quelques Mo sont lus).
4. Quand c'est fini, **Copier le rapport** et envoyez-le-moi avec ce que vous avez vu :
   - la case Cloudflare est-elle apparue ? A-t-elle validé du premier coup ou tourné en boucle ?
   - le bouton « Révéler » a-t-il été cliqué tout seul (voir le journal) ?

Le rapport copié masque les liens et le mot de passe. La version complète reste sur votre PC,
dans `%APPDATA%\Lumiere-prototype\rapports` (bouton **Ouvrir le dossier des rapports**), avec le
journal (`journal.log`), les réglages et la session loadix.

## Si quelque chose bloque

| Problème                                                | Que faire                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| « Non connecté (HTTP 401…) » alors que vous l'êtes      | Envoyez-moi le message : la vérification passe par `api/auth/refresh`, le site a peut-être d'autres exigences.     |
| La case Cloudflare tourne en boucle                     | Notez-le dans votre message : c'est précisément ce que l'essai doit révéler.                                       |
| « boutons « Révéler » sur la page : cliquez vous-même » | Cliquez sur « Révéler » du lien choisi dans la fenêtre : la suite (lecture du lien, 1fichier) continue seule.      |
| Rien ne se passe après la révélation                    | Fermez la fenêtre loadix, puis envoyez-moi le journal et une capture de la fenêtre au moment où le lien s'affiche. |
| Pour repartir de zéro                                   | **Se déconnecter** efface la session loadix ; **Effacer la clé** retire la clé 1fichier.                           |
