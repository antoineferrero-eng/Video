import { createBrowserRouter } from 'react-router';
import { NotFound, Shell } from './components/layout/Shell';
import { PageLoader } from './components/ui/Spinner';
import { HomePage } from './features/home/HomePage';

// Les pages secondaires sont chargées à la demande (découpage du bundle).
export const router = createBrowserRouter([
  {
    path: '/lecture',
    hydrateFallbackElement: <PageLoader />,
    lazy: () =>
      import('./features/player/PlayerPage').then((module) => ({ Component: module.PlayerPage })),
  },
  {
    element: <Shell />,
    // Affiché pendant le chargement initial d'une page chargée à la demande.
    hydrateFallbackElement: <PageLoader />,
    children: [
      { index: true, element: <HomePage /> },
      {
        path: 'films',
        lazy: () =>
          import('./features/catalog/CatalogPage').then((module) => ({
            Component: () => <module.CatalogPage kind="movie" key="movie" />,
          })),
      },
      {
        path: 'series',
        lazy: () =>
          import('./features/catalog/CatalogPage').then((module) => ({
            Component: () => <module.CatalogPage kind="series" key="series" />,
          })),
      },
      {
        path: 'titre/:id',
        lazy: () =>
          import('./features/title/TitlePage').then((module) => ({ Component: module.TitlePage })),
      },
      {
        path: 'recherche',
        lazy: () =>
          import('./features/search/SearchPage').then((module) => ({
            Component: module.SearchPage,
          })),
      },
      {
        path: 'telechargements',
        lazy: () =>
          import('./features/downloads/DownloadsPage').then((module) => ({
            Component: module.DownloadsPage,
          })),
      },
      {
        path: 'bibliotheque',
        lazy: () =>
          import('./features/library/LibraryPage').then((module) => ({
            Component: module.LibraryPage,
          })),
      },
      {
        // Page ouverte par le favori « Envoyer à Lumière » (lien 1fichier dans le fragment).
        path: 'envoi-1fichier',
        lazy: () =>
          import('./features/onefichier/SendPage').then((module) => ({
            Component: module.SendPage,
          })),
      },
      {
        path: 'parametres',
        lazy: () =>
          import('./features/settings/SettingsPage').then((module) => ({
            Component: module.SettingsPage,
          })),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
