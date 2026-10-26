# Lumière — prototype de bureau (étape 1)

Petit programme Electron, **à part du reste de Lumière**, qui vérifie sur votre PC le parcours
prévu pour loadix :

1. **Connexion à loadix** dans une fenêtre de l'application. La session est gardée : on se
   connecte une seule fois.
2. **Révélation d'un lien**, de deux façons à comparer :
   - **« Essai : fenêtre Lumière »** : la fiche loadix s'ouvre dans le prototype directement sur
     ce lien, le bouton « Révéler le lien » est cliqué pour vous, **vous cochez la case
     Cloudflare**, puis le lien 1fichier affiché est récupéré et la fenêtre se ferme ;
   - **« Essai : mon navigateur »** : la fiche s'ouvre dans votre navigateur habituel (Edge,
     Chrome…), vous révélez le lien comme d'habitude puis cliquez **« Copier »** : le prototype
     reprend le lien 1fichier dans le presse-papiers.
3. **1fichier premium** : avec votre clé API, le prototype demande le lien direct puis lit
   quelques Mo (début du fichier, puis deux morceaux en parallèle) pour vérifier ce dont le
   moteur de téléchargement de Lumière aura besoin. Rien n'est enregistré sur le disque.

Aucun débogueur n'est attaché aux pages de loadix (c'est ce qui faisait boucler la vérification
dans l'ancienne version de Lumière) : le prototype observe seulement les codes de réponse et lit
la page une fois le lien affiché. Si la vérification échoue dans la fenêtre, le rapport contient
le code d'erreur écrit par Cloudflare dans la console de la page (par exemple `600010`).

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
   **Afficher les versions**, puis **Essai : fenêtre Lumière** sur une version (la taille n'a pas
   d'importance, seuls quelques Mo sont lus). Si la vérification échoue, attendez quelques
   secondes puis **Annuler l'essai en cours** : le rapport contient alors le diagnostic.
4. Refaites un essai avec **Essai : mon navigateur** sur la même version.
5. Après chaque essai, **Copier le rapport** et envoyez-le-moi avec ce que vous avez vu (la
   case Cloudflare a-t-elle validé, échoué, tourné en boucle ?).

Le rapport copié masque les liens et le mot de passe. La version complète reste sur votre PC,
dans `%APPDATA%\Lumiere-prototype\rapports` (bouton **Ouvrir le dossier des rapports**), avec le
journal (`journal.log`), les réglages et la session loadix.

## Si quelque chose bloque

| Problème                                                | Que faire                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| « Non connecté (HTTP 401…) » alors que vous l'êtes      | Envoyez-moi le message : la vérification passe par `api/auth/refresh`, le site a peut-être d'autres exigences.     |
| « Vérification anti-bot échouée » dans la fenêtre       | **Annuler l'essai en cours** puis copiez le rapport (code d'erreur Cloudflare) ; essayez **mon navigateur**.       |
| « boutons « Révéler » sur la page : cliquez vous-même » | Cliquez sur « Révéler » du lien choisi dans la fenêtre : la suite (lecture du lien, 1fichier) continue seule.      |
| Rien ne se passe après la révélation                    | Fermez la fenêtre loadix, puis envoyez-moi le journal et une capture de la fenêtre au moment où le lien s'affiche. |
| Pour repartir de zéro                                   | **Se déconnecter** efface la session loadix ; **Effacer la clé** retire la clé 1fichier.                           |
